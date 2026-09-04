// Synchronous, in-memory coordination for background Ops work — the single source of truth for
// "is research running for this chat right now?" and "did we just delegate this exact ask?".
//
// Why in-memory and not durable prefs: this flag must be readable on the VERY NEXT turn (a user
// types "ok" ~1.5s after we delegate). Routing it through async durable prefs loses that
// read-after-write race and reproduces the exact bug this exists to kill. It is set SYNCHRONOUSLY
// at the delegation point (before any await), so the next turn always sees it. Deployment is a
// single VM, so a process-local map is authoritative. State dies with the VM — which is correct:
// a crashed Ops run never resumes, so a stale "still pulling" flag must not survive a restart.
//
// Keyed by chatId then taskId so concurrent DISTINCT tasks coexist and each clears only its own
// marker (no first-finisher-clears-everyone bug).
import type { TaskKind } from '../agents/types.js';
import { estimateOpsEta, etaStatus, type EtaEstimate, type EtaStatus } from '../agents/etaEstimate.js';
import { standardLegBudgetMs, browserLegBudgetMs, type EngineRunHandle } from '../agents/ops/engineBackend.js';

interface InFlightEntry {
  kind: TaskKind;
  request: string;
  normKey: string;
  startedAt: number; // epoch ms (app clock — only ever compared to Date.now())
  firstStartedAt: number;  // epoch ms, set once, never reset — true elapsed survives a retry leg
  origin?: 'scheduled';     // set for scheduled engine runs; user-delegated runs leave it unset
  lastMilestone?: string;   // most recent user-noticeable milestone the run reported
  milestoneAt?: number;     // epoch ms that milestone landed — lets Convo say what's happening NOW
  cancel?: AbortController; // aborts the running task's step loop (best-effort, token-saving)
  cancelled?: boolean;      // the load-bearing flag: the orchestrator suppresses delivery on it
  estimateMs?: number;
  estimatePhrase?: string;
  // The ENGINE's handle for the leg currently running, once the adapter has one to give (hermes's
  // run_id, published through EngineRunContext.onRunHandle). It is what a steer or a stop aims at;
  // absent means the run cannot be reached at all yet.
  engineRun?: EngineRunHandle;
  // Everything the user ADDED to this ask mid-run, in the order they said it — kept whether or not
  // the engine accepted any of it, because these are things they said about work that is running:
  // the status line reads them back and a refinement leg folds them in.
  steers?: string[];
  // The subset not yet handed to a caller for delivery. A steer that arrives before engineRun
  // exists (hermes takes a second or two to build the agent) waits here rather than being dropped.
  pendingSteers?: string[];
}

const inFlight = new Map<string, Map<string, InFlightEntry>>();   // chatId -> taskId -> entry
const recentlyDelegated = new Map<string, Map<string, number>>(); // chatId -> normKey -> at (ms)

/**
 * The optional durable twin of the maps above. This module is on the REPLY path and imports no
 * storage — its tests run without a database, and a db import here would drag one into every one of
 * them. So the durable half registers itself as a SINK instead: every method is synchronous (the
 * map writes it shadows are what INV-1 rests on, and an await between them would open the gap that
 * invariant closes) and every call site try/catches it (a durable write must never take down a
 * reply). No sink registered — the flag off, or a test — and every hook below is one false `if`.
 */
export interface OpsTaskSink {
  onStart(e: { chatId: string; taskId: string; kind: TaskKind; request: string; budgetMs: number; origin?: 'scheduled' }): void;
  onRetry(e: { chatId: string; taskId: string }): void;
  onCancel(e: { chatId: string; taskId: string }): void;
  onDone(e: { chatId: string; taskId: string }): void;
  /** "Is this exact ask already running, according to something that outlived the process?" —
   *  consulted only after both maps miss, which after a restart is every ask. */
  isRunningElsewhere(chatId: string, request: string): boolean;
}

let taskSink: OpsTaskSink | null = null;

/** Register (or clear, with null) the durable twin. Called once at boot, and by tests. */
export function setOpsTaskSink(sink: OpsTaskSink | null): void {
  taskSink = sink;
}

// A just-delegated ask stays "recent" this long so a repeat lands on the cached answer, not a
// second run. Short enough that a genuinely fresh re-ask after the data could change still runs.
const RECENT_DELEGATION_MS = 90_000;
// How far PAST its own deadline a leg may run before we stop claiming it is in flight. The orchestrator
// abandons a leg at its budget and clears the marker in `finally`, so this covers only the gap between
// "the deadline passed" and "the teardown got here" — a minute is generous for that, and short enough
// that a genuinely crashed process (no teardown at all) unblocks the next ask quickly.
export const OPS_STALE_SLACK_MS = 60_000;

/**
 * Soft upper bound on how long we'll claim a run is still "in flight" for wording/suppression: the
 * WIDEST leg deadline this deployment can wait on, plus the slack above. A run that overran it
 * (crash, stuck tool) stops blocking; that's a self-heal, not correctness.
 *
 * DERIVED, not pinned, because the two numbers are one fact. While a leg is genuinely running,
 * `getActiveOps` must keep Convo saying "still on it", `getOpsEtaStatus` must keep the ETA, and
 * `isDuplicateDelegation` / `hasInFlightRequest` must keep suppressing the re-ask — so this horizon
 * has to sit OUTSIDE every deadline the orchestrator waits on (ops/client.ts `legBudgetFor`: the
 * standard `OPS_TASK_TIMEOUT_MS` window, or the wider walled-URL browser budget when the operator
 * armed one). Pinned at a flat five minutes, an armed 15-minute browser leg went silent at five: the
 * "still on it" wording stopped, the ETA vanished, and a duplicate re-ask started a SECOND engine run
 * against the one already working.
 *
 * Both env vars are read through the parsers that OWN them (agents/ops/engineBackend.ts), never a
 * second reading of either one, and at CALL time like every other flag so arming the budget needs no
 * restart. Pure — the env is injected, so the caller decides when it is read. A default environment
 * gives 240_000 + 60_000: the same 300_000 this was a constant for.
 */
export function opsStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(standardLegBudgetMs(env), browserLegBudgetMs(env) ?? 0) + OPS_STALE_SLACK_MS;
}

/** Normalize kind+request into a dedupe key. Whitespace/case-insensitive; exact-intent match. */
export function normalizeRequest(kind: string, request: string): string {
  return `${kind}:${request.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/** Record that an Ops task just started for a chat. Call SYNCHRONOUSLY before `void runOps...`.
 *  Pass the task's AbortController so a user cancel can reach the running loop.
 *  `origin: 'scheduled'` marks an Autonome background run (framed differently in Convo's prompt). */
export function markOpsStart(chatId: string, taskId: string, info: { kind: TaskKind; request: string; origin?: 'scheduled'; estimate?: EtaEstimate }, cancel?: AbortController): void {
  const normKey = normalizeRequest(info.kind, info.request);
  const now = Date.now();
  const est = info.estimate ?? estimateOpsEta({ kind: info.kind, request: info.request });
  const byTask = inFlight.get(chatId) ?? new Map<string, InFlightEntry>();
  byTask.set(taskId, { kind: info.kind, request: info.request, normKey, startedAt: now, firstStartedAt: now, origin: info.origin, cancel, estimateMs: est.bucketMs, estimatePhrase: est.phrase });
  inFlight.set(chatId, byTask);
  const ring = recentlyDelegated.get(chatId) ?? new Map<string, number>();
  ring.set(normKey, now);
  recentlyDelegated.set(chatId, ring);
  prune(chatId);
  // The durable copy goes AFTER the maps: the maps are the authority this turn, the row is what
  // answers for this run after the process is gone.
  if (taskSink) {
    try { taskSink.onStart({ chatId, taskId, kind: info.kind, request: info.request, budgetMs: opsStaleMs(), origin: info.origin }); }
    catch { /* durable state is best-effort — never the reply's problem */ }
  }
}

/**
 * User-requested cancel of one in-flight task. Synchronous (this map is the authority): sets the
 * `cancelled` flag the orchestrator's delivery guard reads, aborts the loop's signal (best-effort),
 * and forgets the ask's dedupe key so an immediate "actually run it again" isn't suppressed as a
 * duplicate. Returns 'already_done' when the entry is gone — the task finished and delivered (or
 * never existed); the caller voices that honestly instead of claiming a cancel.
 */
export function requestOpsCancel(chatId: string, taskId: string): 'signalled' | 'already_done' {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry) return 'already_done';
  entry.cancelled = true;
  entry.cancel?.abort();
  recentlyDelegated.get(chatId)?.delete(entry.normKey);
  if (taskSink) {
    try { taskSink.onCancel({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
  return 'signalled';
}

/** Read the cancel flag off the entry (works even for paths the signal never reaches). */
export function isOpsCancelled(chatId: string, taskId: string): boolean {
  return inFlight.get(chatId)?.get(taskId)?.cancelled === true;
}

/**
 * Keep-alive for the cheap RETRY leg (a transient-lane-blip second pass). An llm_error can land
 * LATE in the primary loop, so the retry may run well after the original start and the entry would
 * go stale mid-look (past opsStaleMs, getActiveOps + isDuplicateDelegation silently drop the task, so
 * Convo would stop saying "still on it" and a duplicate re-ask could run mid-look). Resetting the
 * per-leg startedAt hands the new leg the same clock a first leg gets, which is what the horizon is
 * built for: opsStaleMs sits outside the WIDEST leg deadline this deployment can wait on, so a leg
 * whose clock starts now cannot go stale before its own deadline abandons it (while firstStartedAt
 * stays put so true elapsed survives). It does NOT extend the ETA — a retry is expected to be quick and its
 * pings stay silent inside the normal quiet window. In-place, and MUST preserve `cancelled` — this
 * is NOT markOpsStart, which would resurrect a cancelled entry and re-arm its dedupe key. No-op if
 * the entry is already gone.
 */
export function markOpsRetry(chatId: string, taskId: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return;
  entry.startedAt = Date.now();
  if (taskSink) {
    try { taskSink.onRetry({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
}

/**
 * Compute the current ETA status for an in-flight task (elapsed from firstStartedAt so a retry leg
 * doesn't reset the clock). Returns undefined for cancelled, stale, or missing entries.
 *
 * `now` is injectable, like on the three reads below: it defaults to the app clock, and a caller
 * that reads several of these for one turn can pass one instant so they cannot disagree.
 */
export function getOpsEtaStatus(chatId: string, taskId: string, now: number = Date.now()): EtaStatus | undefined {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return undefined;
  if (now - entry.startedAt >= opsStaleMs()) return undefined;
  if (entry.estimateMs == null) return undefined;
  const elapsed = now - entry.firstStartedAt;
  return etaStatus({ bucketMs: entry.estimateMs, phrase: entry.estimatePhrase ?? '' }, elapsed);
}

/**
 * Record the latest user-noticeable milestone for an in-flight run — the tool it just started
 * (a stable key like 'search_email'). Fed by runTask's onProgress signal; this is what lets Convo
 * answer "how's that going?" with what the run is ACTUALLY doing instead of a generic beat.
 * Unlike the texted progress pings (throttled to 1/run so the user isn't spammed), EVERY milestone
 * updates the registry — the throttle is about the mouth, not about what Convo is allowed to know.
 * In-place; no-op if the entry is gone or cancelled (a timed-out abandoned leg's late milestones
 * must never resurrect or mutate a cleared/cancelled entry — mirrors markOpsRetry's discipline).
 */
export function noteOpsProgress(chatId: string, taskId: string, milestoneKey: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) {
    entry.lastMilestone = milestoneKey;
    entry.milestoneAt = Date.now();
  }
}

/**
 * Record the ENGINE's handle for the leg now running (hermes's run_id, from
 * `EngineRunContext.onRunHandle`). Until this lands there is nothing a steer or a stop can aim at.
 *
 * In-place; no-op if the entry is gone or cancelled — the same discipline markOpsRetry and
 * noteOpsProgress keep, and for the same reason: a leg abandoned at its deadline can still publish
 * a handle late, and a cleared or cancelled entry must not be resurrected or mutated by it.
 */
export function noteOpsEngineRun(chatId: string, taskId: string, handle: EngineRunHandle): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (entry && !entry.cancelled) entry.engineRun = handle;
}

/** The engine handle for an in-flight leg, or undefined when there is none (yet, or ever — an
 *  adapter whose transport carries no run id never publishes one). The companion read to
 *  `requestOpsSteer`'s 'ready': the caller needs the handle to actually deliver. */
export function getOpsEngineRun(chatId: string, taskId: string): EngineRunHandle | undefined {
  const entry = inFlight.get(chatId)?.get(taskId);
  return entry && !entry.cancelled ? entry.engineRun : undefined;
}

/**
 * The user just ADDED to a lookup that is already running (steer_research). Synchronous, because
 * this map is the authority and the answer has to be in hand inside the live turn.
 *
 *  - 'ready':        there is an engine handle — the CALLER performs the async POST (this module
 *                    stays storage-free and does no I/O; read the handle with getOpsEngineRun).
 *  - 'queued':       the leg is dispatched but has no handle yet (hermes needs a second or two to
 *                    build the agent). The text waits in pendingSteers and is drained the moment
 *                    the handle lands — losing it here is losing something the user actually said.
 *  - 'already_done': nothing is running under that id, it was cancelled, or the text is blank. The
 *                    caller says so honestly and folds the addition into the next ask.
 *
 * Every non-blank addition is remembered on the entry regardless of the answer, so the status line
 * can say "you added: …" and a refinement leg can carry it even when the engine never took it.
 */
export function requestOpsSteer(chatId: string, taskId: string, text: string): 'ready' | 'queued' | 'already_done' {
  const trimmed = text.trim();
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled || !trimmed) return 'already_done';
  entry.steers = [...(entry.steers ?? []), trimmed];
  if (entry.engineRun) return 'ready';
  entry.pendingSteers = [...(entry.pendingSteers ?? []), trimmed];
  return 'queued';
}

/** Take (and clear) the steers still awaiting delivery — a HAND-OFF, so a second call returns
 *  nothing and two drainers can never send the same addition twice. Empty for a gone or cancelled
 *  entry: a run nobody is waiting on has nothing to be told. */
export function takePendingSteers(chatId: string, taskId: string): string[] {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled || !entry.pendingSteers?.length) return [];
  const queued = entry.pendingSteers;
  entry.pendingSteers = [];
  return queued;
}

/** Clear a single finished task. Call from runOpsAndFollowUp's finally, AFTER the result handoff. */
export function markOpsDone(chatId: string, taskId: string): void {
  const byTask = inFlight.get(chatId);
  if (!byTask) return;
  const had = byTask.delete(taskId);
  if (byTask.size === 0) inFlight.delete(chatId);
  // Only when an entry actually existed: a second markOpsDone (or one for a task this process never
  // held) must not write a row, and must not re-settle one another process already closed out.
  if (had && taskSink) {
    try { taskSink.onDone({ chatId, taskId }); }
    catch { /* durable state is best-effort */ }
  }
}

export interface ActiveOps {
  taskId: string;
  kind: TaskKind;
  request: string;
  startedAt: number;
  firstStartedAt: number;
  origin?: 'scheduled';
  lastMilestone?: string;
  milestoneAt?: number;
  estimateMs?: number;
  estimatePhrase?: string;
  /** What the user added to this ask mid-run, in the order they said it. ABSENT rather than empty
   *  when nobody added anything, so an ordinary run's status line — and the prompt budget pinned to
   *  it — stays exactly the bytes it was. */
  steers?: string[];
}

/** Snapshot of research currently running for this chat (stale and cancelled entries filtered out —
 *  a cancelled task must stop reading as "still pulling" the moment the user killed it). */
export function getActiveOps(chatId: string, now: number = Date.now()): ActiveOps[] {
  const byTask = inFlight.get(chatId);
  if (!byTask) return [];
  const staleMs = opsStaleMs();
  return [...byTask.entries()]
    .filter(([, e]) => now - e.startedAt < staleMs && !e.cancelled)
    .map(([taskId, e]) => ({ taskId, kind: e.kind, request: e.request, startedAt: e.startedAt, firstStartedAt: e.firstStartedAt, origin: e.origin, lastMilestone: e.lastMilestone, milestoneAt: e.milestoneAt, estimateMs: e.estimateMs, estimatePhrase: e.estimatePhrase, ...(e.steers?.length ? { steers: [...e.steers] } : {}) }));
}

/**
 * Kind-agnostic "is THIS exact ask running right now?" — matches on the normalized request text
 * alone, across any TaskKind. The Autonome scheduler uses this before firing a needsOps job: the
 * row's opsKind and the kind Convo's model picked for the same wording routinely differ, so the
 * kind-scoped isDuplicateDelegation would miss the overlap. Full-request equality makes cross-kind
 * false positives negligible. Same freshness/cancel filters as getActiveOps.
 */
export function hasInFlightRequest(chatId: string, request: string, now: number = Date.now()): boolean {
  const byTask = inFlight.get(chatId);
  if (!byTask) return false;
  const staleMs = opsStaleMs();
  const norm = request.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const e of byTask.values()) {
    if (now - e.startedAt < staleMs && !e.cancelled && e.request.trim().toLowerCase().replace(/\s+/g, ' ') === norm) return true;
  }
  return false;
}

/**
 * Deterministic dedup signal for the delegate path:
 *  - 'in_flight': an identical ask is running RIGHT NOW (never run it twice).
 *  - 'recent':    an identical ask was delegated within RECENT_DELEGATION_MS and has finished.
 *  - null:        no recent identical ask.
 * The caller decides what to do (the two-strike refinement path must NOT be suppressed).
 */
export function isDuplicateDelegation(chatId: string, kind: string, request: string, now: number = Date.now()): 'in_flight' | 'recent' | null {
  const key = normalizeRequest(kind, request);
  const staleMs = opsStaleMs();
  const byTask = inFlight.get(chatId);
  if (byTask) {
    for (const e of byTask.values()) {
      // A cancelled run doesn't block a re-ask — "actually, run it again" must start fresh.
      if (e.normKey === key && now - e.startedAt < staleMs && !e.cancelled) return 'in_flight';
    }
  }
  const at = recentlyDelegated.get(chatId)?.get(key);
  if (at && now - at < RECENT_DELEGATION_MS) return 'recent';
  // Last: the durable twin, which is the only one that still remembers anything after a restart.
  // Asked ONLY on a miss, so nothing about the in-memory answer changes, and asked with the request
  // so a run stranded in this chat cannot make an unrelated ask read as already running.
  if (taskSink) {
    try { if (taskSink.isRunningElsewhere(chatId, request)) return 'in_flight'; }
    catch { /* durable state is best-effort — fall through to "no duplicate" */ }
  }
  return null;
}

function prune(chatId: string): void {
  const ring = recentlyDelegated.get(chatId);
  if (!ring) return;
  const now = Date.now();
  for (const [k, at] of ring) if (now - at >= RECENT_DELEGATION_MS) ring.delete(k);
  if (ring.size === 0) recentlyDelegated.delete(chatId);
}

/** Test-only: wipe all coordination state, sink included — the shape of a restart. */
export function __resetOpsCoordination(): void {
  inFlight.clear();
  recentlyDelegated.clear();
  taskSink = null;
}

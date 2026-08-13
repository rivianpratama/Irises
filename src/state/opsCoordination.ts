// Synchronous, in-memory coordination for background Ops work — the single source of truth for
// "is research running for this chat right now?" and "did we just delegate this exact ask?".
//
// Why in-memory and not durable prefs: this flag must be readable on the VERY NEXT turn (a user
// types "ok" ~1.5s after we delegate). Routing it through async Supabase prefs loses that
// read-after-write race and reproduces the exact bug this exists to kill. It is set SYNCHRONOUSLY
// at the delegation point (before any await), so the next turn always sees it. Deployment is a
// single VM, so a process-local map is authoritative. State dies with the VM — which is correct:
// a crashed Ops run never resumes, so a stale "still pulling" flag must not survive a restart.
//
// Keyed by chatId then taskId so concurrent DISTINCT tasks coexist and each clears only its own
// marker (no first-finisher-clears-everyone bug).
import type { TaskKind } from '../agents/types.js';
import { estimateOpsEta, etaStatus, type EtaEstimate, type EtaStatus } from '../agents/etaEstimate.js';

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
}

const inFlight = new Map<string, Map<string, InFlightEntry>>();   // chatId -> taskId -> entry
const recentlyDelegated = new Map<string, Map<string, number>>(); // chatId -> normKey -> at (ms)

// A just-delegated ask stays "recent" this long so a repeat lands on the cached answer, not a
// second run. Short enough that a genuinely fresh re-ask after the data could change still runs.
const RECENT_DELEGATION_MS = 90_000;
// Soft upper bound on how long we'll claim a run is still "in flight" for wording/suppression.
// A run that overran this (crash, stuck tool) stops blocking; it's a self-heal, not correctness.
const STALE_MS = 5 * 60 * 1000;

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
  return 'signalled';
}

/** Read the cancel flag off the entry (works even for paths the signal never reaches). */
export function isOpsCancelled(chatId: string, taskId: string): boolean {
  return inFlight.get(chatId)?.get(taskId)?.cancelled === true;
}

/**
 * Keep-alive for the cheap RETRY leg (a transient-lane-blip second pass). An llm_error can land
 * LATE in the primary loop, so the retry may run well after the original start and the entry would
 * go stale mid-look (past STALE_MS, getActiveOps + isDuplicateDelegation silently drop the task, so
 * Convo would stop saying "still on it" and a duplicate re-ask could run mid-look). Resetting the
 * per-leg startedAt restores the `timeout < STALE_MS` invariant (while firstStartedAt stays put so
 * true elapsed survives). It does NOT extend the ETA — a retry is expected to be quick and its
 * pings stay silent inside the normal quiet window. In-place, and MUST preserve `cancelled` — this
 * is NOT markOpsStart, which would resurrect a cancelled entry and re-arm its dedupe key. No-op if
 * the entry is already gone.
 */
export function markOpsRetry(chatId: string, taskId: string): void {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return;
  entry.startedAt = Date.now();
}

/**
 * Compute the current ETA status for an in-flight task (elapsed from firstStartedAt so a retry leg
 * doesn't reset the clock). Returns undefined for cancelled, stale, or missing entries.
 */
export function getOpsEtaStatus(chatId: string, taskId: string): EtaStatus | undefined {
  const entry = inFlight.get(chatId)?.get(taskId);
  if (!entry || entry.cancelled) return undefined;
  const now = Date.now();
  if (now - entry.startedAt >= STALE_MS) return undefined;
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

/** Clear a single finished task. Call from runOpsAndFollowUp's finally, AFTER the result handoff. */
export function markOpsDone(chatId: string, taskId: string): void {
  const byTask = inFlight.get(chatId);
  if (!byTask) return;
  byTask.delete(taskId);
  if (byTask.size === 0) inFlight.delete(chatId);
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
}

/** Snapshot of research currently running for this chat (stale and cancelled entries filtered out —
 *  a cancelled task must stop reading as "still pulling" the moment the user killed it). */
export function getActiveOps(chatId: string): ActiveOps[] {
  const byTask = inFlight.get(chatId);
  if (!byTask) return [];
  const now = Date.now();
  return [...byTask.entries()]
    .filter(([, e]) => now - e.startedAt < STALE_MS && !e.cancelled)
    .map(([taskId, e]) => ({ taskId, kind: e.kind, request: e.request, startedAt: e.startedAt, firstStartedAt: e.firstStartedAt, origin: e.origin, lastMilestone: e.lastMilestone, milestoneAt: e.milestoneAt, estimateMs: e.estimateMs, estimatePhrase: e.estimatePhrase }));
}

/**
 * Kind-agnostic "is THIS exact ask running right now?" — matches on the normalized request text
 * alone, across any TaskKind. The Autonome scheduler uses this before firing a needsOps job: the
 * row's opsKind and the kind Convo's model picked for the same wording routinely differ, so the
 * kind-scoped isDuplicateDelegation would miss the overlap. Full-request equality makes cross-kind
 * false positives negligible. Same freshness/cancel filters as getActiveOps.
 */
export function hasInFlightRequest(chatId: string, request: string): boolean {
  const byTask = inFlight.get(chatId);
  if (!byTask) return false;
  const now = Date.now();
  const norm = request.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const e of byTask.values()) {
    if (now - e.startedAt < STALE_MS && !e.cancelled && e.request.trim().toLowerCase().replace(/\s+/g, ' ') === norm) return true;
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
export function isDuplicateDelegation(chatId: string, kind: string, request: string): 'in_flight' | 'recent' | null {
  const key = normalizeRequest(kind, request);
  const now = Date.now();
  const byTask = inFlight.get(chatId);
  if (byTask) {
    for (const e of byTask.values()) {
      // A cancelled run doesn't block a re-ask — "actually, run it again" must start fresh.
      if (e.normKey === key && now - e.startedAt < STALE_MS && !e.cancelled) return 'in_flight';
    }
  }
  const at = recentlyDelegated.get(chatId)?.get(key);
  if (at && now - at < RECENT_DELEGATION_MS) return 'recent';
  return null;
}

function prune(chatId: string): void {
  const ring = recentlyDelegated.get(chatId);
  if (!ring) return;
  const now = Date.now();
  for (const [k, at] of ring) if (now - at >= RECENT_DELEGATION_MS) ring.delete(k);
  if (ring.size === 0) recentlyDelegated.delete(chatId);
}

/** Test-only: wipe all coordination state. */
export function __resetOpsCoordination(): void {
  inFlight.clear();
  recentlyDelegated.clear();
}

// The engine seam. Irises keeps only the persona layer (Convo/Composer/Fallfirm/Classify);
// ALL deep work — research, email, media reads, scheduling, long-term memory — runs on an external
// engine (hermes-agent or OpenClaw) that this module dispatches to. The engine is deliberately
// UNMODIFIED upstream software: adapters speak only its public API (hermes: the OpenAI-compatible
// API server; OpenClaw: the Gateway WS `agent` RPC). There is NO native fallback — when the engine
// is unreachable the task fails honestly (Fallfirm voices the snag) and Convo keeps chatting.
import { record } from '../../diagnostics/trace.js';
import { HermesBackend } from './hermesBackend.js';
import { OpenClawBackend } from './openclawBackend.js';
import type { OpsTask, OpsResult, OpsDebrief, OpsFailureCause } from '../types.js';

// ── contract every adapter implements ────────────────────────────────────────

/** Milestone/abort plumbing threaded from the orchestrator through runTask into the adapter. */
export interface EngineRunContext {
  onProgress?: (milestoneKey: string) => void;
  signal?: AbortSignal;
}

/** A reminder/automation living ON THE ENGINE (its cron owns scheduling; Irises holds no rows). */
export interface ReminderSpec {
  chatId: string;
  agentHandle: string;
  instruction: string;   // what to do/say when it fires — the engine's job prompt is built from this
  cron?: string;         // recurring: standard 5-field cron
  fireAt?: number;       // one-time: epoch ms (adapters convert; exactly one of cron/fireAt)
  title?: string;
  // IANA zone the CRON's wall clock is expressed in (the user's zone, not the host's). Adapters
  // whose cron runs in the engine's own zone shift the fields by the offset difference; without it
  // "every weekday at 8am" fires at the engine's 8am. Ignored for fireAt (an absolute instant).
  timezone?: string;
}

export interface ReminderRef {
  id: string;
  title: string;
  schedule: string;      // human-readable-ish schedule the engine reported back
}

export interface ProbeResult { ok: boolean; detail?: string; }

/** The closed, CODE-OWNED vocabulary of deep-work action-classes Convo reasons about. An engine's
 *  raw capability/tool manifest is normalized ONTO this fixed set adapter-side, and NOTHING else
 *  ever reaches a prompt — raw manifest text stays out of the model entirely (that removes both the
 *  prompt-injection hazard and the cache-shape churn a free-form string would cause). */
export type CapabilityClass = 'web' | 'inbox' | 'files' | 'code' | 'media' | 'scheduling';

/** Canonical render order for the closed vocabulary. Declared ONCE here because its whole job is
 *  cross-file identity: a summary must read identically whichever adapter produced it (cache-friendly
 *  for the per-turn prompt line built from it), and a seventh class added to a per-adapter copy would
 *  type-check while silently leaving the other adapter's order wrong. */
export const CAP_ORDER: readonly CapabilityClass[] = ['web', 'inbox', 'files', 'code', 'media', 'scheduling'];

/** What the active engine can actually do THIS deployment, as the closed-vocabulary set above.
 *  Consumed ONLY to shape Convo's per-turn brief (so it never promises what the engine lacks); it
 *  is deliberately never fed into the engine-facing task prompt — Hermes knows its own tools, and a
 *  stale cache must not contradict it mid-run. */
export interface CapabilitySummary {
  classes: CapabilityClass[];
  /** `false` when the manifest carried tokens the adapter could not classify — i.e. the class list is
   *  a floor, not an inventory. Absent means fully understood (an operator declaration always is).
   *  The distinction is load-bearing downstream: only a fully-understood manifest may turn a MISSING
   *  class into a positive claim about the deployment ("their inbox isn't connected"). */
  complete?: boolean;
}

/** The engine went AWAY (unreachable / unconfigured / connection refused) — distinct from "the
 *  engine ran and failed". Callers voice it as a transient snag; nothing retries automatically. */
export class EngineUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) { super(message); this.name = 'EngineUnavailableError'; }
}

/** The engine answered the transport but the RUN failed (rate limit, auth, its own error). */
export class EngineRunError extends Error {
  constructor(message: string, public readonly failureCause: OpsFailureCause, public readonly status?: number) {
    super(message); this.name = 'EngineRunError';
  }
}

export interface EngineBackend {
  readonly name: 'hermes' | 'openclaw';
  /** One deep-work run: prompt in, final answer text out. The adapter owns transport, per-chat
   *  session continuity, media mapping (task.media), and its own request timeout. Throws
   *  EngineUnavailableError / EngineRunError; never returns partial output. */
  runTask(prompt: string, task: OpsTask, ctx: EngineRunContext): Promise<string>;
  createReminder(spec: ReminderSpec): Promise<ReminderRef>;
  listReminders(chatId: string): Promise<ReminderRef[]>;
  cancelReminder(id: string): Promise<boolean>;
  /** ASK the engine to update its own memory (scoped to this chat's engine session). The
   *  engine owns the decision — Irises never writes engine storage directly, and the same
   *  channel carries update, correction, and forget requests (see docs/ENGINES.md, "Memory
   *  boundary"). The reverse direction does not exist: engines have no path into Irises's
   *  own tiers. */
  remember(chatId: string, agentHandle: string, note: string): Promise<void>;
  probe(): Promise<ProbeResult>;
  /** The engine's current action-classes (closed vocabulary), or null when unknown/undiscovered.
   *  MUST be synchronous and NON-BLOCKING: return the last-known cached value immediately and never
   *  perform (or await) a fetch on the calling path — the per-turn Convo prompt build reads this, so
   *  any latency here lands on a user turn. The adapter refreshes the cache in the background.
   *  Optional: a backend that hasn't wired capability discovery simply omits it. */
  getCapabilitySummary?(): CapabilitySummary | null;
  /** Deliver the engine-mode doctrine ONCE, as a chat message the engine folds into its own durable
   *  instructions by its own hand (Irises never edits engine files). `version` is the doctrine's
   *  content hash, so the adapter can key its idempotency on it; returns the engine's reply text.
   *  Optional in the type, implemented by BOTH adapters today — engineOnboarding.ts only runs for an
   *  engine that has it. Where the transport carries no idempotency key (hermes), the doctrine text's
   *  own replace-by-heading ask is the guard against a duplicate append. */
  sendOnboarding?(text: string, version: string): Promise<string>;
  /** Bridge mode: deliver a message THROUGH one of the engine's own channel connections
   *  (the engine keeps owning the bot/number; Irises fronts it — see docs/ENGINES.md).
   *  `platform` is the engine's channel name (telegram/whatsapp/discord/…), `chatId` the raw
   *  platform chat id. Throws EngineUnavailableError/EngineRunError like runTask.
   *  Returns the PLATFORM's own message id when the engine reports one — the bridge channel
   *  stores it so a later tapped reply on that bubble resolves back to what Irises said
   *  (recordSentBubble → resolveTappedReply). `{}` when the engine can't tell us. */
  channelSend(platform: string, chatId: string, text: string, opts?: { threadId?: string; replyToId?: string }): Promise<{ messageId?: string }>;
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Per-call budget: the transport request must give up BEFORE the orchestrator's own
 * OPS_TASK_TIMEOUT_MS deadline abandons the run, so the failure is a clean mapped result
 * (not a DeadlineError synthetic) whenever the engine is merely slow to say no.
 *
 * An explicit ENGINE_TIMEOUT_MS is taken as written (the operator's word is final). Otherwise the
 * derived value is clamped on BOTH sides: the old `max(30s, orch − 15s)` floor overshot the
 * orchestrator whenever OPS_TASK_TIMEOUT_MS was tuned below 45s (a 20s orchestrator deadline got a
 * 30s transport timeout — the deadline always won, and every slow engine looked like a synthetic
 * DeadlineError instead of a mapped timeout).
 */
export function computeEngineTimeoutMs(env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.ENGINE_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const orch = Number(env.OPS_TASK_TIMEOUT_MS) || 4 * 60_000;
  return Math.min(Math.max(30_000, orch - 15_000), Math.max(5_000, orch - 5_000));
}

export const ENGINE_TIMEOUT_MS = computeEngineTimeoutMs(process.env);

/**
 * How long a run may sit in the engine-slot queue below before it gives up and fails honestly.
 *
 * This bound is load-bearing, not a nicety. A QUEUED run is completely invisible: it has not
 * contacted the engine, emitted no `engine:*:start`, opened no socket. An unbounded wait here is
 * therefore a SILENT hang — the delegation logs "Delegating …" and then nothing observable ever
 * happens, which is exactly the failure this bound converts into a mapped 'timeout' the
 * orchestrator's triage can voice.
 *
 * Half the per-call transport budget by default: a run that has already burned that long waiting
 * for a slot is behind a pathologically slow (or leaked) run, and still needs time to actually
 * execute before the orchestrator's own OPS_TASK_TIMEOUT_MS abandons it.
 */
export function computeEngineQueueWaitMs(env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.ENGINE_QUEUE_WAIT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(5_000, Math.round(computeEngineTimeoutMs(env) / 2));
}

// FIFO semaphore over engine AGENT RUNS — a burst of delegations must not stampede the engine
// (hermes's API server caps concurrent runs; OpenClaw serializes per session anyway). It covers
// runViaEngine and the fire-and-forget memory asks (withEngineSlot). Deliberately NOT covered:
// reminder CRUD (15s REST calls, not agent runs — they must stay snappy) and channelSend (a reply
// already composed must never queue behind two long runs).
const MAX_CONCURRENT = Number(process.env.ENGINE_MAX_CONCURRENT) || 2;
let active = 0;
const waiters: Array<() => void> = [];

/** Snapshot of the slot pool — for the `engine:*:queued` trace and for tests. */
export function engineSlotState(): { active: number; waiting: number; cap: number } {
  return { active, waiting: waiters.length, cap: MAX_CONCURRENT };
}

/**
 * Wake EVERY waiter and let each re-check the cap. A broadcast (rather than shifting one waiter)
 * is what makes this deadlock-proof: `shift()?.()` handed the wake-up to a single waiter, and a
 * waiter that had meanwhile given up (abort / queue timeout) swallowed it — the freed slot then sat
 * idle with live waiters still parked, forever. Losers simply re-queue, preserving arrival order.
 */
function wakeAll(): void {
  for (const w of waiters.splice(0, waiters.length)) w();
}

/** Park until a slot MIGHT be free, the caller aborts, or `timeoutMs` elapses. Always resolves —
 *  the acquire loop is the single place that decides what a wake-up means. Self-removes from
 *  `waiters` on give-up so a dead waiter can never absorb a wake-up. */
function waitForSlot(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (dropSelf: boolean) => {
      if (settled) return;
      settled = true;
      if (dropSelf) {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const waiter = () => finish(false);      // woken by wakeAll: already spliced out
    const onAbort = () => finish(true);
    waiters.push(waiter);
    // Deliberately NOT unref'd, unlike most timers here. This one exists solely to guarantee the
    // wait TERMINATES; an unref'd timer is skipped entirely whenever the loop has nothing else
    // holding it, which is precisely the situation where a queued run would otherwise never come
    // back. It is cleared the moment a slot frees or the caller aborts, so the longest it can hold
    // the loop is one queue-wait window — and only while a run is genuinely stuck.
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface AcquireOpts {
  /** Caller's abort signal — a cancelled task must not keep a place in the queue. */
  signal?: AbortSignal;
  /** Give-up bound for the QUEUE WAIT only (not the run). Defaults to computeEngineQueueWaitMs,
   *  read at CALL time (not module load) so an operator's ENGINE_QUEUE_WAIT_MS applies without a
   *  restart — and so a test can pin it without import-order gymnastics. */
  timeoutMs?: number;
  /** Called once, only if the caller actually has to wait — the hook the `engine:*:queued` trace
   *  hangs off, so a stall in this queue is never again invisible. */
  onQueued?: () => void;
}

/** Take one engine slot. Throws EngineRunError('cancelled') on abort and EngineRunError('timeout')
 *  when no slot frees in time; on either the caller never held a slot, so there is nothing to
 *  release. */
async function acquire(opts: AcquireOpts = {}): Promise<() => void> {
  const { signal, timeoutMs = computeEngineQueueWaitMs(process.env) } = opts;
  if (signal?.aborted) throw new EngineRunError('cancelled before an engine slot was taken', 'cancelled');
  if (active >= MAX_CONCURRENT) {
    opts.onQueued?.();
    const deadline = Date.now() + timeoutMs;
    // A LOOP, not a single await: a wake-up only means "a slot MAY be free" — another already-queued
    // acquire() can barge in and take it first, so a woken waiter must re-check the cap rather than
    // increment unconditionally (which pushed `active` one past the engine's concurrent-run limit).
    while (active >= MAX_CONCURRENT) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EngineRunError(
          `no engine slot free after ${timeoutMs}ms (${MAX_CONCURRENT} runs already in flight)`, 'timeout',
        );
      }
      await waitForSlot(signal, remaining);
      if (signal?.aborted) throw new EngineRunError('cancelled while queued for an engine slot', 'cancelled');
    }
  }
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    wakeAll();
  };
}

/** Run `fn` holding one engine slot — for engine calls made OUTSIDE runViaEngine that are still
 *  full agent runs (the memory ask). Releases on throw. */
export async function withEngineSlot<T>(fn: () => Promise<T>, opts: AcquireOpts = {}): Promise<T> {
  const release = await acquire(opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

let cached: EngineBackend | null | undefined;
let warnedNoBackend = false;

/** The configured engine, or null when OPS_BACKEND is unset/unknown (deep work is then offline —
 *  a deliberate, documented state, voiced honestly; Convo still chats). Cached for the process.
 *  Adapter classes are statically imported (cheap, dependency-free); the OpenClaw adapter defers
 *  its optional @openclaw/gateway-client npm dep until the first actual call. */
export function getEngineBackend(): EngineBackend | null {
  if (cached !== undefined) return cached;
  const name = (process.env.OPS_BACKEND || '').trim().toLowerCase();
  if (name === 'hermes') {
    cached = new HermesBackend();
  } else if (name === 'openclaw') {
    cached = new OpenClawBackend();
  } else {
    // NOT cached: "no backend" is a reading of the environment, not a decision about it. Caching it
    // pinned deep work offline for the whole process whenever anything asked before the env was
    // loaded (an early import, a probe at boot) — one unlucky call order and the engine never
    // existed. The warning is once-per-process so a hot path can't spam it. off/none/offline/… are
    // the DELIBERATE debug/standalone offline pins, so they don't warn — only a genuine typo does.
    const OFFLINE_PINS = new Set(['off', 'none', 'offline', 'disabled', 'false', '0']);
    if (name && !OFFLINE_PINS.has(name) && !warnedNoBackend) {
      warnedNoBackend = true;
      console.error(`[engine] unknown OPS_BACKEND "${name}" — deep work is offline`);
    }
    return null;
  }
  return cached;
}

/** Exported for unit tests. */
export function resetEngineBackendCache(backend?: EngineBackend | null): void {
  cached = backend;
}

/** Map an adapter failure onto the OpsResult the orchestrator's triage/compose machinery expects.
 *  Never throws: the seam's contract with runTask is "always an OpsResult". */
function failureResult(task: OpsTask, cause: OpsFailureCause, detail: string, status: OpsResult['status'] = 'error'): { result: OpsResult; cause: OpsFailureCause } {
  return {
    cause,
    result: { taskId: task.id, kind: task.kind, status, summary: 'ran into a problem completing that' },
  };
}

/** Run one task on the configured engine and shape the outcome as an OpsResult. The debrief is the
 *  caller's (runTask owns creating it + the sink/done bookkeeping); this fills in what happened. */
export async function runViaEngine(
  engine: EngineBackend,
  prompt: string,
  task: OpsTask,
  ctx: EngineRunContext,
  debrief: OpsDebrief,
): Promise<OpsResult> {
  const t0 = Date.now();
  // The slot is taken INSIDE the try and released in `finally`, and nothing runs between the two.
  // Previously `acquire()` sat above the try with `ctx.onProgress?.()` and `record()` in the gap:
  // a throw from either leaked one of the (2) slots for the life of the process, and two such leaks
  // wedge EVERY later delegation in acquire() forever — a hang with no trace, no socket and no
  // engine ever contacted. A throw from acquire() itself is safe: it never took a slot.
  let release: (() => void) | undefined;
  try {
    release = await acquire({
      signal: ctx.signal,
      onQueued: () => record({
        type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
        label: `engine:${engine.name}:queued`, detail: { kind: task.kind, ...engineSlotState() },
      }),
    });
    ctx.onProgress?.('engine');
    record({
      type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: `engine:${engine.name}:start`, detail: { kind: task.kind, promptChars: prompt.length, queuedMs: Date.now() - t0 },
    });
    const text = (await engine.runTask(prompt, task, ctx)).trim();
    debrief.steps += 1;
    debrief.toolsRun.push({ name: `engine:${engine.name}`, argsSummary: task.kind, ok: true, resultPreview: text.slice(0, 200), durationMs: Date.now() - t0 });
    debrief.corpus.push(text);
    if (!text) {
      debrief.failure = { cause: 'empty_miss', detail: 'engine returned empty text' };
      return { taskId: task.id, kind: task.kind, status: 'ok', summary: 'NO RESULT: the look came back empty', debrief };
    }
    return { taskId: task.id, kind: task.kind, status: 'ok', summary: text, debrief };
  } catch (err) {
    const durationMs = Date.now() - t0;
    let mapped: { result: OpsResult; cause: OpsFailureCause };
    if (ctx.signal?.aborted) {
      mapped = failureResult(task, 'cancelled', 'aborted');
    } else if (err instanceof EngineRunError) {
      mapped = failureResult(task, err.failureCause, err.message, err.failureCause === 'rate_limited' ? 'rate_limited' : 'error');
    } else if (err instanceof EngineUnavailableError) {
      mapped = failureResult(task, 'llm_error', `engine unreachable: ${err.message}`);
    } else if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      mapped = failureResult(task, 'timeout', `engine call exceeded ${ENGINE_TIMEOUT_MS}ms`);
    } else {
      mapped = failureResult(task, 'llm_error', String((err as Error)?.message ?? err));
    }
    debrief.toolsRun.push({ name: `engine:${engine.name}`, argsSummary: task.kind, ok: false, resultPreview: String((err as Error)?.message ?? err).slice(0, 200), durationMs });
    debrief.failure = { cause: mapped.cause, detail: String((err as Error)?.message ?? err).slice(0, 500) };
    record({
      type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
      label: `engine:${engine.name}:error`, detail: { cause: mapped.cause, ms: durationMs, error: String((err as Error)?.message ?? err).slice(0, 300) },
    });
    return { ...mapped.result, debrief };
  } finally {
    release?.();
  }
}

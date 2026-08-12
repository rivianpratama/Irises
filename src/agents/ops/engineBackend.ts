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
}

export interface ReminderRef {
  id: string;
  title: string;
  schedule: string;      // human-readable-ish schedule the engine reported back
}

export interface ProbeResult { ok: boolean; detail?: string; }

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
  /** Forward a durable fact to the engine's own memory (scoped to this chat's engine session). */
  remember(chatId: string, agentHandle: string, note: string): Promise<void>;
  probe(): Promise<ProbeResult>;
}

// ── dispatch ──────────────────────────────────────────────────────────────────

// Per-call budget: the transport request must give up BEFORE the orchestrator's own
// OPS_TASK_TIMEOUT_MS deadline abandons the run, so the failure is a clean mapped result
// (not a DeadlineError synthetic) whenever the engine is merely slow to say no.
export const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS)
  || Math.max(30_000, Number(process.env.OPS_TASK_TIMEOUT_MS || 4 * 60_000) - 15_000);

// FIFO semaphore across ALL engine calls — a burst of delegations must not stampede the engine
// (hermes's API server caps concurrent runs; OpenClaw serializes per session anyway).
const MAX_CONCURRENT = Number(process.env.ENGINE_MAX_CONCURRENT) || 2;
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>(r => waiters.push(r));
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    waiters.shift()?.();
  };
}

let cached: EngineBackend | null | undefined;

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
    if (name) console.error(`[engine] unknown OPS_BACKEND "${name}" — deep work is offline`);
    cached = null;
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
  const release = await acquire();
  const t0 = Date.now();
  ctx.onProgress?.('engine');
  record({
    type: 'event', chatId: task.chatId, handle: task.agentHandle, taskId: task.id,
    label: `engine:${engine.name}:start`, detail: { kind: task.kind, promptChars: prompt.length },
  });
  try {
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
    release();
  }
}

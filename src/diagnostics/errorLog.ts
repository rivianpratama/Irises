// Central error sink. Every agent path that would otherwise swallow a failure into a console
// line reports it here, and from here it goes three places: the console parity line, the
// diagnostics trace ring (so the dashboard's per-turn error badge keeps counting), and —
// batched and fingerprint-folded — the durable error_log table.
//
// reportError() is SYNCHRONOUS and NEVER throws: it is called from catch blocks on the reply
// path, so a telemetry bug must not become the turn's second failure. It is also independent
// of DIAGNOSTICS_ENABLED (that flag gates only the trace MIRROR, inside record()) — errors are
// recorded whether or not prompt diagnostics are on.
//
// Recursion firewall, three layers: the flush path only ever console.errors (never reportError
// or logDbError), insertErrorRows is likewise exempt, and the logDbError bridge registered at
// the bottom passes trace:false. A db failure while writing errors therefore cannot feed itself.

import { createHash } from 'node:crypto';
import { record } from './trace.js';
import { setDbErrorSink } from '../db/client.js';
import { insertErrorRows, startErrorLogPruneTimer, type StoredErrorRow } from '../db/repositories/errorLog.js';

export type { StoredErrorRow };

export type ErrorSeverity = 'warn' | 'error' | 'fatal';

export interface ReportedError {
  /** Who was working: convo|ops|judge|autonome|reflexion|mm|fallfirm|pipeline|db|llm|webhook|
   *  linq|process|budget|diagnostics|memory. LLM failures use the CALLING role. */
  source: string;
  /** What broke — see the category taxonomy in migration 0014. */
  category: string;
  message?: string;
  err?: unknown;
  severity?: ErrorSeverity;
  detail?: Record<string, unknown>;
  chatId?: string;
  handle?: string;
  taskId?: string;
  /** Mirror into the trace ring as an `ERROR:` event (default true). Pass false where the
   *  caller already recorded one — otherwise that turn's error_count double-counts. */
  trace?: boolean;
}

const MESSAGE_CAP = 2000;
const STACK_CAP = 4000;
const DETAIL_CAP = 8192;
const RING_CAP = 300;
const QUEUE_CAP = 500;
const EAGER_FLUSH_AT = 25;
const FLUSH_DELAY_MS = 3000;
const MAX_BACKOFF_MS = 60_000;
const BATCH_MAX = 100;
// A fingerprint keeps folding for this long after its row was written, so a storm that
// outlives one flush costs ~1 row/minute instead of one row per occurrence.
const FOLD_WINDOW_MS = 60_000;
const FLUSHED_LRU_CAP = 64;

type FlushFn = (rows: StoredErrorRow[]) => Promise<boolean>;

let seq = 0;
const queue: StoredErrorRow[] = [];
// Also kept on the Supabase backend: the dashboard's memory-mode path reads this ring, and
// it is the only store when Supabase isn't configured. Holds the SAME objects as the queue,
// so a fold bumps both at once.
const ring: StoredErrorRow[] = [];
// Fingerprints already flushed, with when. The bumped count on a folded-after-flush entry
// stays local — the durable row keeps the count it was written with; collapsing the storm is
// the point, and the drop is visible as a smaller count rather than as missing rows.
const flushed = new Map<string, { entry: StoredErrorRow; at: number }>();
let dropped = 0;
let consecutiveFailures = 0;
let flushing: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;
let timerAt = 0;
let flushFn: FlushFn = insertErrorRows;

function messageOf(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

function normalizeMessage(e: ReportedError): string {
  let raw = e.message ?? messageOf(e.err);
  if (raw == null && e.err !== undefined) {
    try { raw = String(e.err); } catch { raw = '[unstringifiable error]'; }
  }
  // message is NOT NULL in the table, and a blank row is a dead end for whoever reads it.
  const text = (raw ?? '').trim() || 'unknown error';
  return text.length > MESSAGE_CAP ? text.slice(0, MESSAGE_CAP) : text;
}

function stackOf(err: unknown): string | undefined {
  const s = err instanceof Error ? err.stack
    : err && typeof err === 'object' ? (err as { stack?: unknown }).stack
    : undefined;
  return typeof s === 'string' ? s.slice(0, STACK_CAP) : undefined;
}

function buildDetail(detail: Record<string, unknown> | undefined, stack: string | undefined): Record<string, unknown> | null {
  const src: Record<string, unknown> = { ...(detail ?? {}) };
  if (stack) src.stack = stack;
  const keys = Object.keys(src);
  if (!keys.length) return null;
  // Per-KEY JSON round trip (safeRaw's idiom in trace.ts, narrowed): one circular or
  // otherwise unserializable value must not take the rest of the bag — or the report — down.
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    try { out[k] = JSON.parse(JSON.stringify(src[k] ?? null)); }
    catch { out[k] = '[unserializable]'; }
  }
  try {
    const json = JSON.stringify(out);
    if (json.length > DETAIL_CAP) return { truncated: true, json: json.slice(0, DETAIL_CAP) };
  } catch {
    return { truncated: true, json: '[unserializable detail]' };
  }
  return out;
}

function fingerprintOf(source: string, category: string, message: string): string {
  // Ids, hashes and digit runs collapse to '#' so the same failure folds no matter which
  // record/port/timestamp it carried.
  const shape = message.replace(/[0-9a-f-]{8,}|\d+/gi, '#');
  return createHash('sha1').update(`${source}|${category}|${shape}`).digest('hex').slice(0, 16);
}

/** The entry this occurrence folds into, or null when it needs a row of its own. */
function foldTarget(fingerprint: string, now: number): StoredErrorRow | null {
  // Linear scan of a ≤500-entry queue of short strings — cheaper than maintaining an index
  // across every splice (flush batches, cap drops, re-queues).
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].fingerprint === fingerprint) return queue[i];
  }
  const recent = flushed.get(fingerprint);
  if (recent && now - recent.at < FOLD_WINDOW_MS) return recent.entry;
  if (recent) flushed.delete(fingerprint);
  return null;
}

/** Arm the flush timer, unless one is already set to fire sooner. */
function arm(delayMs: number): void {
  const at = Date.now() + delayMs;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => { timer = null; void flushNow(); }, delayMs);
  (timer as { unref?: () => void }).unref?.();   // telemetry never keeps the process alive
}

function backoffMs(): number {
  return Math.min(FLUSH_DELAY_MS * 2 ** Math.max(consecutiveFailures - 1, 0), MAX_BACKOFF_MS);
}

/**
 * Report one error. Synchronous, never throws. Repeats of the same (source, category,
 * digit-normalized message) fold into one row with a count instead of appending.
 */
export function reportError(e: ReportedError): void {
  try {
    const severity: ErrorSeverity = e.severity ?? 'error';
    const message = normalizeMessage(e);
    // Parity line, always: whoever is tailing logs sees exactly what the table gets.
    const line = `[errlog] ${severity} ${e.source}/${e.category}: ${message}`;
    if (severity === 'warn') console.warn(line);
    else console.error(line);

    const detail = buildDetail(e.detail, stackOf(e.err));
    if (e.trace !== false) {
      // The `ERROR:` prefix is what countTurnErrors (diagnosticTurnHistory.ts) counts, and
      // what the orchestration graph badges. record() is itself gated by DIAGNOSTICS_ENABLED.
      record({
        type: 'event',
        label: `${e.source}:${e.category}`,
        chatId: e.chatId,
        handle: e.handle,
        taskId: e.taskId,
        response: `ERROR: ${message}`,
        detail: detail ?? undefined,
      });
    }

    const now = Date.now();
    const fingerprint = fingerprintOf(e.source, e.category, message);
    const folded = foldTarget(fingerprint, now);
    if (folded) {
      folded.count++;
      folded.lastAt = now;
      return;
    }

    const entry: StoredErrorRow = {
      id: ++seq,
      severity,
      source: e.source,
      category: e.category,
      message,
      detail,
      chatId: e.chatId ?? null,
      handle: e.handle ?? null,
      taskId: e.taskId ?? null,
      fingerprint,
      count: 1,
      firstAt: now,
      lastAt: now,
      createdAt: now,
    };
    ring.push(entry);
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    queue.push(entry);
    // Hard cap: a wedged sink must not grow the heap without bound. Oldest goes first, and
    // the count of casualties is reported once the sink recovers.
    if (queue.length > QUEUE_CAP) dropped += queue.splice(0, queue.length - QUEUE_CAP).length;
    arm(queue.length >= EAGER_FLUSH_AT ? 0 : FLUSH_DELAY_MS);
  } catch (err) {
    console.error('[errlog] reportError failed (this error was NOT recorded)', err);
  }
}

function noteFlushed(batch: StoredErrorRow[], at: number): void {
  for (const row of batch) flushed.set(row.fingerprint, { entry: row, at });
  while (flushed.size > FLUSHED_LRU_CAP) {
    const oldest = flushed.keys().next().value;
    if (oldest === undefined) break;
    flushed.delete(oldest);
  }
}

function reportDrops(): void {
  if (!dropped) return;
  const n = dropped;
  dropped = 0;
  reportError({
    source: 'diagnostics',
    category: 'other',
    severity: 'warn',
    message: `error log dropped ${n} entries at the ${QUEUE_CAP}-entry queue cap`,
    detail: { dropped: n, queueCap: QUEUE_CAP },
    trace: false,
  });
}

/** Drain the queue in batches. One flush at a time; a failed batch is re-queued at the front. */
function flushNow(): Promise<void> {
  if (flushing) return flushing;
  if (!queue.length) return Promise.resolve();
  flushing = (async () => {
    try {
      while (queue.length) {
        const batch = queue.splice(0, BATCH_MAX);
        let ok = false;
        try {
          ok = await flushFn(batch);
        } catch (err) {
          // Recursion firewall: console only. Reporting a flush failure would enqueue it.
          console.error('[errlog] flush threw', err);
        }
        if (!ok) {
          queue.unshift(...batch);
          if (queue.length > QUEUE_CAP) dropped += queue.splice(0, queue.length - QUEUE_CAP).length;
          consecutiveFailures++;
          arm(backoffMs());
          return;
        }
        noteFlushed(batch, Date.now());
        consecutiveFailures = 0;
      }
    } finally {
      flushing = null;
    }
    // Recovered: say how much was lost while the sink was down (folds like any other report).
    reportDrops();
  })();
  return flushing;
}

/** Flush everything now; resolves on completion or when `timeoutMs` elapses, whichever is first. */
export async function flushErrorLog(timeoutMs = 3000): Promise<void> {
  const h: { t?: NodeJS.Timeout } = {};
  try {
    const drain = (async () => {
      // Bounded: stop as soon as a pass fails to shrink the queue — a wedged sink must not spin.
      while (queue.length) {
        const before = queue.length;
        await flushNow();
        if (queue.length >= before) return;
      }
    })();
    await Promise.race([drain, new Promise<void>(resolve => { h.t = setTimeout(resolve, timeoutMs); })]);
  } catch (err) {
    console.error('[errlog] flushErrorLog failed', err);
  } finally {
    if (h.t) clearTimeout(h.t);
  }
}

/**
 * Newest-first slice of the in-memory ring. Live entry objects (a later fold bumps a count you
 * already read — deliberate: the dashboard shows the current count).
 */
export function getRecentErrors(limit = 100): StoredErrorRow[] {
  const n = Math.min(Math.max(limit, 1), RING_CAP);
  return ring.slice(-n).reverse();
}

let handlersInstalled = false;
let exiting = false;   // re-entrancy latch: a crash DURING the shutdown flush must not loop

function onFatal(err: unknown, origin: string): void {
  if (exiting) { console.error(`[errlog] ${origin} while already exiting`, err); return; }
  exiting = true;
  reportError({ severity: 'fatal', source: 'process', category: 'process_crash', err, detail: { origin }, trace: false });
  // exit(1) preserves the container restart signal; the flush is what makes the crash visible
  // in the table afterwards.
  void flushErrorLog(2500).finally(() => process.exit(1));
}

/**
 * Turn process-level death into a durable row. Without this an uncaughtException or an
 * unhandled rejection leaves nothing behind but stdout, which the restart wipes.
 */
export function installProcessErrorHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('uncaughtException', (err, origin) => onFatal(err, origin || 'uncaughtException'));
  process.on('unhandledRejection', reason => onFatal(reason, 'unhandledRejection'));
  const shutdown = (signal: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`[errlog] ${signal} — flushing error log before exit`);
    void flushErrorLog(2000).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// One bridge covers all 110+ logDbError call sites, with no import cycle (db/client.ts holds a
// slot, this module fills it). trace:false: the diagnostics persistence path itself calls
// logDbError, so a trace event here could persist the turn that just failed to persist.
setDbErrorSink((scope, err) => reportError({ source: 'db', category: 'db_error', err, detail: { scope }, trace: false }));
startErrorLogPruneTimer();

export const _test = {
  /** Clean slate, including the default (real) flush fn. */
  reset(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    timerAt = 0;
    queue.length = 0;
    ring.length = 0;
    flushed.clear();
    dropped = 0;
    consecutiveFailures = 0;
    flushing = null;
    seq = 0;
    flushFn = insertErrorRows;
  },
  queueSize: (): number => queue.length,
  setFlushFn(fn: FlushFn): void { flushFn = fn; },
};

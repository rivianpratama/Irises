import { logDbError } from '../client.js';
import { stmt, getDb } from '../sqlite.js';

// Durable agent-wide error log. The WRITER is src/diagnostics/errorLog.ts — it normalizes,
// folds repeats by fingerprint and batches inserts; this module only maps rows to columns
// and reads them back.

const MAX_AGE_DAYS = Number(process.env.ERROR_LOG_MAX_AGE_DAYS || 30);
const KEEP_ROWS = Number(process.env.ERROR_LOG_KEEP_ROWS || 20_000);
const PRUNE_INTERVAL_MS = 6 * 3600_000;

/** One folded error occurrence. Timestamps are epoch ms (repo convention). */
export interface StoredErrorRow {
  id: number;
  severity: string;                             // 'warn' | 'error' | 'fatal'
  source: string;
  category: string;
  message: string;
  detail: Record<string, unknown> | null;
  chatId: string | null;
  handle: string | null;
  taskId: string | null;
  fingerprint: string;
  count: number;                                // occurrences folded into this row
  firstAt: number;
  lastAt: number;
  createdAt: number;
}

const COLUMNS = 'id, severity, source, category, message, detail_json, chat_id, handle, task_id, '
  + 'fingerprint, count, first_at, last_at, created_at';

/** Accepts epoch ms (repo convention) or an already-formatted ISO string. */
const toMsParam = (v: number | string | undefined): number | null =>
  v == null ? null : typeof v === 'number' ? v : Date.parse(v);

function rowToError(r: Record<string, unknown>): StoredErrorRow {
  let detail: Record<string, unknown> | null = null;
  if (typeof r.detail_json === 'string') {
    try { detail = JSON.parse(r.detail_json) as Record<string, unknown>; } catch { /* keep null */ }
  }
  return {
    id: Number(r.id ?? 0),
    severity: (r.severity as string) ?? 'error',
    source: (r.source as string) ?? 'other',
    category: (r.category as string) ?? 'other',
    message: (r.message as string) ?? '',
    detail,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    fingerprint: (r.fingerprint as string) ?? '',
    count: Number(r.count ?? 1),
    firstAt: Number(r.first_at ?? 0),
    lastAt: Number(r.last_at ?? 0),
    createdAt: Number(r.created_at ?? 0),
  };
}

/**
 * Batched insert of folded error rows — one transaction per flush. Returns false (never
 * throws) so the writer can re-queue the batch and back off.
 *
 * EXEMPT from logDbError by design — this is the RECURSION FIREWALL: logDbError feeds the
 * error sink whose flush path calls this, so reporting a failure here would enqueue the very
 * error that just failed to write, and every retry would enqueue another. Console only.
 */
export async function insertErrorRows(rows: StoredErrorRow[]): Promise<boolean> {
  if (!rows.length) return true;
  const db = getDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        stmt(
          `INSERT INTO error_log
             (severity, source, category, message, detail_json, chat_id, handle, task_id,
              fingerprint, count, first_at, last_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          r.severity, r.source, r.category, r.message,
          r.detail ? JSON.stringify(r.detail) : null,
          r.chatId, r.handle, r.taskId,
          r.fingerprint, r.count, r.firstAt, r.lastAt, Date.now(),
        );
      }
      db.exec('COMMIT');
    } catch (inner) {
      try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw inner;
    }
    return true;
  } catch (error) {
    console.error(`[db] insertErrorRows failed (${rows.length} row(s) held for retry)`, error);
    return false;
  }
}

export interface ListErrorsParams {
  source?: string;
  category?: string;
  severity?: string;
  since?: number | string;      // window start, inclusive
  before?: number | string;     // cursor: rows strictly older than this
  q?: string;                   // free text over `message`
  handle?: string;
  limit?: number;
}

/** Newest-first error rows matching the filter bar. */
export async function listErrors(params: ListErrorsParams): Promise<StoredErrorRow[]> {
  try {
    const where: string[] = ['1=1'];
    const args: Array<string | number> = [];
    if (params.source) { where.push('source = ?'); args.push(params.source); }
    if (params.category) { where.push('category = ?'); args.push(params.category); }
    if (params.severity) { where.push('severity = ?'); args.push(params.severity); }
    if (params.handle) { where.push('handle = ?'); args.push(params.handle); }
    const since = toMsParam(params.since);
    if (since != null) { where.push('created_at >= ?'); args.push(since); }
    const before = toMsParam(params.before);
    if (before != null) { where.push('created_at < ?'); args.push(before); }
    if (params.q) {
      // Escape LIKE wildcards in the user's text (same escaping as searchHistory).
      where.push("message LIKE ? ESCAPE '\\'");
      args.push(`%${params.q.replace(/[%_\\]/g, m => `\\${m}`)}%`);
    }
    const rows = stmt(
      `SELECT ${COLUMNS} FROM error_log WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`
    ).all(...args, Math.min(Math.max(params.limit ?? 100, 1), 200)) as unknown as Record<string, unknown>[];
    return rows.map(rowToError);
  } catch (error) {
    logDbError('listErrors', error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregates — plain SQL. `events` sums the folded `count` (occurrences: a
// single row can stand for thousands); `rows` counts the folded rows behind it.
// ---------------------------------------------------------------------------

/** One dimension bucket: e.g. dimension 'source', value 'ops'. */
export interface ErrorStatRow {
  dimension: string;    // 'source' | 'category' | 'severity'
  value: string;
  events: number;       // sum(count) — occurrences, not rows
  rows: number;         // folded rows
}

export interface TopErrorRow {
  fingerprint: string;
  severity: string;
  source: string;
  category: string;
  message: string;      // sample message for the fingerprint
  events: number;       // sum(count)
  lastAt: number;
}

export async function getErrorStats(since: number | string): Promise<ErrorStatRow[]> {
  try {
    const s = toMsParam(since) ?? 0;
    // Sort matches the old RPC contract exactly: dimension ascending, then events descending.
    const rows = stmt(
      `SELECT 'category' AS dimension, category AS value, coalesce(sum(count), 0) AS events, count(*) AS rows
         FROM error_log WHERE created_at >= ? GROUP BY category
       UNION ALL
       SELECT 'severity', severity, coalesce(sum(count), 0), count(*)
         FROM error_log WHERE created_at >= ? GROUP BY severity
       UNION ALL
       SELECT 'source', source, coalesce(sum(count), 0), count(*)
         FROM error_log WHERE created_at >= ? GROUP BY source
       ORDER BY 1, 3 DESC`
    ).all(s, s, s) as unknown as Record<string, unknown>[];
    return rows.map(r => ({
      dimension: (r.dimension as string) ?? '',
      value: (r.value as string) ?? '',
      events: Number(r.events ?? 0),
      rows: Number(r.rows ?? 0),
    }));
  } catch (error) {
    logDbError('getErrorStats', error);
    return [];
  }
}

export async function getTopErrors(since: number | string, limit = 15): Promise<TopErrorRow[]> {
  try {
    // SQLite's documented bare-column-with-max() behavior returns source/category/severity/
    // message from the max(last_at) row — the "newest sample" semantics the old RPC's
    // array_agg(… ORDER BY last_at DESC)[1] produced.
    const rows = stmt(
      `SELECT fingerprint, source, category, severity, message,
              coalesce(sum(count), 0) AS events, max(last_at) AS last_at
       FROM error_log
       WHERE created_at >= ?
       GROUP BY fingerprint
       ORDER BY events DESC, last_at DESC
       LIMIT ?`
    ).all(toMsParam(since) ?? 0, Math.min(Math.max(limit, 1), 50)) as unknown as Record<string, unknown>[];
    return rows.map(r => ({
      fingerprint: (r.fingerprint as string) ?? '',
      severity: (r.severity as string) ?? 'error',
      source: (r.source as string) ?? 'other',
      category: (r.category as string) ?? 'other',
      message: (r.message as string) ?? '',
      events: Number(r.events ?? 0),
      lastAt: Number(r.last_at ?? 0),
    }));
  } catch (error) {
    logDbError('getTopErrors', error);
    return [];
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Retention sweep: drop rows past max age, then trim to the newest N. */
export function startErrorLogPruneTimer(): void {
  if (pruneTimer) return;
  const prune = async () => {
    try {
      const res = stmt(
        `DELETE FROM error_log WHERE id IN (
           SELECT id FROM (
             SELECT id, row_number() OVER (ORDER BY created_at DESC) AS rn, created_at
             FROM error_log
           ) WHERE rn > ? OR created_at < ?
         )`
      ).run(KEEP_ROWS, Date.now() - MAX_AGE_DAYS * 24 * 3600_000);
      const n = Number(res.changes);
      if (n > 0) console.log(`[errlog] pruned ${n} error rows (keep ${KEEP_ROWS}, ${MAX_AGE_DAYS}d max)`);
    } catch (error) {
      logDbError('errorLogPrune', error);
    }
  };
  const boot = setTimeout(() => { void prune(); }, 60_000);
  (boot as { unref?: () => void }).unref?.();
  pruneTimer = setInterval(() => { void prune(); }, PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.();
}

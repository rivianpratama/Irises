import { getSupabase, logDbError } from '../client.js';

// Durable agent-wide error log (table + RPCs land in migration 0014; every function fails
// soft until it's applied). The WRITER is src/diagnostics/errorLog.ts — it normalizes, folds
// repeats by fingerprint and batches inserts; this module only maps rows to columns and reads
// them back. Everything no-ops (or returns empty) on the memory backend, where the writer's
// in-memory ring is the only store.

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

const COLUMNS = 'id, severity, source, category, message, detail, chat_id, handle, task_id, '
  + 'fingerprint, count, first_at, last_at, created_at';

const toMs = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : 0);
/** Accepts epoch ms (repo convention) or an already-formatted ISO string. */
const toIso = (v: number | string | undefined): string | null =>
  v == null ? null : typeof v === 'number' ? new Date(v).toISOString() : v;

function rowToError(r: Record<string, unknown>): StoredErrorRow {
  return {
    id: Number(r.id ?? 0),
    severity: (r.severity as string) ?? 'error',
    source: (r.source as string) ?? 'other',
    category: (r.category as string) ?? 'other',
    message: (r.message as string) ?? '',
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    fingerprint: (r.fingerprint as string) ?? '',
    count: Number(r.count ?? 1),
    firstAt: toMs(r.first_at),
    lastAt: toMs(r.last_at),
    createdAt: toMs(r.created_at),
  };
}

/**
 * Batched insert of folded error rows — one round trip per flush. Returns false (never
 * throws) so the writer can re-queue the batch and back off.
 *
 * EXEMPT from logDbError by design — this is the RECURSION FIREWALL: logDbError feeds the
 * error sink whose flush path calls this, so reporting a failure here would enqueue the very
 * error that just failed to write, and every retry would enqueue another. Console only.
 */
export async function insertErrorRows(rows: StoredErrorRow[]): Promise<boolean> {
  if (!rows.length) return true;
  const supabase = getSupabase();
  if (!supabase) return true;                   // memory backend: the writer's ring is the store
  try {
    const { error } = await supabase.from('error_log').insert(rows.map(r => ({
      severity: r.severity,
      source: r.source,
      category: r.category,
      message: r.message,
      detail: r.detail,
      chat_id: r.chatId,
      handle: r.handle,
      task_id: r.taskId,
      fingerprint: r.fingerprint,
      count: r.count,
      first_at: new Date(r.firstAt).toISOString(),
      last_at: new Date(r.lastAt).toISOString(),
      // created_at defaults in the table.
    })));
    if (error) throw error;
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

/** Newest-first error rows matching the filter bar. Returns [] on the memory backend. */
export async function listErrors(params: ListErrorsParams): Promise<StoredErrorRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    let q = supabase.from('error_log').select(COLUMNS);
    if (params.source) q = q.eq('source', params.source);
    if (params.category) q = q.eq('category', params.category);
    if (params.severity) q = q.eq('severity', params.severity);
    if (params.handle) q = q.eq('handle', params.handle);
    const since = toIso(params.since);
    if (since) q = q.gte('created_at', since);
    const before = toIso(params.before);
    if (before) q = q.lt('created_at', before);
    // Escape ILIKE wildcards in the user's text (same escaping as searchHistory).
    if (params.q) q = q.ilike('message', `%${params.q.replace(/[%_\\]/g, m => `\\${m}`)}%`);
    const { data, error } = await q
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(params.limit ?? 100, 1), 200));
    if (error) throw error;
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToError);
  } catch (error) {
    logDbError('listErrors', error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregates. supabase-js has no GROUP BY, so these are SQL RPCs (migration 0014).
// Mapped defensively — an RPC missing (schema not pushed yet) degrades to an empty
// summary strip rather than a broken tab.
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
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc('error_log_stats', { p_since: toIso(since) });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      dimension: (r.dimension as string) ?? '',
      value: (r.value as string) ?? '',
      events: Number(r.events ?? r.count ?? 0),
      rows: Number(r.rows ?? 0),
    }));
  } catch (error) {
    logDbError('getErrorStats', error);
    return [];
  }
}

export async function getTopErrors(since: number | string, limit = 15): Promise<TopErrorRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc('error_log_top', {
      p_since: toIso(since),
      p_limit: Math.min(Math.max(limit, 1), 50),
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      fingerprint: (r.fingerprint as string) ?? '',
      severity: (r.severity as string) ?? 'error',
      source: (r.source as string) ?? 'other',
      category: (r.category as string) ?? 'other',
      message: (r.message as string) ?? (r.sample_message as string) ?? '',
      events: Number(r.events ?? r.count ?? 0),
      lastAt: toMs(r.last_at),
    }));
  } catch (error) {
    logDbError('getTopErrors', error);
    return [];
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Retention sweep: drop rows past max age, then trim to the newest N. */
export function startErrorLogPruneTimer(): void {
  if (pruneTimer || !getSupabase()) return;
  const prune = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const { data, error } = await supabase.rpc('error_log_prune', {
        p_max_age_days: MAX_AGE_DAYS,
        p_keep_rows: KEEP_ROWS,
      });
      if (error) throw error;
      const n = Number(data ?? 0);
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

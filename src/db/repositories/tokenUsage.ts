import { getSupabase, logDbError } from '../client.js';
import type { LlmUsage } from '../../llm/types.js';

export interface TokenUsageRow {
  handle?: string;
  chatId?: string;
  taskId?: string;
  role: string;
  label?: string;
  provider: string;
  model: string;
  /** Absent on error rows and on providers that returned no usage — recorded as zeros. */
  usage?: LlmUsage;
  latencyMs?: number;
  /** The PRIMARY provider when this call was served by the fallback lane. */
  fallbackFrom?: string;
  status?: 'ok' | 'error';
  /** Capped error message when status='error'. */
  error?: string;
  /** The provider's raw stop/finish reason, verbatim ('end_turn' | 'max_tokens' | 'length' | …). */
  stopReason?: string;
  /** The cap actually SENT (req.maxTokens ?? MAX_TOKENS[role]) — a tiny per-call cap binding over
   *  the role ceiling is the usual cause of truncation, and invisible without this column. */
  maxTokensSent?: number;
  /** Provider-neutral truncation flag (isTruncatedStop). Truncated calls stay status='ok' — see
   *  migration 0015: llm_role_stats/llm_hourly count status in ('ok','error') explicitly. */
  truncated?: boolean;
}

/**
 * Record one LLM call in the durable call ledger (tokens + latency + status +
 * fallback lane). Fire-and-forget analytics: never throws, and no-ops when
 * Supabase isn't configured (nothing reads this on the in-memory path, so
 * there's no fallback store to keep).
 */
export async function recordTokenUsage(row: TokenUsageRow): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from('token_usage').insert({
      handle: row.handle ?? null,
      chat_id: row.chatId ?? null,
      task_id: row.taskId ?? null,
      role: row.role,
      label: row.label ?? null,
      provider: row.provider,
      model: row.model,
      input_tokens: row.usage?.inputTokens ?? 0,
      output_tokens: row.usage?.outputTokens ?? 0,
      cache_creation_input_tokens: row.usage?.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: row.usage?.cacheReadInputTokens ?? 0,
      // total_tokens is a generated column — don't insert it.
      latency_ms: row.latencyMs ?? null,
      fallback_from: row.fallbackFrom ?? null,
      status: row.status ?? 'ok',
      error: row.error ? row.error.slice(0, 500) : null,
      stop_reason: row.stopReason ?? null,
      max_tokens_sent: row.maxTokensSent ?? null,
      truncated: row.truncated ?? false,
    });
    if (error) throw error;
  } catch (error) {
    logDbError('recordTokenUsage', error);
  }
}

// ---------------------------------------------------------------------------
// Analytics readers (dashboard). Aggregates run in SQL RPCs — supabase-js has
// no GROUP BY, and pulling a whole window of rows into Node on every dashboard
// poll would be strictly worse than one indexed aggregate.
// ---------------------------------------------------------------------------

export interface LlmRoleStat {
  role: string;
  provider: string;
  model: string;
  calls: number;
  errors: number;
  fallbacks: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface LlmHourlyBucket {
  bucket: number;          // epoch ms of the hour
  calls: number;
  errors: number;
  fallbacks: number;
  totalTokens: number;
  avgLatencyMs: number | null;
}

export interface SlowLlmCall {
  createdAt: number;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  latencyMs: number;
  // Split tokens (not just the total) so the dashboard can price the call — input, output and
  // cache reads bill at different rates (see estimateCostUsd).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  handle: string | null;
  chatId: string | null;
}

export interface LlmErrorCall {
  createdAt: number;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  latencyMs: number | null;
  error: string | null;
  handle: string | null;
  chatId: string | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** One ledger row with everything the per-turn cost view needs (id for cross-query dedup). */
export interface UsageRowLite {
  id: number;
  taskId: string | null;
  chatId: string | null;
  handle: string | null;
  role: string;
  label: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  status: string;
  latencyMs: number | null;
  createdAt: number;   // epoch ms
}

const LITE_COLUMNS = 'id, task_id, chat_id, handle, role, label, provider, model, '
  + 'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, '
  + 'status, latency_ms, created_at';

function rowToLite(r: Record<string, unknown>): UsageRowLite {
  return {
    id: num(r.id),
    taskId: (r.task_id as string | null) ?? null,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    role: r.role as string,
    label: (r.label as string | null) ?? null,
    provider: r.provider as string,
    model: r.model as string,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_input_tokens),
    cacheCreationTokens: num(r.cache_creation_input_tokens),
    status: (r.status as string) ?? 'ok',
    latencyMs: numOrNull(r.latency_ms),
    createdAt: Date.parse(r.created_at as string),
  };
}

/**
 * Ledger rows inside a time window, scoped to a chat or (for chat-less turns like
 * the email Judge) to a handle with no chat_id — so a user's simultaneous chat
 * traffic can't leak into their email-turn costs. Uses the (chat_id, created_at)
 * / (handle, created_at) indexes. Returns [] on the memory backend.
 */
export async function listUsageInWindow(
  scope: { chatId?: string; handle?: string },
  sinceMs: number,
  untilMs: number,
): Promise<UsageRowLite[]> {
  const supabase = getSupabase();
  if (!supabase || (!scope.chatId && !scope.handle)) return [];
  try {
    let q = supabase.from('token_usage').select(LITE_COLUMNS);
    if (scope.chatId) q = q.eq('chat_id', scope.chatId);
    else q = q.eq('handle', scope.handle!).is('chat_id', null);
    const { data, error } = await q
      .gte('created_at', new Date(sinceMs).toISOString())
      .lte('created_at', new Date(untilMs).toISOString())
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw error;
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToLite);
  } catch (error) {
    logDbError('listUsageInWindow', error);
    return [];
  }
}

/**
 * Ledger rows for a set of delegated task ids — the exact-attribution leg. Late
 * Ops/Composer work lands outside any turn's time window; task_id is how it still
 * bills to the turn that delegated it. Returns [] on the memory backend.
 */
export async function listUsageForTasks(taskIds: string[]): Promise<UsageRowLite[]> {
  const supabase = getSupabase();
  if (!supabase || !taskIds.length) return [];
  try {
    const { data, error } = await supabase
      .from('token_usage')
      .select(LITE_COLUMNS)
      .in('task_id', taskIds.slice(0, 200))
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw error;
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToLite);
  } catch (error) {
    logDbError('listUsageForTasks', error);
    return [];
  }
}

export async function getLlmRoleStats(since: number, handle?: string): Promise<LlmRoleStat[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc('llm_role_stats', {
      p_since: new Date(since).toISOString(),
      p_handle: handle ?? null,
    });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      role: r.role as string,
      provider: r.provider as string,
      model: r.model as string,
      calls: num(r.calls),
      errors: num(r.errors),
      fallbacks: num(r.fallbacks),
      avgLatencyMs: numOrNull(r.avg_latency_ms),
      p95LatencyMs: numOrNull(r.p95_latency_ms),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_tokens),
      cacheCreationTokens: num(r.cache_creation_tokens),
      totalTokens: num(r.total_tokens),
    }));
  } catch (error) {
    logDbError('getLlmRoleStats', error);
    return [];
  }
}

export async function getLlmHourly(since: number): Promise<LlmHourlyBucket[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc('llm_hourly', { p_since: new Date(since).toISOString() });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      bucket: Date.parse(r.bucket as string),
      calls: num(r.calls),
      errors: num(r.errors),
      fallbacks: num(r.fallbacks),
      totalTokens: num(r.total_tokens),
      avgLatencyMs: numOrNull(r.avg_latency_ms),
    }));
  } catch (error) {
    logDbError('getLlmHourly', error);
    return [];
  }
}

export async function listSlowestCalls(since: number, limit = 20): Promise<SlowLlmCall[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('token_usage')
      .select('created_at, role, label, provider, model, latency_ms, input_tokens, output_tokens, cache_read_input_tokens, total_tokens, handle, chat_id')
      .eq('status', 'ok')
      .not('latency_ms', 'is', null)
      .gte('created_at', new Date(since).toISOString())
      .order('latency_ms', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      createdAt: Date.parse(r.created_at as string),
      role: r.role as string,
      label: (r.label as string | null) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      latencyMs: num(r.latency_ms),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      cacheReadTokens: num(r.cache_read_input_tokens),
      totalTokens: num(r.total_tokens),
      handle: (r.handle as string | null) ?? null,
      chatId: (r.chat_id as string | null) ?? null,
    }));
  } catch (error) {
    logDbError('listSlowestCalls', error);
    return [];
  }
}

/** Most recent FAILED LLM calls in the window (status='error'), newest first — the dashboard's
 *  error log. Errors are already durably recorded by recordLlmError (callLLM.ts); this just reads
 *  them back. Mirrors listSlowestCalls' shape/limits; returns [] on the memory backend. */
export async function listRecentErrors(since: number, limit = 20): Promise<LlmErrorCall[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('token_usage')
      .select('created_at, role, label, provider, model, latency_ms, error, handle, chat_id')
      .eq('status', 'error')
      .gte('created_at', new Date(since).toISOString())
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => ({
      createdAt: Date.parse(r.created_at as string),
      role: r.role as string,
      label: (r.label as string | null) ?? null,
      provider: r.provider as string,
      model: r.model as string,
      latencyMs: numOrNull(r.latency_ms),
      error: (r.error as string | null) ?? null,
      handle: (r.handle as string | null) ?? null,
      chatId: (r.chat_id as string | null) ?? null,
    }));
  } catch (error) {
    logDbError('listRecentErrors', error);
    return [];
  }
}

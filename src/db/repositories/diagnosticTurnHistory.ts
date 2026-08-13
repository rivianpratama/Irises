import { getSupabase, logDbError } from '../client.js';
import type { Turn } from '../../diagnostics/turns.js';

// Durable copy of EVERY orchestration turn (one row per turn, upserted on
// (key, turn_id)), powering the dashboard's turn history + search. Sits beside
// diagnostic_turns (latest-per-key), which stays the fast sidebar seed and the
// only place full `raw` wire payloads survive a restart — history rows strip
// `raw` from events by default (DIAGNOSTICS_PERSIST_RAW=true opts back in),
// since raw wire bodies are the MB-scale bulk of a turn. Fire-and-forget:
// diagnostics persistence must never break a reply, and every function no-ops
// (or returns empty) on the memory backend.

const PERSIST_RAW = process.env.DIAGNOSTICS_PERSIST_RAW === 'true';
const HISTORY_KEEP = Number(process.env.DIAGNOSTIC_HISTORY_KEEP || 50);
const HISTORY_MAX_AGE_DAYS = Number(process.env.DIAGNOSTIC_HISTORY_MAX_AGE_DAYS || 30);
const PRUNE_INTERVAL_MS = 6 * 3600_000;

export interface HistoryTurnMeta {
  key: string;
  turnId: string;
  chatId: string | null;
  handle: string | null;
  source: string;
  trigger: string | null;
  agents: string[];
  eventCount: number;
  errorCount: number;
  startedAt: number;   // epoch ms
  lastAt: number;      // epoch ms
}

export interface HistoryKeyRow extends HistoryTurnMeta {
  turnCount: number;
  userTurnCount: number;   // turns on this key whose source is 'user' (the picker gate)
}

const toMs = (ts: unknown): number => (typeof ts === 'string' ? Date.parse(ts) : 0);

function rowToMeta(r: Record<string, unknown>): HistoryTurnMeta {
  return {
    key: r.key as string,
    turnId: r.turn_id as string,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    source: (r.source as string) ?? 'system',
    trigger: (r.trigger as string | null) ?? null,
    agents: (r.agents as string[]) ?? [],
    eventCount: (r.event_count as number) ?? 0,
    errorCount: (r.error_count as number) ?? 0,
    startedAt: toMs(r.started_at),
    lastAt: toMs(r.last_at),
  };
}

/** Events whose response is an ERROR record or that mark a fidelity suppression. */
export function countTurnErrors(turn: Turn): number {
  let n = 0;
  for (const ev of turn.events) {
    if (typeof ev.response === 'string' && ev.response.startsWith('ERROR:')) n++;
    else if (ev.label?.endsWith(':fidelity-suppressed')) n++;
  }
  return n;
}

/** Clone a turn with the per-event raw wire payloads removed (the MB-scale bulk). */
export function stripRawForHistory(turn: Turn): Turn {
  if (PERSIST_RAW) return turn;
  return { ...turn, events: turn.events.map(ev => (ev.raw === undefined ? ev : { ...ev, raw: undefined })) };
}

export async function saveTurnToHistory(turn: Turn): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from('diagnostic_turn_history').upsert({
      key: turn.key,
      turn_id: turn.id,
      chat_id: turn.chatId ?? null,
      handle: turn.handle ?? null,
      source: turn.source,
      trigger: turn.trigger ?? null,
      agents: turn.agents,
      event_count: turn.eventCount,
      error_count: countTurnErrors(turn),
      started_at: new Date(turn.startedAt).toISOString(),
      last_at: new Date(turn.lastAt).toISOString(),
      turn: stripRawForHistory(turn) as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key,turn_id' });
    if (error) throw error;
  } catch (error) {
    logDbError('saveTurnToHistory', error);
  }
}

const META_COLUMNS = 'key, turn_id, chat_id, handle, source, trigger, agents, event_count, error_count, started_at, last_at';

/** Per-key (or per-handle) turn metas, newest first, cursor-paginated on lastAt. */
export async function listTurnHistory(opts: {
  key?: string; handle?: string; before?: number; limit?: number;
}): Promise<HistoryTurnMeta[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    let q = supabase.from('diagnostic_turn_history').select(META_COLUMNS);
    if (opts.key) q = q.eq('key', opts.key);
    if (opts.handle) q = q.eq('handle', opts.handle);
    if (opts.before) q = q.lt('last_at', new Date(opts.before).toISOString());
    const { data, error } = await q
      .order('last_at', { ascending: false })
      .limit(Math.min(Math.max(opts.limit ?? 30, 1), 100));
    if (error) throw error;
    return (data ?? []).map(r => rowToMeta(r as Record<string, unknown>));
  } catch (error) {
    logDbError('listTurnHistory', error);
    return [];
  }
}

/**
 * Newest N FULL turns for a key (turn jsonb, events raw-stripped at save time),
 * returned oldest-first. One query — avoids N× getHistoricalTurn round trips when
 * a view needs every turn's events (e.g. the per-turn cost chat view).
 */
export async function listFullTurnHistory(key: string, limit = 20): Promise<Turn[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('diagnostic_turn_history')
      .select('turn')
      .eq('key', key)
      .order('last_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 50));
    if (error) throw error;
    return ((data ?? []) as Array<{ turn: Turn | null }>)
      .map(r => r.turn)
      .filter((t): t is Turn => !!t && typeof t === 'object')
      .reverse();
  } catch (error) {
    logDbError('listFullTurnHistory', error);
    return [];
  }
}

/** One full historical turn (events raw-stripped at save time). */
export async function getHistoricalTurn(key: string, turnId: string): Promise<Turn | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('diagnostic_turn_history')
      .select('turn')
      .eq('key', key)
      .eq('turn_id', turnId)
      .maybeSingle();
    if (error) throw error;
    return (data?.turn as Turn | undefined) ?? null;
  } catch (error) {
    logDbError('getHistoricalTurn', error);
    return null;
  }
}

/** Latest turn meta per key + real per-key turn counts (sidebar seed after restart). */
export async function listHistoryKeys(limit = 300): Promise<HistoryKeyRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.rpc('diagnostic_history_keys', { p_limit: limit, p_offset: 0 });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(r => {
      const meta = rowToMeta(r);
      // The representative (latest) turn may be an automation/system event that carried
      // no handle/chatId; fall back to the partition-wide value so the chat still shows
      // under its user and scopes usage correctly. any_* are null pre-migration → no-op.
      return {
        ...meta,
        handle: meta.handle ?? ((r.any_handle as string | null) ?? null),
        chatId: meta.chatId ?? ((r.any_chat_id as string | null) ?? null),
        turnCount: Number(r.turn_count ?? 1),
        userTurnCount: Number(r.user_turn_count ?? (meta.source === 'user' ? 1 : 0)),
      };
    });
  } catch (error) {
    logDbError('listHistoryKeys', error);
    return [];
  }
}

export interface HistorySearchParams {
  q?: string;
  handle?: string;
  source?: string;
  agent?: string;
  since?: number;      // epoch ms window start
  deep?: boolean;      // scan turn payloads too (RPC)
  limit?: number;
}

/**
 * Search turn history. Fast path filters meta columns via separate .ilike()
 * queries merged in Node (avoids .or() filter-string escaping pitfalls);
 * deep=true additionally scans the turn jsonb text via RPC.
 */
export async function searchHistory(params: HistorySearchParams): Promise<HistoryTurnMeta[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const sinceIso = new Date(params.since ?? Date.now() - 7 * 86400_000).toISOString();
  try {
    if (params.deep && params.q) {
      const { data, error } = await supabase.rpc('diagnostic_history_search', {
        p_q: params.q,
        p_handle: params.handle ?? null,
        p_source: params.source ?? null,
        p_since: sinceIso,
        p_limit: limit,
      });
      if (error) throw error;
      let rows = ((data ?? []) as Record<string, unknown>[]).map(rowToMeta);
      if (params.agent) rows = rows.filter(r => r.agents.includes(params.agent!));
      return rows;
    }

    const base = () => {
      let q = supabase.from('diagnostic_turn_history')
        .select(META_COLUMNS)
        .gte('last_at', sinceIso);
      if (params.handle) q = q.eq('handle', params.handle);
      if (params.source) q = q.eq('source', params.source);
      if (params.agent) q = q.contains('agents', [params.agent]);
      return q.order('last_at', { ascending: false }).limit(limit);
    };

    if (!params.q) {
      const { data, error } = await base();
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map(rowToMeta);
    }

    // Escape ILIKE wildcards in the user's text; match trigger OR handle OR key.
    const pat = `%${params.q.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    const results = await Promise.all([
      base().ilike('trigger', pat),
      base().ilike('handle', pat),
      base().ilike('key', pat),
    ]);
    const seen = new Set<string>();
    const merged: HistoryTurnMeta[] = [];
    for (const { data, error } of results) {
      if (error) throw error;
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const meta = rowToMeta(r);
        const k = `${meta.key}\u0000${meta.turnId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(meta);
      }
    }
    return merged.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  } catch (error) {
    logDbError('searchHistory', error);
    return [];
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Retention sweep: keep the newest N turns per key, drop rows past max age. */
export function startHistoryPruneTimer(): void {
  if (pruneTimer || !getSupabase()) return;
  const prune = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const { data, error } = await supabase.rpc('diagnostic_history_prune', {
        p_keep: HISTORY_KEEP,
        p_max_age_days: HISTORY_MAX_AGE_DAYS,
      });
      if (error) throw error;
      const n = Number(data ?? 0);
      if (n > 0) console.log(`[diagnostics] pruned ${n} historical turns (keep ${HISTORY_KEEP}/key, ${HISTORY_MAX_AGE_DAYS}d max)`);
    } catch (error) {
      logDbError('diagnosticHistoryPrune', error);
    }
  };
  const boot = setTimeout(() => { void prune(); }, 60_000);
  (boot as { unref?: () => void }).unref?.();
  pruneTimer = setInterval(() => { void prune(); }, PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.();
}

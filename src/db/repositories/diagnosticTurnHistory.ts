import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { MAX_TURN_JSON_CHARS } from './diagnosticTurns.js';
import type { Turn } from '../../diagnostics/turns.js';

// Durable copy of EVERY orchestration turn (one row per turn, upserted on
// (key, turn_id)), powering the dashboard's turn history + search. Sits beside
// diagnostic_turns (latest-per-key), which stays the fast sidebar seed and the
// only place full `raw` wire payloads survive a restart — history rows strip
// `raw` from events by default (DIAGNOSTICS_PERSIST_RAW=true opts back in),
// since raw wire bodies are the MB-scale bulk of a turn. Fire-and-forget:
// diagnostics persistence must never break a reply.

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

function rowToMeta(r: Record<string, unknown>): HistoryTurnMeta {
  let agents: string[] = [];
  if (typeof r.agents_json === 'string') {
    try { agents = JSON.parse(r.agents_json) as string[]; } catch { /* keep [] */ }
  }
  return {
    key: r.key as string,
    turnId: r.turn_id as string,
    chatId: (r.chat_id as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    source: (r.source as string) ?? 'system',
    trigger: (r.trigger as string | null) ?? null,
    agents,
    eventCount: Number(r.event_count ?? 0),
    errorCount: Number(r.error_count ?? 0),
    startedAt: Number(r.started_at ?? 0),
    lastAt: Number(r.last_at ?? 0),
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
  try {
    const json = JSON.stringify(stripRawForHistory(turn));
    if (json.length > MAX_TURN_JSON_CHARS) {
      console.warn(`[diagnostics] skipping history persist for ${turn.key}/${turn.id} — ${json.length} chars exceeds the ${MAX_TURN_JSON_CHARS} write guard`);
      return;
    }
    stmt(
      `INSERT INTO diagnostic_turn_history
         (key, turn_id, chat_id, handle, source, "trigger", agents_json,
          event_count, error_count, started_at, last_at, turn_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, turn_id) DO UPDATE SET
         chat_id = excluded.chat_id, handle = excluded.handle, source = excluded.source,
         "trigger" = excluded."trigger", agents_json = excluded.agents_json,
         event_count = excluded.event_count, error_count = excluded.error_count,
         started_at = excluded.started_at, last_at = excluded.last_at,
         turn_json = excluded.turn_json, updated_at = excluded.updated_at`
    ).run(
      turn.key,
      turn.id,
      turn.chatId ?? null,
      turn.handle ?? null,
      turn.source,
      turn.trigger ?? null,
      JSON.stringify(turn.agents),
      turn.eventCount,
      countTurnErrors(turn),
      turn.startedAt,
      turn.lastAt,
      json,
      Date.now(),
    );
  } catch (error) {
    logDbError('saveTurnToHistory', error);
  }
}

const META_COLUMNS = 'key, turn_id, chat_id, handle, source, "trigger", agents_json, event_count, error_count, started_at, last_at';

/** Per-key (or per-handle) turn metas, newest first, cursor-paginated on lastAt. */
export async function listTurnHistory(opts: {
  key?: string; handle?: string; before?: number; limit?: number;
}): Promise<HistoryTurnMeta[]> {
  try {
    const where: string[] = ['1=1'];
    const args: Array<string | number> = [];
    if (opts.key) { where.push('key = ?'); args.push(opts.key); }
    if (opts.handle) { where.push('handle = ?'); args.push(opts.handle); }
    if (opts.before) { where.push('last_at < ?'); args.push(opts.before); }
    const rows = stmt(
      `SELECT ${META_COLUMNS} FROM diagnostic_turn_history
       WHERE ${where.join(' AND ')} ORDER BY last_at DESC LIMIT ?`
    ).all(...args, Math.min(Math.max(opts.limit ?? 30, 1), 100)) as unknown as Record<string, unknown>[];
    return rows.map(rowToMeta);
  } catch (error) {
    logDbError('listTurnHistory', error);
    return [];
  }
}

/**
 * Newest N FULL turns for a key (turn payload, events raw-stripped at save time),
 * returned oldest-first. One query — avoids N× getHistoricalTurn round trips when
 * a view needs every turn's events (e.g. the per-turn cost chat view).
 */
export async function listFullTurnHistory(key: string, limit = 20): Promise<Turn[]> {
  try {
    const rows = stmt(
      'SELECT turn_json FROM diagnostic_turn_history WHERE key = ? ORDER BY last_at DESC LIMIT ?'
    ).all(key, Math.min(Math.max(limit, 1), 50)) as unknown as Array<{ turn_json: string }>;
    const turns: Turn[] = [];
    for (const r of rows) {
      try { turns.push(JSON.parse(r.turn_json) as Turn); } catch { /* skip a corrupt payload */ }
    }
    return turns.reverse();
  } catch (error) {
    logDbError('listFullTurnHistory', error);
    return [];
  }
}

/** One full historical turn (events raw-stripped at save time). */
export async function getHistoricalTurn(key: string, turnId: string): Promise<Turn | null> {
  try {
    const row = stmt(
      'SELECT turn_json FROM diagnostic_turn_history WHERE key = ? AND turn_id = ?'
    ).get(key, turnId) as { turn_json: string } | undefined;
    return row ? (JSON.parse(row.turn_json) as Turn) : null;
  } catch (error) {
    logDbError('getHistoricalTurn', error);
    return null;
  }
}

/** Latest turn meta per key + real per-key turn counts (sidebar seed after restart). */
export async function listHistoryKeys(limit = 300): Promise<HistoryKeyRow[]> {
  try {
    const rows = stmt(
      `SELECT * FROM (
         SELECT ${META_COLUMNS},
                row_number() OVER (PARTITION BY key ORDER BY last_at DESC)                 AS rn,
                count(*) OVER (PARTITION BY key)                                            AS turn_count,
                count(*) FILTER (WHERE source = 'user') OVER (PARTITION BY key)             AS user_turn_count,
                max(handle) OVER (PARTITION BY key)                                         AS any_handle,
                max(chat_id) OVER (PARTITION BY key)                                        AS any_chat_id
         FROM diagnostic_turn_history
       ) WHERE rn = 1
       ORDER BY last_at DESC LIMIT ?`
    ).all(Math.min(Math.max(limit, 1), 1000)) as unknown as Record<string, unknown>[];
    return rows.map(r => {
      const meta = rowToMeta(r);
      // The representative (latest) turn may be an automation/system event that carried
      // no handle/chatId; fall back to the partition-wide value so the chat still shows
      // under its user and scopes usage correctly.
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
  deep?: boolean;      // scan turn payloads too
  limit?: number;
}

/**
 * Search turn history. Fast path matches the meta columns (trigger/handle/key);
 * deep=true additionally scans the persisted turn payload text. SQLite LIKE is
 * ASCII-case-insensitive (the old ILIKE also folded unicode case) — close enough
 * for a debug search.
 */
export async function searchHistory(params: HistorySearchParams): Promise<HistoryTurnMeta[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const since = params.since ?? Date.now() - 7 * 86400_000;
  try {
    const where: string[] = ['last_at >= ?'];
    const args: Array<string | number> = [since];
    if (params.handle) { where.push('handle = ?'); args.push(params.handle); }
    if (params.source) { where.push('source = ?'); args.push(params.source); }
    let postFilterAgent = false;
    if (params.agent) {
      if (params.deep && params.q) {
        postFilterAgent = true;  // parity with the old RPC path, which post-filtered
      } else {
        where.push('EXISTS (SELECT 1 FROM json_each(agents_json) WHERE value = ?)');
        args.push(params.agent);
      }
    }
    if (params.q) {
      const pat = `%${params.q.replace(/[%_\\]/g, m => `\\${m}`)}%`;
      if (params.deep) {
        where.push('("trigger" LIKE ? ESCAPE \'\\\' OR turn_json LIKE ? ESCAPE \'\\\')');
        args.push(pat, pat);
      } else {
        where.push('("trigger" LIKE ? ESCAPE \'\\\' OR handle LIKE ? ESCAPE \'\\\' OR key LIKE ? ESCAPE \'\\\')');
        args.push(pat, pat, pat);
      }
    }
    const rows = stmt(
      `SELECT ${META_COLUMNS} FROM diagnostic_turn_history
       WHERE ${where.join(' AND ')} ORDER BY last_at DESC LIMIT ?`
    ).all(...args, limit) as unknown as Record<string, unknown>[];
    let metas = rows.map(rowToMeta);
    if (postFilterAgent) metas = metas.filter(r => r.agents.includes(params.agent!));
    return metas;
  } catch (error) {
    logDbError('searchHistory', error);
    return [];
  }
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Retention sweep: keep the newest N turns per key, drop rows past max age. */
export function startHistoryPruneTimer(): void {
  if (pruneTimer) return;
  const prune = async () => {
    try {
      const res = stmt(
        `DELETE FROM diagnostic_turn_history WHERE id IN (
           SELECT id FROM (
             SELECT id, row_number() OVER (PARTITION BY key ORDER BY last_at DESC) AS rn, last_at
             FROM diagnostic_turn_history
           ) WHERE rn > ? OR last_at < ?
         )`
      ).run(HISTORY_KEEP, Date.now() - HISTORY_MAX_AGE_DAYS * 24 * 3600_000);
      const n = Number(res.changes);
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

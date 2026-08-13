import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import type { Turn } from '../../diagnostics/turns.js';

// Durable copy of the MOST RECENT orchestration turn per chat / per user, so the
// /dashboard graph still has something to show after a restart or redeploy (the live
// turn store is in-memory). One row per key, upserted on write. Fire-and-forget:
// diagnostics persistence must never break a reply.

// node:sqlite statements run synchronously on the event loop — refuse to persist a
// pathological turn payload rather than stall a reply behind a multi-MB write.
export const MAX_TURN_JSON_CHARS = 2_000_000;

export interface PersistedTurnRow {
  key: string;
  chatId: string | null;
  handle: string | null;
  turn: Turn;
  updatedAt: string;
}

export async function saveLatestTurn(turn: Turn): Promise<void> {
  try {
    const json = JSON.stringify(turn);
    if (json.length > MAX_TURN_JSON_CHARS) {
      console.warn(`[diagnostics] skipping latest-turn persist for ${turn.key} — ${json.length} chars exceeds the ${MAX_TURN_JSON_CHARS} write guard`);
      return;
    }
    stmt(
      `INSERT INTO diagnostic_turns (key, chat_id, handle, source, "trigger", started_at, last_at, turn_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         chat_id = excluded.chat_id, handle = excluded.handle, source = excluded.source,
         "trigger" = excluded."trigger", started_at = excluded.started_at,
         last_at = excluded.last_at, turn_json = excluded.turn_json, updated_at = excluded.updated_at`
    ).run(
      turn.key,
      turn.chatId ?? null,
      turn.handle ?? null,
      turn.source,
      turn.trigger ?? null,
      turn.startedAt,
      turn.lastAt,
      json,
      Date.now(),
    );
  } catch (error) {
    logDbError('saveLatestTurn', error);
  }
}

/** All persisted latest-turns, newest first. Used to seed the dashboard after a restart. */
export async function listPersistedTurns(): Promise<PersistedTurnRow[]> {
  try {
    const rows = stmt(
      'SELECT key, chat_id, handle, turn_json, updated_at FROM diagnostic_turns ORDER BY last_at DESC LIMIT 200'
    ).all() as unknown as Array<{ key: string; chat_id: string | null; handle: string | null; turn_json: string; updated_at: number }>;
    const out: PersistedTurnRow[] = [];
    for (const r of rows) {
      try {
        out.push({
          key: r.key,
          chatId: r.chat_id ?? null,
          handle: r.handle ?? null,
          turn: JSON.parse(r.turn_json) as Turn,
          updatedAt: new Date(r.updated_at).toISOString(),
        });
      } catch { /* one corrupt payload must not sink the whole seed */ }
    }
    return out;
  } catch (error) {
    logDbError('listPersistedTurns', error);
    return [];
  }
}

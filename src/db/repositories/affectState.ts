// Per-chat affect memory: the last emitted+computed status plus a short mood trail, so mood has
// continuity across turns and the self-recursive meta-prompt carries forward (the Martins-Crib
// pattern, where each turn's meta_prompt is re-injected into the next). Keyed by chat_id — mood is
// Irises's felt state WITH this person, while cycle/circadian are global and recomputed each turn.
//
// The convo turn is already serialized per chat (withChatLock in the send path), so the
// read→push→write here needs no extra lock. Timestamps are epoch-ms, app clock (schema convention).

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { pushMood, type AffectState, type AffectStatus, type MoodPoint } from '../../persona/status.js';

type Row = { chat_id: string; status_json: string; mood_history_json: string; updated_at: number };

const EMPTY: AffectState = { moodHistory: [] };

/** The stored affect state for a chat, or an empty state when none exists / on error. */
export async function getAffectState(chatId: string): Promise<AffectState> {
  try {
    const r = stmt(
      'SELECT chat_id, status_json, mood_history_json, updated_at FROM affect_state WHERE chat_id = ?'
    ).get(chatId) as Row | undefined;
    if (!r) return { moodHistory: [] };
    let last: AffectStatus | undefined;
    let moodHistory: MoodPoint[] = [];
    try { last = JSON.parse(r.status_json) as AffectStatus; } catch { /* keep undefined */ }
    try { moodHistory = JSON.parse(r.mood_history_json) as MoodPoint[]; } catch { /* keep [] */ }
    return { last, moodHistory: Array.isArray(moodHistory) ? moodHistory : [] };
  } catch (error) {
    logDbError('getAffectState', error);
    return { moodHistory: [] };
  }
}

/** Upsert this turn's status as the new `last`, pushing its mood onto the capped trail. */
export async function saveAffectState(chatId: string, status: AffectStatus): Promise<void> {
  try {
    const prior = await getAffectState(chatId);
    const moodHistory = pushMood(prior.moodHistory, status);
    stmt(
      `INSERT INTO affect_state (chat_id, status_json, mood_history_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         status_json = excluded.status_json,
         mood_history_json = excluded.mood_history_json,
         updated_at = excluded.updated_at`
    ).run(chatId, JSON.stringify(status), JSON.stringify(moodHistory), status.at);
  } catch (error) {
    logDbError('saveAffectState', error);
  }
}

/** Test/forget seam. */
export async function clearAffectState(chatId: string): Promise<void> {
  try {
    stmt('DELETE FROM affect_state WHERE chat_id = ?').run(chatId);
  } catch (error) {
    logDbError('clearAffectState', error);
  }
}

export { EMPTY as EMPTY_AFFECT_STATE };

import { getSupabase, logDbError } from '../client.js';
import type { Turn } from '../../diagnostics/turns.js';

// Durable copy of the MOST RECENT orchestration turn per chat / per user, so the
// /dashboard graph still has something to show after a restart or redeploy (the live
// turn store is in-memory). One row per key, upserted on write. Fire-and-forget:
// diagnostics persistence must never break a reply, and it no-ops on the memory
// backend (the live store already holds everything there).

export interface PersistedTurnRow {
  key: string;
  chatId: string | null;
  handle: string | null;
  turn: Turn;
  updatedAt: string;
}

export async function saveLatestTurn(turn: Turn): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from('diagnostic_turns').upsert({
      key: turn.key,
      chat_id: turn.chatId ?? null,
      handle: turn.handle ?? null,
      source: turn.source,
      trigger: turn.trigger ?? null,
      started_at: new Date(turn.startedAt).toISOString(),
      last_at: new Date(turn.lastAt).toISOString(),
      turn: turn as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    if (error) throw error;
  } catch (error) {
    logDbError('saveLatestTurn', error);
  }
}

/** All persisted latest-turns, newest first. Used to seed the dashboard after a restart. */
export async function listPersistedTurns(): Promise<PersistedTurnRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('diagnostic_turns')
      .select('key, chat_id, handle, turn, updated_at')
      .order('last_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []).map(r => ({
      key: r.key as string,
      chatId: (r.chat_id as string | null) ?? null,
      handle: (r.handle as string | null) ?? null,
      turn: r.turn as Turn,
      updatedAt: r.updated_at as string,
    }));
  } catch (error) {
    logDbError('listPersistedTurns', error);
    return [];
  }
}

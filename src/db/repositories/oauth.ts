import { randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ConsumedState {
  handle: string;
  chatId: string;
  deferredTask: Record<string, unknown> | null;
}

export async function createOAuthState(
  handle: string,
  chatId: string,
  deferredTask?: Record<string, unknown>,
): Promise<string> {
  const state = randomUUID();
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('oauth_state').insert({
        state, handle, chat_id: chatId, deferred_task: deferredTask ?? null, expires_at: expiresAt,
      });
      if (error) throw error;
      return state;
    } catch (error) {
      logDbError('createOAuthState', error);
    }
  }
  mem.oauthState.set(state, { state, handle, chatId, deferredTask: deferredTask ?? null, expiresAt, consumedAt: null });
  return state;
}

/** Single-use consume: returns null if missing, expired, or already consumed. */
export async function consumeOAuthState(state: string): Promise<ConsumedState | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase.from('oauth_state')
        .update({ consumed_at: nowIso })
        .eq('state', state)
        .is('consumed_at', null)
        .gt('expires_at', nowIso)
        .select('handle, chat_id, deferred_task')
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { handle: data.handle, chatId: data.chat_id, deferredTask: data.deferred_task ?? null };
    } catch (error) {
      logDbError('consumeOAuthState', error);
    }
  }
  const row = mem.oauthState.get(state);
  if (!row || row.consumedAt || Date.parse(row.expiresAt) <= Date.now()) return null;
  mem.oauthState.set(state, { ...row, consumedAt: new Date().toISOString() });
  return { handle: row.handle, chatId: row.chatId, deferredTask: row.deferredTask };
}

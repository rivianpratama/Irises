import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import type { StoredMessage } from '../types.js';

export type { StoredMessage } from '../types.js';

// Conversation history retention. Bumped 1h → 24h → 7d: the live context windows still
// slice to the last ~10-20 messages (cost unchanged), but keeping a week lets the
// recall path (searchMessages) answer "what did we say about X the other day" and gives
// deal-relevant facts a wide window to be extracted into the relational tables.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 40;

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, handle, created_at')
        .eq('chat_id', chatId)
        .gt('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(MAX_MESSAGES);
      if (error) throw error;
      return (data ?? [])
        .reverse()
        .map(r => ({
          role: r.role,
          content: r.content,
          ...(r.handle ? { handle: r.handle } : {}),
          // DB-clock timestamp (Postgres now()). Lets callers find messages sent WHILE a
          // background task ran. Compare ONLY against other DB-clock values, never Date.now().
          ...(r.created_at ? { at: Date.parse(r.created_at) } : {}),
        }));
    } catch (error) {
      logDbError('getConversation', error);
    }
  }
  return memGet(chatId);
}

/**
 * Append a message and return the canonical stored timestamp (epoch ms): the DB's own
 * created_at on Supabase, or Date.now() in memory. Callers that need to know "what did the
 * user say AFTER this point" stamp it from this return value, so the later comparison stays
 * on a single clock (never app-clock vs DB-clock). Existing callers can ignore the return.
 */
export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  handle?: string,
): Promise<number> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + RETENTION_MS).toISOString();
      const { error: chatErr } = await supabase
        .from('chats')
        .upsert({ chat_id: chatId, last_active: now, expires_at: expires }, { onConflict: 'chat_id' });
      if (chatErr) throw chatErr;
      const { data, error: msgErr } = await supabase
        .from('messages')
        .insert({ chat_id: chatId, role, content, handle: handle ?? null })
        .select('created_at')
        .single();
      if (msgErr) throw msgErr;
      return data?.created_at ? Date.parse(data.created_at) : Date.now();
    } catch (error) {
      logDbError('addMessage', error);
    }
  }
  return memAdd(chatId, role, content, handle);
}

/**
 * Keyword recall over the stored history window (newest first, returned oldest-first).
 * Powers "what did we say about X the other day" — beyond this window, durable facts
 * live in the dossier / important notes, not the chat log.
 */
export async function searchMessages(chatId: string, keyword: string, limit = 12): Promise<StoredMessage[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const supabase = getSupabase();
  if (supabase) {
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
      const escaped = kw.replace(/[%_]/g, '\\$&');
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, handle, created_at')
        .eq('chat_id', chatId)
        .gt('created_at', cutoff)
        .ilike('content', `%${escaped}%`)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? [])
        .reverse()
        .map(r => ({
          role: r.role,
          content: r.content,
          ...(r.handle ? { handle: r.handle } : {}),
          ...(r.created_at ? { at: Date.parse(r.created_at) } : {}),
        }));
    } catch (error) {
      logDbError('searchMessages', error);
    }
  }
  const cutoffMs = Date.now() - RETENTION_MS;
  const lower = kw.toLowerCase();
  return (mem.messages.get(chatId) ?? [])
    .filter(m => m.at > cutoffMs && m.content.content.toLowerCase().includes(lower))
    .slice(-limit)
    .map(m => ({ ...m.content, at: m.at }));
}

export async function clearConversation(chatId: string): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      // ON DELETE CASCADE removes the messages.
      const { error } = await supabase.from('chats').delete().eq('chat_id', chatId);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('clearConversation', error);
    }
  }
  mem.messages.delete(chatId);
}

export async function clearAllConversations(): Promise<void> {
  mem.messages.clear();
  console.log('[conversation] clearAllConversations: in-memory store cleared (DynamoDB TTL no longer applies)');
}

// --- in-memory implementations -------------------------------------------
function memGet(chatId: string): StoredMessage[] {
  const cutoff = Date.now() - RETENTION_MS;
  const all = (mem.messages.get(chatId) ?? []).filter(m => m.at > cutoff);
  // Surface the in-memory store's own `at` (app-clock) so callers get a single-clock timestamp.
  return all.slice(-MAX_MESSAGES).map(m => ({ ...m.content, at: m.at }));
}

function memAdd(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): number {
  const list = mem.messages.get(chatId) ?? [];
  const msg: StoredMessage = { role, content };
  if (handle) msg.handle = handle;
  const at = Date.now();
  list.push({ content: msg, at });
  mem.messages.set(chatId, list.slice(-MAX_MESSAGES));
  return at;
}

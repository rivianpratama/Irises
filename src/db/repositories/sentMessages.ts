import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';

// How long a sent bubble stays resolvable for a reply (matches the migration's 7-day expiry;
// also bounds the in-memory fallback).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remember a bubble Irises just sent, keyed by its Linq message_id. `replyRootId`, when the bubble
 * was sent threaded to an earlier message, is the inbound id it anchored to — so a later reply that
 * iMessage collapses to that root can be mapped back to this answer bubble. Fire-and-forget; never throws.
 */
export async function recordSentBubble(chatId: string, messageId: string, content: string, replyRootId?: string): Promise<void> {
  if (!messageId || !content) return;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase
        .from('sent_messages')
        .upsert({ message_id: messageId, chat_id: chatId, content, reply_root_id: replyRootId ?? null }, { onConflict: 'message_id' });
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('recordSentBubble', error);
    }
  }
  mem.sentMessages.set(messageId, { chatId, content, at: Date.now(), replyRootId });
}

/**
 * Resolve an inbound reply_to.message_id back to the bubble text Irises sent, or null if
 * unknown/expired. Scoped to the chat the reply arrived in: a message_id from another chat
 * (id collision, forged webhook body) must never inject that chat's text into this prompt.
 */
export async function lookupSentBubble(messageId: string, chatId: string): Promise<string | null> {
  if (!messageId || !chatId) return null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('sent_messages')
        .select('content')
        .eq('message_id', messageId)
        .eq('chat_id', chatId)
        .gt('created_at', cutoff)
        .maybeSingle();
      if (error) throw error;
      return data?.content ?? null;
    } catch (error) {
      logDbError('lookupSentBubble', error);
    }
  }
  const hit = mem.sentMessages.get(messageId);
  if (hit && hit.chatId === chatId && Date.now() - hit.at <= TTL_MS) return hit.content;
  return null;
}

/**
 * Irises's recorded answer bubbles that were sent threaded to `rootId` in this chat, in send order,
 * capped. Used when an inbound reply collapses to the thread ROOT (the user's own message): those
 * are the bubbles that actually answered it, and almost certainly what the user tapped. Chat-scoped
 * for the same reason as lookupSentBubble.
 */
export async function listSentBubblesByReplyRoot(rootId: string, chatId: string, limit = 6): Promise<string[]> {
  if (!rootId || !chatId) return [];
  const supabase = getSupabase();
  if (supabase) {
    try {
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('sent_messages')
        .select('content')
        .eq('reply_root_id', rootId)
        .eq('chat_id', chatId)
        .gt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(r => r.content as string);
    } catch (error) {
      logDbError('listSentBubblesByReplyRoot', error);
    }
  }
  const now = Date.now();
  return [...mem.sentMessages.values()]
    .filter(v => v.chatId === chatId && v.replyRootId === rootId && now - v.at <= TTL_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(v => v.content);
}

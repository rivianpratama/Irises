import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';

// Index of the user's OWN inbound text-bearing messages, keyed by Linq message_id.
// iMessage collapses a tapped reply to the THREAD ROOT, which — for a reply tapped
// on one of Irises's Ops answers (those are threaded to the originating question) —
// is the user's own opening message. This lets that id resolve back to the text
// that opened the exchange. Sibling to sent_messages (never merged into it: keeping
// user-authored rows out of the Irises-bubble lookup avoids any chance of injected
// text satisfying a "what did Irises say" resolution). Ephemeral (~7 days).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Soft cap for the in-memory twin (Supabase enforces its own TTL). Prune on write —
// unlike mem.sentMessages, which only TTL-checks on read and grows unbounded.
const MEM_CAP = 2000;

function pruneMem(): void {
  const now = Date.now();
  for (const [id, v] of mem.inboundMessages) {
    if (now - v.at > TTL_MS) mem.inboundMessages.delete(id);
  }
  // Map preserves insertion order — drop the oldest entries past the cap.
  while (mem.inboundMessages.size > MEM_CAP) {
    const oldest = mem.inboundMessages.keys().next().value;
    if (oldest === undefined) break;
    mem.inboundMessages.delete(oldest);
  }
}

/** Remember a text-bearing message the user sent, keyed by its Linq message_id. Fire-and-forget; never throws. */
export async function recordInboundMessage(chatId: string, messageId: string, content: string, senderHandle?: string): Promise<void> {
  if (!messageId || !content) return;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase
        .from('inbound_messages')
        .upsert({ message_id: messageId, chat_id: chatId, content, sender_handle: senderHandle ?? null }, { onConflict: 'message_id' });
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('recordInboundMessage', error);
    }
  }
  mem.inboundMessages.set(messageId, { chatId, content, senderHandle, at: Date.now() });
  pruneMem();
}

/**
 * Resolve an inbound reply_to.message_id back to the USER'S message text (+ sender), or null if
 * unknown/expired. Scoped to the chat the reply arrived in — a message_id from another chat (id
 * collision, forged webhook body) must never inject that chat's text into this prompt.
 */
export async function lookupInboundMessage(messageId: string, chatId: string): Promise<{ content: string; senderHandle?: string } | null> {
  if (!messageId || !chatId) return null;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('inbound_messages')
        .select('content, sender_handle')
        .eq('message_id', messageId)
        .eq('chat_id', chatId)
        .gt('created_at', cutoff)
        .maybeSingle();
      if (error) throw error;
      return data ? { content: data.content as string, senderHandle: (data.sender_handle as string | null) ?? undefined } : null;
    } catch (error) {
      logDbError('lookupInboundMessage', error);
    }
  }
  const hit = mem.inboundMessages.get(messageId);
  if (hit && hit.chatId === chatId && Date.now() - hit.at <= TTL_MS) return { content: hit.content, senderHandle: hit.senderHandle };
  return null;
}

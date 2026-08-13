import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

// How long a sent bubble stays resolvable for a reply. Reads filter on created_at;
// the retention sweep hard-deletes expired rows daily.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remember a bubble Irises just sent, keyed by its transport message_id. `replyRootId`, when the bubble
 * was sent threaded to an earlier message, is the inbound id it anchored to — so a later reply that
 * some transports collapse to that root can be mapped back to this answer bubble. Fire-and-forget; never throws.
 */
export async function recordSentBubble(chatId: string, messageId: string, content: string, replyRootId?: string): Promise<void> {
  if (!messageId || !content) return;
  try {
    stmt(
      `INSERT INTO sent_messages (message_id, chat_id, content, reply_root_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         chat_id = excluded.chat_id, content = excluded.content,
         reply_root_id = excluded.reply_root_id, created_at = excluded.created_at`
    ).run(messageId, chatId, content, replyRootId ?? null, Date.now());
  } catch (error) {
    logDbError('recordSentBubble', error);
  }
}

/**
 * Resolve an inbound reply_to.message_id back to the bubble text Irises sent, or null if
 * unknown/expired. Scoped to the chat the reply arrived in: a message_id from another chat
 * (id collision, forged webhook body) must never inject that chat's text into this prompt.
 */
export async function lookupSentBubble(messageId: string, chatId: string): Promise<string | null> {
  if (!messageId || !chatId) return null;
  try {
    const row = stmt(
      'SELECT content FROM sent_messages WHERE message_id = ? AND chat_id = ? AND created_at > ?'
    ).get(messageId, chatId, Date.now() - TTL_MS) as { content: string } | undefined;
    return row?.content ?? null;
  } catch (error) {
    logDbError('lookupSentBubble', error);
    return null;
  }
}

/**
 * Irises's recorded answer bubbles that were sent threaded to `rootId` in this chat, in send order,
 * capped. Used when an inbound reply collapses to the thread ROOT (the user's own message): those
 * are the bubbles that actually answered it, and almost certainly what the user tapped. Chat-scoped
 * for the same reason as lookupSentBubble.
 */
export async function listSentBubblesByReplyRoot(rootId: string, chatId: string, limit = 6): Promise<string[]> {
  if (!rootId || !chatId) return [];
  try {
    const rows = stmt(
      `SELECT content FROM sent_messages
       WHERE reply_root_id = ? AND chat_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT ?`
    ).all(rootId, chatId, Date.now() - TTL_MS, limit) as unknown as Array<{ content: string }>;
    return rows.map(r => r.content);
  } catch (error) {
    logDbError('listSentBubblesByReplyRoot', error);
    return [];
  }
}

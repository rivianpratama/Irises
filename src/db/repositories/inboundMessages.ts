import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

// Index of the user's OWN inbound text-bearing messages, keyed by transport message_id.
// Some transports collapse a tapped reply to the THREAD ROOT, which — for a reply tapped
// on one of Irises's Ops answers (those are threaded to the originating question) —
// is the user's own opening message. This lets that id resolve back to the text
// that opened the exchange. Sibling to sent_messages (never merged into it: keeping
// user-authored rows out of the Irises-bubble lookup avoids any chance of injected
// text satisfying a "what did Irises say" resolution). Ephemeral (~7 days).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Soft cap, pruned on write — a webhook flood must not grow the index unbounded
// between retention sweeps.
const CAP = 2000;

function pruneOnWrite(now: number): void {
  stmt('DELETE FROM inbound_messages WHERE created_at <= ?').run(now - TTL_MS);
  stmt(
    `DELETE FROM inbound_messages WHERE message_id IN (
       SELECT message_id FROM inbound_messages ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`
  ).run(CAP);
}

/** Remember a text-bearing message the user sent, keyed by its transport message_id. Fire-and-forget; never throws. */
export async function recordInboundMessage(chatId: string, messageId: string, content: string, senderHandle?: string): Promise<void> {
  if (!messageId || !content) return;
  try {
    const now = Date.now();
    stmt(
      `INSERT INTO inbound_messages (message_id, chat_id, sender_handle, content, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         chat_id = excluded.chat_id, sender_handle = excluded.sender_handle,
         content = excluded.content, created_at = excluded.created_at`
    ).run(messageId, chatId, senderHandle ?? null, content, now);
    pruneOnWrite(now);
  } catch (error) {
    logDbError('recordInboundMessage', error);
  }
}

/**
 * Resolve an inbound reply_to.message_id back to the USER'S message text (+ sender), or null if
 * unknown/expired. Scoped to the chat the reply arrived in — a message_id from another chat (id
 * collision, forged webhook body) must never inject that chat's text into this prompt.
 */
export async function lookupInboundMessage(messageId: string, chatId: string): Promise<{ content: string; senderHandle?: string } | null> {
  if (!messageId || !chatId) return null;
  try {
    const row = stmt(
      'SELECT content, sender_handle FROM inbound_messages WHERE message_id = ? AND chat_id = ? AND created_at > ?'
    ).get(messageId, chatId, Date.now() - TTL_MS) as { content: string; sender_handle: string | null } | undefined;
    return row ? { content: row.content, ...(row.sender_handle ? { senderHandle: row.sender_handle } : {}) } : null;
  } catch (error) {
    logDbError('lookupInboundMessage', error);
    return null;
  }
}

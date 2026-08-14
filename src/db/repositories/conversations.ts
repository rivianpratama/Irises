import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import type { StoredMessage } from '../types.js';

export type { StoredMessage } from '../types.js';

// Conversation history retention. Bumped 1h → 24h → 7d: the live context windows still
// slice to the last ~10-20 messages (cost unchanged), and a week gives deal-relevant
// facts a wide window to be extracted into the memory tiers.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 40;

type MessageRow = { role: 'user' | 'assistant'; content: string; handle: string | null; created_at: number };

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  try {
    const rows = stmt(
      `SELECT role, content, handle, created_at FROM messages
       WHERE chat_id = ? AND created_at > ?
       ORDER BY created_at DESC, id DESC
       LIMIT ${MAX_MESSAGES}`
    ).all(chatId, Date.now() - RETENTION_MS) as unknown as MessageRow[];
    // id breaks same-millisecond ties, so the reversed list is true insertion order.
    return rows.reverse().map(r => ({
      role: r.role,
      content: r.content,
      ...(r.handle ? { handle: r.handle } : {}),
      at: r.created_at,
    }));
  } catch (error) {
    logDbError('getConversation', error);
    return [];
  }
}

/**
 * Append a message and return the canonical stored timestamp (epoch ms, app clock —
 * single-host storage means one clock everywhere). Callers that need to know "what did
 * the user say AFTER this point" stamp it from this return value.
 */
export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  handle?: string,
): Promise<number> {
  const at = Date.now();
  try {
    stmt(
      'INSERT INTO messages (chat_id, role, content, handle, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, role, content, handle ?? null, at);
    // Keep the chat bounded even if the retention timer dies: one indexed DELETE of
    // this chat's rows past the window (the newest-40 cap is applied on read).
    stmt('DELETE FROM messages WHERE chat_id = ? AND created_at <= ?').run(chatId, at - RETENTION_MS);
  } catch (error) {
    logDbError('addMessage', error);
  }
  return at;
}

/**
 * Distinct chats with any message newer than `sinceMs`, most-recent first — the audience for a
 * proactive update announcement. Reuses idx_messages_chat_created; the 7d message window keeps the
 * scan small. Returns [] on any error (same fail-soft contract as getConversation).
 */
export async function listActiveChats(sinceMs: number, limit = 20): Promise<{ chatId: string; lastAt: number }[]> {
  try {
    const rows = stmt(
      `SELECT chat_id AS chatId, MAX(created_at) AS lastAt FROM messages
       WHERE created_at > ?
       GROUP BY chat_id
       ORDER BY lastAt DESC
       LIMIT ?`
    ).all(sinceMs, limit) as unknown as { chatId: string; lastAt: number }[];
    return rows;
  } catch (error) {
    logDbError('listActiveChats', error);
    return [];
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  try {
    stmt('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  } catch (error) {
    logDbError('clearConversation', error);
  }
}

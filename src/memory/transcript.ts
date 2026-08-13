// Scope a chat-history window to ONE user before it feeds a memory writer.
//
// Conversation history is keyed by chat, not by person — in any thread that ever carried a
// second participant, an unfiltered window hands the dossier harvesters OTHER
// people's words as if the target user said them ("call me Chief" leaking into the wrong
// user's memory was exactly this). Every transcript a per-user memory writer consumes goes
// through here first.

import { isGroupHandle } from './identity.js';
import type { StoredMessage } from '../db/types.js';

/**
 * Keep only the rows that belong in `handle`'s memory view of a window:
 * - assistant rows always stay (Irises's own side of the conversation);
 * - user rows stay when their stored `handle` matches;
 * - null-handle user rows (legacy data predating attribution) stay ONLY when no user row in
 *   the window carries a different handle — single-party evidence reads as the target's own
 *   1:1 history; any foreign handle makes unattributed rows unknowable, so they drop;
 * - a group memory handle (`group:<chatId>`) returns the window unchanged: the group identity
 *   is legitimately multi-party, and its writers attribute lines instead of filtering them.
 */
export function scopeHistoryToUser(messages: StoredMessage[], handle: string): StoredMessage[] {
  if (isGroupHandle(handle)) return messages;
  const foreignPresent = messages.some(m => m.role === 'user' && m.handle && m.handle !== handle);
  return messages.filter(m => {
    if (m.role !== 'user') return true;
    if (m.handle) return m.handle === handle;
    return !foreignPresent;
  });
}

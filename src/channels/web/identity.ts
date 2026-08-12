// Synthetic identity for the web debug channel (single-user, no external messaging setup needed).
//
// The web channel lets you chat with Irises in the browser. It has no real phone handle, so we mint a
// stable synthetic chatId + handle. The handle is what the memory tiers, Gmail OAuth, and
// clarification/research state key on — default it to something DISTINCT from any real phone
// handle so debug turns don't pollute a real user's memory (override via WEB_DEBUG_HANDLE to
// deliberately test against a real handle's memory).
import type { ChatInfo } from '../types.js';

export const WEB_DEBUG_HANDLE = process.env.WEB_DEBUG_HANDLE || 'web:guest';
export const IRISES_SELF_HANDLE = 'web:irises';
const DEFAULT_CLIENT = (process.env.WEB_DEBUG_CHAT_ID || 'web:debug').replace(/^web:/, '') || 'debug';

/** Derive the web chatId from an optional client id (single-user default: "web:debug"). */
export function webChatId(clientId?: string): string {
  const id = (clientId || DEFAULT_CLIENT).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'debug';
  return `web:${id}`;
}

/**
 * A synthetic 1:1 ChatInfo. Exactly TWO handles (the user + Irises) so `is_group`/
 * `handles.length > 2` is false and the group-chat classifier path is correctly skipped,
 * matching a 1:1 iMessage thread.
 */
export function webChatInfo(chatId: string): ChatInfo {
  return {
    id: chatId,
    display_name: null,
    handles: [
      { handle: WEB_DEBUG_HANDLE, service: 'web' },
      { handle: IRISES_SELF_HANDLE, service: 'web' },
    ],
    is_group: false,
    service: 'web',
  };
}

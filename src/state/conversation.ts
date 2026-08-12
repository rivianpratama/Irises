// Compatibility shim. The conversation/profile store moved from DynamoDB to the
// Supabase data layer (src/db). This file preserves the original import path and
// signatures so existing call sites (claude/client.ts, index.ts) need no changes.
export type { StoredMessage } from '../db/repositories/conversations.js';
export type { UserProfile } from '../db/repositories/profiles.js';
export {
  getConversation,
  addMessage,
  clearConversation,
  clearAllConversations,
} from '../db/repositories/conversations.js';
export {
  getUserProfile,
  updateUserProfile,
  addUserFact,
  setUserName,
  clearUserProfile,
} from '../db/repositories/profiles.js';

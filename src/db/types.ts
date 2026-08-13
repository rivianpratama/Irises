// Domain types for the local data layer. Repositories map snake_case columns
// <-> these camelCase shapes at the boundary.

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string; // sender handle (group chats)
  at?: number;     // epoch ms the message was stored — app clock (single-host storage
                   // means one clock everywhere). Used to find messages a user sent
                   // WHILE a background task ran.
}

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number; // epoch seconds (preserved for backwards-compat)
  lastSeen: number;  // epoch seconds
}

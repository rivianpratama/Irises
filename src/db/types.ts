// Domain types for the Supabase data layer. Repositories map snake_case DB
// columns <-> these camelCase shapes at the boundary.

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string; // sender handle (group chats)
  at?: number;     // epoch ms the message was stored. Single-clock per backend (Supabase: DB
                   // created_at; in-memory: Date.now()). Used to find messages a user sent
                   // WHILE a background task ran. Never compare across backends.
}

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number; // epoch seconds (preserved for backwards-compat)
  lastSeen: number;  // epoch seconds
}

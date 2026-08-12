// In-memory fallback store mirroring every table. Used for local dev (no
// Supabase creds) and as a degradation path on transient Supabase errors.
// Data is per-process and lost on restart — never for production.

import type {
  StoredMessage, UserProfile,
  Automation, GmailToken, OAuthState, Workflow,
} from './types.js';
import type { AgentMemory } from './repositories/memory.js';
import type { IndexedEmail } from './repositories/emails.js';
import type { ShortTermEntry } from './repositories/memoryShort.js';
import type { MediumEntry } from './repositories/memoryMedium.js';
import type { LongRevision } from './repositories/memoryLong.js';

export const mem = {
  // chatId -> messages (also tracks lastActive for TTL emulation)
  messages: new Map<string, { content: StoredMessage; at: number }[]>(),
  profiles: new Map<string, UserProfile>(),
  automations: new Map<string, Automation>(),
  gmailTokens: new Map<string, GmailToken>(),
  oauthState: new Map<string, OAuthState>(),
  workflows: new Map<string, Workflow>(),
  agentMemory: new Map<string, AgentMemory>(),
  // Linq message_id -> the bubble Irises sent, so an inbound reply_to can be resolved
  // back to the text she said. `replyRootId` is the inbound id this bubble was sent
  // threaded to (present on Ops answers), the join key for thread-aware resolution.
  // `at` drives TTL emulation.
  sentMessages: new Map<string, { chatId: string; content: string; at: number; replyRootId?: string }>(),
  // Linq message_id -> a text-bearing message the USER sent, so a thread-root reply_to
  // (which iMessage collapses to the user's own opening message) resolves to its text.
  // `at` drives TTL emulation; the repo prunes on write past a soft cap.
  inboundMessages: new Map<string, { chatId: string; content: string; senderHandle?: string; at: number }>(),
  // handle -> (gmail message id -> indexed email). The local mail search index.
  emails: new Map<string, Map<string, IndexedEmail>>(),
  // Three-tier memory (Stage 1 of the memory revamp). Same per-process caveat as above.
  memoryShort: new Map<string, ShortTermEntry[]>(),
  memoryMedium: new Map<string, MediumEntry[]>(),
  memoryLong: new Map<string, { docMd: string; version: number; revisions: LongRevision[] }>(),
};

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

export type WorkflowKind = 'onboarding' | 'gmail_oauth' | 'other';
export type WorkflowStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

// ---------------------------------------------------------------------------
// Automations — the single source of truth for proactive outreach. Written by
// Convo (user-asked), the email pipeline (triaged), and Ops/orchestrator
// (grounded follow-ups); fired by the Autonome runner. Replaces the dormant
// `reminders` path. See supabase/migrations/0005_automations.sql.
// ---------------------------------------------------------------------------
export type AutomationStatus = 'active' | 'paused' | 'done' | 'cancelled' | 'failed';
export type ScheduleKind = 'once' | 'cron';
// 'reflexion' rows are the memory curator's daily pass + self-scheduled wakes: claimed by the
// same Autonome runner but routed to a SILENT branch (never voiced, never listed to the user).
export type AutomationSource = 'convo' | 'email' | 'ops' | 'reflexion' | 'judge_daily';

export interface Automation {
  id: string;
  agentHandle: string;
  chatId: string;
  source: AutomationSource;
  title: string | null;
  instruction: string;        // NL brief the Autonome agent voices/acts on
  needsOps: boolean;          // pull fresh data via Ops before voicing?
  opsKind: string | null;     // optional TaskKind hint (kept free-text; cast at task-build time)
  dealId: string | null;
  deadlineId: string | null;
  scheduleKind: ScheduleKind;
  nextRunAt: string;          // ISO, UTC
  cron: string | null;
  timezone: string;           // IANA
  respectQuietHours: boolean; // defer 9pm-8am (email reminders) vs fire exactly (user-set)
  status: AutomationStatus;
  lastRunAt: string | null;
  runCount: number;
  attempts: number;
  lastError: string | null;
  claimedAt: string | null;
  dedupeKey: string | null;
}

export interface NewAutomation {
  agentHandle: string;
  chatId: string;
  source?: AutomationSource;   // defaults 'convo'
  title?: string | null;
  instruction: string;
  needsOps?: boolean;
  opsKind?: string | null;
  dealId?: string | null;
  deadlineId?: string | null;
  scheduleKind: ScheduleKind;
  nextRunAt?: string;          // required for 'once'; for 'cron' the repo computes it from cron+tz
  cron?: string | null;
  timezone?: string;           // defaults 'America/Chicago'
  respectQuietHours?: boolean; // defaults false
  dedupeKey?: string | null;
}

export interface GmailToken {
  handle: string;
  refreshTokenEnc: Buffer;
  accessTokenEnc: Buffer | null;
  accessTokenExpiry: string | null;
  scope: string;
  googleEmail: string | null;
  revoked: boolean;
}

export interface GmailTokenInput {
  refreshTokenEnc: Buffer;
  accessTokenEnc?: Buffer | null;
  accessTokenExpiry?: string | null;
  scope: string;
  googleEmail?: string | null;
}

export interface OAuthState {
  state: string;
  handle: string;
  chatId: string;
  deferredTask: Record<string, unknown> | null;
  expiresAt: string;
  consumedAt: string | null;
}

export interface Workflow {
  id: string;
  agentHandle: string;
  chatId: string | null;
  kind: WorkflowKind;
  status: WorkflowStatus;
  dealId: string | null;
  state: Record<string, unknown>;
}

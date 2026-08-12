-- Project Maria — Autonome: the single source of truth for proactive outreach.
-- Supersedes the deal/deadline-coupled `reminders` table (now dormant) as the place
-- every scheduled, unprompted message is queued. Written by three sources:
--   - the Convo agent (user explicitly asked for a reminder/automation),
--   - the email-ingest pipeline (triaged important mail),
--   - the Ops engine / orchestrator (a grounded follow-up on a future obligation).
-- Fired by the Autonome runner (src/pipeline/automations.ts), which voices each row
-- through the Autonome agent (Maria's proactive persona) instead of a fixed template.
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type automation_status as enum ('active','paused','done','cancelled','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_kind as enum ('once','cron');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists automations (
  id            uuid primary key default gen_random_uuid(),
  agent_handle  text not null,
  chat_id       text not null,                        -- where the proactive message goes
  source        text not null default 'convo',        -- 'convo' | 'email' | 'ops'
  title         text,                                 -- short label for listing/cancel
  instruction   text not null,                        -- NL brief the Autonome agent voices/acts on
  needs_ops     boolean not null default false,       -- pull fresh data via Ops before voicing?
  ops_kind      text,                                 -- optional TaskKind hint (TS-only union; free text here)
  deal_id       uuid references deals(id) on delete cascade,
  deadline_id   uuid references deadlines(id) on delete cascade,
  schedule_kind schedule_kind not null,
  next_run_at   timestamptz not null,                 -- absolute next fire, UTC
  cron          text,                                 -- 5-field cron when schedule_kind='cron'
  timezone      text not null default 'America/Chicago', -- IANA tz the cron is evaluated in
  respect_quiet_hours boolean not null default false,  -- email reminders=true; user-set=false
  status        automation_status not null default 'active',
  last_run_at   timestamptz,
  run_count     int not null default 0,
  attempts      int not null default 0,               -- consecutive failures since last success
  last_error    text,
  claimed_at    timestamptz,                          -- non-null while a runner holds the row (lease)
  dedupe_key    text,                                 -- unique PER AGENT (see index below), not globally
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- a cron job must carry a cron string; a one-time job must not.
  constraint automations_cron_shape check (
    (schedule_kind = 'cron' and cron is not null) or
    (schedule_kind = 'once' and cron is null)
  )
);

-- Hot path for the claim RPC: due, active rows ordered by next_run_at.
create index if not exists idx_automations_due
  on automations(next_run_at)
  where status = 'active';
-- For listAutomations(handle).
create index if not exists idx_automations_handle
  on automations(agent_handle, status);
-- dedupe_key is unique PER AGENT, not globally: two agents can legitimately share a
-- key (e.g. a deal at the same street address). Partial so null keys don't collide.
create unique index if not exists uq_automations_dedupe
  on automations(agent_handle, dedupe_key)
  where dedupe_key is not null;

create trigger trg_automations_updated before update on automations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Claim RPC (PostgREST cannot do FOR UPDATE SKIP LOCKED directly).
-- Called from the runner via supabase.rpc('claim_due_automations', { p_limit }).
-- Marks due, active, unclaimed (or stuck-claimed) rows as claimed by setting
-- claimed_at=now(), and returns them. Status is NOT changed here — the runner
-- decides reschedule (cron) vs. done (once) after the send. A claim older than the
-- 10-minute lease is reclaimable, so a runner that crashed mid-job self-heals.
-- ---------------------------------------------------------------------------
create or replace function claim_due_automations(p_limit int default 10)
returns setof automations as $$
  update automations a
     set claimed_at = now()
   where a.id in (
     select id from automations
      where status = 'active'
        and next_run_at <= now()
        and (claimed_at is null or claimed_at < now() - interval '10 minutes')
      order by next_run_at
      limit p_limit
      for update skip locked
   )
  returning a.*;
$$ language sql;

-- ---------------------------------------------------------------------------
-- Row Level Security: lock out anon; the server uses the service-role key which
-- bypasses RLS. Enable RLS with no permissive policies (matches 0001).
-- ---------------------------------------------------------------------------
alter table automations enable row level security;

-- Project Maria — Supabase Postgres schema (replaces DynamoDB single-table)
-- Apply with: supabase db push   (or paste into the SQL editor)
-- Idempotent where practical so re-running is safe during development.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;     -- fuzzy address matching

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type deal_status as enum ('prospect','active','under_contract','pending','closed','dead');
exception when duplicate_object then null; end $$;

do $$ begin
  create type deal_side as enum ('buy','list','dual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_role as enum (
    'buyer','seller','buyer_agent','listing_agent','lender','title','escrow',
    'inspector','appraiser','attorney','hoa','other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type deadline_kind as enum (
    'inspection','financing','appraisal','earnest_money','closing','possession',
    'rent_back','contingency_removal','addendum','hoa_docs','title_review','option','other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type reminder_status as enum ('pending','sent','dismissed','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type workflow_kind as enum ('onboarding','gmail_oauth','deal_intake','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type workflow_status as enum ('pending','in_progress','blocked','done','cancelled');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Conversation + profile (replace DynamoDB CHAT# / USER#)
-- ---------------------------------------------------------------------------
create table if not exists chats (
  chat_id     text primary key,
  last_active timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  created_at  timestamptz not null default now()
);

create table if not exists messages (
  id         bigint generated always as identity primary key,
  chat_id    text not null references chats(chat_id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  handle     text,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_chat_created on messages(chat_id, created_at desc);

create table if not exists user_profiles (
  handle     text primary key,
  name       text,
  facts      text[] not null default '{}',
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Real-estate domain
-- ---------------------------------------------------------------------------
create table if not exists properties (
  id             uuid primary key default gen_random_uuid(),
  dealmachine_id text unique,
  address_norm   text,
  address_raw    text,
  beds           int,
  baths          numeric(4,1),
  sqft           int,
  lot_sqft       int,
  year_built     int,
  specs          jsonb not null default '{}',
  fetched_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_properties_address on properties(address_norm);
create trigger trg_properties_updated before update on properties
  for each row execute function set_updated_at();

create table if not exists deals (
  id                    uuid primary key default gen_random_uuid(),
  agent_handle          text not null,
  chat_id               text,
  address_line1         text not null,
  city                  text,
  state                 text,
  postal_code           text,
  address_norm          text not null,
  nickname              text,
  side                  deal_side,
  status                deal_status not null default 'active',
  list_price            numeric(14,2),
  contract_price        numeric(14,2),
  earnest_amount        numeric(14,2),
  closing_date          date,
  last_gmail_activity_at timestamptz,
  property_id           uuid references properties(id) on delete set null,
  contract_facts        jsonb not null default '{}',
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_deals_agent_status on deals(agent_handle, status);
create index if not exists idx_deals_closing on deals(closing_date)
  where status in ('active','under_contract','pending');
create index if not exists idx_deals_address_trgm on deals using gin (lower(address_norm) gin_trgm_ops);
create trigger trg_deals_updated before update on deals
  for each row execute function set_updated_at();

create table if not exists contacts (
  id           uuid primary key default gen_random_uuid(),
  agent_handle text not null,
  name         text,
  email        text,
  phone        text,
  phone_norm   text,
  company      text,
  role         contact_role,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create unique index if not exists uq_contacts_phone on contacts(agent_handle, phone_norm)
  where phone_norm is not null;
create unique index if not exists uq_contacts_email on contacts(agent_handle, lower(email))
  where email is not null;

create table if not exists deal_parties (
  deal_id    uuid not null references deals(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  role       contact_role not null,
  primary key (deal_id, contact_id, role)
);
create index if not exists idx_deal_parties_deal on deal_parties(deal_id);

create table if not exists contract_facts (
  id                  uuid primary key default gen_random_uuid(),
  deal_id             uuid not null references deals(id) on delete cascade,
  source_message_id   text,
  source_attachment_id text,
  facts               jsonb not null,
  extracted_at        timestamptz not null default now(),
  unique (deal_id, source_message_id, source_attachment_id)
);

create table if not exists deadlines (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references deals(id) on delete cascade,
  kind       deadline_kind not null,
  due_at     timestamptz not null,
  is_all_day boolean not null default true,
  label      text,
  completed  boolean not null default false,
  completed_at timestamptz,
  source     text,
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_deadlines_sweep on deadlines(due_at) where completed = false;
create index if not exists idx_deadlines_deal on deadlines(deal_id, due_at);
create trigger trg_deadlines_updated before update on deadlines
  for each row execute function set_updated_at();

create table if not exists reminders (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid references deals(id) on delete cascade,
  deadline_id  uuid references deadlines(id) on delete cascade,
  agent_handle text not null,
  chat_id      text,
  fire_at      timestamptz not null,
  window_hours int not null default 48,
  status       reminder_status not null default 'pending',
  message      text,
  alerted_at   timestamptz,
  attempts     int not null default 0,
  last_error   text,
  dedupe_key   text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_reminders_due on reminders(fire_at) where status = 'pending';
create trigger trg_reminders_updated before update on reminders
  for each row execute function set_updated_at();

create table if not exists gmail_oauth_tokens (
  handle               text primary key,
  refresh_token_enc    bytea not null,
  access_token_enc     bytea,
  access_token_expiry  timestamptz,
  scope                text not null,
  google_email         text,
  revoked              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_gmail_tokens_updated before update on gmail_oauth_tokens
  for each row execute function set_updated_at();

create table if not exists oauth_state (
  state         text primary key,
  handle        text not null,
  chat_id       text not null,
  deferred_task jsonb,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_oauth_state_expires on oauth_state(expires_at);

create table if not exists workflows (
  id           uuid primary key default gen_random_uuid(),
  agent_handle text not null,
  chat_id      text,
  kind         workflow_kind not null,
  status       workflow_status not null default 'pending',
  deal_id      uuid references deals(id) on delete set null,
  state        jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_workflows_handle_status on workflows(agent_handle, status);
create trigger trg_workflows_updated before update on workflows
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Reminder claim RPC (PostgREST cannot do FOR UPDATE SKIP LOCKED directly)
-- Called from the sweeper via supabase.rpc('claim_due_reminders', { p_limit }).
-- ---------------------------------------------------------------------------
create or replace function claim_due_reminders(p_limit int default 20)
returns setof reminders as $$
  update reminders r
     set status = 'sent', attempts = r.attempts + 1
   where r.id in (
     select id from reminders
      where status = 'pending' and alerted_at is null and fire_at <= now()
      order by fire_at
      limit p_limit
      for update skip locked
   )
  returning r.*;
$$ language sql;

-- ---------------------------------------------------------------------------
-- Row Level Security: lock out anon; the server uses the service-role key
-- which bypasses RLS. Enable RLS with no permissive policies.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'chats','messages','user_profiles','properties','deals','contacts',
    'deal_parties','contract_facts','deadlines','reminders',
    'gmail_oauth_tokens','oauth_state','workflows'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

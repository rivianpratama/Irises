-- Irises — core Supabase Postgres schema: conversation state, user profiles,
-- and the message indexes that power thread-aware replies.
-- Apply with: supabase db push   (or paste into the SQL editor)
-- Idempotent where practical so re-running is safe during development.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Conversation + profile
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

-- Durable per-agent memory dossier + structured preferences. The dossier is a
-- living markdown document injected into the Convo agent's prompt; prefs holds
-- structured flags (onboarding state, chat_id, timezone, …).
create table if not exists agent_memory (
  handle     text primary key,
  dossier_md text not null default '',
  prefs      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create trigger trg_agent_memory_updated before update on agent_memory
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sent_messages: the channel message_id of each bubble Irises sends, mapped to
-- its text. Lets an inbound reply_to.message_id be resolved back to the bubble
-- the user is replying to, so the reply is answered in that context.
-- reply_root_id is the inbound id the bubble was anchored (threaded) to when
-- sent — the join key when a transport collapses a tapped reply to the thread
-- root (the user's own originating message). Ephemeral (~7 days).
-- ---------------------------------------------------------------------------
create table if not exists sent_messages (
  message_id    text primary key,
  chat_id       text not null,
  content       text not null,
  reply_root_id text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days'
);
create index if not exists idx_sent_messages_chat on sent_messages(chat_id, created_at desc);
create index if not exists idx_sent_messages_reply_root
  on sent_messages(chat_id, reply_root_id) where reply_root_id is not null;

-- ---------------------------------------------------------------------------
-- inbound_messages: message_id -> text of the user's OWN text-bearing messages,
-- so a thread-root reply_to resolves to the message that opened the exchange.
-- Ephemeral (~7 days), mirroring sent_messages.
-- ---------------------------------------------------------------------------
create table if not exists inbound_messages (
  message_id    text primary key,
  chat_id       text not null,
  sender_handle text,
  content       text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days'
);
create index if not exists idx_inbound_messages_chat
  on inbound_messages(chat_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: lock out anon; the server uses the service-role key
-- which bypasses RLS. Enable RLS with no permissive policies.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'chats','messages','user_profiles','agent_memory','sent_messages','inbound_messages'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

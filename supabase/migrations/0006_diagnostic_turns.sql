-- ---------------------------------------------------------------------------
-- diagnostic_turns: the MOST RECENT orchestration turn per chat (or per user
-- handle for chat-less flows like the email Judge), upserted by the diagnostics
-- turn store so the /dashboard graph survives restarts/redeploys. One row per
-- key; the full event list (prompts, responses, tool calls — strings already
-- capped by the trace layer) lives in the `turn` jsonb payload.
-- ---------------------------------------------------------------------------
create table if not exists diagnostic_turns (
  key        text primary key,   -- chatId, or "handle:<phone>" when no chat is involved
  chat_id    text,
  handle     text,               -- agent phone number, when known
  source     text,               -- user | email | automation | system
  trigger    text,               -- what kicked the turn off (user text / instruction), truncated
  started_at timestamptz,
  last_at    timestamptz not null,
  turn       jsonb not null,     -- full Turn object: meta + capped TraceEvent list
  updated_at timestamptz not null default now()
);

create index if not exists idx_diagnostic_turns_handle on diagnostic_turns(handle, last_at desc);
create index if not exists idx_diagnostic_turns_last   on diagnostic_turns(last_at desc);

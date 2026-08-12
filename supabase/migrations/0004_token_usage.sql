-- ---------------------------------------------------------------------------
-- token_usage: one row per successful LLM call routed through callLLM(), for
-- analyzing token spend per interaction / per phone number across the three
-- model roles (convo, ops, classify). Append-only. Bound to the agent's phone
-- number (handle) wherever the call site carries it.
--
-- NOTE: voice-memo transcription (src/llm/transcribe.ts) is a direct OpenRouter
-- call that bypasses callLLM and is intentionally NOT captured here.
-- ---------------------------------------------------------------------------
create table if not exists token_usage (
  id           bigint generated always as identity primary key,
  handle       text,            -- agent phone number (null for unbound classify:effect calls)
  chat_id      text,
  task_id      text,
  role         text not null,   -- convo | ops | classify
  label        text,            -- convo | ops:step0 | ops:final | convo:followup | classify ...
  provider     text not null,   -- anthropic | openrouter
  model        text not null,
  input_tokens                 integer not null default 0,
  output_tokens                integer not null default 0,
  cache_creation_input_tokens  integer not null default 0,
  cache_read_input_tokens      integer not null default 0,
  total_tokens integer generated always as
    (input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) stored,
  created_at   timestamptz not null default now()
);

create index if not exists idx_token_usage_handle on token_usage(handle, created_at desc);
create index if not exists idx_token_usage_chat   on token_usage(chat_id, created_at desc);
create index if not exists idx_token_usage_task   on token_usage(task_id);

-- Server uses the service-role key, which bypasses RLS; anon stays locked out.
alter table token_usage enable row level security;

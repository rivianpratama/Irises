-- Irises — telemetry: the durable LLM call ledger, orchestration-turn history for
-- the admin dashboard, and the agent-wide error log.
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.

-- ---------------------------------------------------------------------------
-- token_usage: one row per LLM call routed through callLLM(), for analyzing
-- token spend / latency / fallbacks per interaction and per user handle.
-- Append-only.
--
-- NOTE: voice-memo transcription (src/llm/transcribe.ts) is a direct OpenRouter
-- call that bypasses callLLM and is intentionally NOT captured here.
-- ---------------------------------------------------------------------------
create table if not exists token_usage (
  id           bigint generated always as identity primary key,
  handle       text,            -- user handle (null for unbound classify calls)
  chat_id      text,
  task_id      text,
  role         text not null,   -- convo | ops | classify | fallfirm
  label        text,            -- convo | ops:step0 | convo:followup | classify ...
  provider     text not null,   -- anthropic | openrouter
  model        text not null,
  input_tokens                 integer not null default 0,
  output_tokens                integer not null default 0,
  cache_creation_input_tokens  integer not null default 0,
  cache_read_input_tokens      integer not null default 0,
  total_tokens integer generated always as
    (input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) stored,
  latency_ms      integer,
  fallback_from   text,                        -- primary provider when this call ran on the fallback lane
  status          text not null default 'ok',  -- 'ok' | 'error'
  error           text,                        -- capped message when status='error'
  -- Truncation ledger: a token-starved reply must never look identical to a healthy
  -- one. Truncated calls stay status='ok' with the flag set (a third status would
  -- silently drop them from every aggregate below).
  stop_reason     text,                        -- the provider's raw stop/finish reason, verbatim
  max_tokens_sent integer,                     -- the cap actually sent (req.maxTokens ?? MAX_TOKENS[role])
  truncated       boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists idx_token_usage_handle  on token_usage(handle, created_at desc);
create index if not exists idx_token_usage_chat    on token_usage(chat_id, created_at desc);
create index if not exists idx_token_usage_task    on token_usage(task_id);
create index if not exists idx_token_usage_created on token_usage(created_at desc);
-- Partial index: truncation is the rare case, so the index stays small and the
-- "recent truncated calls" dashboard query never scans the full ledger.
create index if not exists idx_token_usage_truncated on token_usage(created_at desc) where truncated;

alter table token_usage enable row level security;

-- ---------------------------------------------------------------------------
-- diagnostic_turns: the MOST RECENT orchestration turn per chat (or per user
-- handle for chat-less flows), upserted by the diagnostics turn store so the
-- /dashboard graph survives restarts/redeploys. One row per key; the full event
-- list (prompts, responses, tool calls — strings already capped by the trace
-- layer) lives in the `turn` jsonb payload.
-- ---------------------------------------------------------------------------
create table if not exists diagnostic_turns (
  key        text primary key,   -- chatId, or "handle:<handle>" when no chat is involved
  chat_id    text,
  handle     text,               -- user handle, when known
  source     text,               -- user | system
  trigger    text,               -- what kicked the turn off (user text / instruction), truncated
  started_at timestamptz,
  last_at    timestamptz not null,
  turn       jsonb not null,     -- full Turn object: meta + capped TraceEvent list
  updated_at timestamptz not null default now()
);

create index if not exists idx_diagnostic_turns_handle on diagnostic_turns(handle, last_at desc);
create index if not exists idx_diagnostic_turns_last   on diagnostic_turns(last_at desc);

-- ---------------------------------------------------------------------------
-- diagnostic_turn_history: one row per orchestration turn (diagnostic_turns
-- keeps ONLY the latest per key — it stays the fast sidebar seed and the one
-- place full `raw` wire payloads survive a restart). History rows are
-- raw-stripped at save time and pruned by diagnostic_history_prune.
-- ---------------------------------------------------------------------------
create table if not exists diagnostic_turn_history (
  id           bigint generated always as identity primary key,
  key          text not null,             -- chatId, or "handle:<handle>"
  turn_id      text not null,             -- boot-unique turn id (t<seq>.<boot>)
  chat_id      text,
  handle       text,
  source       text not null,             -- user | system
  trigger      text,
  agents       text[] not null default '{}',
  event_count  integer not null default 0,
  error_count  integer not null default 0, -- events whose response starts 'ERROR:' or label ends ':fidelity-suppressed'
  started_at   timestamptz not null,
  last_at      timestamptz not null,
  turn         jsonb not null,            -- full Turn, events raw-stripped unless DIAGNOSTICS_PERSIST_RAW=true
  updated_at   timestamptz not null default now(),
  unique (key, turn_id)
);

create index if not exists idx_dth_key_last    on diagnostic_turn_history(key, last_at desc);
create index if not exists idx_dth_handle_last on diagnostic_turn_history(handle, last_at desc);
create index if not exists idx_dth_last        on diagnostic_turn_history(last_at desc);

drop trigger if exists trg_dth_updated on diagnostic_turn_history;
create trigger trg_dth_updated before update on diagnostic_turn_history
  for each row execute function set_updated_at();

alter table diagnostic_turn_history enable row level security;

-- ---------------------------------------------------------------------------
-- RPC: prune turn history (keep newest N per key, drop older than max age)
-- ---------------------------------------------------------------------------
create or replace function diagnostic_history_prune(p_keep int default 50, p_max_age_days int default 30)
returns int language sql as $$
  with ranked as (
    select id,
           row_number() over (partition by key order by last_at desc) as rn,
           last_at
    from diagnostic_turn_history
  ), del as (
    delete from diagnostic_turn_history
    where id in (
      select id from ranked
      where rn > p_keep or last_at < now() - make_interval(days => p_max_age_days)
    )
    returning 1
  )
  select count(*)::int from del;
$$;

-- ---------------------------------------------------------------------------
-- RPC: latest turn meta per key + real per-key turn counts (sidebar seed).
-- Also reports, per key:
--   user_turn_count : how many of the key's turns were user-sourced (the Turn
--                     cost picker's real gate — the representative newest turn
--                     may be an automated one on a real user chat),
--   any_handle      : a partition-wide handle / chat id, so a chat whose newest
--   any_chat_id       turn carried neither still displays and scopes right.
-- ---------------------------------------------------------------------------
create or replace function diagnostic_history_keys(p_limit int default 300, p_offset int default 0)
returns table(key text, chat_id text, handle text, source text, trigger text, agents text[],
              event_count int, error_count int, started_at timestamptz, last_at timestamptz,
              turn_id text, turn_count bigint, user_turn_count bigint,
              any_handle text, any_chat_id text)
language sql stable as $$
  select * from (
    select distinct on (h.key)
           h.key, h.chat_id, h.handle, h.source, h.trigger, h.agents,
           h.event_count, h.error_count, h.started_at, h.last_at, h.turn_id,
           count(*) over (partition by h.key) as turn_count,
           count(*) filter (where h.source = 'user') over (partition by h.key) as user_turn_count,
           max(h.handle)  over (partition by h.key) as any_handle,
           max(h.chat_id) over (partition by h.key) as any_chat_id
    from diagnostic_turn_history h
    order by h.key, h.last_at desc
  ) t
  order by t.last_at desc
  limit least(coalesce(p_limit, 300), 1000) offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- RPC: deep search over turn payloads (bounded by window + limit; the fast
-- meta-column search runs through supabase-js filters, not this function).
-- ---------------------------------------------------------------------------
create or replace function diagnostic_history_search(
  p_q text,
  p_handle text default null,
  p_source text default null,
  p_since timestamptz default now() - interval '7 days',
  p_limit int default 50)
returns table(key text, turn_id text, chat_id text, handle text, source text, trigger text,
              agents text[], event_count int, error_count int, started_at timestamptz, last_at timestamptz)
language sql stable as $$
  select h.key, h.turn_id, h.chat_id, h.handle, h.source, h.trigger,
         h.agents, h.event_count, h.error_count, h.started_at, h.last_at
  from diagnostic_turn_history h
  where h.last_at >= coalesce(p_since, now() - interval '7 days')
    and (p_handle is null or h.handle = p_handle)
    and (p_source is null or h.source = p_source)
    and (h.trigger ilike '%' || p_q || '%' or h.turn::text ilike '%' || p_q || '%')
  order by h.last_at desc
  limit least(coalesce(p_limit, 50), 100);
$$;

-- ---------------------------------------------------------------------------
-- RPC: LLM call aggregates by role/provider/model over a window
-- ---------------------------------------------------------------------------
create or replace function llm_role_stats(p_since timestamptz, p_handle text default null)
returns table(role text, provider text, model text, calls bigint, errors bigint, fallbacks bigint,
              avg_latency_ms numeric, p95_latency_ms numeric,
              input_tokens bigint, output_tokens bigint,
              cache_read_tokens bigint, cache_creation_tokens bigint, total_tokens bigint)
language sql stable as $$
  select u.role, u.provider, u.model,
         count(*) filter (where u.status = 'ok'),
         count(*) filter (where u.status = 'error'),
         count(*) filter (where u.fallback_from is not null),
         round(avg(u.latency_ms) filter (where u.status = 'ok')),
         percentile_cont(0.95) within group (order by u.latency_ms)
           filter (where u.status = 'ok' and u.latency_ms is not null),
         coalesce(sum(u.input_tokens), 0),
         coalesce(sum(u.output_tokens), 0),
         coalesce(sum(u.cache_read_input_tokens), 0),
         coalesce(sum(u.cache_creation_input_tokens), 0),
         coalesce(sum(u.total_tokens), 0)
  from token_usage u
  where u.created_at >= p_since and (p_handle is null or u.handle = p_handle)
  group by u.role, u.provider, u.model
  order by 4 desc;
$$;

-- ---------------------------------------------------------------------------
-- RPC: hourly LLM call series over a window (overview + analytics sparklines)
-- ---------------------------------------------------------------------------
create or replace function llm_hourly(p_since timestamptz)
returns table(bucket timestamptz, calls bigint, errors bigint, fallbacks bigint,
              total_tokens bigint, avg_latency_ms numeric)
language sql stable as $$
  select date_trunc('hour', u.created_at),
         count(*) filter (where u.status = 'ok'),
         count(*) filter (where u.status = 'error'),
         count(*) filter (where u.fallback_from is not null),
         coalesce(sum(u.total_tokens), 0),
         round(avg(u.latency_ms) filter (where u.status = 'ok'))
  from token_usage u
  where u.created_at >= p_since
  group by 1
  order by 1;
$$;

-- ---------------------------------------------------------------------------
-- error_log: one row per DISTINCT failure (source|category|normalized message),
-- with repeat occurrences folded into `count` + `last_at` by the writer so an
-- error storm collapses into one row instead of thousands.
-- Deploy this BEFORE the code that uses it: the writer fails soft (console-only,
-- queue re-queued then dropped at cap) until the table exists.
-- ---------------------------------------------------------------------------
create table if not exists error_log (
  id          bigint generated always as identity primary key,
  severity    text not null default 'error',  -- warn | error | fatal
  source      text not null,                  -- WHO was working: convo|ops|fallfirm|pipeline|db|llm|webhook|process|budget|diagnostics|memory (LLM failures use the CALLING ROLE)
  category    text not null,                  -- WHAT broke: llm_error|truncation|timeout|tool_failure|send_failure|db_error|process_crash|voicing_failure|classifier_failure|turn_failure|retry_exhausted|llm_fallback|degraded|budget|floor_engaged|push_dropped|other
  message     text not null,                  -- writer caps at 2000 chars
  detail      jsonb,                          -- stack, provider/model, scope… writer caps at ~8KB
  chat_id     text,
  handle      text,
  task_id     text,
  fingerprint text not null,                  -- sha1(source|category|digit-normalized message) first 16 hex chars
  count       integer not null default 1,     -- occurrences folded into this row
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_errlog_created     on error_log(created_at desc);
create index if not exists idx_errlog_source      on error_log(source, created_at desc);
create index if not exists idx_errlog_category    on error_log(category, created_at desc);
create index if not exists idx_errlog_severity    on error_log(severity, created_at desc);
create index if not exists idx_errlog_fingerprint on error_log(fingerprint, created_at desc);
create index if not exists idx_errlog_handle      on error_log(handle, created_at desc);

alter table error_log enable row level security;

-- ---------------------------------------------------------------------------
-- RPC: prune the log (drop older than max age, and anything beyond the newest N)
-- ---------------------------------------------------------------------------
create or replace function error_log_prune(p_max_age_days int default 30, p_keep_rows int default 20000)
returns int language sql as $$
  with ranked as (
    select id,
           row_number() over (order by created_at desc) as rn,
           created_at
    from error_log
  ), del as (
    delete from error_log
    where id in (
      select id from ranked
      where rn > p_keep_rows or created_at < now() - make_interval(days => p_max_age_days)
    )
    returning 1
  )
  select count(*)::int from del;
$$;

-- ---------------------------------------------------------------------------
-- RPC: PER-DIMENSION rollups over a window — three independent group-bys
-- (source, category, severity) unioned into one long-form result, one row per
-- (dimension, value) bucket. `events` sums the folded `count` (occurrences: a
-- single row can stand for thousands); `rows` counts the folded rows behind it.
-- `rows` MUST stay double-quoted — ROWS is a reserved word in Postgres.
--
-- This shape is contractual and must stay in LOCKSTEP with both readers:
--   • getErrorStats in src/db/repositories/errorLog.ts (maps dimension/value/events/rows)
--   • memoryErrorStats in src/diagnostics/adminDashboard/api/errors.ts (the memory
--     backend's re-implementation — the two paths must be indistinguishable to the view)
-- Sort matches memoryErrorStats exactly: dimension ascending, then events descending.
-- ---------------------------------------------------------------------------
create or replace function error_log_stats(p_since timestamptz)
returns table(dimension text, value text, events bigint, "rows" bigint)
language sql stable as $$
  select 'source'::text, e.source, coalesce(sum(e.count), 0)::bigint, count(*)::bigint
    from error_log e where e.created_at >= p_since group by e.source
  union all
  select 'category'::text, e.category, coalesce(sum(e.count), 0)::bigint, count(*)::bigint
    from error_log e where e.created_at >= p_since group by e.category
  union all
  select 'severity'::text, e.severity, coalesce(sum(e.count), 0)::bigint, count(*)::bigint
    from error_log e where e.created_at >= p_since group by e.severity
  order by 1, 3 desc;
$$;

-- ---------------------------------------------------------------------------
-- RPC: top recurring fingerprints over a window, with the most recent message
-- of each group as the sample (the fold means messages within a fingerprint
-- differ only in digits, so the latest is representative). `events` sums the
-- folded `count`, not rows — the reader is getTopErrors in
-- src/db/repositories/errorLog.ts, which maps `events ?? count` (never `n`), so
-- this out-param name is contractual. Sort matches memoryTopErrors in
-- src/diagnostics/adminDashboard/api/errors.ts: events desc, then last_at desc.
-- ---------------------------------------------------------------------------
create or replace function error_log_top(p_since timestamptz, p_limit int default 15)
returns table(fingerprint text, source text, category text, severity text,
              sample_message text, events bigint, first_at timestamptz, last_at timestamptz)
language sql stable as $$
  select e.fingerprint,
         (array_agg(e.source   order by e.last_at desc))[1],
         (array_agg(e.category order by e.last_at desc))[1],
         (array_agg(e.severity order by e.last_at desc))[1],
         (array_agg(e.message  order by e.last_at desc))[1],
         coalesce(sum(e.count), 0)::bigint,
         min(e.first_at),
         max(e.last_at)
  from error_log e
  where e.created_at >= p_since
  group by e.fingerprint
  order by 6 desc, 8 desc
  limit least(coalesce(p_limit, 15), 50);
$$;

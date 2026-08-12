-- Project Maria — admin dashboard expansion (turn history + LLM analytics).
--   diagnostic_turn_history : one row per orchestration turn (the existing
--                             diagnostic_turns keeps ONLY the latest per key and is
--                             untouched — it stays the fast sidebar seed and the one
--                             place full `raw` wire payloads survive a restart).
--                             History rows are raw-stripped at save time and pruned
--                             by diagnostic_history_prune (keep N per key + max age).
--   token_usage additions   : latency/status/fallback columns so the durable call
--                             ledger can answer "how slow / how often did we fall
--                             back / what failed" — not just token sums. Existing
--                             rows remain valid status='ok' history with null latency.
--   RPCs                    : supabase-js has no GROUP BY; aggregates follow the
--                             repo's RPC convention (claim_due_automations,
--                             memory_medium_supersede, …).
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.
-- Deploy this BEFORE the code that uses it: new columns have defaults, and the
-- history writer fails soft (logged + swallowed) until the table exists.

-- ---------------------------------------------------------------------------
-- diagnostic_turn_history: one row per turn
-- ---------------------------------------------------------------------------
create table if not exists diagnostic_turn_history (
  id           bigint generated always as identity primary key,
  key          text not null,             -- chatId, or "handle:<handle>"
  turn_id      text not null,             -- boot-unique turn id (t<seq>.<boot>)
  chat_id      text,
  handle       text,
  source       text not null,             -- user | email | automation | system
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

-- Server uses the service-role key, which bypasses RLS; anon stays locked out.
alter table diagnostic_turn_history enable row level security;

-- ---------------------------------------------------------------------------
-- token_usage: latency / fallback / error columns (durable LLM call ledger)
-- ---------------------------------------------------------------------------
alter table token_usage add column if not exists latency_ms    integer;
alter table token_usage add column if not exists fallback_from text;  -- primary provider when this call ran on the fallback lane
alter table token_usage add column if not exists status        text not null default 'ok';  -- 'ok' | 'error'
alter table token_usage add column if not exists error         text;  -- capped message when status='error'

create index if not exists idx_token_usage_created on token_usage(created_at desc);

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
-- Replaces the latest-only listPersistedTurns seed (and its hardcoded turnCount=1).
-- ---------------------------------------------------------------------------
create or replace function diagnostic_history_keys(p_limit int default 300, p_offset int default 0)
returns table(key text, chat_id text, handle text, source text, trigger text, agents text[],
              event_count int, error_count int, started_at timestamptz, last_at timestamptz,
              turn_id text, turn_count bigint)
language sql stable as $$
  select * from (
    select distinct on (h.key)
           h.key, h.chat_id, h.handle, h.source, h.trigger, h.agents,
           h.event_count, h.error_count, h.started_at, h.last_at, h.turn_id,
           count(*) over (partition by h.key) as turn_count
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

-- Irises — durable agent-wide error log.
--   error_log : one row per DISTINCT failure (source|category|normalized message), with
--               repeat occurrences folded into `count` + `last_at` by the writer so an
--               error storm collapses into one row instead of thousands. This is the
--               first sink that survives a restart: before it, ~20 failure classes were
--               console-only (logDbError, dead Convo turns, failed Linq sends, process
--               crashes) or inferred from a trace-ring string sniff.
--   RPCs      : supabase-js has no GROUP BY; aggregates follow the repo's RPC convention
--               (diagnostic_history_prune, llm_role_stats, claim_due_automations, …).
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.
-- Deploy this BEFORE the code that uses it: the writer fails soft (console-only, queue
-- re-queued then dropped at cap) until the table exists, per the 0011 precedent.

-- ---------------------------------------------------------------------------
-- error_log: one row per folded failure fingerprint
-- ---------------------------------------------------------------------------
create table if not exists error_log (
  id          bigint generated always as identity primary key,
  severity    text not null default 'error',  -- warn | error | fatal
  source      text not null,                  -- WHO was working: convo|ops|judge|autonome|reflexion|mm|fallfirm|pipeline|db|llm|webhook|linq|process|budget|diagnostics|memory (LLM failures use the CALLING ROLE)
  category    text not null,                  -- WHAT broke: llm_error|truncation|timeout|tool_failure|send_failure|db_error|process_crash|voicing_failure|surfacing_failure|classifier_failure|transcription_failure|automation_failure|turn_failure|retry_exhausted|llm_fallback|degraded|budget|floor_engaged|push_dropped|other
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

-- Server uses the service-role key, which bypasses RLS; anon stays locked out.
-- No policies = no access for anyone but service_role (0011/0013 convention).
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

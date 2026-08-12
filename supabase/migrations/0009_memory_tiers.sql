-- Project Maria — three-tier memory storage (Stage 1 of the memory revamp).
--   memory_short  : 24h coherence tier — every Ops research result, MM media analysis,
--                   and Judge email flag, multi-entry and full-fidelity (replaces the
--                   latest-only prefs.recent_research / pending_email_contexts stashes).
--                   Ephemeral: read-time expiry filter + a swept hard delete is fine here.
--   memory_medium : weeks–years operational tier — conversationally-learned facts,
--                   directives, and important notes as first-class rows. Append-mostly
--                   ledger: rows are SUPERSEDED or RETRACTED, never deleted (the one
--                   sanctioned hard-delete lives in the /forget path, Stage 3).
--                   Replaces the prefs.directives / prefs.important_notes JSONB arrays,
--                   whose read-rebuild-write pattern had a concurrency clobber window;
--                   dedupe is now enforced by unique indexes, not application reads.
--   memory_long   : one free-form markdown doc per user (profile + how Maria should
--                   behave — the future "flexible prompt layer"), with every version
--                   snapshotted into memory_long_revisions. Replaces agent_memory.dossier_md
--                   (kept frozen until Stage 3's Reflexion migration completes).
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type memory_medium_kind as enum ('fact','directive','important_note');
exception when duplicate_object then null; end $$;

do $$ begin
  create type memory_medium_status as enum ('active','superseded','retracted');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- TIER 1: memory_short (24h chat coherence; ephemeral)
-- ---------------------------------------------------------------------------
create table if not exists memory_short (
  id           uuid primary key default gen_random_uuid(),
  agent_handle text not null,
  chat_id      text,                        -- set for chat-scoped entries (media reads)
  kind         text not null,               -- 'ops_research' | 'media_analysis' | 'email_flag'
  request      text,                        -- what was asked, verbatim
  content      text not null,               -- full-fidelity summary (app caps at 8000 chars)
  meta         jsonb not null default '{}', -- taskKind/attempt | emailId/severity/deadline…
  task_id      text,                        -- OpsTask/MmTask id, or gmail message id for flags
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '24 hours')
);

create index if not exists idx_memory_short_handle
  on memory_short(agent_handle, created_at desc);
create index if not exists idx_memory_short_expiry
  on memory_short(expires_at);
-- At-most-once per task/email even when a retrying pipeline re-inserts (the Judge's
-- at-least-once batch loop, an orchestrator retry). Partial so null task_ids never collide.
create unique index if not exists uq_memory_short_task
  on memory_short(agent_handle, kind, task_id)
  where task_id is not null;

alter table memory_short enable row level security;

-- ---------------------------------------------------------------------------
-- TIER 2: memory_medium (append-mostly ledger; supersede, never delete)
-- ---------------------------------------------------------------------------
create table if not exists memory_medium (
  id            uuid primary key default gen_random_uuid(),
  agent_handle  text not null,
  kind          memory_medium_kind not null,
  key           text,                       -- fact slot name (e.g. 'brokerage'); null for directive/note
  body          text not null,
  status        memory_medium_status not null default 'active',
  superseded_by uuid references memory_medium(id),
  source        text not null default 'convo',  -- 'convo' | 'migration' | 'system' | 'reflexion'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_memory_medium_active
  on memory_medium(agent_handle, kind, created_at)
  where status = 'active';
-- DB-enforced dedupe: a concurrent duplicate INSERT now fails with a unique violation
-- (which the app treats as "already saved") instead of silently clobbering a sibling.
create unique index if not exists uq_memory_medium_active_text
  on memory_medium(agent_handle, kind, lower(body))
  where status = 'active' and kind in ('directive','important_note');
-- One active value per fact slot.
create unique index if not exists uq_memory_medium_active_fact
  on memory_medium(agent_handle, key)
  where status = 'active' and kind = 'fact';

drop trigger if exists trg_memory_medium_updated on memory_medium;
create trigger trg_memory_medium_updated before update on memory_medium
  for each row execute function set_updated_at();

alter table memory_medium enable row level security;

-- Atomic fact upsert: supersede the active row and insert its replacement in ONE
-- transaction so the partial unique index is never violated mid-flight. No-op (returns
-- the existing row) when the value is unchanged.
create or replace function memory_medium_upsert_fact(
  p_handle text, p_key text, p_body text, p_source text default 'convo'
) returns memory_medium as $$
declare
  new_id  uuid := gen_random_uuid();
  new_row memory_medium;
begin
  select * into new_row from memory_medium
   where agent_handle = p_handle and kind = 'fact' and key = p_key and status = 'active';
  if found and new_row.body = p_body then
    return new_row;
  end if;
  update memory_medium set status = 'superseded', superseded_by = new_id
   where agent_handle = p_handle and kind = 'fact' and key = p_key and status = 'active';
  insert into memory_medium (id, agent_handle, kind, key, body, source)
  values (new_id, p_handle, 'fact', p_key, p_body, p_source)
  returning * into new_row;
  return new_row;
end;
$$ language plpgsql;

-- Atomic directive/note supersede: the "edit" operation is old-row-superseded plus a
-- new row, one transaction. Returns null when the id wasn't found active (caller voices
-- "couldn't find that one" instead of inventing success).
create or replace function memory_medium_supersede(
  p_handle text, p_old_id uuid, p_new_body text, p_source text default 'convo'
) returns memory_medium as $$
declare
  new_id  uuid := gen_random_uuid();
  k       memory_medium_kind;
  new_row memory_medium;
begin
  update memory_medium set status = 'superseded', superseded_by = new_id
   where id = p_old_id and agent_handle = p_handle and status = 'active'
  returning kind into k;
  if k is null then
    return null;
  end if;
  insert into memory_medium (id, agent_handle, kind, body, source)
  values (new_id, p_handle, k, p_new_body, p_source)
  returning * into new_row;
  return new_row;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- TIER 3: memory_long (one markdown doc per user) + full revision history
-- ---------------------------------------------------------------------------
create table if not exists memory_long (
  agent_handle text primary key,
  doc_md       text not null default '',
  version      int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists trg_memory_long_updated on memory_long;
create trigger trg_memory_long_updated before update on memory_long
  for each row execute function set_updated_at();

create table if not exists memory_long_revisions (
  agent_handle text not null,
  version      int  not null,
  doc_md       text not null,
  written_by   text not null default 'system',  -- 'dossier_llm' | 'migration' | 'reflexion' | 'forget'
  created_at   timestamptz not null default now(),
  primary key (agent_handle, version)
);

alter table memory_long enable row level security;
alter table memory_long_revisions enable row level security;

-- Optimistic-concurrency save: bump the version and snapshot the new doc into revisions.
-- Returns the new version, or null when p_expected_version is stale (caller re-reads,
-- re-merges, retries once). Nothing is ever lost: every accepted write leaves a revision.
create or replace function memory_long_save(
  p_handle text, p_doc text, p_expected_version int, p_written_by text default 'system'
) returns int as $$
declare v int;
begin
  insert into memory_long (agent_handle, doc_md, version)
  values (p_handle, p_doc, 1)
  on conflict (agent_handle) do update
    set doc_md = excluded.doc_md, version = memory_long.version + 1
    where memory_long.version = p_expected_version
  returning version into v;
  if v is null then
    return null;
  end if;
  insert into memory_long_revisions (agent_handle, version, doc_md, written_by)
  values (p_handle, v, p_doc, p_written_by)
  on conflict (agent_handle, version) do nothing;
  return v;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- One-time backfill from agent_memory.prefs (idempotent; safe to re-run).
-- MECHANICAL copies only — the semantic curation of dossier content is Reflexion's
-- first-run job (Stage 3). Directives carry their original uuid ids, so a re-run
-- is a PK-conflict no-op; notes/facts rely on the partial unique indexes the same way.
-- ---------------------------------------------------------------------------
insert into memory_medium (id, agent_handle, kind, body, source, created_at)
select (d->>'id')::uuid, am.handle, 'directive', d->>'text', 'migration',
       case when d->>'createdAt' ~ '^[0-9]+' then to_timestamp((d->>'createdAt')::numeric / 1000.0)
            else now() end
from agent_memory am,
     jsonb_array_elements(coalesce(am.prefs->'directives','[]'::jsonb)) d
where (d ? 'id') and (d ? 'text') and coalesce(d->>'text','') <> ''
      and (d->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict do nothing;

insert into memory_medium (agent_handle, kind, body, source, created_at)
select am.handle, 'important_note', n->>'note', 'migration',
       case when n->>'at' ~ '^[0-9]+' then to_timestamp((n->>'at')::numeric / 1000.0)
            else now() end
from agent_memory am,
     jsonb_array_elements(coalesce(am.prefs->'important_notes','[]'::jsonb)) n
where (n ? 'note') and coalesce(n->>'note','') <> ''
on conflict do nothing;

insert into memory_medium (agent_handle, kind, key, body, source)
select am.handle, 'fact', k.key, am.prefs->>k.key, 'migration'
from agent_memory am
cross join (values ('comms_style'),('business_state'),('brokerage'),('commission_split'),
                   ('market_area'),('preferred_lender'),('preferred_title'),('address_as')) k(key)
where am.prefs ? k.key
  and jsonb_typeof(am.prefs->k.key) = 'string'
  and length(am.prefs->>k.key) > 0
on conflict do nothing;

-- Seed the long doc with the raw legacy dossier so downstream renderers never start
-- sparse; Reflexion's first pass rewrites it properly (and leaves this as revision 1).
insert into memory_long (agent_handle, doc_md, version)
select handle, dossier_md, 1 from agent_memory where coalesce(dossier_md,'') <> ''
on conflict (agent_handle) do nothing;

insert into memory_long_revisions (agent_handle, version, doc_md, written_by)
select handle, 1, dossier_md, 'migration' from agent_memory where coalesce(dossier_md,'') <> ''
on conflict do nothing;

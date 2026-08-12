-- Project Maria — Reflexion agent state (Stage 3 of the memory revamp).
-- One row per user for the memory curator's own awareness:
--   self_prompt_md   : Reflexion's updatable self-prompt (focus areas, behavior patterns it
--                      noticed) — the read-write half of its rigid/flexible split. Advisory
--                      only; its Context.md values always outrank it.
--   self_prompt_revs : capped last-10 revision history [{md, note, at}] — the same
--                      never-destroy discipline as memory_long, kept inline (small doc).
--   last_daily_at    : last COMPLETED daily reflection pass.
--   last_run_at      : last completed run of any trigger (daily / delegated / self-wake).
--   migrated_at      : the legacy agent_memory row was rewritten into the tiers (set only
--                      after a run that actually wrote at least one tier entry).
-- Scheduling itself lives in the `automations` table (source='reflexion'); this row is memory.
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.

create table if not exists reflexion_state (
  handle           text primary key,
  self_prompt_md   text not null default '',
  self_prompt_revs jsonb not null default '[]'::jsonb,
  last_daily_at    timestamptz,
  last_run_at      timestamptz,
  migrated_at      timestamptz,
  updated_at       timestamptz not null default now()
);

drop trigger if exists trg_reflexion_state_updated on reflexion_state;
create trigger trg_reflexion_state_updated before update on reflexion_state
  for each row execute function set_updated_at();

alter table reflexion_state enable row level security;

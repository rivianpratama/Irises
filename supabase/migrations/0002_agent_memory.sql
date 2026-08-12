-- Project Maria — durable per-agent memory dossier + structured preferences.
-- The dossier is a living markdown document injected into the Convo agent's prompt;
-- prefs holds structured flags (onboarding state, gmail_declined, commission split, etc.).

create table if not exists agent_memory (
  handle     text primary key,
  dossier_md text not null default '',
  prefs      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create trigger trg_agent_memory_updated before update on agent_memory
  for each row execute function set_updated_at();

alter table agent_memory enable row level security;

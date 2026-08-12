-- ---------------------------------------------------------------------------
-- emails: the local search index over the user's mailbox. Populated by the
-- push/history pipeline (every message the Judge fetches), the sent-mail sweep,
-- and the search backfill — so Ops can search substrings/fields deterministically
-- (Gmail's own q has token-only matching, PST date walls, and no thread-wide
-- search). Content lives in body_text; haystack is the lowercased concatenation
-- of subject+from+to+body used for ILIKE/trigram matching.
-- ---------------------------------------------------------------------------
create table if not exists emails (
  handle          text not null,
  id              text not null,             -- Gmail message id
  thread_id       text,
  from_addr       text,
  to_addrs        text,                      -- comma-joined recipient list
  subject         text,
  snippet         text,
  body_text       text,
  haystack        text,                      -- lower(subject || from || to || body)
  labels          jsonb not null default '[]'::jsonb,
  attachments     jsonb not null default '[]'::jsonb, -- [{filename,mimeType,attachmentId,sizeBytes}]
  has_attachments boolean not null default false,
  internal_date   bigint not null default 0, -- Gmail internalDate (epoch ms)
  indexed_at      timestamptz not null default now(),
  primary key (handle, id)
);

create index if not exists idx_emails_handle_date on emails(handle, internal_date desc);
create index if not exists idx_emails_thread on emails(handle, thread_id);

-- Trigram index makes ILIKE '%term%' fast at mailbox scale (best-effort: skip
-- cleanly where the extension isn't available; ILIKE still works, just slower).
do $$
begin
  create extension if not exists pg_trgm;
  create index if not exists idx_emails_haystack_trgm on emails using gin (haystack gin_trgm_ops);
exception when others then
  raise notice 'pg_trgm unavailable; emails.haystack falls back to unindexed ILIKE';
end $$;

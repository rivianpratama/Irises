-- Irises — truncation ledger on token_usage.
-- Anthropic's stop_reason 'max_tokens' was never recorded anywhere (three guards only
-- checked OpenRouter's 'length'), so a token-starved reply looked identical to a healthy
-- one in the durable ledger: dossier rewrites persisted half-written, Judge marked urgent
-- mail "not important", Ops escalated at full cost for what was really a budget cut.
--   stop_reason     : the provider's raw stop/finish reason, verbatim.
--   max_tokens_sent : the cap actually sent (req.maxTokens ?? MAX_TOKENS[role]) — a tiny
--                     per-call cap binding over the role ceiling is the usual cause.
--   truncated       : normalized flag ('max_tokens' | 'length'), so aggregates can count
--                     truncation without provider-specific string tests.
-- Kept on token_usage (not a new status value) deliberately: llm_role_stats / llm_hourly
-- count status in ('ok','error') explicitly, so a third status would silently drop these
-- rows from every aggregate. Truncated calls stay status='ok' with this flag set.
-- Apply with: supabase db push   (or paste into the SQL editor). Idempotent.
-- Deploy this BEFORE the code that uses it: all three columns have defaults, and the
-- usage writer fails soft (logged + swallowed) until they exist.

alter table token_usage add column if not exists stop_reason     text;
alter table token_usage add column if not exists max_tokens_sent integer;
alter table token_usage add column if not exists truncated       boolean not null default false;

-- Partial index: truncation is the rare case, so the index stays small and the
-- "recent truncated calls" dashboard query never scans the full ledger.
create index if not exists idx_token_usage_truncated on token_usage(created_at desc) where truncated;

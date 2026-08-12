-- Irises — Turn cost picker: surface EVERY user chat, not just the chats
-- whose NEWEST turn happens to be a user message.
--
-- Bug: the sidebar seed (diagnostic_history_keys) returns ONE row per key — the
-- LATEST turn — and the dashboard client keeps a chat only when that representative
-- turn's source is 'user'. Irises's automated flows (Autonome proactive sends,
-- Reflexion / system sweeps) frequently land as the newest turn on a real chat, so
-- those chats fall out of the Turn cost picker even though the user has messaged
-- many times. Net effect in prod: often a single chat shows.
--
-- Fix (read-only, additive): the RPC now also reports, per key —
--   user_turn_count : how many of the key's turns were user-sourced (the real gate),
--   any_handle      : a partition-wide handle, so a chat whose newest turn is an
--   any_chat_id       automation event that carried neither still displays/scopes right.
-- The representative row (source, trigger, last_at, agents, …) is UNCHANGED, so the
-- shared /api/state — and the Orchestration view that also consumes it — behaves
-- exactly as before; only NEW columns are added. Apply with: supabase db push.
--
-- The RETURNS TABLE signature changes, so the function must be dropped first
-- (CREATE OR REPLACE cannot alter output columns). Idempotent.

drop function if exists diagnostic_history_keys(int, int);

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

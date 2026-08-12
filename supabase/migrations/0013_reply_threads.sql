-- ---------------------------------------------------------------------------
-- Thread-aware tapped-reply resolution. When a user taps reply on a bubble,
-- iMessage collapses the reply to the THREAD ROOT id — and because Irises's
-- Ops-delivered answers are themselves sent threaded to the user's originating
-- question (anchorFirstTo), that root is the USER'S OWN earlier message id, not
-- Irises's bubble. sent_messages only indexes Irises's outbound bubbles, so those
-- taps used to resolve to null and the turn silently misattributed the reply.
--
-- 1) sent_messages.reply_root_id: the inbound id a Irises bubble was anchored to
--    when sent — the join key from a thread-root reply back to her answer bubbles.
-- 2) inbound_messages: message_id -> text of the user's OWN text-bearing messages,
--    so a thread-root reply_to resolves to the message that opened the exchange.
-- Ephemeral (~7 days), mirroring sent_messages.
-- ---------------------------------------------------------------------------

alter table sent_messages add column if not exists reply_root_id text;
create index if not exists idx_sent_messages_reply_root
  on sent_messages(chat_id, reply_root_id) where reply_root_id is not null;

create table if not exists inbound_messages (
  message_id    text primary key,
  chat_id       text not null,
  sender_handle text,
  content       text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days'
);
create index if not exists idx_inbound_messages_chat
  on inbound_messages(chat_id, created_at desc);

-- Enable RLS to match the project convention (0001/0002/0004/0005/0009/0010/0011). The app connects
-- with the service_role key, which BYPASSES RLS, so this changes nothing for the server — it only
-- denies anon/authenticated keys, which is correct for a server-only table. No policies = no access
-- for anyone but service_role. Idempotent, so re-running the migration is safe.
alter table inbound_messages enable row level security;

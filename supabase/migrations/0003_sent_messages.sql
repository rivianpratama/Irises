-- ---------------------------------------------------------------------------
-- sent_messages: the Linq message_id of each bubble Maria sends, mapped to its
-- text. Lets an inbound reply_to.message_id be resolved back to the bubble the
-- user is replying to, so Maria can answer in that context. Ephemeral (~7 days).
-- ---------------------------------------------------------------------------
create table if not exists sent_messages (
  message_id text primary key,
  chat_id    text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index if not exists idx_sent_messages_chat on sent_messages(chat_id, created_at desc);

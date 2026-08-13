// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Inbound-message index: the user's own message ids resolve to their text only
// inside the chat they arrived in (cross-chat isolation), expire past the TTL,
// and the index prunes on write so it never grows unbounded.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recordInboundMessage, lookupInboundMessage } from './inboundMessages.js';
import { resetStorageForTests, stmt } from '../sqlite.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function backdate(messageId: string, toMsAgo: number): void {
  stmt('UPDATE inbound_messages SET created_at = ? WHERE message_id = ?').run(Date.now() - toMsAgo, messageId);
}

beforeEach(() => resetStorageForTests());

test('lookupInboundMessage resolves within the same chat, with sender', async () => {
  await recordInboundMessage('chat-a', 'msg-1', 'can you pull up the notes from Tuesday?', '+15551234');
  assert.deepEqual(await lookupInboundMessage('msg-1', 'chat-a'), { content: 'can you pull up the notes from Tuesday?', senderHandle: '+15551234' });
});

test('lookupInboundMessage refuses a message_id recorded for a DIFFERENT chat', async () => {
  await recordInboundMessage('chat-a', 'msg-1', 'private text from chat A');
  assert.equal(await lookupInboundMessage('msg-1', 'chat-b'), null);
});

test('lookupInboundMessage requires both ids and skips empty content', async () => {
  await recordInboundMessage('chat-a', 'msg-1', 'text');
  await recordInboundMessage('chat-a', 'msg-2', ''); // empty content is not indexed
  assert.equal(await lookupInboundMessage('', 'chat-a'), null);
  assert.equal(await lookupInboundMessage('msg-1', ''), null);
  assert.equal(await lookupInboundMessage('msg-2', 'chat-a'), null);
});

test('an entry older than the TTL resolves to null', async () => {
  await recordInboundMessage('chat-a', 'old', 'stale text');
  backdate('old', TTL_MS + 1_000);
  assert.equal(await lookupInboundMessage('old', 'chat-a'), null);
});

test('prune on write: expired entries hard-delete and size stays bounded', async () => {
  await recordInboundMessage('chat-a', 'expired', 'gone soon');
  backdate('expired', TTL_MS + 1_000);
  await recordInboundMessage('chat-a', 'fresh', 'still here');
  const rows = stmt('SELECT message_id FROM inbound_messages').all() as unknown as Array<{ message_id: string }>;
  assert.deepEqual(rows.map(r => r.message_id), ['fresh'], 'expired entry pruned on write');
});

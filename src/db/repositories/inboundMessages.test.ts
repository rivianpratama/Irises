// Run with: npm test   (TZ=UTC tsx --test)
// Inbound-message index on the in-memory backend: the user's own message ids resolve to their text
// only inside the chat they arrived in (cross-chat isolation), expire past the TTL, and the in-memory
// twin prunes on write so it never grows unbounded.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInboundMessage, lookupInboundMessage } from './inboundMessages.js';
import { mem } from '../memory.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

test('lookupInboundMessage resolves within the same chat, with sender', async () => {
  mem.inboundMessages.clear();
  await recordInboundMessage('chat-a', 'msg-1', 'can you pull up the notes from Tuesday?', '+15551234');
  assert.deepEqual(await lookupInboundMessage('msg-1', 'chat-a'), { content: 'can you pull up the notes from Tuesday?', senderHandle: '+15551234' });
});

test('lookupInboundMessage refuses a message_id recorded for a DIFFERENT chat', async () => {
  mem.inboundMessages.clear();
  await recordInboundMessage('chat-a', 'msg-1', 'private text from chat A');
  assert.equal(await lookupInboundMessage('msg-1', 'chat-b'), null);
});

test('lookupInboundMessage requires both ids and skips empty content', async () => {
  mem.inboundMessages.clear();
  await recordInboundMessage('chat-a', 'msg-1', 'text');
  await recordInboundMessage('chat-a', 'msg-2', ''); // empty content is not indexed
  assert.equal(await lookupInboundMessage('', 'chat-a'), null);
  assert.equal(await lookupInboundMessage('msg-1', ''), null);
  assert.equal(await lookupInboundMessage('msg-2', 'chat-a'), null);
});

test('an entry older than the TTL resolves to null', async () => {
  mem.inboundMessages.clear();
  await recordInboundMessage('chat-a', 'old', 'stale text');
  const hit = mem.inboundMessages.get('old')!;
  hit.at = Date.now() - TTL_MS - 1_000; // backdate past the TTL
  assert.equal(await lookupInboundMessage('old', 'chat-a'), null);
});

test('the in-memory twin prunes on write: expired entries drop and size stays bounded', async () => {
  mem.inboundMessages.clear();
  // Seed an expired entry, then a fresh write should prune it.
  await recordInboundMessage('chat-a', 'expired', 'gone soon');
  mem.inboundMessages.get('expired')!.at = Date.now() - TTL_MS - 1_000;
  await recordInboundMessage('chat-a', 'fresh', 'still here');
  assert.equal(mem.inboundMessages.has('expired'), false, 'expired entry pruned on write');
  assert.equal(mem.inboundMessages.has('fresh'), true);
});

// Run with: npm test   (TZ=UTC tsx --test)
// Sent-bubble reply resolution on the in-memory backend: a reply target resolves only
// inside the chat it arrived in — a message_id recorded for another chat must never
// inject that chat's text into this one's prompt (cross-chat isolation).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { recordSentBubble, lookupSentBubble, listSentBubblesByReplyRoot } from './sentMessages.js';
import { mem } from '../memory.js';

test('lookupSentBubble resolves within the same chat', async () => {
  mem.sentMessages.clear();
  await recordSentBubble('chat-a', 'msg-1', 'the trip notes are ready');
  assert.equal(await lookupSentBubble('msg-1', 'chat-a'), 'the trip notes are ready');
});

test('lookupSentBubble refuses a message_id recorded for a DIFFERENT chat', async () => {
  mem.sentMessages.clear();
  await recordSentBubble('chat-a', 'msg-1', 'private text from chat A');
  assert.equal(await lookupSentBubble('msg-1', 'chat-b'), null);
});

test('lookupSentBubble requires both ids', async () => {
  mem.sentMessages.clear();
  await recordSentBubble('chat-a', 'msg-1', 'text');
  assert.equal(await lookupSentBubble('', 'chat-a'), null);
  assert.equal(await lookupSentBubble('msg-1', ''), null);
});

// ── listSentBubblesByReplyRoot (thread-aware resolution join) ─────────────────

test('listSentBubblesByReplyRoot returns a root\'s answer bubbles in send order', async () => {
  mem.sentMessages.clear();
  // Two bubbles answering the user's question "user-q", plus an unrelated bubble.
  await recordSentBubble('chat-a', 'a1', 'checking the calendar now', 'user-q');
  await new Promise(r => setTimeout(r, 2)); // keep `at` strictly increasing for a stable sort
  await recordSentBubble('chat-a', 'a2', 'you are free after 3pm', 'user-q');
  await recordSentBubble('chat-a', 'b1', 'unrelated bubble', 'other-q');
  const bubbles = await listSentBubblesByReplyRoot('user-q', 'chat-a');
  assert.deepEqual(bubbles, ['checking the calendar now', 'you are free after 3pm']);
});

test('listSentBubblesByReplyRoot excludes un-anchored bubbles and other chats', async () => {
  mem.sentMessages.clear();
  await recordSentBubble('chat-a', 'a1', 'anchored to root', 'user-q');
  await recordSentBubble('chat-a', 'a2', 'no anchor at all');           // replyRootId undefined
  await recordSentBubble('chat-b', 'b1', 'other chat, same root', 'user-q');
  const bubbles = await listSentBubblesByReplyRoot('user-q', 'chat-a');
  assert.deepEqual(bubbles, ['anchored to root']);
});

test('listSentBubblesByReplyRoot honors the cap and requires both ids', async () => {
  mem.sentMessages.clear();
  for (let i = 0; i < 5; i++) {
    await recordSentBubble('chat-a', `m${i}`, `bubble ${i}`, 'user-q');
    await new Promise(r => setTimeout(r, 1));
  }
  assert.equal((await listSentBubblesByReplyRoot('user-q', 'chat-a', 3)).length, 3);
  assert.deepEqual(await listSentBubblesByReplyRoot('', 'chat-a'), []);
  assert.deepEqual(await listSentBubblesByReplyRoot('user-q', ''), []);
});

// send_reaction `re` targeting: the model can tapback a specific numbered [msg N] on a burst. The
// envelope schema flattens tool args to strings, so `re` usually arrives as "2"; processConvoResult
// coerces it (coerceReactionIndex) and index.ts resolves it to an id (resolveReactionTarget, tested in
// state/replyThreading.test.ts). Here: the dispatch-level parse into ChatResponse.reaction.
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, coerceReactionIndex, type ChatContext } from './shared.js';
import { STANDARD_REACTION_TYPES } from './tools.js';
import { getConversation } from '../../db/repositories/conversations.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}

const reaction = (input: Record<string, unknown>): LlmToolCall => ({ name: 'send_reaction', input });

function baseArgs() {
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}` };
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
}

// ── coerceReactionIndex (pure) ───────────────────────────────────────────────

test('coerceReactionIndex: numbers, numeric strings, and garbage', () => {
  assert.equal(coerceReactionIndex(2), 2);
  assert.equal(coerceReactionIndex('2'), 2);
  assert.equal(coerceReactionIndex(' 3 '), 3);
  assert.equal(coerceReactionIndex(0), undefined);      // 1-based
  assert.equal(coerceReactionIndex(-1), undefined);
  assert.equal(coerceReactionIndex(1.5), undefined);    // non-integer
  assert.equal(coerceReactionIndex('two'), undefined);
  assert.equal(coerceReactionIndex(null), undefined);
  assert.equal(coerceReactionIndex(undefined), undefined);
  assert.equal(coerceReactionIndex(100), undefined);    // past MAX_RE
});

// ── dispatch into ChatResponse.reaction ──────────────────────────────────────

test('numeric-string re → reaction carries the integer index', async () => {
  __resetOpsCoordination();
  const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type: 'like', re: '2' })]), textToSend: 'x' });
  assert.deepEqual(out.reaction, { type: 'like', re: 2 });
});

test('numeric re → carried as-is', async () => {
  __resetOpsCoordination();
  const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type: 'love', re: 1 })]), textToSend: 'x' });
  assert.deepEqual(out.reaction, { type: 'love', re: 1 });
});

test('no re → plain reaction, untargeted (falls back to latest downstream)', async () => {
  __resetOpsCoordination();
  const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type: 'like' })]), textToSend: 'x' });
  assert.deepEqual(out.reaction, { type: 'like' });
});

test('malformed re is dropped but the reaction still fires', async () => {
  __resetOpsCoordination();
  const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type: 'emphasize', re: 'two' })]), textToSend: 'x' });
  assert.deepEqual(out.reaction, { type: 'emphasize' });
});

test('custom-emoji arm carries re too', async () => {
  __resetOpsCoordination();
  const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type: 'custom', emoji: '🔥', re: '3' })]), textToSend: 'x' });
  assert.deepEqual(out.reaction, { type: 'custom', emoji: '🔥', re: 3 });
});

// ── the type guard ───────────────────────────────────────────────────────────
// The old parse was a NEGATIVE test (`input.type !== 'custom'`), so every value that wasn't the
// string 'custom' — a missing type, a hallucinated 'wave' — became a Reaction whose type was
// whatever the model wrote. That is how `[reacted with undefined]` reached the live transcript.
// A tapback glyph is a closed set: an unknown one is dropped, and the turn records nothing.

async function reactionHistory(chatId: string): Promise<string[]> {
  return (await getConversation(chatId)).map(m => m.content);
}

test('a missing type is dropped — no reaction, no history line', async () => {
  __resetOpsCoordination();
  const args = baseArgs();
  const out = await processConvoResult({ ...args, res: makeResult([], [reaction({})]), textToSend: 'x' });
  assert.equal(out.reaction, null);
  assert.equal((await reactionHistory(args.chatId)).some(c => c.includes('[reacted with')), false);
});

test('an unknown tapback type is dropped — no reaction, no history line', async () => {
  __resetOpsCoordination();
  const args = baseArgs();
  const out = await processConvoResult({ ...args, res: makeResult([], [reaction({ type: 'wave' })]), textToSend: 'x' });
  assert.equal(out.reaction, null);
  assert.equal((await reactionHistory(args.chatId)).some(c => c.includes('[reacted with')), false);
});

test('custom with no emoji is dropped — no reaction, no history line', async () => {
  __resetOpsCoordination();
  const args = baseArgs();
  const out = await processConvoResult({ ...args, res: makeResult([], [reaction({ type: 'custom' })]), textToSend: 'x' });
  assert.equal(out.reaction, null);
  assert.equal((await reactionHistory(args.chatId)).some(c => c.includes('[reacted with')), false);
});

test('every standard type still survives the guard', async () => {
  for (const type of STANDARD_REACTION_TYPES) {
    __resetOpsCoordination();
    const out = await processConvoResult({ ...baseArgs(), res: makeResult([], [reaction({ type })]), textToSend: 'x' });
    assert.deepEqual(out.reaction, { type }, type);
  }
});

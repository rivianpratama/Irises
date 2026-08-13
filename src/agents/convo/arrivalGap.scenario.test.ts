// End-to-end (unit-level) replay of the stale-queued-message scenario the arrival-gap feature exists
// for: a short question arrives while Ops is mid-delivery, a progress ping and the completion land
// AFTER it, and Convo's turn for it must (a) be told the true order — the message predates those
// sends — and (b) be licensed to stand down (react / say nothing) instead of re-answering. Exercises
// the REAL modules end to end: outboundLog → mergeBurst → arrivals (as index.ts computes them) →
// buildSystemPrompt → processConvoResult → resolveReactionTarget.
process.env.DATA_BACKEND = 'memory';
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { noteSend, countSendsSince, __resetOutboundLog } from '../../state/outboundLog.js';
import { mergeBurst } from '../../state/burstMerge.js';
import { resolveReactionTarget } from '../../state/replyThreading.js';
import { buildSystemPrompt, processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import type { StoredMessage } from '../../state/conversation.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// The thread as recorded by the time Convo's turn acquires the lock: holding line, ping 1 (seen by
// the user before they typed), then ping 2 + completion (sent AFTER their question queued).
const history: StoredMessage[] = [
  { role: 'assistant', content: 'got it pulling that up now', at: 2000 },
  { role: 'assistant', content: "this one's taking a bit more digging", at: 3000 },
  { role: 'assistant', content: 'their site is being slow about it', at: 4000 },
  { role: 'assistant', content: 'took some digging but here it is — confirmed, in full', at: 5000 },
];

function seedSends() {
  __resetOutboundLog();
  const chatId = randomUUID();
  // Every outbound above went through sendBubbles → noteSend, same clock as receivedAt.
  noteSend(chatId, 2000); // holding line
  noteSend(chatId, 3000); // ping 1 — on their screen when they typed
  noteSend(chatId, 4000); // ping 2 — landed after their question queued
  noteSend(chatId, 5000); // completion — landed after their question queued
  return chatId;
}

const ctx = (arrivals: ChatContext['arrivals']): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null,
  senderHandle: '+15550001111', arrivals,
});

test('scenario: a question queued mid-delivery is flagged with the true order and the stand-down license', () => {
  const chatId = seedSends();

  // Their "how" arrived at 3500 — after ping 1, before ping 2 and the completion.
  const merged = mergeBurst([{ from: '+15550001111', text: 'how', messageId: 'msg-how', media: emptyMedia(), receivedAt: 3500 }]);
  assert.deepEqual(merged.manifest, [{ text: 'how', handle: '+15550001111', receivedAt: 3500 }]);

  // arrivals exactly as index.ts computes them post-drain.
  const arrivals = merged.manifest.map(m => ({
    receivedAt: m.receivedAt,
    sendsAfterArrival: m.receivedAt > 0 ? countSendsSince(chatId, m.receivedAt) : 0,
  }));
  assert.deepEqual(arrivals, [{ receivedAt: 3500, sendsAfterArrival: 2 }], 'ping 2 + completion count; ping 1 (already seen) does not');

  // The reply-quote anchor agrees (gapped), same signal, same log.
  assert.equal(merged.earliestReceivedAt > 0 && countSendsSince(chatId, merged.earliestReceivedAt) > 0, true);

  const prompt = buildSystemPrompt(ctx(arrivals), '', [], undefined, undefined, history, 'how', undefined);
  assert.match(prompt, /## Timing note — their message is OLDER than your latest sends/);
  assert.match(prompt, /typed BEFORE the last 2 messages you sent/);
  assert.match(prompt, /do NOT answer it again/);
  assert.match(prompt, /send_reaction/);
  assert.ok(!prompt.includes('## What their new message is landing on'),
    'the normal landing note (which would claim the message arrived AFTER those sends) is replaced');
});

test('scenario: the model stands down with a reaction-only envelope → tapback lands on that message', async () => {
  __resetOpsCoordination();
  const toolCalls: LlmToolCall[] = [{ name: 'send_reaction', input: { type: 'like' } }];
  const res: LlmResult = {
    text: JSON.stringify({ confidence_level: 90, tool_calls: [{ name: 'send_reaction', args: { type: 'like' } }], bubbles: [] }),
    toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test',
  };
  const chatContext = ctx([{ receivedAt: 3500, sendsAfterArrival: 2 }]);
  const out = await processConvoResult({ chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history, media: emptyMedia(), res, textToSend: 'how' });

  assert.equal(out.text, null, 'no bubbles — silence plus the tapback IS the reply');
  assert.deepEqual(out.reaction, { type: 'like' });
  // index.ts resolves the target: single-message turn → falls back to that message's own id.
  assert.equal(resolveReactionTarget(out.reaction?.re, ['msg-how'], 'msg-how'), 'msg-how');
});

test('scenario control: the same question arriving AFTER everything delivered gets the normal regime', () => {
  const chatId = seedSends();
  const merged = mergeBurst([{ from: '+15550001111', text: 'how', messageId: 'msg-how2', media: emptyMedia(), receivedAt: 6000 }]);
  const arrivals = merged.manifest.map(m => ({
    receivedAt: m.receivedAt,
    sendsAfterArrival: m.receivedAt > 0 ? countSendsSince(chatId, m.receivedAt) : 0,
  }));
  assert.deepEqual(arrivals, [{ receivedAt: 6000, sendsAfterArrival: 0 }]);
  assert.equal(countSendsSince(chatId, merged.earliestReceivedAt) > 0, false, 'not gapped');

  const prompt = buildSystemPrompt(ctx(arrivals), '', [], undefined, undefined, history, 'how', undefined);
  assert.ok(!prompt.includes('## Timing note'), 'no stale flag when nothing was sent past it');
  assert.match(prompt, /## What their new message is landing on/, 'the ordinary landing note still renders');
});

test('scenario: burst where only the older message is stale → only it is named, re-targeting offered', () => {
  const chatId = seedSends();
  const merged = mergeBurst([
    { from: '+15550001111', text: 'how', messageId: 'msg-how', media: emptyMedia(), receivedAt: 3500 },
    { from: '+15550001111', text: 'also send me the doc', messageId: 'msg-doc', media: emptyMedia(), receivedAt: 6000 },
  ]);
  const arrivals = merged.manifest.map(m => ({
    receivedAt: m.receivedAt,
    sendsAfterArrival: m.receivedAt > 0 ? countSendsSince(chatId, m.receivedAt) : 0,
  }));
  assert.deepEqual(arrivals.map(a => a.sendsAfterArrival), [2, 0]);

  const prompt = buildSystemPrompt(ctx(arrivals), '', [], undefined, undefined, history, 'how\n\nalso send me the doc', undefined);
  // Scope assertions to the Timing-note section itself (the persona elsewhere legitimately mentions
  // [msg N] and the word BEFORE in unrelated rules).
  const sectionStart = prompt.indexOf('## Timing note');
  assert.ok(sectionStart >= 0, 'Timing note renders');
  const section = prompt.slice(sectionStart, prompt.indexOf('\n## ', sectionStart + 1) === -1 ? undefined : prompt.indexOf('\n## ', sectionStart + 1));
  assert.match(section, /\[msg 1\] was typed BEFORE the last 2 messages/);
  assert.ok(!section.includes('[msg 2]'), 'the fresh message is never flagged in the Timing note');
  assert.match(section, /set `re` to its number on send_reaction/);
  // And the model reacting to [msg 1] resolves to the stale message's id, not the latest.
  assert.equal(resolveReactionTarget(1, merged.incomingMessageIds, merged.lastMessageId), 'msg-how');
});

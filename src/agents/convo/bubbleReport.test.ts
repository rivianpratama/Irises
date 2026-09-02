// The hard-cap flag's attribution, at the seam it has to survive: a Convo turn returns
// `hardCapped` on its ChatResponse, and src/index.ts's send boundary reports THAT against the
// reply it ships (buildBubbleReport). The flag was a process-global tally first, drained at the
// boundary — so a cap fired by the Composer, by Fallfirm, by a discarded retry-validation parse or
// by a tool-call-only parse attached itself to whatever chat sent next, and two chats in flight
// raced for it (the chat lock is per-chat). These tests pin the per-parse attribution instead.
//
// Runs end-to-end against the ephemeral DB backend with no LLM: the plain reply path never calls a
// voicer, so nothing here reaches a provider (repo DI convention, same harness as silentTurn.test.ts).

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { parseReply, BUBBLE_HARD_CAP } from '../../pipeline/bubbleJson.js';
import type { LlmResult } from '../../llm/types.js';

// A social ask: the routing gate and the false-refusal floor both leave it alone, so the model's
// own bubbles are what ships and the flag has a delivered reply to describe.
const ASK = 'haha ok tell me a joke about cats';

function makeResult(bubbles: string[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

let seq = 0;
function args(textToSend = ASK) {
  __resetOpsCoordination();
  const sender = `+1555700${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return {
    chatId: randomUUID(),
    handle: chatContext.senderHandle!,
    chatContext,
    history: [],
    media: emptyMedia(),
    textToSend,
  };
}

test("a reply whose own parse hit the guard reports hardCapped, and it is that turn's reply", async () => {
  const out = await processConvoResult({ ...args(), res: makeResult(['one', 'two', 'three', 'four', 'five', 'six']) });
  assert.equal(out.hardCapped, true, 'the cap fired on the parse behind this very text');
  assert.equal(out.text!.split('\n---\n').length, BUBBLE_HARD_CAP, 'and the text it describes is the capped list');
});

test('a reply under the guard reports no cap', async () => {
  const out = await processConvoResult({ ...args(), res: makeResult(['one', 'two']) });
  assert.equal(out.hardCapped, false);
});

test("another agent's capped parse cannot flip the flag on an unrelated reply", async () => {
  // Stand-ins for every parse that runs through the same collectBubbles and is NOT a delivered
  // Convo reply: the Composer's re-voice, Fallfirm's voicers, callLLM's tool-call extraction, and
  // Convo's own retry-validation parse. Each owns its flag; none of them may colour the next send.
  const capped = JSON.stringify({ bubbles: ['a', 'b', 'c', 'd', 'e', 'f'].map(text => ({ text })) });
  assert.equal(parseReply(capped).hardCapped, true, 'the capped parse owns its own flag');
  assert.equal(parseReply(capped).hardCapped, true, 'and reading it again does not drain it');

  const out = await processConvoResult({ ...args(), res: makeResult(['sure', 'here it is']) });
  assert.equal(out.hardCapped, false, "a stranger's cap is not this reply's news");
});

// The acting half of an ask. A message can carry two parts — something to set up on the engine's
// side, and something to find out — and before `engine_actions` existed there was nowhere for the
// first part to travel: `request` distils ONE ask, so delegation shipped the research half and
// dropped the rest, with nothing downstream able to tell that a part was missing.
//
// End to end through processConvoResult with the model faked at the lane seam (the pattern of
// approvalGate.test.ts), so the task, the in-flight registry and the durable row are the live ones.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext, type ConvoTurnContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination, getActiveOps, markOpsStart } from '../../state/opsCoordination.js';
import { listPendingApprovals } from '../../db/repositories/opsTasks.js';
import { buildTaskPrompt } from '../ops/client.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

// The shape the incident had: one setup the engine performs on its own side, one thing to find out.
const SETUP = 'install the skill published at the url they gave and the CLI it needs';
const ASK = 'what the search APIs charge per 1,000 searches';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[] = []): LlmResult {
  const envelope = {
    confidence_level: 90,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', provider: 'anthropic', model: 'test' };
}

function delegate(input: Record<string, unknown>): LlmToolCall {
  return { name: 'delegate_to_ops', input: { kind: 'general', ...input } };
}

let seq = 0;
function args(textToSend: string) {
  __resetOpsCoordination();
  const sender = `+1555930${(seq++).toString().padStart(4, '0')}`;
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia(), textToSend };
}

const turn: ConvoTurnContext = {
  system: 'persona',
  messages: [{ role: 'user', content: 'hey' }],
  tools: [],
  call: async () => makeResult(['unused']),
};

test('a two-part ask carries the acting half on the task, in the order it was asked', async () => {
  const a = args(`set that skill up, then find ${ASK}`);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it — skill first, then the price'], [delegate({
      request: ASK, engine_actions: [SETUP, 'run the CLI once to confirm it answers'],
    })]),
    turn,
  });
  assert.ok(out.delegatedTask, 'the look goes out');
  assert.deepEqual(out.delegatedTask!.engineActions, [SETUP, 'run the CLI once to confirm it answers'],
    'both actions ride the task, in order, nothing dropped');
  assert.equal(out.delegatedTask!.request, ASK);
});

// The incident end to end, in one test: the whole ask leaves the turn, and the prompt the engine is
// handed carries the acting half as work to perform rather than as text it is told to disregard.
test('the task the turn built renders an engine prompt that carries both halves', async () => {
  const a = args(`set that skill up, then find ${ASK}`);
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: [SETUP] })]),
    turn,
  });
  const prompt = buildTaskPrompt(out.delegatedTask!, { now: Date.parse('2026-09-19T09:30:00Z'), tz: 'UTC' });
  assert.match(prompt, /Required actions \(do these first, they are part of the assignment, not optional\):/);
  assert.match(prompt, new RegExp(`^1\\. ${SETUP}$`, 'm'));
  assert.ok(prompt.indexOf(SETUP) < prompt.indexOf('<user_request>'), 'in the instruction layer');
  assert.match(prompt, /<user_request>[\s\S]*what the search APIs charge/, 'and the reading half is still the request');
});

test('the actions are tracked where the next turn can read them back', () => {
  __resetOpsCoordination();
  const chatId = randomUUID();
  markOpsStart(chatId, 'task-1', { kind: 'general', request: ASK, engineActions: [SETUP] });
  assert.deepEqual(getActiveOps(chatId)[0].engineActions, [SETUP]);
});

test('a run that was asked for no action carries the field not at all', () => {
  __resetOpsCoordination();
  const chatId = randomUUID();
  markOpsStart(chatId, 'task-2', { kind: 'web_research', request: ASK });
  assert.equal('engineActions' in getActiveOps(chatId)[0], false,
    'absent rather than empty — an ordinary run stays the bytes it was');
});

test('a garbled or empty actions argument leaves the field off rather than tracking nothing', async () => {
  for (const engine_actions of [[], ['', '   '], 'set it up', 7, null]) {
    const a = args('go find that');
    const out = await processConvoResult({
      ...a,
      res: makeResult(['looking'], [delegate({ request: ASK, engine_actions })]),
      turn,
    });
    assert.equal(out.delegatedTask!.engineActions, undefined, `${JSON.stringify(engine_actions)} tracks nothing`);
  }
});

// The approval gate exists for actions on the USER's accounts. An action on the engine's own
// environment is not one, and nothing in the side-effect lexicon reads it as one — so it runs
// straight through rather than parking behind a yes. Deliberate, and pinned here so it stays so.
test('an engine-side setup is not an act on the world: it starts, it does not park', async () => {
  const a = args('set that skill up and then look this up');
  const out = await processConvoResult({
    ...a,
    res: makeResult(['on it'], [delegate({ request: ASK, engine_actions: [SETUP] })]),
    turn,
  });
  assert.ok(out.delegatedTask, 'the task goes out for kickoff');
  assert.equal(out.delegatedTask!.effect, 'read');
  assert.equal(out.delegatedTask!.approval, undefined);
  assert.equal(listPendingApprovals(a.chatId).length, 0, 'no approval row');
});

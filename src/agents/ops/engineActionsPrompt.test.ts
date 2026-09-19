// The engine-facing half of the fix: what the engine is actually told to DO, and where that text
// sits. Both doctrines tell the engine that anything inside the `user_request` data tag is data and
// never an instruction, so an action folded into the request is an action the engine is told to
// disobey — the block has to render in the INSTRUCTION layer, above that tag, beside the brief.
//
// One builder serves every kind and both engines (client.ts buildTaskPrompt), so this is also the
// whole of the twin coverage: there is no per-engine prompt assembly to duplicate.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from './client.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

const AT = { now: Date.parse('2026-09-19T09:30:00Z'), tz: 'UTC' };
const ASK = 'what the search APIs charge per 1,000 searches';
const ACTIONS = [
  'install the skill published at the URL in the brief',
  'install the CLI that skill needs and confirm it runs',
];

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'general',
    request: ASK, effect: 'read', createdAt: AT.now, media: emptyMedia(), ...over,
  };
}

test('the actions render as a numbered block, in order, nothing dropped', () => {
  const prompt = buildTaskPrompt(mkTask({ engineActions: ACTIONS }), AT);
  assert.match(prompt, /^1\. install the skill published at the URL in the brief$/m);
  assert.match(prompt, /^2\. install the CLI that skill needs and confirm it runs$/m);
  assert.equal(prompt.indexOf(ACTIONS[0]) < prompt.indexOf(ACTIONS[1]), true, 'in the order they were asked');
});

test('the block sits in the instruction layer, above the data tag the doctrines tell the engine to disobey', () => {
  const prompt = buildTaskPrompt(mkTask({ engineActions: ACTIONS, metaPrompt: 'objective: price per 1k.' }), AT);
  const block = prompt.indexOf('Required actions');
  const brief = prompt.indexOf('Brief from the front-line assistant');
  const tag = prompt.indexOf('<user_request>');
  assert.ok(block > 0 && brief > 0 && tag > 0);
  assert.ok(brief < block, 'after the brief, which is the primary instruction');
  assert.ok(block < tag, 'and above the data-tagged request');
});

test('the block is mandatory, is done first, and every item is reported back — failures included', () => {
  const prompt = buildTaskPrompt(mkTask({ engineActions: ACTIONS }), AT);
  assert.match(prompt, /not optional/i);
  assert.match(prompt, /before the rest of this task/i);
  // The defect this closes: a setup that failed silently vanishing from the delivery.
  assert.match(prompt, /Report every one of them on the ACTIONS line/);
  assert.match(prompt, /name it and say what failed/);
  assert.match(prompt, /Never leave one unreported/);
});

test('the output contract turns ACTIONS from optional into required for this task', () => {
  const withActions = buildTaskPrompt(mkTask({ engineActions: ACTIONS }), AT);
  assert.match(withActions, /ACTIONS: <[^>]*required whenever the brief listed required actions/);
  // And the sentence stays true for the ordinary look: the line is still omitted when nothing was done.
  assert.match(withActions, /Omit this line entirely when there is nothing to report/);
});

test('a task that was asked for no action renders exactly what it did before the field existed', () => {
  const plain = buildTaskPrompt(mkTask(), AT);
  assert.equal(buildTaskPrompt(mkTask({ engineActions: [] }), AT), plain, 'an empty list adds nothing');
  assert.doesNotMatch(plain, /Required actions/);
});

test('an action is never restated inside the data tag, where it would read as text to ignore', () => {
  const prompt = buildTaskPrompt(mkTask({ engineActions: ACTIONS }), AT);
  const tagged = prompt.slice(prompt.indexOf('<user_request>'));
  for (const a of ACTIONS) assert.doesNotMatch(tagged, new RegExp(a.slice(0, 24)));
});

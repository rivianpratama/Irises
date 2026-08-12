// Coverage for update_directives END-STATE semantics (the person-who-remembers rule) and, above all,
// the NEVER-SILENT floor: a tool-only update_directives envelope (empty bubbles, no reaction) must
// still land an acknowledgment — a tapback where reactions exist, a short voiced line on SMS — so the
// turn can never vanish. Also guards the mechanism leak: no outcome brief may carry storage
// vocabulary for the voicer to pick up ("nothing saved yet, what preferences…").
// Runs against the in-memory backend; validateDirective's LLM leg fails open (regex already passed),
// and voiced outcomes degrade to the Fallfirm floor — both deterministic here.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processConvoResult, type ChatContext } from './shared.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { listMediumActive } from '../../db/repositories/memoryMedium.js';
import type { LlmResult, LlmToolCall } from '../../llm/types.js';

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}

function directives(op: 'add' | 'update' | 'remove', opts: { text?: string; match?: string } = {}): LlmToolCall {
  return { name: 'update_directives', input: { op, text: opts.text ?? null, match: opts.match ?? null } };
}

function ctx(): ChatContext {
  const handle = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
  return { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
}

const baseArgs = () => {
  const chatContext = ctx();
  return { chatId: randomUUID(), handle: chatContext.senderHandle!, chatContext, history: [], media: emptyMedia() };
};

test('a performed add is a CLEAN success — the model\'s own affirmation is the whole reply', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(['got it, no more bro'], [directives('add', { text: 'never call them bro' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'stop calling me bro' });

  // Nothing appended by an outcome voicer.
  assert.equal(out.text, 'got it, no more bro');
  const stored = await listMediumActive(a.handle, ['directive']);
  assert.deepEqual(stored.map(d => d.body), ['never call them bro']);
});

test('a remove targeting nothing stored is voiced honestly — never a fake confirmation', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  const res = makeResult(['got it, no more bro'], [directives('remove', { match: 'bro' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'stop calling me bro' });

  assert.notEqual(out.text, 'got it, no more bro', 'the optimistic text is corrected, not left standing');
  assert.equal(out.reaction, null, 'a voiced correction is its own reply — never also a tapback');
});

test('a genuinely ambiguous remove voices a question and retracts NOTHING', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  // Two stored rules both mention email — "drop my email preference" is genuinely ambiguous.
  await processConvoResult({ ...a, res: makeResult(['noted'], [directives('add', { text: 'always flag email from my manager' })]), textToSend: 'x' });
  await processConvoResult({ ...a, res: makeResult(['noted'], [directives('add', { text: 'ignore newsletter email' })]), textToSend: 'y' });

  const res = makeResult(['sure'], [directives('remove', { match: 'email' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'drop my email preference' });

  assert.notEqual(out.text, 'sure', 'a clarifying beat was appended');
  const stillActive = await listMediumActive(a.handle, ['directive']);
  assert.equal(stillActive.length, 2, 'nothing was retracted on an ambiguous ask');
});

test('no outcome brief carries storage vocabulary for the voicer to pick up', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  await processConvoResult({ ...a, res: makeResult(['noted'], [directives('add', { text: 'always flag email from my manager' })]), textToSend: 'x' });
  await processConvoResult({ ...a, res: makeResult(['noted'], [directives('add', { text: 'ignore newsletter email' })]), textToSend: 'y' });

  const res = makeResult(['sure'], [directives('remove', { match: 'email' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'drop my email preference' });

  // The floor/voiced text must never surface storage language (the regression this guards).
  for (const banned of ['saved', 'save ', 'settings', 'set a preference', 'nothing saved']) {
    assert.ok(!out.text!.toLowerCase().includes(banned), `voiced text leaked "${banned}": ${out.text}`);
  }
});

// ── Silent-turn regression: a tool-only update_directives (empty bubbles, no reaction) must never
// leave the user hanging. The incident: "stop using capitals" saved a directive and sent nothing.

test('tool-only directive success gets a tapback on iMessage (never a silent turn)', async () => {
  __resetOpsCoordination();
  const a = baseArgs(); // ctx() sets no service → treated as reaction-capable (iMessage/RCS)
  // Empty bubbles + a directive call, exactly the envelope the model produced in the incident.
  const res = makeResult([], [directives('add', { text: 'no capital letters, keep it all lowercase' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'stop using capitals' });

  assert.equal(out.text, null, 'no synthesized text — the acknowledgment is a tapback');
  assert.deepEqual(out.reaction, { type: 'like' }, 'a like tapback acknowledges the saved preference');
  const stored = await listMediumActive(a.handle, ['directive']);
  assert.deepEqual(stored.map(d => d.body), ['no capital letters, keep it all lowercase'], 'the directive actually persisted');
});

test('tool-only directive success voices a line on SMS (no reactions there)', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  a.chatContext.service = 'SMS';
  const res = makeResult([], [directives('add', { text: 'text me only in the morning' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'only text me in the mornings' });

  assert.ok(out.text && out.text.trim().length > 0, 'SMS gets a voiced acknowledgment, not a dropped turn');
  assert.equal(out.reaction, null, 'no reaction on SMS');
  // Still no storage-vocabulary leak in the voiced floor.
  for (const banned of ['saved', 'settings', 'preference stored', 'nothing saved']) {
    assert.ok(!out.text!.toLowerCase().includes(banned), `voiced text leaked "${banned}": ${out.text}`);
  }
});

test('a tool-only UPDATE of an existing directive also gets the acknowledgment beat', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  await processConvoResult({ ...a, res: makeResult(['noted'], [directives('add', { text: 'use lots of caps for emphasis' })]), textToSend: 'x' });

  const res = makeResult([], [directives('update', { match: 'caps', text: 'no capital letters, keep it all lowercase' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'stop using capitals' });

  assert.equal(out.text, null, 'no synthesized text — the acknowledgment is a tapback');
  assert.deepEqual(out.reaction, { type: 'like' });
  const stored = await listMediumActive(a.handle, ['directive']);
  assert.deepEqual(stored.map(d => d.body), ['no capital letters, keep it all lowercase'], 'the directive was actually changed');
});

test('the acknowledgment floor never overrides the model\'s own beat', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  // Model wrote its own confirmation bubble alongside the directive → floor must stay out.
  const res = makeResult(['got it, all lowercase from here'], [directives('add', { text: 'keep everything lowercase' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'lowercase please' });

  assert.equal(out.text, 'got it, all lowercase from here');
  assert.equal(out.reaction, null, 'no floor tapback added when the model already spoke');
});

test('an empty no-op directive is NOT falsely acknowledged (and trips no reaction)', async () => {
  __resetOpsCoordination();
  const a = baseArgs();
  // add with empty text is a pure no-op — acted:false, so no tapback, no voiced line.
  const res = makeResult([], [directives('add', { text: '' })]);
  const out = await processConvoResult({ ...a, res, textToSend: 'hey' });

  assert.equal(out.text, null, 'nothing to acknowledge → no synthesized text');
  assert.equal(out.reaction, null, 'nothing acted on → no floor tapback');
  const stored = await listMediumActive(a.handle, ['directive']);
  assert.equal(stored.length, 0, 'no directive stored for an empty no-op');
});

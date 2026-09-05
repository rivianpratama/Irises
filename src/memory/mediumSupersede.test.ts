// The medium-tier contradiction pass: when a NEW standing rule or remembered fact lands, the entries
// it reverses or makes obsolete are retired with lineage instead of left stacked beside it.
//
// What is proven here, in order: the classify leg is a SUGGESTER whose every answer is re-validated
// against the rows it was shown (out-of-range numbers, the new entry itself, the other kind);
// every failure mode — garbage, a timeout, a thrown lane, the flag off — retires NOTHING; and the
// two live entry points (update_directives add/update, set_preference important_note) reach it
// end-to-end through processConvoResult with the groomer still running behind it.
process.env.DATA_BACKEND = 'memory';
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  mediumSupersedeEnabled, planSupersessions, supersedeContradicted,
  __setSupersedeLlmForTests,
} from './mediumSupersede.js';
import {
  addDirective, addImportantNote, listMediumActive, listMediumAll,
  type MediumEntry,
} from '../db/repositories/memoryMedium.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { processConvoResult, type ChatContext } from '../agents/convo/shared.js';
import { emptyMedia } from '../webhook/types.js';
import { __resetOpsCoordination } from '../state/opsCoordination.js';
import type { LlmResult, LlmToolCall } from '../llm/types.js';

let seq = 0;
const freshHandle = () => `+1555600${(seq++).toString().padStart(4, '0')}`;

/** A fake classify lane that answers with `text`, and counts how often it was asked. */
function fakeLlm(text: string) {
  const calls: Array<{ system: string; user: string; maxTokens?: number; role: string }> = [];
  const llm = async (req: any): Promise<any> => {
    calls.push({ system: String(req.system ?? ''), user: String(req.messages?.[0]?.content ?? ''), maxTokens: req.maxTokens, role: req.role });
    return { text, toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
  };
  return { llm: llm as any, calls };
}

const withFlag = async (value: string | undefined, fn: () => Promise<void>) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'MEMORY_MEDIUM_SUPERSEDE');
  const prior = process.env.MEMORY_MEDIUM_SUPERSEDE;
  if (value == null) delete process.env.MEMORY_MEDIUM_SUPERSEDE;
  else process.env.MEMORY_MEDIUM_SUPERSEDE = value;
  try {
    await fn();
  } finally {
    if (had) process.env.MEMORY_MEDIUM_SUPERSEDE = prior;
    else delete process.env.MEMORY_MEDIUM_SUPERSEDE;
  }
};

const bodies = async (h: string, kind: 'directive' | 'important_note') =>
  (await listMediumActive(h, [kind])).map(e => e.body);

async function waitFor(pred: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ── planSupersessions: the classify leg, in isolation ────────────────────────

test('planSupersessions maps the numbers it is given back to ids', async () => {
  const { llm, calls } = fakeLlm('[1]');
  const existing = [{ id: 'id-a', text: 'never be sarcastic' }, { id: 'id-b', text: 'flag urgent email' }];
  assert.deepEqual(await planSupersessions('directive', 'full sarcasm mode always', existing, llm), ['id-a']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'classify');
  assert.equal(calls[0].maxTokens, 40);
  assert.match(calls[0].system, /standing rule/, 'a directive is a standing rule in the prompt');
  // The rows the model reads are DATA, inside their own tag, numbered in the order given.
  assert.match(calls[0].user, /<existing>\n1\. never be sarcastic\n2\. flag urgent email\n<\/existing>/);
  assert.match(calls[0].user, /<new>\nfull sarcasm mode always\n<\/new>/);
  assert.match(calls[0].user, /^<prompt>/);
});

test('planSupersessions calls a remembered fact by its own name', async () => {
  const { llm, calls } = fakeLlm('[]');
  await planSupersessions('important_note', 'moved to Bandung', [{ id: 'x', text: 'lives in Bekasi' }], llm);
  assert.match(calls[0].system, /remembered fact/);
});

test('planSupersessions retires nothing on an empty answer, garbage, or a bad shape', async () => {
  const existing = [{ id: 'id-a', text: 'never be sarcastic' }];
  for (const answer of ['[]', 'sure! I think entry 1 is obsolete', '{"retire":[1]}', '', '[1.5]', '["1"]']) {
    const { llm } = fakeLlm(answer);
    assert.deepEqual(
      await planSupersessions('directive', 'be sarcastic', existing, llm), [],
      `"${answer}" must retire nothing`,
    );
  }
});

test('planSupersessions ignores numbers that point at no row', async () => {
  const { llm } = fakeLlm('[0,1,2,9,-3]');
  const existing = [{ id: 'id-a', text: 'a' }, { id: 'id-b', text: 'b' }];
  assert.deepEqual(await planSupersessions('directive', 'c', existing, llm), ['id-a', 'id-b']);
});

test('planSupersessions rejects a TRUNCATED answer wholesale', async () => {
  const llm = (async () => ({ text: '[1', toolCalls: [], stopReason: 'max_tokens', truncated: true, provider: 'anthropic', model: 'test' })) as any;
  assert.deepEqual(await planSupersessions('directive', 'x', [{ id: 'id-a', text: 'a' }], llm), []);
});

test('planSupersessions fails open to nothing on a thrown lane and on a timeout', async () => {
  const thrower = (async () => { throw new Error('no lane configured'); }) as any;
  assert.deepEqual(await planSupersessions('directive', 'x', [{ id: 'id-a', text: 'a' }], thrower), []);

  // A lane that answers eventually, long after the bound: the answer must not land at all.
  const slow = (async () => {
    await new Promise(r => setTimeout(r, 150));
    return { text: '[1]', toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
  }) as any;
  assert.deepEqual(await planSupersessions('directive', 'x', [{ id: 'id-a', text: 'a' }], slow, 10), []);
});

// ── supersedeContradicted: the validated write ───────────────────────────────

test('supersedeContradicted retires the named row and never the other kind', async () => {
  const h = freshHandle();
  const old = await addDirective(h, 'never be sarcastic');
  await addDirective(h, 'flag urgent email only');
  await addImportantNote(h, 'never be sarcastic');            // same words, WRONG kind
  const created = await addDirective(h, 'full sarcasm mode always');
  clearTraces();

  const { llm, calls } = fakeLlm('[1]');
  await supersedeContradicted(h, created!, 'chat-1', { llm });

  assert.deepEqual(await bodies(h, 'directive'), ['flag urgent email only', 'full sarcasm mode always']);
  assert.deepEqual(await bodies(h, 'important_note'), ['never be sarcastic'], 'the note is a different kind');
  const retired = (await listMediumAll(h)).find(e => e.id === old!.id);
  assert.equal(retired?.status, 'superseded');
  assert.equal(retired?.supersededBy, created!.id, 'lineage points at the entry that replaced it');

  // Only the rows of the created entry's kind, minus itself, were ever shown.
  assert.match(calls[0].user, /1\. never be sarcastic\n2\. flag urgent email only/);
  assert.doesNotMatch(calls[0].user, /3\./);

  const receipt = getTraces().find(e => e.label === 'memory:medium_supersede');
  assert.deepEqual(receipt?.detail, { kind: 'directive', newId: created!.id, retired: 1, considered: 2 });
});

test('supersedeContradicted never retires the entry that triggered it', async () => {
  const h = freshHandle();
  await addDirective(h, 'never be sarcastic');
  const created = await addDirective(h, 'full sarcasm mode always');
  // Every number the model can say, including ones past the list.
  const { llm } = fakeLlm('[1,2,3]');
  await supersedeContradicted(h, created!, undefined, { llm });

  assert.deepEqual(await bodies(h, 'directive'), ['full sarcasm mode always']);
});

test('supersedeContradicted retires a superseded remembered fact', async () => {
  const h = freshHandle();
  const old = await addImportantNote(h, 'lives in Bekasi');
  const created = await addImportantNote(h, 'moved to Bandung');
  const { llm, calls } = fakeLlm('[1]');
  await supersedeContradicted(h, created!, undefined, { llm });

  assert.deepEqual(await bodies(h, 'important_note'), ['moved to Bandung']);
  assert.equal((await listMediumAll(h)).find(e => e.id === old!.id)?.supersededBy, created!.id);
  assert.match(calls[0].system, /remembered fact/);
});

test('supersedeContradicted asks nothing when there is nothing to compare against', async () => {
  const h = freshHandle();
  const created = await addDirective(h, 'the only rule they ever gave');
  const { llm, calls } = fakeLlm('[1]');
  await supersedeContradicted(h, created!, undefined, { llm });
  assert.equal(calls.length, 0, 'one entry cannot contradict anything');
  assert.deepEqual(await bodies(h, 'directive'), ['the only rule they ever gave']);
});

test('supersedeContradicted retires nothing when the answer is garbage or the lane dies', async () => {
  for (const llm of [fakeLlm('nope, all of them look fine').llm, (async () => { throw new Error('dead lane'); }) as any]) {
    const h = freshHandle();
    await addDirective(h, 'never be sarcastic');
    const created = await addDirective(h, 'full sarcasm mode always');
    await supersedeContradicted(h, created!, undefined, { llm });
    assert.deepEqual(await bodies(h, 'directive'), ['never be sarcastic', 'full sarcasm mode always']);
  }
});

test('the flag off means no call and no retirement', async () => {
  await withFlag('off', async () => {
    assert.equal(mediumSupersedeEnabled(), false);
    const h = freshHandle();
    await addDirective(h, 'never be sarcastic');
    const created = await addDirective(h, 'full sarcasm mode always');
    const { llm, calls } = fakeLlm('[1]');
    await supersedeContradicted(h, created!, undefined, { llm });
    assert.equal(calls.length, 0);
    assert.deepEqual(await bodies(h, 'directive'), ['never be sarcastic', 'full sarcasm mode always']);
  });
});

test('the flag defaults ON, and every truthy spelling is respected', async () => {
  await withFlag(undefined, async () => assert.equal(mediumSupersedeEnabled(), true));
  await withFlag('', async () => assert.equal(mediumSupersedeEnabled(), true));
  await withFlag('on', async () => assert.equal(mediumSupersedeEnabled(), true));
  await withFlag('false', async () => assert.equal(mediumSupersedeEnabled(), false));
});

// ── end to end, through the two tools that create medium-tier entries ────────

function makeResult(bubbles: string[], toolCalls: LlmToolCall[]): LlmResult {
  const envelope = {
    confidence_level: 85,
    tool_calls: toolCalls.length ? toolCalls.map(c => ({ name: c.name, args: c.input })) : null,
    bubbles: bubbles.map(text => ({ text, re: null })),
    status: { mood_label: 'content', mood_shift: 'steady' },
  };
  return { text: JSON.stringify(envelope), toolCalls, stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test' };
}

function baseArgs() {
  __resetOpsCoordination();
  clearTraces();
  const sender = freshHandle();
  const chatContext: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: sender };
  return { chatId: randomUUID(), handle: sender, chatContext, history: [], media: emptyMedia() };
}

test('a new standing rule retires the one it reverses, through update_directives', async () => {
  const a = baseArgs();
  await addDirective(a.handle, 'never be sarcastic');
  const { llm } = fakeLlm('[1]');
  __setSupersedeLlmForTests(llm);
  try {
    const res = makeResult(['ha, ok'], [{ name: 'update_directives', input: { op: 'add', text: 'full sarcasm mode always', match: null } }]);
    await processConvoResult({ ...a, res, textToSend: 'be sarcastic with me from now on' });
    await waitFor(async () => (await bodies(a.handle, 'directive')).length === 1, 'the reversed rule to retire');
  } finally {
    __setSupersedeLlmForTests(null);
  }
  assert.deepEqual(await bodies(a.handle, 'directive'), ['full sarcasm mode always']);
});

test('a new remembered fact retires the stale one, and the groomer still runs behind it', async () => {
  const a = baseArgs();
  await addImportantNote(a.handle, 'lives in Bekasi');
  const { llm } = fakeLlm('[1]');
  __setSupersedeLlmForTests(llm);
  try {
    const res = makeResult(['noted'], [{ name: 'set_preference', input: { key: 'important_note', value: 'moved to Bandung' } }]);
    await processConvoResult({ ...a, res, textToSend: 'remember i moved to bandung' });
    await waitFor(async () => (await bodies(a.handle, 'important_note')).length === 1, 'the stale note to retire');
  } finally {
    __setSupersedeLlmForTests(null);
  }
  assert.deepEqual(await bodies(a.handle, 'important_note'), ['moved to Bandung']);
  // The groomer is chained AFTER the pass, so it never merges a note that is about to be retired:
  // the retirement receipt is on the record and the surviving note is the new one.
  assert.ok(getTraces().some(e => e.label === 'memory:medium_supersede'));
});

test('a rule the model UPDATES is compared against the rules that survive it', async () => {
  const a = baseArgs();
  const stale = await addDirective(a.handle, 'never be sarcastic');
  await addDirective(a.handle, 'keep replies short');
  const { llm, calls } = fakeLlm('[1]');
  __setSupersedeLlmForTests(llm);
  try {
    const res = makeResult(['done'], [{ name: 'update_directives', input: { op: 'update', text: 'always be sarcastic', match: 'short' } }]);
    await processConvoResult({ ...a, res, textToSend: 'change that short rule to be sarcastic instead' });
    await waitFor(async () => (await bodies(a.handle, 'directive')).length === 1, 'the contradicted rule to retire');
  } finally {
    __setSupersedeLlmForTests(null);
  }
  assert.deepEqual(await bodies(a.handle, 'directive'), ['always be sarcastic']);
  assert.match(calls[0].user, /1\. never be sarcastic/);
  assert.equal((await listMediumAll(a.handle)).find(e => e.id === stale!.id)?.status, 'superseded');
});

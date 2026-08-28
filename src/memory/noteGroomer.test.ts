// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The note groomer: the cheap similarity gate that decides whether a model is called at all, the
// re-validation of everything the model proposes, and the invariants that keep a bad groom from
// costing the user a note — anti-loop freeze, the /forget fence, and total silence on failure.
// The LLM is always injected (deps.llm); no test here reaches a lane.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  groomNotes, similarityPairs, parseMergePlan, __resetGroomThrottleForTests,
  NOTE_MERGE_SYSTEM_PROMPT, GROOM_MIN_ACTIVE_NOTES,
} from './noteGroomer.js';
import { addImportantNote, listMediumActive, listMediumAll, MERGED_NOTE_MAX_CHARS } from '../db/repositories/memoryMedium.js';
import { listArchiveFor } from '../db/repositories/memoryArchive.js';
import { bumpForgetEpoch } from '../db/repositories/memory.js';
import type { callLLM } from '../llm/callLLM.js';
import type { LlmRequest } from '../llm/types.js';

let seq = 0;
function freshHandle(): string {
  return `+1555200${(seq++).toString().padStart(4, '0')}`;
}

beforeEach(() => __resetGroomThrottleForTests());

function stubLlm(text: string | null, opts: { truncated?: boolean } = {}) {
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    return {
      text, toolCalls: [], stopReason: opts.truncated ? 'max_tokens' : 'end_turn',
      truncated: !!opts.truncated, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;
  return { llm, calls };
}

function userContent(req: LlmRequest): string {
  return String(req.messages[0].content);
}

// Six notes with exactly ONE near-duplicate pair: #1 and #6 are the same gate code, restated.
const NEAR_DUP_SET = [
  'the gate code is 4421',
  'dog is called Pepper',
  'bins go out on thursday',
  'no calls before 9am',
  'parking permit expires in march',
  'the gate code for the house is 4421',
];

async function seed(bodies: string[], source?: string): Promise<string> {
  const h = freshHandle();
  for (const b of bodies) await addImportantNote(h, b, source);
  return h;
}

const GATE_MERGE = '{"merges":[{"notes":[1,6],"merged":"the gate code for the house is 4421","confidence":"high"}]}';

// ── The prompt contract ───────────────────────────────────────────────────────

test('NOTE_MERGE_SYSTEM_PROMPT pins the merge contract', () => {
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('Reply with STRICT JSON only. No prose, no code fences, no explanation'));
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('the SAME fact'));
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('Merge only notes that clearly record the same fact.'));
  // A merge replaces duplicates of ONE fact — it must never become a bundle of unrelated ones.
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('NEVER combine different facts'));
  // Conflict resolution: the list is numbered oldest → newest, so the highest number is current.
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('the newest note (highest number) wins'));
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('Keep literal values'));
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('Synthesize, do not concatenate.'));
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('at most 600 characters'));
  assert.equal(MERGED_NOTE_MAX_CHARS, 600, 'the prompt bound and the enforced bound are the same number');
  assert.ok(NOTE_MERGE_SYSTEM_PROMPT.includes('Set confidence to "high" only when'));
});

// ── similarityPairs (pure) ────────────────────────────────────────────────────

test('similarityPairs flags near-duplicates and ignores distinct notes', () => {
  assert.deepEqual(similarityPairs(NEAR_DUP_SET), [[0, 5]]);
  assert.deepEqual(similarityPairs([
    'dog is called Pepper', 'bins go out on thursday', 'no calls before 9am', 'the accountant is Marlene',
  ]), []);
});

test('similarityPairs catches the containment case Jaccard alone misses', () => {
  // A short note swallowed whole by a long one: three shared tokens against fifteen is a Jaccard of
  // ~0.2 (under the floor), but the short note is 100% contained — the exact shape of a user
  // restating a fact at length months later.
  const short = 'gate code 4421';
  const long = 'the gate code for the house is 4421, punch it in on the keypad by the side door and hold the star key until it beeps twice';
  assert.deepEqual(similarityPairs([short, long]), [[0, 1]]);
});

// ── The gates BEFORE the model (no call must happen) ───────────────────────────

test('no LLM call when nothing is plausibly duplicated', async () => {
  const h = await seed([
    'dog is called Pepper', 'bins go out on thursday', 'no calls before 9am',
    'parking permit expires in march', 'wifi router lives in the hall cupboard', 'the accountant is Marlene',
  ]);
  const { llm, calls } = stubLlm(GATE_MERGE);
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'no_candidates' });
  assert.equal(calls.length, 0, 'the cheap gate answered — no model was paid for this');
});

test('no LLM call below the minimum candidate count', async () => {
  const h = await seed(['the gate code is 4421', 'gate code 4421', 'the gate code for the house is 4421']);
  assert.ok(3 < GROOM_MIN_ACTIVE_NOTES);
  const { llm, calls } = stubLlm(GATE_MERGE);
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'too_few' });
  assert.equal(calls.length, 0);
});

// ── The accepted path ─────────────────────────────────────────────────────────

test('an accepted plan collapses the cluster into one note', async () => {
  const h = await seed(NEAR_DUP_SET);
  const before = await listMediumActive(h, ['important_note']);
  const { llm } = stubLlm(GATE_MERGE);

  assert.deepEqual(await groomNotes(h, { llm }), { merged: 2, clusters: 1, skipped: null });

  const active = await listMediumActive(h, ['important_note']);
  assert.equal(active.length, 5, 'six notes became five — one slot bought back');
  const merged = active[active.length - 1];
  assert.equal(merged.body, 'the gate code for the house is 4421');
  assert.equal(merged.source, 'groomer');
  assert.deepEqual(merged.mergedFrom, [before[0].id, before[5].id]);

  const all = await listMediumAll(h);
  for (const source of [before[0], before[5]]) {
    const row = all.find(e => e.id === source.id)!;
    assert.equal(row.status, 'superseded');
    assert.equal(row.supersededBy, merged.id);
  }
  const archived = await listArchiveFor(h);
  assert.equal(archived.length, 2);
  assert.ok(archived.every(a => a.source === 'medium_merged' && a.meta.mergedInto === merged.id));
});

test('note bodies reach the model as tagged data', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm, calls } = stubLlm('{"merges":[]}');
  await groomNotes(h, { llm });

  assert.equal(calls.length, 1);
  const content = userContent(calls[0]);
  assert.ok(content.includes('<prompt>'), 'the whole dynamic block is wrapped');
  assert.ok(content.includes('<active_notes>'), 'and the user-authored notes are tagged as data inside it');
  assert.ok(content.includes('1. the gate code is 4421'), 'numbered 1..N oldest first');
  assert.ok(content.includes('6. the gate code for the house is 4421'), 'so "highest number = newest" is true');
});

// ── Everything the model can get wrong ────────────────────────────────────────

test('a truncated reply is rejected wholesale, however valid it looks', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm } = stubLlm(GATE_MERGE, { truncated: true });
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'truncated' });
  assert.equal((await listMediumActive(h, ['important_note'])).length, 6);
});

test('unparsable output is a no-op', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm } = stubLlm("sorry, I can't help with that");
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'unparsable' });
  assert.equal((await listMediumActive(h, ['important_note'])).length, 6);
  assert.equal(parseMergePlan('no json here'), null);
  assert.equal(parseMergePlan(null), null);
});

test('jsonrepair rescues a lightly malformed plan', async () => {
  const h = await seed(NEAR_DUP_SET);
  const malformed = '{"merges":[{"notes":[1,6],"merged":"the gate code for the house is 4421","confidence":"high",},]}';
  assert.throws(() => JSON.parse(malformed)); // strict JSON.parse really does reject it
  assert.deepEqual(parseMergePlan(malformed)?.merges[0].notes, [1, 6]);

  const { llm } = stubLlm(malformed);
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 2, clusters: 1, skipped: null });
});

test('low-confidence clusters are skipped', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm } = stubLlm('{"merges":[{"notes":[1,6],"merged":"the gate code for the house is 4421","confidence":"medium"}]}');
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'rejected' });
  assert.equal((await listMediumActive(h, ['important_note'])).length, 6);
});

test('a cluster naming a non-candidate is rejected', async () => {
  const out = await seed(NEAR_DUP_SET);
  const { llm: l1 } = stubLlm('{"merges":[{"notes":[1,99],"merged":"the gate code for the house is 4421","confidence":"high"}]}');
  assert.deepEqual(await groomNotes(out, { llm: l1 }), { merged: 0, clusters: 0, skipped: 'rejected' });
  assert.equal((await listMediumActive(out, ['important_note'])).length, 6);

  // A frozen groomer note is not in the candidate list at all, so the index that WOULD address it
  // is out of range — it can't be dragged back into a merge by a model that guesses at the count.
  __resetGroomThrottleForTests();
  const h = await seed(NEAR_DUP_SET);
  await addImportantNote(h, 'a note this groomer wrote last week', 'groomer');
  const { llm: l2, calls } = stubLlm('{"merges":[{"notes":[1,7],"merged":"the gate code for the house is 4421","confidence":"high"}]}');
  assert.deepEqual(await groomNotes(h, { llm: l2 }), { merged: 0, clusters: 0, skipped: 'rejected' });
  assert.ok(!userContent(calls[0]).includes('7.'), 'the model was only ever shown six notes');
  assert.equal((await listMediumActive(h, ['important_note'])).length, 7, 'the frozen note is untouched');
});

test('overlapping clusters: the first wins and the rest are dropped', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm } = stubLlm(
    '{"merges":[' +
    '{"notes":[1,6],"merged":"the gate code for the house is 4421","confidence":"high"},' +
    '{"notes":[2,6],"merged":"dog is called Pepper","confidence":"high"}]}',
  );
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 2, clusters: 1, skipped: null });
  const bodies = (await listMediumActive(h, ['important_note'])).map(n => n.body);
  assert.ok(bodies.includes('dog is called Pepper'), 'the contested cluster was dropped, not applied');
  assert.equal(bodies.length, 5);
});

test('an over-long merged body and a merge longer than its sources are both rejected', async () => {
  const tooLong = await seed(NEAR_DUP_SET);
  const { llm: l1 } = stubLlm(JSON.stringify({
    merges: [{ notes: [1, 6], merged: `4421 ${'x'.repeat(MERGED_NOTE_MAX_CHARS)}`, confidence: 'high' }],
  }));
  assert.deepEqual(await groomNotes(tooLong, { llm: l1 }), { merged: 0, clusters: 0, skipped: 'rejected' });
  assert.equal((await listMediumActive(tooLong, ['important_note'])).length, 6);

  // Under the hard cap, but longer than the two notes it claims to replace — that is a
  // concatenation, and notes render verbatim every single turn.
  __resetGroomThrottleForTests();
  const bloated = await seed(NEAR_DUP_SET);
  const sourceChars = NEAR_DUP_SET[0].length + NEAR_DUP_SET[5].length;
  const merged = `the gate code for the house is 4421 ${'and again '.repeat(10)}`.trim();
  assert.ok(merged.length > sourceChars && merged.length <= MERGED_NOTE_MAX_CHARS);
  const { llm: l2 } = stubLlm(JSON.stringify({ merges: [{ notes: [1, 6], merged, confidence: 'high' }] }));
  assert.deepEqual(await groomNotes(bloated, { llm: l2 }), { merged: 0, clusters: 0, skipped: 'rejected' });
  assert.equal((await listMediumActive(bloated, ['important_note'])).length, 6);
});

test('a merge that drops a literal value is rejected', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm } = stubLlm('{"merges":[{"notes":[1,6],"merged":"the gate code for the house is on the fridge","confidence":"high"}]}');
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'rejected' });
  const bodies = (await listMediumActive(h, ['important_note'])).map(n => n.body);
  assert.ok(bodies.includes('the gate code is 4421'), '4421 would have been lost with nothing saying so');
});

// ── The invariants that make it safe to run unattended ────────────────────────

test('ANTI-LOOP: a groomer-made note is frozen out of the next run', async () => {
  const h = await seed([
    'the gate code is 4421',
    'dog is called Pepper',
    'bins go out on thursday',
    'no calls before 9am',
    'parking permit expires in march',
    'the dog Pepper is a whippet',
    'wifi router lives in the hall cupboard',
    'the gate code for the house is 4421',
  ]);
  const { llm: first } = stubLlm('{"merges":[{"notes":[1,8],"merged":"gate code 4421 for the house","confidence":"high"}]}');
  assert.deepEqual(await groomNotes(h, { llm: first }), { merged: 2, clusters: 1, skipped: null });

  // Second pass, with a model that would happily merge anything it is shown.
  __resetGroomThrottleForTests();
  const { llm: second, calls } = stubLlm('{"merges":[{"notes":[1,2],"merged":"anything at all","confidence":"high"}]}');
  await groomNotes(h, { llm: second });
  assert.equal(calls.length, 1);
  const shown = userContent(calls[0]);
  assert.ok(!shown.includes('gate code 4421 for the house'), 'the fresh merge is not a candidate for re-merging');
  assert.ok(shown.includes('dog is called Pepper'), 'the ordinary notes still are');
});

test('the per-handle throttle blocks a second run', async () => {
  const h = await seed(NEAR_DUP_SET);
  const { llm, calls } = stubLlm('{"merges":[]}');
  // 'none', not 'rejected': the model looked and found no duplicates — the healthy answer, and a
  // different event from a plan whose every cluster failed validation.
  assert.equal((await groomNotes(h, { llm })).skipped, 'none');
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'throttled' });
  assert.equal(calls.length, 1, 'exactly one model call for the window');
});

test('a /forget during the LLM call fences the write', async () => {
  const h = await seed(NEAR_DUP_SET);
  const llm = (async () => {
    bumpForgetEpoch(h); // the user asked to be forgotten while the model was thinking
    return {
      text: GATE_MERGE, toolCalls: [], stopReason: 'end_turn', truncated: false,
      provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;

  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'forgotten' });
  assert.equal((await listMediumActive(h, ['important_note'])).length, 6, 'nothing was merged past the wipe');
  assert.equal((await listArchiveFor(h)).length, 0);
});

test('an LLM failure is silent and non-mutating', async () => {
  const h = await seed(NEAR_DUP_SET);
  const llm = (async () => { throw new Error('no lane is configured'); }) as typeof callLLM;
  assert.deepEqual(await groomNotes(h, { llm }), { merged: 0, clusters: 0, skipped: 'llm_failed' });
  assert.equal((await listMediumActive(h, ['important_note'])).length, 6);
  assert.equal((await listArchiveFor(h)).length, 0);
});

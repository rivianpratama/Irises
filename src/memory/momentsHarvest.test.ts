// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The nightly moments pass: the gate order that keeps a thin turn from burning the night, the
// ratchet that stops one evening being minted twice, the /forget fence, and the re-validation that
// makes the writer a suggester rather than an author.
//
// What these tests are really guarding:
//
//   • EVERY PASS LEAVES A RECEIPT. The healthy skip too — a pass that keeps finding nothing and a
//     pass that stopped running are otherwise indistinguishable — and exactly one `skipped` bucket
//     per pass, so the report can be scored.
//   • NOTHING PARTIAL EVER STAMPS. A truncated reply, a dead lane, an unreadable file, a fenced
//     write: none of them touch `last_harvest_at`, because the night they fell in is still owed.
//   • A BAD EPISODE IS DROPPED, NEVER THE BATCH (the note groomer's rule), and an episode longer
//     than the evidence it could have read is the one invention this store cannot afford — there is
//     no archive to correct it from.
//   • NO TEST HERE REACHES A LANE. The LLM is injected on every call (opts.llm).
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateMoments, buildMomentsWindow, renderMomentsWindow, renderExistingMoments,
  parseMomentsReply, validateProposals, evidenceMaxFor, validateThesisNote, mergeRejections,
  __resetMomentsInFlightForTests, __resetMomentsBackoffForTests, __momentsBackoffAtForTests,
  MOMENTS_SYSTEM_PROMPT, MOMENTS_COOLDOWN_MS, MOMENTS_MIN_USER_LINES,
  MOMENTS_FAILURE_BACKOFF_MS, MOMENT_EVIDENCE_SLACK,
} from './momentsHarvest.js';
import { groupHandle } from './identity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { readMoments, writeMoments } from '../db/repositories/moments.js';
import { getThesis, readThesisHead } from '../db/repositories/thesis.js';
import { bumpForgetEpoch } from '../db/repositories/memory.js';
import { memoriesDir } from '../db/stateDir.js';
import { MOMENT_TEXT_MAX, MAX_MOMENTS, type MomentEntry } from '../persona/moments.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { PROMPT_TAG } from '../llm/promptTag.js';
import type { callLLM } from '../llm/callLLM.js';
import type { LlmRequest } from '../llm/types.js';
import type { StoredMessage } from '../db/types.js';

const T0 = Date.UTC(2026, 3, 1, 22, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seq = 0;
function freshHandle(): string {
  return `+1555500${(seq++).toString().padStart(4, '0')}`;
}

beforeEach(() => {
  resetStorageForTests();
  __resetMomentsInFlightForTests();
  __resetMomentsBackoffForTests();
  clearTraces();
  delete process.env.MEMORY_MOMENTS_ENABLED;
  delete process.env.MEMORY_THESIS_ENABLED;
});

function stubLlm(text: string | null, opts: { truncated?: boolean; throws?: boolean; before?: () => void } = {}) {
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    opts.before?.();
    if (opts.throws) throw new Error('lane exploded');
    return {
      text, toolCalls: [], stopReason: opts.truncated ? 'max_tokens' : 'end_turn',
      truncated: !!opts.truncated, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;
  return { llm, calls };
}

/** A substantive evening: `lines` of theirs, interleaved with her replies, all stamped from `at`.
 *  Their lines are long enough that a two-hundred-character moment clears the evidence bound. */
function evening(at: number, handle: string, lines = MOMENTS_MIN_USER_LINES): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < lines; i++) {
    out.push({
      role: 'user', handle, at: at + i * 60_000,
      content: `their line ${i}: ${'and then i checked the volcano dashboard again for no reason at all '.repeat(4)}`,
    });
    out.push({ role: 'assistant', content: `her reply ${i}`, at: at + i * 60_000 + 1_000 });
  }
  return out;
}

const ONE_MOMENT = JSON.stringify({
  moments: [{ text: 'checked the volcano dashboard again, for the third time this month', tag: 'habit' }],
});
const NOTHING = '{"moments":[]}';

function receipts(): Record<string, unknown>[] {
  return getTraces()
    .filter(e => e.type === 'event' && e.label === 'moments:harvest')
    .map(e => e.detail as Record<string, unknown>);
}
function receipt(): Record<string, unknown> {
  const all = receipts();
  assert.equal(all.length, 1, `expected exactly one moments:harvest receipt, got ${all.length}`);
  return all[0];
}

function entry(over: Partial<MomentEntry> = {}): MomentEntry {
  return {
    id: 'a', text: 'called the cat by their own name, twice', tag: 'habit',
    at: T0 - DAY, count: 1, offered: 0, lastOfferedAt: 0, ...over,
  };
}

// ── the pure half ────────────────────────────────────────────────────────────

test('the window is scoped to them, cut at the stamp, and an unstamped row is a hole in the ratchet', () => {
  const h = freshHandle();
  const rows: StoredMessage[] = [
    { role: 'user', content: 'already harvested', handle: h, at: T0 - 2 * DAY },
    { role: 'user', content: 'somebody else', handle: '+15559999999', at: T0 },
    { role: 'user', content: 'no stamp at all', handle: h },
    { role: 'assistant', content: 'her reply', at: T0 },
    { role: 'user', content: 'tonight', handle: h, at: T0 },
  ];
  const out = buildMomentsWindow(h, rows, T0 - DAY);
  assert.deepEqual(out.map(m => m.content), ['her reply', 'tonight']);
});

test('the window is capped to the newest rows, so one loud evening cannot be a whole prompt', () => {
  const h = freshHandle();
  const rows = Array.from({ length: 200 }, (_, i) => ({
    role: 'user' as const, content: `line ${i}`, handle: h, at: T0 + i,
  }));
  const out = buildMomentsWindow(h, rows, 0);
  assert.equal(out.length, 60);
  assert.equal(out[out.length - 1].content, 'line 199', 'the NEWEST rows survive');
});

test('the rendered window keeps the clock — an episode has a time in it — and survives a row without one', () => {
  const rows: StoredMessage[] = [
    { role: 'user', content: 'is that the mcdonalds ad girl', handle: 'h', at: T0 },
    { role: 'assistant', content: 'yes' },
  ];
  const lines = renderMomentsWindow(rows, 'UTC').split('\n');
  assert.match(lines[0], /^\[.+\] user: is that the mcdonalds ad girl$/);
  assert.equal(lines[1], 'assistant: yes', 'an unstamped row renders untimed rather than being dropped');
});

test('the existing moments carry the id a merge is claimed with, newest first, capped at the active cap', () => {
  const many = Array.from({ length: MAX_MOMENTS + 5 }, (_, i) => entry({ id: `id-${i}`, at: T0 - i * DAY }));
  const lines = renderExistingMoments(many, T0).split('\n');
  assert.equal(lines.length, MAX_MOMENTS);
  assert.match(lines[0], /^id=id-0 tag=habit age=0d \(today\) — called the cat/);
  assert.match(lines[1], /^id=id-1 tag=habit age=1d \(yesterday\) — /, 'newest first');
  assert.ok(lines.every(l => l.startsWith('id=')), 'every line offers an id to merge into');
});

test('a parsed reply survives a prose wrapper and a trailing comma; an empty harvest is not a failure', () => {
  assert.deepEqual(parseMomentsReply(ONE_MOMENT)?.moments.length, 1);
  assert.deepEqual(parseMomentsReply(`sure, here you go:\n${ONE_MOMENT}\nthat's all`)?.moments.length, 1);
  assert.deepEqual(parseMomentsReply('{"moments":[{"text":"a","tag":"habit"},]}')?.moments.length, 1);
  // The honest answer most nights, and reading it as a failure would put every quiet evening into
  // the backoff and stop the clock from ever stamping.
  assert.deepEqual(parseMomentsReply(NOTHING), { moments: [], thesisNote: undefined });
  assert.equal(parseMomentsReply('no.'), null);
  assert.equal(parseMomentsReply(null), null);
  assert.equal(parseMomentsReply('{"other":1}'), null, 'an object with neither key is some other object');
  assert.deepEqual(parseMomentsReply('{"thesisNote":"they asked three times"}')?.thesisNote, 'they asked three times');
});

test('every rejection bucket is reachable, and one bad episode never drops the batch', () => {
  const good = { text: 'checked the volcano again', tag: 'habit' };
  const v = validateProposals(
    [
      good,
      { text: '   ', tag: 'habit' },
      { text: 'none', tag: 'habit' },
      { text: 'they said <hello>', tag: 'habit' },
      { text: 'x'.repeat(MOMENT_TEXT_MAX + 1), tag: 'habit' },
      { text: 'checked the volcano again', tag: 'sad' },
      'not an object',
    ],
    MOMENT_TEXT_MAX,
  );
  assert.deepEqual(v.accepted, [good]);
  assert.deepEqual(v.rejected, { empty: 2, null_literal: 1, markup: 1, too_long: 1, bad_tag: 1 });
});

test('a text longer than the evidence it could have read is refused — the invention this store cannot correct', () => {
  const long = { text: 'x'.repeat(120), tag: 'obsession' };
  assert.deepEqual(validateProposals([long], 100).rejected, { unevidenced: 1 });
  assert.deepEqual(validateProposals([long], 200).accepted, [long], 'and stands when the evidence is there');
});

test('a pass may propose three episodes and no more, whatever it claims about them', () => {
  const four = Array.from({ length: 4 }, (_, i) => ({ text: `episode ${i}`, tag: 'habit' }));
  const v = validateProposals(four, MOMENT_TEXT_MAX);
  assert.equal(v.accepted.length, 3);
  assert.deepEqual(v.rejected, { cap: 1 });
});

test('an accepted proposal is normalised, and its merge claims are cleaned rather than trusted', () => {
  const v = validateProposals(
    [{ text: '  spent   twenty\nminutes  ', tag: ' Habit ', merges: ['  a  ', '', 7, 'b'] }],
    MOMENT_TEXT_MAX,
  );
  assert.deepEqual(v.accepted, [{ text: 'spent twenty minutes', tag: 'habit', merges: ['a', 'b'] }]);
  // An empty claim list is absent rather than empty, so `foldHarvest` reads one shape for "no claim".
  assert.deepEqual(validateProposals([{ text: 'a b c', tag: 'habit', merges: [] }], 100).accepted, [{ text: 'a b c', tag: 'habit' }]);
});

test('the evidence bound is the longest thing THEY said plus the slack; her own lines are not evidence', () => {
  const rows: StoredMessage[] = [
    { role: 'user', content: 'short', handle: 'h', at: T0 },
    { role: 'assistant', content: 'x'.repeat(500), at: T0 },
    { role: 'user', content: 'a longer line from them', handle: 'h', at: T0 },
  ];
  assert.equal(evidenceMaxFor(rows), 'a longer line from them'.length + MOMENT_EVIDENCE_SLACK);
  assert.equal(evidenceMaxFor([]), 0, 'nothing readable is a bound nothing clears');
});

test('the evidence note is validated like an episode, minus the evidence bound', () => {
  assert.equal(validateThesisNote('  they asked   three times  '), 'they asked three times');
  assert.equal(validateThesisNote('none'), null);
  assert.equal(validateThesisNote('they said `no`'), null);
  assert.equal(validateThesisNote('x'.repeat(201)), null);
  assert.equal(validateThesisNote(7), null);
  // A note is a claim about the whole evening, not a retelling of one line, so it is deliberately
  // NOT measured against the longest thing they typed — most evenings are short lines.
  assert.equal(validateThesisNote('x'.repeat(200))?.length, 200);
});

test('two rejection maps are summed per bucket, not overwritten', () => {
  assert.deepEqual(mergeRejections({ too_long: 1, cap: 2 }, { too_long: 3 }), { too_long: 4, cap: 2 });
});

test('the writer prompt is the staged prose, and the bounds it states in words are the ones code holds', () => {
  assert.match(MOMENTS_SYSTEM_PROMPT, /^You are Irises, reading back over today's texts with one person, at night, alone, writing down the\n/);
  assert.ok(MOMENTS_SYSTEM_PROMPT.includes('Under two hundred characters each.'));
  assert.ok(MOMENTS_SYSTEM_PROMPT.includes('never write more than three.'));
  // The one thing this pass must never mint: loops are minted on live turns through `thread_note`.
  assert.ok(MOMENTS_SYSTEM_PROMPT.includes('A promise or a pending outcome (those are tracked elsewhere; do not write them here).'));
});

// ── the gate order ───────────────────────────────────────────────────────────

test('the flag off costs no call, and still says so', async () => {
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  const h = freshHandle();
  const { llm, calls } = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  assert.equal(calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'flag_off' });
});

test('a group identity is skipped entirely — no model call, no file', async () => {
  const g = groupHandle('chat-moments-group');
  const { llm, calls } = stubLlm(ONE_MOMENT);
  await updateMoments(g, evening(T0, g), { llm, now: T0, chatId: 'chat-moments-group' });
  assert.equal(calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'group' });
  assert.deepEqual((await readMoments(g)).entries, []);
});

test('a burst of replies inside one pass costs one call — the second sees the in-flight guard', async () => {
  const h = freshHandle();
  let release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    await gate;
    return { text: ONE_MOMENT, toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'anthropic' as const, model: 'test' };
  }) as typeof callLLM;

  const first = updateMoments(h, evening(T0, h), { llm, now: T0 });
  // The guard is taken synchronously before the first await, so this second pass sees it.
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.deepEqual(receipts().map(r => r.skipped), ['in_flight', null]);
});

test('a failed pass backs off, and the backoff neither stamps nor bills again inside the hour', async () => {
  const h = freshHandle();
  const dead = stubLlm(null, { throws: true });
  await updateMoments(h, evening(T0, h), { llm: dead.llm, now: T0 });
  assert.equal(dead.calls.length, 1);
  assert.equal(__momentsBackoffAtForTests(h), T0 + MOMENTS_FAILURE_BACKOFF_MS);
  assert.equal((await readMoments(h)).lastHarvestAt, 0, 'the night this failure fell in is still owed');

  const again = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0, h), { llm: again.llm, now: T0 + 30 * 60_000 });
  assert.equal(again.calls.length, 0);
  assert.deepEqual(receipts().map(r => r.skipped), ['lane_error', 'backoff']);

  // …and the hour expiring lets the next reply through, which clears it.
  const later = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0, h), { llm: later.llm, now: T0 + MOMENTS_FAILURE_BACKOFF_MS });
  assert.equal(later.calls.length, 1);
  assert.equal(__momentsBackoffAtForTests(h), undefined, 'a landed write clears it');
});

test('an UNREADABLE file skips without stamping — a whole-file writer must not read it as empty', async () => {
  const h = freshHandle();
  fs.mkdirSync(path.join(memoriesDir(h), 'MOMENTS.md'), { recursive: true });
  const { llm, calls } = stubLlm(ONE_MOMENT);
  const realError = console.error;
  console.error = () => {};
  try {
    await updateMoments(h, evening(T0, h), { llm, now: T0 });
  } finally {
    console.error = realError;
  }
  assert.equal(calls.length, 0, 'no call is spent on a file the pass may not write back');
  assert.deepEqual(receipt(), { skipped: 'degraded' });
  // Not a lane failure, so no hour is burned: re-reading the same file next turn costs nothing.
  assert.equal(__momentsBackoffAtForTests(h), undefined);
});

test('the 20h cooldown is read from the FILE HEADER, so a restart cannot re-harvest the same evening', async () => {
  const h = freshHandle();
  assert.equal(await writeMoments(h, [entry()], T0, []), true);

  const inside = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0 + 19 * HOUR, h), { llm: inside.llm, now: T0 + 19 * HOUR });
  assert.equal(inside.calls.length, 0);
  assert.equal(receipt().skipped, 'cooldown');

  const outside = stubLlm(NOTHING);
  await updateMoments(h, evening(T0 + MOMENTS_COOLDOWN_MS, h), { llm: outside.llm, now: T0 + MOMENTS_COOLDOWN_MS });
  assert.equal(outside.calls.length, 1);
});

test('a thin evening skips WITHOUT stamping, so the real conversation an hour later still gets its pass', async () => {
  const h = freshHandle();
  const thin = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0, h, MOMENTS_MIN_USER_LINES - 1), { llm: thin.llm, now: T0 });
  assert.equal(thin.calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'thin_window', windowUserLines: MOMENTS_MIN_USER_LINES - 1 });
  assert.equal((await readMoments(h)).lastHarvestAt, 0);

  const real = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0 + HOUR, h), { llm: real.llm, now: T0 + HOUR });
  assert.equal(real.calls.length, 1);
});

// ── the pass that lands ──────────────────────────────────────────────────────

test('a good night writes the moment, stamps the clock, and rides the transcript inside the data tags', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(ONE_MOMENT);
  await updateMoments(h, evening(T0, h), { llm, now: T0, chatId: 'chat-1' });

  const req = calls[0];
  assert.equal(req.role, 'classify', 'the house lane for every background pass');
  assert.equal(req.maxTokens, 600);
  assert.equal(req.system, MOMENTS_SYSTEM_PROMPT);
  const body = String(req.messages[0].content);
  assert.ok(body.startsWith(`<${PROMPT_TAG}>`) && body.endsWith(`</${PROMPT_TAG}>`), 'user-authored text is wrapped');
  // The prose file's own input order: the moments she holds, then tonight, then the one instruction.
  assert.ok(body.indexOf('<existing_moments>') < body.indexOf('<transcript>'));
  assert.ok(body.indexOf('<transcript>') < body.indexOf('Write down what is worth remembering.'));
  assert.ok(body.includes('<existing_moments>\nnone yet\n</existing_moments>'));
  assert.ok(body.includes('their line 0'));

  const file = await readMoments(h);
  assert.equal(file.entries.length, 1);
  assert.equal(file.entries[0].tag, 'habit');
  assert.equal(file.entries[0].at, T0);
  assert.equal(file.lastHarvestAt, T0, 'the clock is the file header');
  const r = receipt();
  assert.equal(r.skipped, null);
  assert.deepEqual([r.proposed, r.added, r.merged, r.pruned, r.active], [1, 1, 0, 0, 1]);
  assert.equal(r.note, false);
  assert.equal(r.noteSaved, null, 'no note was written, so nothing is claimed about landing one');
});

test('an empty harvest is a pass: nothing is added and the clock still moves', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(NOTHING);
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  assert.equal(calls.length, 1);
  const file = await readMoments(h);
  assert.deepEqual(file.entries, []);
  assert.equal(file.lastHarvestAt, T0);
  assert.deepEqual([receipt().skipped, receipt().proposed, receipt().added], [null, 0, 0]);
});

test('a merge folds into the older id and a decayed moment is DELETED in the same pass', async () => {
  const h = freshHandle();
  const old = entry({ id: 'old', text: 'checked the volcano dashboard again', at: T0 - 5 * DAY });
  const dead = entry({ id: 'dead', text: 'a joke that stopped being funny', at: T0 - 200 * DAY });
  assert.equal(await writeMoments(h, [old, dead], 0, []), true);

  const { llm } = stubLlm(JSON.stringify({
    moments: [{ text: 'checked the volcano dashboard again, third time this month', tag: 'habit', merges: ['old'] }],
  }));
  await updateMoments(h, evening(T0, h), { llm, now: T0 });

  const file = await readMoments(h);
  assert.deepEqual(file.entries.map(e => e.id), ['old'], 'the merge kept the id; the decayed row is gone, nowhere');
  assert.equal(file.entries[0].count, 2);
  const r = receipt();
  assert.deepEqual([r.merged, r.added, r.pruned], [1, 0, 1]);
});

test('the evidence note lands in THESIS.md, and a bad one is dropped without touching the moments', async () => {
  const h = freshHandle();
  const good = stubLlm(JSON.stringify({ moments: [], thesisNote: 'they asked about the schedule three times and then set their own' }));
  await updateMoments(h, evening(T0, h), { llm: good.llm, now: T0 });
  const doc = await getThesis(h);
  assert.ok(doc?.docMd.includes('- they asked about the schedule three times and then set their own'));
  assert.equal(receipt().noteSaved, true);

  clearTraces();
  const bad = stubLlm(JSON.stringify({ moments: [], thesisNote: 'n/a' }));
  await updateMoments(h, evening(T0 + MOMENTS_COOLDOWN_MS, h), { llm: bad.llm, now: T0 + MOMENTS_COOLDOWN_MS });
  assert.equal(receipt().note, false);
  assert.equal((await getThesis(h))?.docMd.split('- they asked').length, 2, 'still exactly one note');
});

// MEMORY_THESIS_ENABLED gates the DOCUMENT, not just its two passes. `appendThesisEvidence` is a
// SAVE — it creates THESIS.md when there is none — so an ungated nightly note would grow a thesis on
// an install that turned the thesis off: a file nothing renders, nobody asked for, and that holds
// her read of somebody in plaintext on disk.
test('with the thesis flag OFF the note lands nowhere and THESIS.md is never created', async () => {
  process.env.MEMORY_THESIS_ENABLED = 'off';
  const h = freshHandle();
  const { llm } = stubLlm(JSON.stringify({
    moments: [{ text: 'checked the volcano dashboard again, third time this month', tag: 'habit' }],
    thesisNote: 'they asked about the schedule three times and then set their own',
  }));
  await updateMoments(h, evening(T0, h), { llm, now: T0 });

  // Absent, not degraded: the pass never opened the file at all.
  assert.deepEqual(await readThesisHead(h), { doc: null, degraded: false });
  assert.equal(fs.existsSync(path.join(memoriesDir(h), 'THESIS.md')), false);
  assert.equal(fs.existsSync(path.join(memoriesDir(h), 'revisions')), false);

  // The MOMENTS half of the pass is untouched — the two features are separate switches.
  assert.equal((await readMoments(h)).entries.length, 1);
  // And the receipt says which of the two it was: a night that WROTE a note it could not land is not
  // a night that had none, and `noteSaved: false` is the only thing that can tell them apart.
  assert.equal(receipt().note, true);
  assert.equal(receipt().noteSaved, false);
});

test('a TRUNCATED reply writes nothing, stamps nothing, and is told apart from a dead lane', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(ONE_MOMENT, { truncated: true });
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  assert.equal(calls.length, 1);
  const file = await readMoments(h);
  assert.deepEqual(file.entries, []);
  assert.equal(file.lastHarvestAt, 0);
  assert.deepEqual(receipt(), { skipped: 'truncated' });
  assert.equal(__momentsBackoffAtForTests(h), T0 + MOMENTS_FAILURE_BACKOFF_MS);
});

test('an UNPARSABLE reply is its own bucket — the lane answered, the answer was not a harvest', async () => {
  const h = freshHandle();
  const { llm } = stubLlm('most nights there is nothing.');
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  assert.deepEqual(receipt(), { skipped: 'unparsable' });
  assert.equal((await readMoments(h)).lastHarvestAt, 0);
});

test('a /forget landing mid-pass FENCES the write out, and nothing is stamped', async () => {
  const h = freshHandle();
  // The wipe lands while the model is thinking, so the call, the parse and the fold all succeed and
  // the only thing that fails is the write.
  const { llm, calls } = stubLlm(ONE_MOMENT, { before: () => { bumpForgetEpoch(h); } });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await updateMoments(h, evening(T0, h), { llm, now: T0 });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(calls.length, 1);
  const file = await readMoments(h);
  assert.deepEqual(file.entries, [], 'nothing the user asked to be forgotten came back');
  assert.equal(file.lastHarvestAt, 0);
  assert.equal(receipt().skipped, 'fenced');
  // A write that never landed is the same shape as a broken lane and needs the same backoff.
  assert.equal(__momentsBackoffAtForTests(h), T0 + MOMENTS_FAILURE_BACKOFF_MS);
});

test('a hallucinated episode is dropped and the good one beside it still lands', async () => {
  const h = freshHandle();
  const { llm } = stubLlm(JSON.stringify({
    moments: [
      { text: 'x'.repeat(MOMENT_TEXT_MAX + 40), tag: 'habit' },
      { text: 'read out two numbers and decided nothing', tag: 'obsession' },
      { text: 'called the cat by their own name', tag: 'affectionate' },
    ],
  }));
  await updateMoments(h, evening(T0, h), { llm, now: T0 });
  const file = await readMoments(h);
  assert.deepEqual(file.entries.map(e => e.text), ['read out two numbers and decided nothing']);
  const r = receipt();
  assert.deepEqual([r.proposed, r.added], [3, 1]);
  assert.deepEqual(r.rejected, { too_long: 1, bad_tag: 1 });
});

test('a hand-written segment survives the pass that writes beside it', async () => {
  const h = freshHandle();
  const hand = 'a line somebody typed into the file by hand';
  assert.equal(await writeMoments(h, [], 0, [hand]), true);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const { llm } = stubLlm(ONE_MOMENT);
    await updateMoments(h, evening(T0, h), { llm, now: T0 });
  } finally {
    console.warn = realWarn;
  }
  const file = await readMoments(h);
  assert.deepEqual(file.preserved, [hand]);
  assert.equal(file.entries.length, 1);
});

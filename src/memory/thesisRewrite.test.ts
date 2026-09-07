// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The weekly thesis rewrite: the cooldown that reads the document's OWN rewrite stamp, the window
// ratchet, the /forget fence, and the validation that keeps last week's read when this week's answer
// is not a read.
//
// What these tests are really guarding:
//
//   • EVERY PASS LEAVES A RECEIPT, the healthy skip included, and exactly one `skipped` bucket.
//   • A NIGHTLY NOTE CANNOT RESET THE WEEK. The cooldown gates on `rewritten=`, not on the write
//     stamp — the whole reason THESIS.md carries two.
//   • A NO-OP REWRITE IS A PASS. The writer prompt sanctions returning the current read unchanged,
//     and that answer still stamps the clock, or the same question is re-asked on every reply until
//     the words happen to move.
//   • LAST WEEK'S READ STANDS unless a validated one replaced it: a truncation, a dead lane, a
//     label instead of a read — none of them write, and none of them stamp.
//   • NO TEST HERE REACHES A LANE. The LLM is injected on every call (opts.llm).
//   • A BROKEN FILE OR A FULL DISK COSTS THE WEEK, NOT THE VM. A throw out of a locked section is
//     process-fatal, and on a failure that persists it is a LOOP — so the unreadable head is gated
//     before the call and the write itself is dropped rather than thrown.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateThesis, parseThesisReply, renderThesisWindow, renderThesisMoments,
  __resetThesisInFlightForTests, __resetThesisBackoffForTests, __thesisBackoffAtForTests,
  THESIS_SYSTEM_PROMPT, THESIS_FAILURE_BACKOFF_MS,
} from './thesisRewrite.js';
import {
  THESIS_COOLDOWN_MS, THESIS_MIN_USER_LINES, THESIS_MAX_SENTENCES, THESIS_EVIDENCE_HEADING,
  splitThesisDoc,
} from './thesisEngine.js';
import { groupHandle } from './identity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getThesis, saveThesis, appendThesisEvidence, THESIS_REWRITE_WRITER } from '../db/repositories/thesis.js';
import { writeMoments } from '../db/repositories/moments.js';
import { bumpForgetEpoch, withHandleLock } from '../db/repositories/memory.js';
import { memoriesDir } from '../db/stateDir.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { PROMPT_TAG } from '../llm/promptTag.js';
import type { callLLM } from '../llm/callLLM.js';
import type { LlmRequest } from '../llm/types.js';
import type { StoredMessage } from '../db/types.js';

const T0 = Date.UTC(2026, 3, 8, 21, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function freshHandle(): string {
  return `+1555600${(seq++).toString().padStart(4, '0')}`;
}

beforeEach(() => {
  resetStorageForTests();
  __resetThesisInFlightForTests();
  __resetThesisBackoffForTests();
  clearTraces();
  delete process.env.MEMORY_THESIS_ENABLED;
});

const READ = 'They decide fast on things that cost money and slowly on things that cost a conversation. They would rather re-do a job than ask anyone to fix it.';
const NEXT = 'They decide fast on things that cost money and slowly on things that cost a conversation, and the supplier disputes sit open for weeks because of it.';

function stubLlm(text: string | null, opts: { truncated?: boolean; throws?: boolean; before?: () => void | Promise<void> } = {}) {
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    // Awaited, so a test that writes a competing version inside it has really landed it before the
    // pass reaches its own save — a conflict this suite pins must not depend on microtask order.
    await opts.before?.();
    if (opts.throws) throw new Error('lane exploded');
    return {
      text, toolCalls: [], stopReason: opts.truncated ? 'max_tokens' : 'end_turn',
      truncated: !!opts.truncated, provider: 'anthropic' as const, model: 'test',
    };
  }) as typeof callLLM;
  return { llm, calls };
}

const replyWith = (thesis: string) => JSON.stringify({ thesis });

/** The rewrite stamp the store actually wrote. `saveThesis` dates its own header from the wall clock
 *  (there is no injected clock on a store write), so every cooldown offset in this file is measured
 *  from THIS rather than from a hand-picked instant — a fixed T0 in the past reads as "the read was
 *  rewritten in the future", which is a closed cooldown forever. */
async function rewrittenAt(handle: string): Promise<number> {
  const doc = await getThesis(handle);
  assert.ok(doc && doc.lastRewriteAt > 0, 'the seed save did not stamp the rewrite clock');
  return doc.lastRewriteAt;
}

/** A week with enough of THEIR lines in it to be worth reading, all stamped from `at`. */
function week(at: number, handle: string, lines = THESIS_MIN_USER_LINES): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (let i = 0; i < lines; i++) {
    out.push({ role: 'user', content: `their line ${i} about the schedule again`, handle, at: at + i * 60_000 });
    out.push({ role: 'assistant', content: `her reply ${i}`, at: at + i * 60_000 + 1_000 });
  }
  return out;
}

function headPath(handle: string): string {
  return path.join(memoriesDir(handle), 'THESIS.md');
}

/** The next macrotask. The two tests below rely on ONE property of it: every microtask the pass has
 *  queued drains before a timer callback runs, so a bump scheduled in here lands strictly after the
 *  pass's next unlocked read — which is what makes an ordering test out of what is otherwise a race. */
function macrotask(): Promise<void> {
  return new Promise<void>(r => { setTimeout(r, 0); });
}

/** A competing version, landed by editing the one token the optimistic check reads. Called only from
 *  INSIDE the handle lock, which is the only writer allowed to touch these bytes, and it edits rather
 *  than re-renders so the test carries no copy of the store's header format. */
function bumpHeadVersion(handle: string, to: number): void {
  const p = headPath(handle);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/version=\d+/, `version=${to}`));
}

/** Run `body` with console.warn and console.error swallowed — the store logs loudly on a fence, a
 *  dropped write and an unreadable head, and a passing test should not print like a failing one. */
async function quietly(body: () => Promise<void>): Promise<void> {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await body();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

function receipts(): Record<string, unknown>[] {
  return getTraces()
    .filter(e => e.type === 'event' && e.label === 'thesis:rewrite')
    .map(e => e.detail as Record<string, unknown>);
}
function receipt(): Record<string, unknown> {
  const all = receipts();
  assert.equal(all.length, 1, `expected exactly one thesis:rewrite receipt, got ${all.length}`);
  return all[0];
}

// ── the pure half ────────────────────────────────────────────────────────────

test('the rendered week is plain two-party text with NO clock in it', () => {
  const rows: StoredMessage[] = [
    { role: 'user', content: 'is the dock still on order', handle: 'h', at: T0 },
    { role: 'assistant', content: 'six to eight weeks', at: T0 },
  ];
  assert.equal(renderThesisWindow(rows), 'user: is the dock still on order\nassistant: six to eight weeks');
});

test('the moments input carries the id, the tag and a coarse age in WORDS', () => {
  const line = renderThesisMoments(
    [{ id: 'mo-1', text: 'checked the volcano again', tag: 'habit', at: T0 - 40 * DAY, count: 3, offered: 0, lastOfferedAt: 0 }],
    T0,
  );
  assert.equal(line, 'id=mo-1 tag=habit (a month or two ago) — checked the volcano again');
});

test('a proposed read survives a prose wrapper; a present-but-empty field is a refusal, not a parse failure', () => {
  assert.equal(parseThesisReply(replyWith(READ)), READ);
  assert.equal(parseThesisReply(`here:\n${replyWith(READ)}\n`), READ);
  assert.equal(parseThesisReply('{"thesis":"a",}'), 'a', 'jsonrepair rescues a trailing comma');
  assert.equal(parseThesisReply('{"thesis":""}'), '', 'the lane answered with nothing — a refused read');
  assert.equal(parseThesisReply('{"thesis":null}'), '');
  assert.equal(parseThesisReply('{"other":1}'), null);
  assert.equal(parseThesisReply('nope'), null);
  assert.equal(parseThesisReply(null), null);
});

test('the writer prompt is the staged prose, and the bounds it states in words are the ones code holds', () => {
  assert.match(THESIS_SYSTEM_PROMPT, /^You are Irises\. Once a week you rewrite the one read you carry on this person: the short, true,\n/);
  assert.ok(THESIS_SYSTEM_PROMPT.includes('A thesis. Two to four sentences.'));
  assert.ok(THESIS_SYSTEM_PROMPT.includes('If the week gave you nothing new, return the current read unchanged.'));
  assert.equal(THESIS_MAX_SENTENCES, 4, 'the code bound and the prose bound are the same number');
});

// ── the gate order ───────────────────────────────────────────────────────────

test('the flag off costs no call, and still says so', async () => {
  process.env.MEMORY_THESIS_ENABLED = 'off';
  const h = freshHandle();
  const { llm, calls } = stubLlm(replyWith(READ));
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  assert.equal(calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'flag_off' });
});

test('a group identity is skipped entirely — a room has no them to have a read about', async () => {
  const g = groupHandle('chat-thesis-group');
  const { llm, calls } = stubLlm(replyWith(READ));
  await updateThesis(g, week(T0, g), { llm, now: T0, chatId: 'chat-thesis-group' });
  assert.equal(calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'group' });
  assert.equal(await getThesis(g), null);
});

test('a burst of replies inside one pass costs one call — the second sees the in-flight guard', async () => {
  const h = freshHandle();
  let release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const calls: LlmRequest[] = [];
  const llm = (async (req: LlmRequest) => {
    calls.push(req);
    await gate;
    return { text: replyWith(READ), toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'anthropic' as const, model: 'test' };
  }) as typeof callLLM;

  const first = updateThesis(h, week(T0, h), { llm, now: T0 });
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.deepEqual(receipts().map(r => r.skipped), ['in_flight', null]);
});

test('a failed pass backs off for an hour and never stamps the week it lost', async () => {
  const h = freshHandle();
  const dead = stubLlm(null, { throws: true });
  await updateThesis(h, week(T0, h), { llm: dead.llm, now: T0 });
  assert.equal(dead.calls.length, 1);
  assert.equal(__thesisBackoffAtForTests(h), T0 + THESIS_FAILURE_BACKOFF_MS);
  assert.equal(await getThesis(h), null, 'nothing was written, so the week is still owed');

  const inside = stubLlm(replyWith(READ));
  await updateThesis(h, week(T0, h), { llm: inside.llm, now: T0 + 30 * 60_000 });
  assert.equal(inside.calls.length, 0);
  assert.deepEqual(receipts().map(r => r.skipped), ['lane_error', 'backoff']);

  const later = stubLlm(replyWith(READ));
  await updateThesis(h, week(T0, h), { llm: later.llm, now: T0 + THESIS_FAILURE_BACKOFF_MS });
  assert.equal(later.calls.length, 1);
  assert.equal(__thesisBackoffAtForTests(h), undefined, 'a landed save clears it');
});

test("the cooldown reads the document's OWN rewrite stamp — a nightly note cannot reset the week", async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const cut = await rewrittenAt(h);

  const inside = stubLlm(replyWith(NEXT));
  await updateThesis(h, week(cut, h), { llm: inside.llm, now: cut + 1_000 });
  assert.equal(inside.calls.length, 0);
  assert.equal(receipt().skipped, 'cooldown');

  // A note lands mid-week and moves `updated=`. If the cooldown read THAT, the steady state of
  // somebody she texts daily would be a read written once and never again.
  clearTraces();
  assert.notEqual(await appendThesisEvidence(h, 'they set their own deadline again'), null);
  const stillInside = stubLlm(replyWith(NEXT));
  await updateThesis(h, week(cut, h), { llm: stillInside.llm, now: cut + 6 * DAY });
  assert.equal(stillInside.calls.length, 0);
  assert.equal(receipt().skipped, 'cooldown');

  clearTraces();
  const due = stubLlm(replyWith(NEXT));
  await updateThesis(h, week(cut + THESIS_COOLDOWN_MS, h), { llm: due.llm, now: cut + THESIS_COOLDOWN_MS + 1_000 });
  assert.equal(due.calls.length, 1);
});

test('a thin week skips WITHOUT stamping — a week of "ok" is not evidence to sharpen a read on', async () => {
  const h = freshHandle();
  const thin = stubLlm(replyWith(READ));
  await updateThesis(h, week(T0, h, THESIS_MIN_USER_LINES - 1), { llm: thin.llm, now: T0 });
  assert.equal(thin.calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'thin_window', windowUserLines: THESIS_MIN_USER_LINES - 1 });
  assert.equal(await getThesis(h), null);
});

// ── the pass that lands ──────────────────────────────────────────────────────

test('a first read is written, the clock is stamped, and all four inputs ride the prose file order', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  assert.notEqual(await appendThesisEvidence(h, 'they argued with the schedule and then set their own'), null);
  assert.equal(await writeMoments(h, [
    { id: 'mo-1', text: 'checked the volcano again', tag: 'habit', at: T0 - 3 * DAY, count: 2, offered: 0, lastOfferedAt: 0 },
  ], 0, []), true);

  const now = (await rewrittenAt(h)) + THESIS_COOLDOWN_MS + DAY;
  const { llm, calls } = stubLlm(replyWith(NEXT));
  await updateThesis(h, week(now - DAY, h), { llm, now, chatId: 'chat-1' });

  const req = calls[0];
  assert.equal(req.role, 'classify');
  assert.equal(req.maxTokens, 400);
  assert.equal(req.system, THESIS_SYSTEM_PROMPT);
  const body = String(req.messages[0].content);
  assert.ok(body.startsWith(`<${PROMPT_TAG}>`) && body.endsWith(`</${PROMPT_TAG}>`));
  const order = ['<current_thesis>', '<evidence>', '<moments>', '<transcript>', 'Rewrite the read.'];
  let at = -1;
  for (const tag of order) {
    const found = body.indexOf(tag);
    assert.ok(found > at, `${tag} is out of the prose file's order`);
    at = found;
  }
  assert.ok(body.includes(READ), 'the current read is the first thing it sees');
  assert.ok(body.includes('- they argued with the schedule and then set their own'));
  assert.ok(body.includes('id=mo-1 tag=habit'));
  assert.ok(!body.includes(THESIS_EVIDENCE_HEADING), 'the tail rides as its own tag, not inside the read');

  const doc = await getThesis(h);
  assert.equal(splitThesisDoc(doc!.docMd).thesis, NEXT);
  assert.equal(doc!.writtenBy, THESIS_REWRITE_WRITER);
  assert.equal(doc!.lastRewriteAt > 0, true, 'the rewrite clock moved');
  // The notes were this rewrite's input; a note that survived its own rewrite would be read again
  // next week against a read that already contains it.
  assert.deepEqual(splitThesisDoc(doc!.docMd).evidence, []);

  const r = receipt();
  assert.equal(r.skipped, null);
  assert.deepEqual([r.changed, r.hadRead, r.evidenceUsed, r.momentsSeen], [true, true, 1, 1]);
  assert.equal(r.sentences, 1);
});

test('a person with no read yet is told so, and the first pass writes version one', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(replyWith(READ));
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  assert.ok(String(calls[0].messages[0].content).includes('<current_thesis>\nnone yet\n</current_thesis>'));
  assert.equal((await getThesis(h))?.version, 1);
  assert.deepEqual([receipt().changed, receipt().hadRead], [true, false]);
});

test('a no-op rewrite is a PASS: the same words still stamp the week', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const before = await rewrittenAt(h);

  const now = before + THESIS_COOLDOWN_MS + DAY;
  const { llm } = stubLlm(replyWith(READ));
  await updateThesis(h, week(now - DAY, h), { llm, now });

  const doc = await getThesis(h);
  assert.equal(splitThesisDoc(doc!.docMd).thesis, READ);
  assert.equal(doc!.version, 2, 'one version per week, whether or not the words moved');
  assert.ok(doc!.lastRewriteAt >= before, 'and the clock moved, or the same question is re-asked every reply');
  assert.equal(receipt().changed, false);
});

test('the week is cut at the last rewrite, so one strong evening cannot be re-read into the same read', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const cut = (await getThesis(h))!.lastRewriteAt;

  const now = cut + THESIS_COOLDOWN_MS + DAY;
  // Half the rows predate the last rewrite: they were what THAT read was written from.
  const rows = [...week(cut - 3 * DAY, h), ...week(now - DAY, h)];
  const { llm, calls } = stubLlm(replyWith(NEXT));
  await updateThesis(h, rows, { llm, now });
  const body = String(calls[0].messages[0].content);
  const transcript = body.slice(body.indexOf('<transcript>'), body.indexOf('</transcript>'));
  assert.equal(transcript.split('their line 0').length, 2, 'exactly one evening of theirs, the fresh one');
  assert.equal(receipt().windowUserLines, THESIS_MIN_USER_LINES);
});

// ── the read that is not a read ──────────────────────────────────────────────

test('a LABEL instead of a read is refused and last week\'s read stands', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const now = (await rewrittenAt(h)) + THESIS_COOLDOWN_MS + DAY;
  const { llm } = stubLlm(replyWith('is lazy'));
  await updateThesis(h, week(now - DAY, h), { llm, now });

  assert.equal(splitThesisDoc((await getThesis(h))!.docMd).thesis, READ);
  assert.equal((await getThesis(h))!.version, 1, 'nothing was written');
  assert.deepEqual(receipt(), { skipped: 'rejected', reason: 'too_short', chars: 7 });
  // The backoff: a model that keeps writing labels must not bill a call per reply for a week.
  assert.equal(__thesisBackoffAtForTests(h), now + THESIS_FAILURE_BACKOFF_MS);
});

test('a lane that answered "none" is reported as a lane with nothing to say, not as a short read', async () => {
  const h = freshHandle();
  const { llm } = stubLlm(replyWith('none'));
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  assert.equal(receipt().reason, 'null_literal');
});

test('a TRUNCATED reply writes nothing, stamps nothing, and is its own bucket', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(replyWith(READ), { truncated: true });
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  assert.equal(calls.length, 1);
  assert.equal(await getThesis(h), null);
  assert.deepEqual(receipt(), { skipped: 'truncated' });
  assert.equal(__thesisBackoffAtForTests(h), T0 + THESIS_FAILURE_BACKOFF_MS);
});

test('an UNPARSABLE reply is told apart from a dead lane', async () => {
  const h = freshHandle();
  const { llm } = stubLlm('they overthink things.');
  await updateThesis(h, week(T0, h), { llm, now: T0 });
  assert.deepEqual(receipt(), { skipped: 'unparsable' });
  assert.equal(await getThesis(h), null);
});

test('a /forget landing mid-pass FENCES the save out, and is not retried', async () => {
  const h = freshHandle();
  const { llm, calls } = stubLlm(replyWith(READ), { before: () => { bumpForgetEpoch(h); } });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await updateThesis(h, week(T0, h), { llm, now: T0 });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(calls.length, 1);
  assert.equal(await getThesis(h), null, 'nothing the user asked to be forgotten came back');
  assert.equal(receipt().skipped, 'fenced');
  // A fence is the user erasing this person: nothing is broken and there is nothing to retry, so no
  // hour is burned either.
  assert.equal(__thesisBackoffAtForTests(h), undefined);
});

test('a nightly note landing mid-pass costs ONE re-read, not the rewrite', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const now = (await rewrittenAt(h)) + THESIS_COOLDOWN_MS + DAY;
  // The note lands while the model is thinking, so the version the pass read is already stale.
  const { llm } = stubLlm(replyWith(NEXT), {
    before: async () => { await appendThesisEvidence(h, 'a note that raced the rewrite'); },
  });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await updateThesis(h, week(now - DAY, h), { llm, now });
  } finally {
    console.warn = realWarn;
  }
  const doc = await getThesis(h);
  assert.equal(splitThesisDoc(doc!.docMd).thesis, NEXT, 'the rewrite landed on the second attempt');
  assert.equal(receipt().skipped, null);
  // The KNOWN cost of the retry, pinned rather than discovered: the note that arrived between the
  // read and the conflict is dropped, because what this pass writes is the read with an empty tail.
  // One note, once, on a pass that runs weekly — against a lost rewrite, which is a week.
  assert.deepEqual(splitThesisDoc(doc!.docMd).evidence, []);
});

test('a version that moves on BOTH attempts is a CONFLICT, and burns no hour', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const now = (await rewrittenAt(h)) + THESIS_COOLDOWN_MS + DAY;

  // Two competing versions, ORDERED rather than raced, because the second one is the whole point:
  // the retry re-reads the version before it saves, so a bump that lands before that read would let
  // the retry succeed. Both bumps run inside the handle lock, so the pass's two saves queue behind
  // them; both are timed off a macrotask, so every microtask the pass has queued — its own
  // unlocked re-read included — has already drained when they land.
  const { llm, calls } = stubLlm(replyWith(NEXT), {
    before: async () => {
      void withHandleLock(h, async () => {
        bumpHeadVersion(h, 2); // the version the pass read (1) is now stale — the first conflict
        await macrotask();     // …and the pass enqueues its first save behind this section meanwhile
        void withHandleLock(h, async () => {
          await macrotask();   // let the retry re-read version 2 first
          bumpHeadVersion(h, 3); // …then invalidate it — the second conflict
        });
      });
      // Long enough for the section above to have taken the lock and stamped version 2.
      await macrotask();
    },
  });
  await quietly(() => updateThesis(h, week(now - DAY, h), { llm, now }));

  assert.equal(calls.length, 1, 'one call, two attempts');
  assert.deepEqual(receipt(), { skipped: 'conflict', changed: true });
  // A double conflict means the nightly note is winning the race, which the cooldown spaces out on
  // its own: nothing is broken, so no hour is burned — and it is NOT reported as the fence, which is
  // the other null the store hands back.
  assert.equal(__thesisBackoffAtForTests(h), undefined);
  assert.equal(splitThesisDoc((await getThesis(h))!.docMd).thesis, READ, "last week's read stands");
});

// ── the file that will not parse, and the disk that will not write ───────────
// Both of these were a process EXIT before the T12 review: `saveThesis` threw from inside
// `withHandleLock`, whose queue publishes a second, unowned copy of the rejection, and
// `installProcessErrorHandlers` exits on `unhandledRejection`. Neither cause goes away by itself, so
// each was a restart LOOP — the VM died inside the turn, the process-local backoff died with it, and
// the next non-group turn with a week's lines in it ran the whole pass again. node:test fails on that
// unowned rejection too, which is what makes these two tests the guard and not just the coverage.

test('an unreadable head doc skips BEFORE the call, and stamps nothing', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  const hand = 'somebody hand-wrote a read with no header\n';
  fs.writeFileSync(headPath(h), hand);

  const { llm, calls } = stubLlm(replyWith(READ));
  await quietly(() => updateThesis(h, week(T0, h), { llm, now: T0 }));

  // The gate is BEFORE the lane, which is the point of having it: an unreadable head degrades to
  // "never rewritten" through the store's read, i.e. to an open cooldown on a file that will not
  // parse tomorrow either — so every reply would otherwise spend a classify call to reach a write
  // that cannot land.
  assert.equal(calls.length, 0);
  assert.deepEqual(receipt(), { skipped: 'degraded' });
  assert.equal(fs.readFileSync(headPath(h), 'utf8'), hand, 'the bytes stay exactly where they were');
  // No backoff: this failure is a file on disk, not a lane, and re-reading it next turn costs
  // nothing (the nightly pass's own reasoning for the same gate).
  assert.equal(__thesisBackoffAtForTests(h), undefined);
});

test('a durable write failure costs the week, not the process', async () => {
  const h = freshHandle();
  assert.equal(await saveThesis(h, READ, 0, THESIS_REWRITE_WRITER), 1);
  const now = (await rewrittenAt(h)) + THESIS_COOLDOWN_MS + DAY;
  // A full disk or an EACCES, reproduced the way db/repositories/thesis.test.ts reproduces it: put a
  // FILE where the revisions DIRECTORY has to go, so the first of the store's two writes throws.
  fs.rmSync(path.join(memoriesDir(h), 'revisions'), { recursive: true, force: true });
  fs.writeFileSync(path.join(memoriesDir(h), 'revisions'), 'not a directory');

  const { llm, calls } = stubLlm(replyWith(NEXT));
  await quietly(() => updateThesis(h, week(now - DAY, h), { llm, now }));

  assert.equal(calls.length, 1);
  // Told apart from a conflict, which is what the null out of the store would otherwise have read
  // as: nothing landed and nothing raced, so the version on disk never moved.
  assert.deepEqual(receipt(), { skipped: 'write_failed', changed: true });
  assert.equal(splitThesisDoc((await getThesis(h))!.docMd).thesis, READ, "last week's read stands");
  assert.equal((await getThesis(h))!.version, 1, 'nothing was written');
  // The sticky kind, so it takes the hour: the clock it could not stamp leaves the cooldown wide
  // open, and without the backoff a full disk bills one classify call per reply until it is fixed.
  assert.equal(__thesisBackoffAtForTests(h), now + THESIS_FAILURE_BACKOFF_MS);
});

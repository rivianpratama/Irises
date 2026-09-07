// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The THESIS.md store: the long tier's versioned-markdown discipline applied to her one read on a
// person, plus the evidence tail the two passes share.
//
// What the tests are really guarding:
//
//   • NOTHING IS LOST. Every accepted save bumps the version and snapshots a revision, a wipe
//     included — the read costs a week to earn, so a save that vanished would be invisible for
//     seven days.
//   • A STALE WRITER WRITES NOTHING. The nightly note and the weekly rewrite race by design; the
//     loser conflicts and retries rather than clobbering.
//   • TWO STORES, ONE REVISIONS FOLDER. LONG.vNNNN.md and THESIS.vNNNN.md live side by side and
//     neither listing sees the other's files.
//   • A WRITE IS REFUSED, NOT GUESSED. An unreadable head doc throws instead of being overwritten.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getThesis, saveThesis, listThesisRevisions, appendThesisEvidence, clearThesis, ThesisWriteError,
  THESIS_REWRITE_WRITER,
} from './thesis.js';
import { saveLongDoc, listLongRevisions } from './memoryLong.js';
import { memoriesDir } from '../stateDir.js';
import { splitThesisDoc, joinThesisDoc, THESIS_EVIDENCE_MAX } from '../../memory/thesisEngine.js';

let seq = 0;
function freshHandle(): string {
  return `+1555400${(seq++).toString().padStart(4, '0')}`;
}

const READ = 'They decide fast on things that cost money and slowly on things that cost a conversation.';

function filePath(handle: string): string {
  return path.join(memoriesDir(handle), 'THESIS.md');
}

// ── the version machine ──────────────────────────────────────────────────────

test('first save creates version 1 + a revision; reads round-trip', async () => {
  const h = freshHandle();
  assert.equal(await getThesis(h), null);
  const v = await saveThesis(h, READ, 0, 'weekly');
  assert.equal(v, 1);
  const doc = await getThesis(h);
  assert.equal(doc?.version, 1);
  assert.equal(doc?.docMd, READ);
  const revs = await listThesisRevisions(h);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].writtenBy, 'weekly');
});

test('every accepted save snapshots a revision — a wipe included', async () => {
  const h = freshHandle();
  await saveThesis(h, 'read one', 0, 'weekly');
  await saveThesis(h, 'read two', 1, 'weekly');
  await saveThesis(h, '', 2, 'forget'); // clearing is itself a revision
  const revs = await listThesisRevisions(h);
  assert.deepEqual(revs.map(r => [r.version, r.docMd, r.writtenBy]), [
    [3, '', 'forget'], [2, 'read two', 'weekly'], [1, 'read one', 'weekly'],
  ]);
  assert.equal((await getThesis(h))?.docMd, '');
});

test('the header carries the REWRITE clock the weekly pass gates on', async () => {
  const h = freshHandle();
  const before = Date.now();
  await saveThesis(h, READ, 0, 'weekly');
  const doc = await getThesis(h);
  assert.equal(doc?.writtenBy, 'weekly');
  assert.ok(doc!.lastRewriteAt >= before);
  assert.ok(doc!.lastRewriteAt <= Date.now());
  // One file, one clock: the stamp the pass gates on is the same line that carries the version it
  // writes against, so a cooldown can never disagree with the document it guards.
  const head = fs.readFileSync(filePath(h), 'utf8');
  assert.match(head, /^<!-- irises:thesis version=1 written_by=weekly updated=\S+ rewritten=\S+ -->\n/);
  assert.equal(head.slice(head.indexOf('\n') + 1), READ);
});

test('a nightly note does NOT move the rewrite clock — and a wipe does not either', async () => {
  // THE bug this store exists to not have. The document has two writers at two rhythms: gate the
  // 6.5-day cooldown on the last WRITE and one nightly note inside the window resets it, so the
  // steady state of somebody she texts daily is a read written once, ever. `updated=` is the write
  // stamp; `rewritten=` is the clock; only a 'weekly' save advances it.
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  const clock = (await getThesis(h))!.lastRewriteAt;
  assert.ok(clock > 0);

  assert.equal(await appendThesisEvidence(h, 'they asked about the volcano again'), 2);
  const noted = await getThesis(h);
  assert.equal(noted?.writtenBy, 'evidence');
  assert.equal(noted?.version, 2, 'a note is still a version — the optimistic check depends on it');
  assert.equal(noted?.lastRewriteAt, clock, 'but it is not a rewrite');
  // In the bytes: the write stamp moved, the rewrite stamp is the one the read was written at.
  const m = fs.readFileSync(filePath(h), 'utf8').match(/updated=(\S+) rewritten=(\S+)/)!;
  assert.equal(Date.parse(m[2]), clock);
  assert.ok(Date.parse(m[1]) >= clock);

  // A wipe carries it forward rather than clearing it: after a /forget the cooldown stays shut
  // until the erased read would have been due anyway, so nothing re-mints a read minutes after
  // somebody asked to be forgotten.
  assert.equal(await clearThesis(h), 3);
  assert.equal((await getThesis(h))!.lastRewriteAt, clock);

  // And the writer word that DOES advance it, advances it.
  const before = Date.now();
  assert.equal(await saveThesis(h, 'a sharper read of them', 3, THESIS_REWRITE_WRITER), 4);
  assert.ok((await getThesis(h))!.lastRewriteAt >= before);
});

test('a doc that was never rewritten reads a zero clock — an OPEN window, not a fresh one', async () => {
  const h = freshHandle();
  // The nightly pass runs for days before the first rewrite, so a tail can exist with no read.
  assert.equal(await appendThesisEvidence(h, 'a note before there was a read'), 1);
  assert.equal((await getThesis(h))!.lastRewriteAt, 0, 'never rewritten must not read as just rewritten');
  assert.match(
    fs.readFileSync(filePath(h), 'utf8'),
    /^<!-- irises:thesis version=1 written_by=evidence updated=\S+ rewritten=never -->\n/,
    'and a human opening the file reads the answer instead of doing arithmetic on 1970',
  );
});

test('a header written before the rewrite stamp existed still parses, and heals on the next save', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  fs.writeFileSync(filePath(h), `<!-- irises:thesis version=4 written_by=weekly updated=2026-09-01T00:00:00.000Z -->\n${READ}`);
  const doc = await getThesis(h);
  assert.equal(doc?.version, 4, 'a field that was ADDED must not fail-loud a write over a real read');
  assert.equal(doc?.docMd, READ);
  assert.equal(doc?.lastRewriteAt, 0, 'and it reads as never-rewritten: one extra rewrite, never a year of skipped ones');
  assert.equal(await saveThesis(h, 'a fresh read of them', 4, 'weekly'), 5);
  assert.ok((await getThesis(h))!.lastRewriteAt > 0);
});

test('stale expectedVersion returns null and writes NOTHING', async () => {
  const h = freshHandle();
  await saveThesis(h, 'current', 0, 'weekly');
  const conflicted = await saveThesis(h, 'from a stale reader', 0, 'weekly');
  assert.equal(conflicted, null);
  assert.equal((await getThesis(h))?.docMd, 'current');
  assert.equal((await listThesisRevisions(h)).length, 1);

  const cur = await getThesis(h);
  assert.equal(await saveThesis(h, 'merged', cur!.version, 'weekly'), 2);
});

test('two racing writers: exactly one wins, the loser conflicts', async () => {
  const h = freshHandle();
  await saveThesis(h, 'base', 0, 'weekly');
  const [r1, r2] = await Promise.all([
    saveThesis(h, 'the weekly rewrite', 1, 'weekly'),
    saveThesis(h, 'a nightly note', 1, 'evidence'),
  ]);
  assert.equal([r1, r2].filter(v => v === 2).length, 1);
  assert.equal([r1, r2].filter(v => v === null).length, 1);
  assert.equal((await getThesis(h))?.version, 2);
});

test('a present-but-unreadable head doc degrades the READ and never gets clobbered', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  const hand = 'somebody hand-wrote a read with no header\n';
  fs.writeFileSync(filePath(h), hand);
  // The read degrades to null — a turn must not die over a file — while the bytes stay exactly
  // where they were. Everything that reads this store therefore behaves like a handle with no read
  // at all, which is the safe half of the fail-loud policy.
  assert.equal(await getThesis(h), null);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), hand);
  // The wipe refuses it too, on the same read, so /forget never turns an unparseable file into an
  // empty one it cannot version — and never reaches the throwing branch below.
  assert.equal(await clearThesis(h), null);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), hand);

  // And the NIGHTLY pass DROPS its note rather than reaching the refusal, which is the one
  // asymmetry in the fail-loud policy and the reason for it: a throw out of a locked section is
  // process-fatal, not pass-fatal (withHandleLock keeps its queue with `void next.finally(...)`,
  // so the rejection is also published unowned, and diagnostics/errorLog.ts exits the process on
  // unhandledRejection). This store's own render seam cites "a human who opened THESIS.md and
  // typed" as a real case; that hand edit must cost one dropped note, not the VM.
  assert.equal(await appendThesisEvidence(h, 'a note with nowhere to land'), null);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), hand, 'the bytes stay exactly where they were');
  assert.equal(fs.existsSync(path.join(memoriesDir(h), 'revisions')), false, 'and nothing was versioned');

  // THE WRITE HALF IS NOT EXERCISED HERE, and the reason is worth writing down rather than leaving
  // as a coverage hole for the next reader to "fix": `saveThesis` refuses this file with a
  // ThesisWriteError from INSIDE withHandleLock, and that queue keeps itself with
  // `void next.finally(...)` (db/repositories/memory.ts) — so a throwing locked section publishes a
  // second, unowned copy of the rejection beside the one the caller catches, and node:test fails
  // the running test on it whatever listeners the test installs. It is not this store's wart: it is
  // why memoryLong's and memoryMedium's identical fail-loud branches have no test either. What can
  // be pinned without firing it is the contract itself.
  assert.equal(typeof ThesisWriteError, 'function');
  const err = new ThesisWriteError('saveThesis (head read)');
  assert.equal(err.name, 'ThesisWriteError');
  assert.match(err.message, /^\[memory-thesis\] durable write failed: /);
  assert.ok(err instanceof Error);
});

test('the head doc and revisions land as files, and share the folder with the long tier', async () => {
  const h = freshHandle();
  await saveThesis(h, '# a read', 0, 'weekly');
  await saveLongDoc(h, '# the long doc', 0, 'dossier');
  assert.ok(fs.existsSync(path.join(memoriesDir(h), 'revisions', 'THESIS.v0001.md')));
  assert.ok(fs.existsSync(path.join(memoriesDir(h), 'revisions', 'LONG.v0001.md')));
  // Neither listing sees the other's file: same version number, different document.
  assert.deepEqual((await listThesisRevisions(h)).map(r => r.docMd), ['# a read']);
  assert.deepEqual((await listLongRevisions(h)).map(r => r.docMd), ['# the long doc']);
});

test('a corrupt revision is skipped rather than sinking the listing', async () => {
  const h = freshHandle();
  await saveThesis(h, 'v1', 0, 'weekly');
  await saveThesis(h, 'v2', 1, 'weekly');
  fs.writeFileSync(path.join(memoriesDir(h), 'revisions', 'THESIS.v0001.md'), 'headerless junk');
  assert.deepEqual((await listThesisRevisions(h)).map(r => r.version), [2]);
});

// ── the evidence tail ────────────────────────────────────────────────────────

test('a nightly note appends to the tail, bumps the version, and leaves the read alone', async () => {
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  assert.equal(await appendThesisEvidence(h, 'asked about the volcano again'), 2);
  const doc = await getThesis(h);
  const parts = splitThesisDoc(doc!.docMd);
  assert.equal(parts.thesis, READ, 'the read is the weekly pass\'s to change, not the nightly one\'s');
  assert.deepEqual(parts.evidence, ['asked about the volcano again']);
  // A note IS a change to the document the weekly rewrite reads, so it moves the version — a store
  // where one writer could mutate a document without moving its version is a store where the other
  // writer's optimistic check means nothing.
  assert.equal((await listThesisRevisions(h))[0].writtenBy, 'evidence');
});

test('the tail is FIFO at seven: the eighth note pushes the oldest out', async () => {
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  for (let i = 1; i <= THESIS_EVIDENCE_MAX + 3; i++) await appendThesisEvidence(h, `note ${i}`);
  const { thesis, evidence } = splitThesisDoc((await getThesis(h))!.docMd);
  assert.equal(thesis, READ);
  assert.equal(evidence.length, THESIS_EVIDENCE_MAX);
  assert.deepEqual(evidence, ['note 4', 'note 5', 'note 6', 'note 7', 'note 8', 'note 9', 'note 10']);
});

test('a note lands on a handle with no read yet, and an empty note lands nowhere', async () => {
  const h = freshHandle();
  // The nightly pass runs long before the first rewrite, so the tail has to exist without a read.
  assert.equal(await appendThesisEvidence(h, 'they asked how i knew'), 1);
  assert.deepEqual(splitThesisDoc((await getThesis(h))!.docMd), { thesis: '', evidence: ['they asked how i knew'] });

  assert.equal(await appendThesisEvidence(h, '   '), null, 'nothing to append is not a write');
  assert.equal(await appendThesisEvidence(h, ''), null);
  assert.equal((await getThesis(h))?.version, 1, 'and it did not bump the version');
});

test('a note that loses the race retries once and lands', async () => {
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  // The real collision: the weekly rewrite commits while the nightly append is mid-flight. The
  // append re-reads and retries, so the note lands ON TOP of the new read rather than being lost.
  //
  // The interleaving is deterministic rather than lucky: the append reads the file synchronously on
  // the way to its first await, and withHandleLock's queue is FIFO by CALL time (memory.ts sets the
  // chain entry synchronously), so the rewrite below is already in the queue when the append's own
  // save asks to join it. The append therefore always writes second, against a version that moved.
  const [note, rewrite] = await Promise.all([
    appendThesisEvidence(h, 'the note from tonight'),
    saveThesis(h, 'a sharper read of them', 1, 'weekly'),
  ]);
  assert.equal(rewrite, 2);
  assert.equal(note, 3);
  const parts = splitThesisDoc((await getThesis(h))!.docMd);
  assert.equal(parts.thesis, 'a sharper read of them');
  assert.deepEqual(parts.evidence, ['the note from tonight']);
});

// ── the wipe ─────────────────────────────────────────────────────────────────

test('the wipe empties the read AND the tail, as a new version', async () => {
  const h = freshHandle();
  await saveThesis(h, joinThesisDoc(READ, ['a note', 'another']), 0, 'weekly');
  assert.equal(await clearThesis(h), 2);
  const doc = await getThesis(h);
  assert.equal(doc?.docMd, '');
  assert.deepEqual(splitThesisDoc(doc!.docMd), { thesis: '', evidence: [] });
  // The revision history survives the wipe, exactly as the long tier's does: nothing here is
  // searchable, so nothing comes back through recall_memory.
  assert.deepEqual((await listThesisRevisions(h)).map(r => r.version), [2, 1]);
});

test('a wipe on a handle with nothing written creates no file', async () => {
  const h = freshHandle();
  assert.equal(await clearThesis(h), null);
  assert.equal(fs.existsSync(filePath(h)), false, '/forget must not mint a file to record a forget');
  // And a wipe of an already-wiped read is a no-op rather than a stack of empty versions.
  await saveThesis(h, READ, 0, 'weekly');
  assert.equal(await clearThesis(h), 2);
  assert.equal(await clearThesis(h), null);
  assert.equal((await getThesis(h))?.version, 2);
});

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
//   • A WRITE IS REFUSED, NOT GUESSED. An unreadable head doc throws instead of being overwritten —
//     for every writer except the wipe, which is the one write whose whole point is losing content.
//   • A /forget IS NOT UNDONE. Both passes read, think for fifteen seconds, then write; a wipe that
//     lands inside that window fences the save out rather than being reverted by it.
//   • A BACKGROUND WRITER NEVER KILLS THE PROCESS. A throw out of a locked section is process-fatal,
//     so every writer nobody is waiting on — the nightly note, the wipe and (since the T12 review)
//     the weekly rewrite — asks for `onFailure: 'drop'`. The throw survives as the DEFAULT, which is
//     what these tests exercise it as.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getThesis, readThesisHead, saveThesis, listThesisRevisions, appendThesisEvidence, clearThesis,
  ThesisWriteError, THESIS_REWRITE_WRITER,
} from './thesis.js';
import { saveLongDoc, listLongRevisions } from './memoryLong.js';
import { getForgetEpoch, bumpForgetEpoch } from './memory.js';
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

test('a nightly note does NOT move the rewrite clock — and a wipe DOES', async () => {
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

  // A WIPE stamps the clock, so the next window starts at the wipe — the same decision
  // clearMoments records for its harvest stamp, and for the same reason: this stamp is also the
  // weekly window's CUT (buildThesisWindow), and /forget does not clear the transcript (that is
  // /clear). Carried forward, the first pass after the cooldown reopened would read the pre-forget
  // rows and re-mint substantially the read the user asked to erase. Stamped here, the cooldown
  // also stays shut a full 6.5 days FROM the wipe, which is longer than carrying it forward.
  const wipedAt = Date.now();
  assert.equal(await clearThesis(h), 3);
  const wiped = fs.readFileSync(filePath(h), 'utf8').match(/updated=(\S+) rewritten=(\S+)/)!;
  assert.equal(wiped[2], wiped[1], 'the wipe\'s two stamps are ONE instant — the wipe itself');
  const afterWipe = (await getThesis(h))!.lastRewriteAt;
  assert.ok(afterWipe >= wipedAt, 'and the clock the next window cuts at is the wipe, not last week');

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

// ── the /forget fence ────────────────────────────────────────────────────────

test('a /forget that lands mid-pass fences the save out, and nothing is versioned', async () => {
  const h = freshHandle();
  const epoch0 = getForgetEpoch(h);
  assert.equal(await saveThesis(h, READ, 0, 'weekly', { ifForgetEpoch: epoch0 }), 1);

  // The shape of the real race: the weekly pass reads the document, spends fifteen seconds in a
  // classify call, and writes. A /forget inside that window wipes — and the version check alone
  // cannot see it, because the wipe left the version exactly where the pass expects it.
  const epoch1 = getForgetEpoch(h);
  assert.equal(await clearThesis(h), 2);
  bumpForgetEpoch(h); // what clearDossier does, under the same per-handle queue
  assert.equal(
    await saveThesis(h, 'the read the pass was holding', 2, 'weekly', { ifForgetEpoch: epoch1 }),
    null,
    'the version matched — only the epoch could refuse this',
  );
  assert.equal((await getThesis(h))?.docMd, '', 'the wipe stands');
  assert.deepEqual((await listThesisRevisions(h)).map(r => r.version), [2, 1], 'and nothing new was minted');

  // The fence is per-call, not a latch: a pass that read the epoch AFTER the forget writes normally.
  assert.equal(await saveThesis(h, READ, 2, 'weekly', { ifForgetEpoch: getForgetEpoch(h) }), 3);
});

test('the nightly note carries the fence too, and does NOT retry through it', async () => {
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  // The nightly pass fences the same window the moments call spans (writeMoments takes the same
  // option off the same read).
  const epoch0 = getForgetEpoch(h);
  bumpForgetEpoch(h);
  assert.equal(await appendThesisEvidence(h, 'a note from before the wipe', { ifForgetEpoch: epoch0 }), null);
  assert.equal((await getThesis(h))?.version, 1, 'nothing was written');
  assert.equal((await listThesisRevisions(h)).length, 1);
  // A fenced-out save shares the null with a version conflict and must not be retried — the
  // document the loop is holding is exactly what the user erased. Without the fence the note lands.
  assert.equal(await appendThesisEvidence(h, 'a note after the wipe', { ifForgetEpoch: getForgetEpoch(h) }), 2);
});

test('a durable write failure DROPS a nightly note and a wipe rather than the process', async () => {
  const h = freshHandle();
  await saveThesis(h, READ, 0, 'weekly');
  // A full disk or an EACCES, reproduced the only way a test can without root: put a FILE where the
  // revisions DIRECTORY has to go, so atomicWriteText's mkdir throws on the way to the first of the
  // two writes. This is the half of the fail-loud policy the head-read test above cannot fire, and
  // the reason these two writers must not fire it: node:test would fail this test on the unowned
  // rejection withHandleLock publishes, which is precisely the signal that the VM would have died.
  fs.rmSync(path.join(memoriesDir(h), 'revisions'), { recursive: true, force: true });
  fs.writeFileSync(path.join(memoriesDir(h), 'revisions'), 'not a directory');
  assert.equal(await appendThesisEvidence(h, 'a note on a full disk'), null);
  assert.equal(await clearThesis(h), null);
  assert.equal((await getThesis(h))?.docMd, READ, 'the document is untouched by either failure');
  assert.equal((await getThesis(h))?.version, 1);
});

test('a present-but-unreadable head doc degrades the READ and no PASS ever clobbers it', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  const hand = 'somebody hand-wrote a read with no header\n';
  fs.writeFileSync(filePath(h), hand);
  // The read degrades to null — a turn must not die over a file — while the bytes stay exactly
  // where they were. Everything that reads this store therefore behaves like a handle with no read
  // at all, which is the safe half of the fail-loud policy. A WRITER that must not confuse the two
  // nulls reads `readThesisHead` instead, and gets the same `degraded` flag the moments store gives.
  assert.equal(await getThesis(h), null);
  assert.deepEqual(await readThesisHead(h), { doc: null, degraded: true });
  assert.deepEqual(await readThesisHead(freshHandle()), { doc: null, degraded: false }, 'absent is not degraded');
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), hand);

  // And the NIGHTLY pass DROPS its note rather than reaching the refusal, which is the
  // asymmetry in the fail-loud policy and the reason for it: a throw out of a locked section is
  // process-fatal, not pass-fatal (withHandleLock keeps its queue with `void next.finally(...)`,
  // so the rejection is also published unowned, and diagnostics/errorLog.ts exits the process on
  // unhandledRejection). This store's own render seam cites "a human who opened THESIS.md and
  // typed" as a real case; that hand edit must cost one dropped note, not the VM.
  assert.equal(await appendThesisEvidence(h, 'a note with nowhere to land'), null);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), hand, 'the bytes stay exactly where they were');
  assert.equal(fs.existsSync(path.join(memoriesDir(h), 'revisions')), false, 'and nothing was versioned');

  // ONLY HALF the write path is exercised here — the HEAD-READ refusal — and the reason the other
  // half is not is worth writing down rather than leaving as a coverage hole for the next reader to
  // "fix": `saveThesis` refuses this file with a ThesisWriteError from INSIDE withHandleLock, and
  // that queue keeps itself with `void next.finally(...)` (db/repositories/memory.ts) — so a
  // throwing locked section publishes a second, unowned copy of the rejection beside the one the
  // caller catches, and node:test fails the running test on it whatever listeners the test
  // installs. It is also exactly why a caller-side try/catch was never an option and the two
  // background writers pass `onFailure: 'drop'` instead: the DURABLE-WRITE half of the same policy
  // is now non-fatal for them and IS exercised, two tests below. It is not this store's wart: it is
  // why memoryLong's and memoryMedium's identical fail-loud branches have no test either. What can
  // be pinned without firing it is the contract itself.
  assert.equal(typeof ThesisWriteError, 'function');
  const err = new ThesisWriteError('saveThesis (head read)');
  assert.equal(err.name, 'ThesisWriteError');
  assert.match(err.message, /^\[memory-thesis\] durable write failed: /);
  assert.ok(err instanceof Error);
});

test('/forget wipes an unreadable head anyway — the one write that outranks the version', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  fs.writeFileSync(filePath(h), 'somebody hand-wrote a read with no header\n');
  // Every OTHER writer refuses a file it cannot version, because the read in there costs a week to
  // earn back. A wipe is the exception on the plainest possible grounds: losing that content is the
  // request. Refusing here would leave her read of somebody sitting on disk in plaintext through
  // the one command that exists to remove it — and `clearMoments` overwrites unconditionally for
  // the same reason.
  assert.equal(await clearThesis(h), 1);
  const doc = await getThesis(h);
  assert.equal(doc?.docMd, '');
  assert.equal(doc?.writtenBy, 'forget');
  assert.ok(doc!.lastRewriteAt > 0, 'and the wipe stamps the clock like any other wipe');
  assert.ok(fs.existsSync(path.join(memoriesDir(h), 'revisions', 'THESIS.v0001.md')));
});

test('an unversioned wipe numbers itself above the revisions it cannot read', async () => {
  const h = freshHandle();
  await saveThesis(h, 'read one', 0, 'weekly');
  await saveThesis(h, 'read two', 1, 'weekly');
  // The head is mangled at v2; the revisions folder still holds v1 and v2. A wipe that started at
  // version 1 would mint THESIS.v0002.md again and overwrite a real revision, and the next save
  // would then be a version that already exists.
  fs.writeFileSync(filePath(h), 'half a write, no header');
  assert.equal(await clearThesis(h), 3);
  assert.deepEqual((await listThesisRevisions(h)).map(r => [r.version, r.docMd]), [
    [3, ''], [2, 'read two'], [1, 'read one'],
  ]);
  assert.equal(await saveThesis(h, 'a read after the wipe', 3, 'weekly'), 4);
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

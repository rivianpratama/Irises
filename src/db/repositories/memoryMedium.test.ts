// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Exercises the medium (no-error-margin) memory tier on the MEDIUM.md file store: dedupe,
// supersede chains, retraction, cap eviction, fact upsert semantics, and the concurrent
// append regression the legacy prefs-array rebuild used to lose.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listMediumActive, listMediumAll, listMediumPreserved, addDirective, updateDirective, retractEntry,
  retractAllForHandle, addImportantNote, upsertFact, mergeNotes,
  MAX_ACTIVE_DIRECTIVES, MAX_ACTIVE_NOTES, CAP_EVICTED, MERGED_NOTE_MAX_CHARS,
  MEDIUM_ARCHIVE_MAX_BYTES, MEDIUM_ARCHIVE_KEEP,
} from './memoryMedium.js';
import { listArchiveFor } from './memoryArchive.js';
import { getForgetEpoch, bumpForgetEpoch } from './memory.js';
import { memoriesDir } from '../stateDir.js';

let seq = 0;
function freshHandle(): string {
  return `+1555100${(seq++).toString().padStart(4, '0')}`;
}

test('addDirective round-trip + case-insensitive dedupe returns null', async () => {
  const h = freshHandle();
  const created = await addDirective(h, 'keep replies short');
  assert.ok(created);
  assert.equal(created!.kind, 'directive');
  assert.equal(await addDirective(h, 'Keep Replies Short'), null); // dup, case-insensitive
  const active = await listMediumActive(h, ['directive']);
  assert.equal(active.length, 1);
});

test('updateDirective supersedes: old row survives with a forward pointer', async () => {
  const h = freshHandle();
  const first = await addDirective(h, 'no emojis');
  assert.ok(first);
  const ok = await updateDirective(h, first!.id, 'no emojis except thumbs up');
  assert.equal(ok, true);

  const all = await listMediumAll(h);
  assert.equal(all.length, 2); // NOTHING deleted
  const old = all.find(e => e.id === first!.id)!;
  const neu = all.find(e => e.id !== first!.id)!;
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, neu.id); // chain points forward
  assert.equal(neu.status, 'active');
  assert.equal(neu.body, 'no emojis except thumbs up');

  assert.equal(await updateDirective(h, first!.id, 'again'), false); // already superseded
  assert.equal(await updateDirective(h, 'no-such-id', 'x'), false);
});

test('retractEntry soft-removes; retractAllForHandle sweeps active rows', async () => {
  const h = freshHandle();
  const d = await addDirective(h, 'flag urgent email only');
  await addImportantNote(h, 'lockbox is 4421');
  assert.equal(await retractEntry(h, d!.id), true);
  assert.equal(await retractEntry(h, d!.id), false); // no longer active

  await retractAllForHandle(h);
  assert.equal((await listMediumActive(h)).length, 0);
  assert.equal((await listMediumAll(h)).length, 2); // rows preserved, just retracted
});

test('addImportantNote dedupes and returns text either way (confirmation stands)', async () => {
  const h = freshHandle();
  assert.equal(await addImportantNote(h, 'gate code 88'), 'gate code 88');
  assert.equal(await addImportantNote(h, 'GATE CODE 88'), 'GATE CODE 88'); // dedupe, still confirmed
  assert.equal((await listMediumActive(h, ['important_note'])).length, 1);
});

test('directive cap evicts the OLDEST active row by superseding it', async () => {
  const h = freshHandle();
  for (let i = 0; i < MAX_ACTIVE_DIRECTIVES + 2; i++) {
    await addDirective(h, `directive number ${i}`);
  }
  const active = await listMediumActive(h, ['directive']);
  assert.equal(active.length, MAX_ACTIVE_DIRECTIVES);
  assert.equal(active[0].body, 'directive number 2'); // 0 and 1 evicted (FIFO)
  const all = await listMediumAll(h);
  assert.equal(all.length, MAX_ACTIVE_DIRECTIVES + 2); // evicted rows still exist
  const evicted = all.filter(e => e.status === 'superseded');
  assert.equal(evicted.length, 2);
  // An aged-out row was NOT replaced by whichever entry tripped the cap — the sentinel says so.
  for (const e of evicted) assert.equal(e.supersededBy, CAP_EVICTED);
});

test('note cap matches MAX_ACTIVE_NOTES', async () => {
  const h = freshHandle();
  for (let i = 0; i < MAX_ACTIVE_NOTES + 1; i++) {
    await addImportantNote(h, `note ${i}`);
  }
  assert.equal((await listMediumActive(h, ['important_note'])).length, MAX_ACTIVE_NOTES);
});

test('upsertFact: one active value per slot, unchanged value is a no-op', async () => {
  const h = freshHandle();
  await upsertFact(h, 'brokerage', 'Keller Williams');
  await upsertFact(h, 'brokerage', 'Keller Williams'); // no-op
  assert.equal((await listMediumAll(h)).length, 1);

  await upsertFact(h, 'brokerage', 'eXp Realty');
  const all = await listMediumAll(h);
  assert.equal(all.length, 2);
  const active = await listMediumActive(h, ['fact']);
  assert.equal(active.length, 1);
  assert.equal(active[0].body, 'eXp Realty');
  const old = all.find(e => e.body === 'Keller Williams')!;
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, active[0].id);
});

test('REGRESSION: two concurrent appends with different texts both survive', async () => {
  // The legacy prefs-array path read the whole array, rebuilt it, and wrote it back — two
  // concurrent adds could each read the same base and one silently clobbered the other.
  // Rows + per-handle lock make both land.
  const h = freshHandle();
  await Promise.all([
    addDirective(h, 'always give square footage'),
    addDirective(h, 'text me before 8pm only'),
  ]);
  const active = await listMediumActive(h, ['directive']);
  assert.deepEqual(active.map(d => d.body).sort(), ['always give square footage', 'text me before 8pm only']);
});

test('concurrent same-text appends dedupe to exactly one row', async () => {
  const h = freshHandle();
  const [a, b] = await Promise.all([
    addDirective(h, 'keep it brief'),
    addDirective(h, 'keep it brief'),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal((await listMediumActive(h, ['directive'])).length, 1);
});

test('entries live in MEDIUM.md; retired lineage lands in MEDIUM.archive.md', async () => {
  const h = freshHandle();
  const d = await addDirective(h, 'anything');
  const active = fs.readFileSync(path.join(memoriesDir(h), 'MEDIUM.md'), 'utf8');
  assert.ok(active.includes('anything'));
  assert.ok(active.includes(`id=${d!.id}`));
  await retractEntry(h, d!.id);
  const archive = fs.readFileSync(path.join(memoriesDir(h), 'MEDIUM.archive.md'), 'utf8');
  assert.ok(archive.includes('status=retracted'));
  assert.ok(!fs.readFileSync(path.join(memoriesDir(h), 'MEDIUM.md'), 'utf8').includes('anything'));
});

test('hand-edited (unannotated) segments are preserved verbatim across rewrites', async () => {
  const h = freshHandle();
  await addDirective(h, 'keep me');
  const p = path.join(memoriesDir(h), 'MEDIUM.md');
  fs.appendFileSync(p, '\n§\na human scribbled this without an annotation');
  await addDirective(h, 'second entry');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.includes('a human scribbled this without an annotation'));
  // the hand edit is preserved but never rendered as an entry
  assert.equal((await listMediumActive(h)).length, 2);
});

test('listMediumPreserved surfaces a mangled annotation the renderers silently skip', async () => {
  const h = freshHandle();
  const created = await addDirective(h, 'flag anything from the county');
  assert.equal((await listMediumPreserved(h)).length, 0);

  // Corrupt the annotation the way a hand edit does (a dropped closing marker).
  const p = path.join(memoriesDir(h), 'MEDIUM.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(` id=${created!.id}`, ' id='), 'utf8');

  assert.equal((await listMediumActive(h)).length, 0, 'the entry is invisible to every renderer');
  const preserved = await listMediumPreserved(h);
  assert.equal(preserved.length, 1);
  assert.match(preserved[0], /flag anything from the county/);
});

// ── The archive feed: every retire path lands in memory_archive with the right source ────────

test('each retire path lands the right archive source', async () => {
  const h = freshHandle();
  const d = await addDirective(h, 'a directive that will be edited');
  await updateDirective(h, d!.id, 'the edited directive');            // → medium_superseded
  const r = await addDirective(h, 'a directive they will drop');
  await retractEntry(h, r!.id);                                       // → medium_retracted
  await upsertFact(h, 'brokerage', 'Keller Williams');
  await upsertFact(h, 'brokerage', 'eXp Realty');                     // → medium_superseded

  const archived = await listArchiveFor(h);
  const bySource = new Map(archived.map(a => [a.content, a.source]));
  assert.equal(bySource.get('a directive that will be edited'), 'medium_superseded');
  assert.equal(bySource.get('a directive they will drop'), 'medium_retracted');
  assert.equal(bySource.get('Keller Williams'), 'medium_superseded');
  // The fact's slot name rides along as `request` so a recall search can match on it.
  assert.equal(archived.find(a => a.content === 'Keller Williams')?.request, 'brokerage');
  assert.equal(archived.find(a => a.content === 'Keller Williams')?.kind, 'fact');
});

test('a cap eviction is archived as medium_cap_evicted', async () => {
  const h = freshHandle();
  for (let i = 0; i < MAX_ACTIVE_NOTES + 1; i++) await addImportantNote(h, `note ${i}`);
  const archived = await listArchiveFor(h);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].source, 'medium_cap_evicted');
  assert.equal(archived[0].content, 'note 0');
});

test('the /forget sweep archives every retracted row', async () => {
  const h = freshHandle();
  await addDirective(h, 'first standing preference');
  await addImportantNote(h, 'the gate code is 4421');
  await retractAllForHandle(h);
  const archived = await listArchiveFor(h);
  assert.equal(archived.length, 2);
  assert.ok(archived.every(a => a.source === 'medium_retracted'));
});

test('MEDIUM.archive.md rotates when it gets big; the rows survive in memory_archive', async () => {
  const h = freshHandle();
  const p = path.join(memoriesDir(h), 'MEDIUM.archive.md');
  // Seed an oversized ledger of REAL entries, so the rotation has something parsable to keep.
  await addDirective(h, 'seed');
  const seeded = (await listMediumActive(h))[0];
  const bulky = 'x'.repeat(500);
  const one = `${bulky}\n<!-- mm id=${seeded.id} kind=directive source=convo created=${new Date(seeded.createdAt).toISOString()} updated=${new Date(seeded.updatedAt).toISOString()} status=superseded -->\n§\n`;
  const copies = Math.ceil(MEDIUM_ARCHIVE_MAX_BYTES / one.length) + 5;
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  fs.writeFileSync(p, one.repeat(copies), 'utf8');
  assert.ok(fs.statSync(p).size > MEDIUM_ARCHIVE_MAX_BYTES);
  assert.ok(copies > MEDIUM_ARCHIVE_KEEP, 'the ledger really is over the keep count');

  // Any retire now trips the rotation (appendArchive is the single choke point).
  const doomed = await addDirective(h, 'the newest retired entry');
  await retractEntry(h, doomed!.id);

  assert.ok(fs.statSync(p).size <= MEDIUM_ARCHIVE_MAX_BYTES, 'the file is bounded again');
  const left = await listMediumAll(h);
  assert.ok(left.length <= MEDIUM_ARCHIVE_KEEP + 2, `rotated down to the newest entries (${left.length})`);
  // The retire that tripped the rotation is intact in both stores.
  assert.ok(fs.readFileSync(p, 'utf8').includes('the newest retired entry'));
  const archived = await listArchiveFor(h);
  assert.equal(archived[0].content, 'the newest retired entry');
  assert.equal(archived[0].source, 'medium_retracted');
});

// ── mergeNotes: the groomer's write primitive (supersede N, insert 1) ─────────────────────────
// Near-duplicate notes crowd out older distinct ones at MAX_ACTIVE_NOTES, so the groomer folds
// them. Every rejection here has to be a clean no-op: the tier is the no-error-margin store, and a
// half-applied merge would drop a note's content on the floor with nothing saying so.

async function seedNotes(h: string, bodies: string[]) {
  for (const b of bodies) await addImportantNote(h, b);
  return listMediumActive(h, ['important_note']);
}

test('mergeNotes folds N active notes into one synthesized note', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['gate code is 4421', 'the gate code for the house is 4421', 'dog is called Pepper']);
  const before = Date.now();

  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'the gate code for the house is 4421');
  assert.ok(merged);
  assert.equal(merged!.kind, 'important_note');
  assert.equal(merged!.source, 'groomer');
  assert.ok(![notes[0].id, notes[1].id].includes(merged!.id), 'the replacement is a NEW row, not a rewritten source');
  assert.ok(merged!.createdAt >= before, 'the merge is fresh, not backdated to its oldest source');

  const active = await listMediumActive(h, ['important_note']);
  assert.deepEqual(active.map(n => n.body), ['dog is called Pepper', 'the gate code for the house is 4421']);
});

test('mergeNotes supersedes every source with a forward pointer', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['lockbox 1180', 'the lockbox code is 1180']);
  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'the lockbox code is 1180');
  assert.ok(merged);

  const all = await listMediumAll(h);
  assert.equal(all.length, 3, 'nothing deleted — both sources retired, plus the replacement');
  for (const id of [notes[0].id, notes[1].id]) {
    const row = all.find(e => e.id === id)!;
    assert.equal(row.status, 'superseded');
    assert.equal(row.supersededBy, merged!.id, 'the chain points forward at the merge');
  }
  const target = all.find(e => e.id === merged!.id)!;
  assert.equal(target.status, 'active');
  assert.deepEqual(target.mergedFrom, [notes[0].id, notes[1].id], 'and back at its sources');
});

test('merged_from survives a full file rewrite', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['bin day is thursday', 'the bins go out on thursday']);
  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'the bins go out on thursday');
  assert.ok(merged);

  const p = path.join(memoriesDir(h), 'MEDIUM.md');
  const attr = `merged_from=${notes[0].id},${notes[1].id}`;
  assert.ok(fs.readFileSync(p, 'utf8').includes(attr), 'rendered into the annotation');

  await addImportantNote(h, 'a brand new unrelated note'); // forces a full rewrite of MEDIUM.md
  assert.ok(fs.readFileSync(p, 'utf8').includes(attr), 'and re-rendered identically after the rewrite');
  const reread = (await listMediumActive(h, ['important_note'])).find(n => n.id === merged!.id)!;
  assert.deepEqual(reread.mergedFrom, [notes[0].id, notes[1].id], 'and parses back symmetrically');
});

test('a merged note is FIFO-fresh: it outlives its sources at the cap', async () => {
  const h = freshHandle();
  const bodies = Array.from({ length: MAX_ACTIVE_NOTES }, (_, i) => `note ${i}`);
  const notes = await seedNotes(h, bodies);
  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'note 0 and note 1 are the same thing');
  assert.ok(merged);

  let active = await listMediumActive(h, ['important_note']);
  assert.equal(active.length, MAX_ACTIVE_NOTES - 1);
  assert.equal(active[active.length - 1].id, merged!.id, 'the merge sorts LAST — it is the newest note');

  await addImportantNote(h, 'filler to reach the cap');
  await addImportantNote(h, 'the note that trips the cap');
  active = await listMediumActive(h, ['important_note']);
  assert.equal(active.length, MAX_ACTIVE_NOTES);
  assert.ok(active.some(n => n.id === merged!.id), 'the merge survived');
  assert.ok(!active.some(n => n.body === 'note 2'), 'an older DISTINCT note aged out instead');
});

test('mergeNotes archives every source as medium_merged', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['wifi password is hunter2', 'the wifi password is hunter2']);
  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'the wifi password is hunter2');
  assert.ok(merged);

  const archived = await listArchiveFor(h);
  assert.equal(archived.length, 2);
  for (const row of archived) {
    assert.equal(row.source, 'medium_merged');
    assert.equal(row.kind, 'important_note');
    assert.equal(row.meta.mergedInto, merged!.id, 'the cold copy names what replaced it');
  }
});

test('REGRESSION: mergeNotes AWAITS its archive write', async () => {
  // appendArchive used to fire-and-forget the table copy, so the row landed a microtask after the
  // mutator resolved — long enough for a /forget purge to run in between and miss it.
  const h = freshHandle();
  const notes = await seedNotes(h, ['spare key under the pot', 'the spare key is under the blue pot']);
  await mergeNotes(h, [notes[0].id, notes[1].id], 'the spare key is under the blue pot');
  assert.equal((await listArchiveFor(h)).length, 2, 'already there — no setTimeout beat needed');
});

test('mergeNotes is a no-op on illegal inputs', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['note one', 'note two', 'note three']);
  const directive = await addDirective(h, 'a directive, not a note');
  await updateDirective(h, notes[2].id, 'note three, edited'); // retires notes[2]

  const snapshot = async () => JSON.stringify([await listMediumActive(h), await listArchiveFor(h)]);
  const before = await snapshot();

  const cases: Array<[string, string[]]> = [
    ['an id that does not exist', [notes[0].id, 'no-such-id']],
    ['a superseded id', [notes[0].id, notes[2].id]],
    ['a directive id', [notes[0].id, directive!.id]],
    ['a single id', [notes[0].id]],
    ['duplicate ids collapsing to one', [notes[0].id, notes[0].id]],
  ];
  for (const [label, ids] of cases) {
    assert.equal(await mergeNotes(h, ids, 'a perfectly good synthesis'), null, label);
    assert.equal(await snapshot(), before, `${label} left the tier byte-identical`);
  }
});

test('mergeNotes rejects a body over MERGED_NOTE_MAX_CHARS (never truncates it)', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['short one', 'short two']);
  const before = JSON.stringify([await listMediumActive(h), await listArchiveFor(h)]);

  assert.equal(await mergeNotes(h, [notes[0].id, notes[1].id], 'x'.repeat(MERGED_NOTE_MAX_CHARS + 1)), null);
  assert.equal(await mergeNotes(h, [notes[0].id, notes[1].id], '   '), null);
  assert.equal(JSON.stringify([await listMediumActive(h), await listArchiveFor(h)]), before);
});

test('mergeNotes aborts when a /forget lands mid-groom', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['pin is 9080', 'the door pin is 9080']);
  const epoch0 = getForgetEpoch(h);
  bumpForgetEpoch(h); // the user asked to be forgotten while the model was synthesizing

  assert.equal(await mergeNotes(h, [notes[0].id, notes[1].id], 'the door pin is 9080', 'groomer', { ifForgetEpoch: epoch0 }), null);
  assert.equal((await listMediumActive(h, ['important_note'])).length, 2, 'the sources are untouched');
  assert.equal((await listArchiveFor(h)).length, 0, 'and nothing leaked into the cold archive');
});

test('mergeNotes with a matching forget epoch writes normally', async () => {
  const h = freshHandle();
  const notes = await seedNotes(h, ['bus is the 42', 'the bus to town is the 42']);
  const merged = await mergeNotes(h, [notes[0].id, notes[1].id], 'the bus to town is the 42', 'groomer', {
    ifForgetEpoch: getForgetEpoch(h),
  });
  assert.ok(merged);
  assert.deepEqual((await listMediumActive(h, ['important_note'])).map(n => n.body), ['the bus to town is the 42']);
});

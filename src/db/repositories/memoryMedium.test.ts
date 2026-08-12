// Run with: npm test   (TZ=UTC tsx --test)
// Exercises the medium (no-error-margin) memory tier on the in-memory backend: dedupe,
// supersede chains, retraction, cap eviction, fact upsert semantics, and the concurrent
// append regression the legacy prefs-array rebuild used to lose.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listMediumActive, listMediumAll, addDirective, updateDirective, retractEntry,
  retractAllForHandle, addImportantNote, upsertFact,
  MAX_ACTIVE_DIRECTIVES, MAX_ACTIVE_NOTES,
} from './memoryMedium.js';
import { mem } from '../memory.js';

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
  assert.ok(all.filter(e => e.status === 'superseded').length === 2);
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

test('in-memory rows are per-process (mem map is the dev backend)', async () => {
  const h = freshHandle();
  await addDirective(h, 'anything');
  assert.ok(mem.memoryMedium.get(h)?.length === 1);
});

// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The user_profiles mutators, which are all read→merge→upsert and therefore all racy until
// each one holds the per-handle lock for its WHOLE sequence. The first two tests fail against
// the pre-fix code: two concurrent writers each read the same row and one silently clobbered
// the other (a fact or a name just vanished, with a cheerful "Added fact" log to match).
// Plus fact dedupe (normalized) and the cap's archive lineage.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUserProfile, updateUserProfile, addUserFact, setUserName, clearUserProfile,
  PROFILE_FACTS_CAP,
} from './profiles.js';
import { listArchiveFor } from './memoryArchive.js';

let seq = 0;
function freshHandle(): string {
  return `+1555300${(seq++).toString().padStart(4, '0')}`;
}

test('REGRESSION: two concurrent addUserFact calls both survive', async () => {
  const h = freshHandle();
  const [a, b] = await Promise.all([
    addUserFact(h, 'drives a green truck'),
    addUserFact(h, 'has a dog named biscuit'),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  const facts = (await getUserProfile(h))?.facts ?? [];
  assert.deepEqual([...facts].sort(), ['drives a green truck', 'has a dog named biscuit']);
});

test('REGRESSION: a concurrent setUserName + addUserFact lose neither', async () => {
  const h = freshHandle();
  await Promise.all([
    setUserName(h, 'Ace'),
    addUserFact(h, 'plays golf on thursdays'),
  ]);
  const p = await getUserProfile(h);
  assert.equal(p?.name, 'Ace');
  assert.deepEqual(p?.facts, ['plays golf on thursdays']);
});

test('a burst of concurrent facts all land', async () => {
  const h = freshHandle();
  const wanted = Array.from({ length: 8 }, (_, i) => `fact number ${i}`);
  await Promise.all(wanted.map(f => addUserFact(h, f)));
  const facts = (await getUserProfile(h))?.facts ?? [];
  assert.deepEqual([...facts].sort(), [...wanted].sort());
});

test('fact dedupe is normalized: casing and stray whitespace are the same fact', async () => {
  const h = freshHandle();
  assert.equal(await addUserFact(h, 'Likes  Golf '), true);
  assert.equal(await addUserFact(h, 'likes golf'), false);
  const facts = (await getUserProfile(h))?.facts ?? [];
  assert.deepEqual(facts, ['Likes  Golf '], 'the ORIGINAL wording is what stays stored');
});

test('over the cap: the oldest fact is evicted into the archive, the newest lands', async () => {
  const h = freshHandle();
  for (let i = 0; i < PROFILE_FACTS_CAP; i++) await addUserFact(h, `fact ${i}`);
  assert.equal((await getUserProfile(h))?.facts.length, PROFILE_FACTS_CAP);
  assert.equal((await listArchiveFor(h)).length, 0, 'nothing evicted while at the cap');

  assert.equal(await addUserFact(h, 'the newest fact'), true);
  const facts = (await getUserProfile(h))?.facts ?? [];
  assert.equal(facts.length, PROFILE_FACTS_CAP);
  assert.equal(facts[0], 'fact 1', 'fact 0 aged out');
  assert.equal(facts[facts.length - 1], 'the newest fact');

  const archived = await listArchiveFor(h);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].source, 'profile_fact_evicted');
  assert.equal(archived[0].content, 'fact 0');
  assert.equal(archived[0].agentHandle, h);
});

test('updateUserProfile merges rather than replaces, and preserves first_seen', async () => {
  const h = freshHandle();
  await updateUserProfile(h, { name: 'Jo' });
  const first = await getUserProfile(h);
  await updateUserProfile(h, { facts: ['keeps odd hours'] });
  const after = await getUserProfile(h);
  assert.equal(after?.name, 'Jo', 'a facts-only update keeps the name');
  assert.deepEqual(after?.facts, ['keeps odd hours']);
  assert.equal(after?.firstSeen, first?.firstSeen);
});

test('setUserName is a no-op (false) when the name is unchanged; clear removes the row', async () => {
  const h = freshHandle();
  assert.equal(await setUserName(h, 'Rex'), true);
  assert.equal(await setUserName(h, 'Rex'), false);
  assert.equal(await clearUserProfile(h), true);
  assert.equal(await getUserProfile(h), null);
  assert.equal(await clearUserProfile(h), false);
});

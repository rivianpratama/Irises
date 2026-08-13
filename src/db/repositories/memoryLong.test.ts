// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Exercises the long (versioned markdown doc) memory tier on the LONG.md file store:
// version bumps, per-save revision snapshots, and optimistic-concurrency conflicts.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLongDoc, saveLongDoc, listLongRevisions } from './memoryLong.js';
import { memoriesDir } from '../stateDir.js';

let seq = 0;
function freshHandle(): string {
  return `+1555200${(seq++).toString().padStart(4, '0')}`;
}

test('first save creates version 1 + a revision; reads round-trip', async () => {
  const h = freshHandle();
  assert.equal(await getLongDoc(h), null);
  const v = await saveLongDoc(h, '# Profile\nName: Jo', 0, 'test');
  assert.equal(v, 1);
  const doc = await getLongDoc(h);
  assert.equal(doc?.version, 1);
  assert.equal(doc?.docMd, '# Profile\nName: Jo');
  const revs = await listLongRevisions(h);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].writtenBy, 'test');
});

test('every accepted save snapshots a revision — nothing is ever lost', async () => {
  const h = freshHandle();
  await saveLongDoc(h, 'v1 content', 0, 'a');
  await saveLongDoc(h, 'v2 content', 1, 'b');
  await saveLongDoc(h, '', 2, 'forget'); // "clearing" is itself a revision
  const revs = await listLongRevisions(h);
  assert.deepEqual(revs.map(r => [r.version, r.docMd]), [[3, ''], [2, 'v2 content'], [1, 'v1 content']]);
  assert.equal((await getLongDoc(h))?.docMd, '');
});

test('stale expectedVersion returns null and writes NOTHING', async () => {
  const h = freshHandle();
  await saveLongDoc(h, 'current', 0, 'a');
  const conflicted = await saveLongDoc(h, 'from a stale reader', 0, 'b');
  assert.equal(conflicted, null);
  assert.equal((await getLongDoc(h))?.docMd, 'current'); // untouched
  assert.equal((await listLongRevisions(h)).length, 1);

  // Re-read and retry (the caller contract) succeeds.
  const cur = await getLongDoc(h);
  const v = await saveLongDoc(h, 'merged content', cur!.version, 'b');
  assert.equal(v, 2);
});

test('two racing writers: exactly one wins, the loser conflicts', async () => {
  const h = freshHandle();
  await saveLongDoc(h, 'base', 0, 'seed');
  const [r1, r2] = await Promise.all([
    saveLongDoc(h, 'writer one', 1, 'w1'),
    saveLongDoc(h, 'writer two', 1, 'w2'),
  ]);
  const wins = [r1, r2].filter(v => v === 2);
  const losses = [r1, r2].filter(v => v === null);
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  assert.equal((await getLongDoc(h))?.version, 2);
});

test('the head doc and revisions land as files under memories/<handle>/', async () => {
  const h = freshHandle();
  await saveLongDoc(h, '# doc body', 0, 't');
  const head = fs.readFileSync(path.join(memoriesDir(h), 'LONG.md'), 'utf8');
  assert.ok(head.startsWith('<!-- irises:long version=1 '));
  assert.ok(head.endsWith('# doc body'));
  assert.ok(fs.existsSync(path.join(memoriesDir(h), 'revisions', 'LONG.v0001.md')));
});

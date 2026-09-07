// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The MOMENTS.md store: the forked medium-tier grammar, the harvest clock in the file header, and
// the three behaviours that make a file store safe to hand to a nightly LLM pass:
//
//   • ROUND TRIP. Every field survives a write and a read, ids and text included, whatever they
//     carry — the annotation is percent-encoded and the text may be anything she wrote.
//   • HAND EDITS SURVIVE. A segment without a valid annotation is preserved verbatim at the top of
//     every rewrite, and the warning about it fires once per handle, not once per read.
//   • FAILURE IS EMPTY, NOT FATAL. An unreadable file degrades to an empty read (this tier is
//     re-derivable and renders on the reply path), and a fenced or failed write returns false so
//     the pass never stamps a harvest clock for a harvest that is not on disk.
//   • COUNTERS DEGRADE ONE AT A TIME. Only id, tag and at can fail an entry; each counter falls back
//     to its default on its own, which means `offered` and `last_offered` can disagree — pinned here
//     and survived by `pruneMoments`, because losing a moment to a typo is unrecoverable in a tier
//     that archives nothing.
//   • NO ARCHIVE. There is no second file in this store, and no test here looks for one.
process.env.TZ = 'UTC';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMoments, writeMoments, clearMoments, momentsHeader } from './moments.js';
import { getForgetEpoch, bumpForgetEpoch } from './memory.js';
import { memoriesDir } from '../stateDir.js';
import { pruneMoments, type MomentEntry } from '../../persona/moments.js';

const T0 = Date.UTC(2026, 3, 1);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function freshHandle(): string {
  return `+1555300${(seq++).toString().padStart(4, '0')}`;
}

function filePath(handle: string): string {
  return path.join(memoriesDir(handle), 'MOMENTS.md');
}

function entry(over: Partial<MomentEntry> = {}): MomentEntry {
  return {
    id: over.id ?? 'm1',
    text: over.text ?? 'they checked the volcano again',
    tag: over.tag ?? 'habit',
    at: over.at ?? T0 - DAY,
    count: over.count ?? 1,
    offered: over.offered ?? 0,
    lastOfferedAt: over.lastOfferedAt ?? 0,
  };
}

test('an absent file reads as an empty file with an open harvest window', async () => {
  const h = freshHandle();
  assert.deepEqual(await readMoments(h), { entries: [], lastHarvestAt: 0, preserved: [] });
});

test('write then read round-trips every field, the harvest clock included', async () => {
  const h = freshHandle();
  const entries = [
    entry({ id: 'a', tag: 'habit', at: T0 - 3 * DAY, count: 4, offered: 2, lastOfferedAt: T0 - DAY }),
    entry({ id: 'b', tag: 'obsession', text: 'twenty minutes on one ad, then asked how i knew', at: T0 - 40 * DAY }),
    entry({ id: 'c', tag: 'embarrassing', text: 'called the cat by their own name, twice', at: T0 }),
  ];
  assert.equal(await writeMoments(h, entries, T0, []), true);
  const back = await readMoments(h);
  assert.deepEqual(back.entries, entries);
  assert.equal(back.lastHarvestAt, T0);
  assert.deepEqual(back.preserved, []);
});

test('the header carries last_harvest_at, and never is a real value', async () => {
  const h = freshHandle();
  assert.equal(await writeMoments(h, [entry()], 0, []), true);
  const raw = fs.readFileSync(filePath(h), 'utf8');
  assert.ok(raw.startsWith('<!-- irises:moments format=1 last_harvest_at=never '), raw.slice(0, 120));
  assert.equal((await readMoments(h)).lastHarvestAt, 0, 'never reads back as an open window');

  assert.equal(await writeMoments(h, [entry()], T0 - 5 * DAY, []), true);
  assert.match(fs.readFileSync(filePath(h), 'utf8'), /last_harvest_at=2026-03-27T00:00:00\.000Z/);
  assert.equal((await readMoments(h)).lastHarvestAt, T0 - 5 * DAY);

  // The header says what the file is and that nothing here is archived — the store's own contract,
  // stated where a human editing the file will read it.
  assert.match(momentsHeader(T0), /machine-managed by src\/db\/repositories\/moments\.ts/);
  assert.match(momentsHeader(T0), /DELETED, never archived/);
});

test('an empty entry list still writes a header, and reads back as empty', async () => {
  const h = freshHandle();
  assert.equal(await writeMoments(h, [], T0, []), true);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), `${momentsHeader(T0)}\n`);
  const back = await readMoments(h);
  assert.deepEqual(back.entries, []);
  assert.equal(back.lastHarvestAt, T0);
});

test('ids and text survive whatever they carry — the annotation is encoded, the text is not', async () => {
  const h = freshHandle();
  const entries = [
    entry({ id: 'has a space and %25 and §', text: 'text with a § and a --> in it' }),
    entry({ id: 'b', text: 'punctuation: 100% of the time, at 3am' }),
  ];
  assert.equal(await writeMoments(h, entries, T0, []), true);
  const back = await readMoments(h);
  assert.deepEqual(back.entries, entries);
  assert.deepEqual(back.preserved, [], 'nothing was mistaken for a hand edit');
});

test('a moment with no offer history writes last_offered=never and reads back as zero', async () => {
  const h = freshHandle();
  assert.equal(await writeMoments(h, [entry({ offered: 0, lastOfferedAt: 0 })], T0, []), true);
  assert.match(fs.readFileSync(filePath(h), 'utf8'), /offered=0 last_offered=never/);
  const back = await readMoments(h);
  assert.equal(back.entries[0].offered, 0);
  assert.equal(back.entries[0].lastOfferedAt, 0);
});

test('parse drops an entry ONLY for a missing id, an unknown tag or an unparseable date', async () => {
  const h = freshHandle();
  const good = entry({ id: 'good', text: 'the one that survives' });
  await writeMoments(h, [good], T0, []);
  const raw = fs.readFileSync(filePath(h), 'utf8');

  for (const [name, broken] of [
    ['no id', raw.replace('id=good', 'id=')],
    ['unknown tag', raw.replace('tag=habit', 'tag=hilarious')],
    ['no tag', raw.replace(/tag=habit /, '')],
    // A leading space, so this hits the entry's own `at=` and not `last_harvest_at=` in the header.
    ['unparseable date', raw.replace(/ at=[^ ]+/, ' at=lastnight')],
    ['no annotation at all', raw.replace(/\n<!-- mo .+ -->/, '')],
  ] as Array<[string, string]>) {
    fs.writeFileSync(filePath(h), broken, 'utf8');
    const back = await readMoments(h);
    assert.equal(back.entries.length, 0, `${name}: the entry must not be trusted`);
    assert.equal(back.preserved.length, 1, `${name}: and must be preserved verbatim`);
    assert.match(back.preserved[0], /the one that survives/, name);
  }
});

test('a mangled counter degrades to its default rather than dropping her writing', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'x', count: 5, offered: 3, lastOfferedAt: T0 - DAY })], T0, []);
  const raw = fs.readFileSync(filePath(h), 'utf8');
  fs.writeFileSync(
    filePath(h),
    raw.replace('count=5', 'count=lots').replace('offered=3', 'offered=-4').replace(/last_offered=[^ ]+/, 'last_offered=tuesday'),
    'utf8',
  );
  const back = await readMoments(h);
  assert.equal(back.entries.length, 1, 'the moment survives');
  assert.equal(back.entries[0].count, 1);
  assert.equal(back.entries[0].offered, 0);
  assert.equal(back.entries[0].lastOfferedAt, 0);
});

test('a mangled offer stamp ALONE keeps its counter, and the moment still survives a prune', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'x', count: 2, offered: 3, lastOfferedAt: T0 - 2 * DAY })], T0, []);
  const raw = fs.readFileSync(filePath(h), 'utf8');
  // One attribute, hand-edited — not the three at once. `offered` comes back intact and the stamp
  // does not, which is the pair the engine has to survive: reading the absent stamp would put this
  // one-day-old moment past every decay window, and nothing in this tier archives it.
  fs.writeFileSync(filePath(h), raw.replace(/last_offered=[^ ]+/, 'last_offered=tuesday'), 'utf8');
  const back = await readMoments(h);
  assert.deepEqual(back.entries.map(e => [e.id, e.count, e.offered, e.lastOfferedAt]), [['x', 2, 3, 0]]);
  assert.deepEqual(pruneMoments(back.entries, T0).map(e => e.id), ['x']);
});

test('a headerless hand-written file is all preserved, and gains a header on the next write', async () => {
  const h = freshHandle();
  fs.mkdirSync(memoriesDir(h), { recursive: true });
  fs.writeFileSync(filePath(h), 'a human started this file by hand\n', 'utf8');
  const back = await readMoments(h);
  assert.deepEqual(back.entries, []);
  assert.equal(back.lastHarvestAt, 0);
  assert.deepEqual(back.preserved, ['a human started this file by hand']);

  assert.equal(await writeMoments(h, [entry({ id: 'z' })], T0, back.preserved), true);
  const raw = fs.readFileSync(filePath(h), 'utf8');
  assert.ok(raw.startsWith(`${momentsHeader(T0)}\na human started this file by hand\n§\n`), raw);
  const after = await readMoments(h);
  assert.deepEqual(after.preserved, ['a human started this file by hand']);
  assert.deepEqual(after.entries.map(e => e.id), ['z']);
});

test('a hand edit is preserved verbatim at the TOP of every rewrite, however often it is rewritten', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'a' })], T0, []);
  fs.appendFileSync(filePath(h), '\n§\na human scribbled this without an annotation');

  let file = await readMoments(h);
  assert.equal(file.preserved.length, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal(await writeMoments(h, [...file.entries, entry({ id: `n${i}` })], T0 + i, file.preserved), true);
    const raw = fs.readFileSync(filePath(h), 'utf8');
    const body = raw.slice(raw.indexOf('\n') + 1);
    assert.ok(body.startsWith('a human scribbled this without an annotation'), `rewrite ${i}: hand edit first`);
    file = await readMoments(h);
    assert.deepEqual(file.preserved, ['a human scribbled this without an annotation']);
    assert.equal(file.entries.length, i + 2, 'and the entries are still all there');
  }
});

test('the preserved-segment warning fires once per handle, not once per read', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'a' })], T0, []);
  fs.appendFileSync(filePath(h), '\n§\nanother hand edit');
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await readMoments(h);
    await readMoments(h);
    await readMoments(h);
  } finally {
    console.warn = original;
  }
  const mine = warnings.filter(w => w.includes('[moments]'));
  assert.equal(mine.length, 1, mine.join(' | '));
  assert.match(mine[0], /unannotated segment/);
});

test('an unreadable file degrades to an empty read instead of killing the turn', async () => {
  const h = freshHandle();
  // A directory where the file should be: present, and unreadable in a way no ENOENT check catches.
  fs.mkdirSync(filePath(h), { recursive: true });
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    assert.deepEqual(await readMoments(h), { entries: [], lastHarvestAt: 0, preserved: [] });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some(e => e.includes('readMoments')), errors.join(' | '));
});

test('a write that cannot land returns false rather than reporting a phantom harvest', async () => {
  const h = freshHandle();
  fs.mkdirSync(filePath(h), { recursive: true }); // rename onto a directory fails
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await writeMoments(h, [entry()], T0, []), false);
  } finally {
    console.error = original;
  }
});

test('the forget fence refuses a write whose epoch went stale mid-pass, and writes nothing', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'before', text: 'written before the forget' })], T0, []);
  const epoch = getForgetEpoch(h);

  // The pass read the epoch, thought for a while, and a /forget landed in the meantime.
  bumpForgetEpoch(h);
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await writeMoments(h, [entry({ id: 'after', text: 'a moment from the old transcript' })], T0 + DAY, [], { ifForgetEpoch: epoch }), false);
  } finally {
    console.warn = original;
  }
  const back = await readMoments(h);
  assert.deepEqual(back.entries.map(e => e.id), ['before'], 'the file was not touched at all');
  assert.equal(back.lastHarvestAt, T0, 'and the harvest clock did not move');

  // A pass that reads the CURRENT epoch writes normally.
  assert.equal(await writeMoments(h, [entry({ id: 'after' })], T0 + DAY, [], { ifForgetEpoch: getForgetEpoch(h) }), true);
  assert.deepEqual((await readMoments(h)).entries.map(e => e.id), ['after']);
  // No fence given at all is the unfenced write path, and it still works.
  assert.equal(await writeMoments(h, [entry({ id: 'unfenced' })], T0 + DAY, []), true);
});

test('clearMoments wipes entries and hand edits, and stamps the window at the wipe', async () => {
  const h = freshHandle();
  await writeMoments(h, [entry({ id: 'a' }), entry({ id: 'b' })], T0, []);
  fs.appendFileSync(filePath(h), '\n§\na hand edit that also goes');

  await clearMoments(h, T0 + DAY);
  assert.equal(fs.readFileSync(filePath(h), 'utf8'), `${momentsHeader(T0 + DAY)}\n`);
  const back = await readMoments(h);
  assert.deepEqual(back.entries, []);
  assert.deepEqual(back.preserved, []);
  assert.equal(back.lastHarvestAt, T0 + DAY, 'the next harvest window starts at the wipe, never before it');

  // Nothing else was created: one file, no archive, no revisions.
  assert.deepEqual(fs.readdirSync(memoriesDir(h)).filter(f => f.startsWith('MOMENTS')), ['MOMENTS.md']);
});

test('clearMoments on a handle with no file is a no-op that still leaves a clean file', async () => {
  const h = freshHandle();
  await clearMoments(h, T0);
  assert.deepEqual(await readMoments(h), { entries: [], lastHarvestAt: T0, preserved: [] });
});

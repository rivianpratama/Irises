// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The familiarity row's storage doctrine, the climate row's: reads DEGRADE rather than throw (the row
// is read on the reply path), a field that will not parse falls back on its own without costing the
// others, and a /forget that lands mid-pass fences the save that would put the level back.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import { clearFamiliarity, getFamiliarity, saveFamiliarity, type FamiliarityRow } from './familiarity.js';
import { bumpForgetEpoch, getForgetEpoch } from './memory.js';
import { groupHandle } from '../../memory/identity.js';

beforeEach(() => resetStorageForTests());

const ROW = { level: 52, turns: 140, activeDays: 14, lastDay: '2026-09-25' };

/** The row without its write clock, which is the one field a test cannot state in advance. */
const bare = (r: FamiliarityRow | null) => r && { level: r.level, turns: r.turns, activeDays: r.activeDays, lastDay: r.lastDay };

/** Write a row straight past the repository, so a corrupt or hand-built row can be tested. */
function rawRow(handle: string, level: number | string, turns: number | string, activeDays: number | string, lastDay: string): void {
  stmt('INSERT INTO familiarity (handle, level, turns, active_days, last_day, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(handle, level, turns, activeDays, lastDay, Date.now());
}

test('an unknown handle reads back no row, which the callers read as a stranger', async () => {
  assert.equal(await getFamiliarity('+15550001111'), null);
});

test('save then get round-trips the level, the counters and the day, stamped with a write clock', async () => {
  const h = '+15550002222';
  assert.equal(await saveFamiliarity(h, ROW), true);
  const got = await getFamiliarity(h);
  assert.deepEqual(bare(got), ROW);
  assert.ok((got?.updatedAt ?? 0) > 0, 'the save stamps its write clock');
  // Upsert, not insert: a second save replaces the row rather than throwing on the key.
  assert.equal(await saveFamiliarity(h, { ...ROW, level: 54, turns: 141 }), true);
  assert.deepEqual(bare(await getFamiliarity(h)), { ...ROW, level: 54, turns: 141 });
});

test('a save clamps what it is handed to the scale and the grammar', async () => {
  const h = '+15550003333';
  await saveFamiliarity(h, { level: 250, turns: -4, activeDays: 2.7, lastDay: 'yesterday' });
  assert.deepEqual(bare(await getFamiliarity(h)), { level: 100, turns: 0, activeDays: 2, lastDay: '' });
  await saveFamiliarity(h, { level: 0, turns: 3, activeDays: 1, lastDay: '2026-09-25' });
  assert.equal((await getFamiliarity(h))?.level, 1);
});

test('a corrupt row degrades field by field instead of throwing', async () => {
  const h = '+15550004444';
  rawRow(h, 'high', 'many', -3, 'last tuesday');
  assert.deepEqual(bare(await getFamiliarity(h)), { level: 1, turns: 0, activeDays: 0, lastDay: '' });
  // One bad field costs that field only: the earned level survives a rotted day stamp.
  const h2 = '+15550004445';
  rawRow(h2, 61, 300, 20, 'soon');
  assert.deepEqual(bare(await getFamiliarity(h2)), { level: 61, turns: 300, activeDays: 20, lastDay: '' });
});

test('the forget epoch fence refuses a save that started before the wipe', async () => {
  const h = '+15550005555';
  const epoch0 = getForgetEpoch(h);
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: epoch0 }), true);
  bumpForgetEpoch(h);
  await clearFamiliarity(h);
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: epoch0 }), false);
  assert.equal(await getFamiliarity(h), null, 'the wipe stands');
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: getForgetEpoch(h) }), true);
});

test('clear drops the row, clearing a missing one is a no-op, and a test reset wipes the table', async () => {
  const h = '+15550006666';
  await saveFamiliarity(h, ROW);
  await clearFamiliarity(h);
  assert.equal(await getFamiliarity(h), null);
  await clearFamiliarity('+15550009999');
  await saveFamiliarity(h, ROW);
  resetStorageForTests();
  assert.equal(await getFamiliarity(h), null);
});

test('a group pseudo-handle and a raw chat id are different rows', async () => {
  const chatId = 'chat-familiarity-1';
  await saveFamiliarity(groupHandle(chatId), ROW);
  assert.deepEqual(bare(await getFamiliarity(groupHandle(chatId))), ROW);
  assert.equal(await getFamiliarity(chatId), null);
});

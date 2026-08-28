// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The climate row's storage doctrine: reads DEGRADE rather than throw (this sits on the reply
// path), the dials and the rolling-window ledger degrade INDEPENDENTLY, and a /forget that lands
// mid-eval fences the save that would otherwise resurrect the wiped register.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import {
  getRelationshipClimate, saveRelationshipClimate, clearRelationshipClimate,
} from './relationshipClimate.js';
import { bumpForgetEpoch, getForgetEpoch } from './memory.js';
import { defaultClimate, type RelationshipClimate } from '../../persona/climate.js';
import { groupHandle } from '../../memory/identity.js';

beforeEach(() => resetStorageForTests());

const T0 = Date.UTC(2026, 0, 1);

function moved(): RelationshipClimate {
  return {
    dials: { ease: 52, candor: 61, playfulness: 34 },
    moves: [{ at: T0, k: 'ease', d: 1 }, { at: T0 + 1000, k: 'candor', d: 2 }],
    lastEvalAt: T0 + 1000,
    evalCount: 7,
  };
}

/** Write a row straight past the repository, so a corrupt/hand-built row can be tested. */
function rawRow(handle: string, dialsJson: string, movesJson: string, lastEvalAt = 0, evalCount = 0): void {
  stmt(
    `INSERT INTO relationship_climate (handle, dials_json, moves_json, last_eval_at, eval_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(handle, dialsJson, movesJson, lastEvalAt, evalCount, Date.now());
}

test('an unknown handle reads back the default register', async () => {
  assert.deepEqual(await getRelationshipClimate('+15550001111'), defaultClimate());
});

test('save then get round-trips the dials, the ledger, and the eval stamps', async () => {
  const h = '+15550002222';
  assert.equal(await saveRelationshipClimate(h, moved()), true);
  assert.deepEqual(await getRelationshipClimate(h), moved());

  // Upsert, not insert: a second save replaces the row rather than throwing on the PK.
  const again = { ...moved(), evalCount: 8, dials: { ease: 53, candor: 61, playfulness: 34 } };
  assert.equal(await saveRelationshipClimate(h, again), true);
  assert.equal((await getRelationshipClimate(h)).evalCount, 8);
  assert.equal((await getRelationshipClimate(h)).dials.ease, 53);
});

test('a corrupt dials_json degrades to defaults without throwing', async () => {
  const h = '+15550003333';
  rawRow(h, '{not json at all', '[]', T0, 3);
  const c = await getRelationshipClimate(h);
  assert.deepEqual(c.dials, defaultClimate().dials);
  // The stamps around it are still honoured — the cooldown must not reset just because a blob rotted.
  assert.equal(c.lastEvalAt, T0);
  assert.equal(c.evalCount, 3);
});

test('a corrupt moves_json costs the ledger only — the earned dials survive', async () => {
  const h = '+15550004444';
  rawRow(h, JSON.stringify({ ease: 52, candor: 61, playfulness: 34 }), '[[[', T0, 5);
  const c = await getRelationshipClimate(h);
  assert.deepEqual(c.dials, { ease: 52, candor: 61, playfulness: 34 }, 'the register is not lost');
  assert.deepEqual(c.moves, [], 'but its budget history is');

  // Same, one row at a time: a single malformed entry is dropped, its siblings kept.
  const h2 = '+15550004445';
  rawRow(h2, '{}', JSON.stringify([{ at: T0, k: 'ease', d: 1 }, { k: 'nope', d: 'x' }, null, { at: T0, k: 'candor', d: 2 }]));
  assert.deepEqual((await getRelationshipClimate(h2)).moves, [
    { at: T0, k: 'ease', d: 1 }, { at: T0, k: 'candor', d: 2 },
  ]);
});

test('the forget epoch fence refuses a save that started before the wipe', async () => {
  const h = '+15550005555';
  const epoch0 = getForgetEpoch(h);
  await saveRelationshipClimate(h, moved(), { ifForgetEpoch: epoch0 });
  assert.equal((await getRelationshipClimate(h)).dials.ease, 52);

  // A /forget lands. The in-flight eval's save now carries a stale epoch.
  bumpForgetEpoch(h);
  await clearRelationshipClimate(h);
  const refused = await saveRelationshipClimate(h, moved(), { ifForgetEpoch: epoch0 });
  assert.equal(refused, false);
  assert.deepEqual(await getRelationshipClimate(h), defaultClimate(), 'the wipe stands');

  // Without the fence (or with a current one) the same write lands.
  assert.equal(await saveRelationshipClimate(h, moved(), { ifForgetEpoch: getForgetEpoch(h) }), true);
});

test('clear drops the row back to defaults', async () => {
  const h = '+15550006666';
  await saveRelationshipClimate(h, moved());
  await clearRelationshipClimate(h);
  assert.deepEqual(await getRelationshipClimate(h), defaultClimate());
  // Clearing a handle that was never there is a no-op, not an error.
  await clearRelationshipClimate('+15550009999');
});

// The key is the MEMORY handle. A group's shared identity is `group:<chatId>`, which must never
// collide with — or read from — the 1:1 climate of anyone in the room, nor with the raw chat id.
test('a group pseudo-handle and a raw chat id are different rows', async () => {
  const chatId = 'chat-climate-1';
  const g = groupHandle(chatId);
  await saveRelationshipClimate(g, moved());
  assert.equal((await getRelationshipClimate(g)).dials.ease, 52);
  assert.deepEqual(await getRelationshipClimate(chatId), defaultClimate());
  assert.deepEqual(await getRelationshipClimate('+15550007777'), defaultClimate());
});

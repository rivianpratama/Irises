// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The thread inventory's storage doctrine: reads DEGRADE rather than throw (this sits on the reply
// path), the four json columns degrade INDEPENDENTLY of each other, one malformed entry is dropped
// without costing its siblings, and a /forget that lands mid-turn fences the save that would
// otherwise resurrect the wiped themes and loops.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import {
  getThreadInventory, saveThreadInventory, clearThreadInventory, listThreadInventoryHandles,
  threadingEnabled,
} from './threadInventory.js';
import { bumpForgetEpoch, getForgetEpoch } from './memory.js';
import {
  defaultThreadInventory, type OpenLoop, type ThreadInventory, type ThreadTheme,
} from '../../persona/threads.js';
import { groupHandle } from '../../memory/identity.js';

beforeEach(() => resetStorageForTests());

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

function theme(over: Partial<ThreadTheme> = {}): ThreadTheme {
  return {
    id: 'th-1',
    label: 'speed vs craft',
    kind: 'tension',
    note: 'ships fast, then hates the seams',
    evidenceDays: [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 4)],
    evidenceCount: 2,
    status: 'taggable',
    confidence: 40,
    firstSeenAt: T0,
    lastSeenAt: T0 + 3 * DAY,
    lastOfferedAt: 0,
    lastTaggedAt: 0,
    lastOutcome: null,
    soreAt: 0,
    uptakes: 0,
    passes: 0,
    pushbacks: 0,
    mintedDistressed: false,
    ...over,
  };
}

function loop(over: Partial<OpenLoop> = {}): OpenLoop {
  return {
    id: 'lp-1',
    label: 'the interview',
    note: 'thursday, the one they moved twice',
    status: 'open',
    capturedAt: T0,
    lastSeenAt: T0,
    offeredAt: 0,
    askedAt: 0,
    resolvedAt: 0,
    passes: 0,
    ...over,
  };
}

/** A fully populated inventory: every column carries something worth losing. */
function rich(): ThreadInventory {
  return {
    themes: [theme(), theme({ id: 'th-2', label: 'the shed project', kind: 'goal', status: 'shorthand', confidence: 80, uptakes: 3 })],
    loops: [loop(), loop({ id: 'lp-2', label: "his mother's surgery", status: 'asked', askedAt: T0 + DAY })],
    offers: [{ at: T0 + DAY, themeId: 'th-1', material: 'theme' }, { at: T0 + 2 * DAY, themeId: 'lp-1', material: 'loop' }],
    pending: { themeId: 'th-1', at: T0 + 2 * DAY, phase: 'awaiting', material: 'theme' },
    turnsSinceOffer: 3,
    lastHarvestAt: T0 + 2 * DAY,
    harvestCount: 61,
    lastPingAt: T0 + DAY,
  };
}

/** Write a row straight past the repository, so a corrupt/hand-built row can be tested. */
function rawRow(
  handle: string,
  cols: { themes?: string; loops?: string; offers?: string; pending?: string;
          turns?: number; lastHarvest?: number; harvestCount?: number; lastPing?: number } = {},
): void {
  stmt(
    `INSERT INTO thread_inventory (handle, themes_json, loops_json, offers_json, pending_json,
                                   turns_since_offer, last_harvest_at, harvest_count, last_ping_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    handle,
    cols.themes ?? '[]',
    cols.loops ?? '[]',
    cols.offers ?? '[]',
    cols.pending ?? 'null',
    cols.turns ?? 0,
    cols.lastHarvest ?? 0,
    cols.harvestCount ?? 0,
    cols.lastPing ?? 0,
    Date.now(),
  );
}

test('an unknown handle reads back the default inventory', async () => {
  assert.deepEqual(await getThreadInventory('+15551110001'), defaultThreadInventory());
});

test('save then get round-trips themes, loops, the offer ledger, the pending slot, and the stamps', async () => {
  const h = '+15551110002';
  assert.equal(await saveThreadInventory(h, rich()), true);
  assert.deepEqual(await getThreadInventory(h), rich());

  // The pending slot keeps its MATERIAL: a loop offer and a theme offer are answered by different
  // outcome-ask prose, so losing it would ask about a tag she never made.
  const withLoopPending: ThreadInventory = {
    ...rich(),
    pending: { themeId: 'lp-2', at: T0 + 3 * DAY, phase: 'offered', material: 'loop' },
  };
  assert.equal(await saveThreadInventory(h, withLoopPending), true);
  assert.deepEqual((await getThreadInventory(h)).pending, withLoopPending.pending);

  // Upsert, not insert: a second save replaces the row rather than throwing on the PK.
  assert.equal(await saveThreadInventory(h, { ...rich(), harvestCount: 62, turnsSinceOffer: 0 }), true);
  const again = await getThreadInventory(h);
  assert.equal(again.harvestCount, 62);
  assert.equal(again.turnsSinceOffer, 0);
});

// The independence pin, in every direction: whichever column rotted, the other three come back
// whole. A mangled loops_json costs a few days of pending questions; it must never cost months of
// theme evidence.
test('a corrupt themes_json costs themes only — loops, offers, and pending survive', async () => {
  const h = '+15551110003';
  const r = rich();
  rawRow(h, {
    themes: '{not json at all',
    loops: JSON.stringify(r.loops),
    offers: JSON.stringify(r.offers),
    pending: JSON.stringify(r.pending),
    turns: 3, lastHarvest: T0 + 2 * DAY, harvestCount: 61, lastPing: T0 + DAY,
  });
  const inv = await getThreadInventory(h);
  assert.deepEqual(inv.themes, [], 'the patterns are gone');
  assert.deepEqual(inv.loops, r.loops, 'the pending questions are not');
  assert.deepEqual(inv.offers, r.offers);
  assert.deepEqual(inv.pending, r.pending);
  // The stamps around the blobs are still honoured — no cooldown or budget resets because a blob rotted.
  assert.equal(inv.harvestCount, 61);
  assert.equal(inv.lastPingAt, T0 + DAY);
});

test('a corrupt loops_json costs loops only — the earned themes survive', async () => {
  const h = '+15551110004';
  const r = rich();
  rawRow(h, { themes: JSON.stringify(r.themes), loops: '[[[', offers: JSON.stringify(r.offers), pending: JSON.stringify(r.pending) });
  const inv = await getThreadInventory(h);
  assert.deepEqual(inv.themes, r.themes, 'a season of evidence is not lost to a week of questions');
  assert.deepEqual(inv.loops, []);
  assert.deepEqual(inv.offers, r.offers);
  assert.deepEqual(inv.pending, r.pending);
});

test('a corrupt offers_json costs the budget history only', async () => {
  const h = '+15551110005';
  const r = rich();
  rawRow(h, { themes: JSON.stringify(r.themes), loops: JSON.stringify(r.loops), offers: '{"at":', pending: JSON.stringify(r.pending) });
  const inv = await getThreadInventory(h);
  assert.deepEqual(inv.themes, r.themes);
  assert.deepEqual(inv.loops, r.loops);
  assert.deepEqual(inv.offers, []);
  assert.deepEqual(inv.pending, r.pending);
});

test('a corrupt pending_json idles the machine for a turn and costs nothing else', async () => {
  const h = '+15551110006';
  const r = rich();
  rawRow(h, { themes: JSON.stringify(r.themes), loops: JSON.stringify(r.loops), offers: JSON.stringify(r.offers), pending: 'nul' });
  const inv = await getThreadInventory(h);
  assert.equal(inv.pending, null);
  assert.deepEqual(inv.themes, r.themes);
  assert.deepEqual(inv.loops, r.loops);
  assert.deepEqual(inv.offers, r.offers);
});

// Row-level tolerance, the same doctrine as the climate ledger's: one malformed entry is dropped,
// its siblings kept. A theme is dropped only when it has lost its IDENTITY.
test('a malformed theme row is dropped while its siblings survive', async () => {
  const h = '+15551110007';
  rawRow(h, {
    themes: JSON.stringify([
      theme({ id: 'th-a' }),
      { label: 'no id at all', kind: 'value', status: 'open' },
      theme({ id: 'th-b', kind: 'not-a-kind' as never }),
      theme({ id: 'th-c', status: 'legendary' as never }),
      null,
      'a bare string',
      theme({ id: 'th-d', label: 'the shed' }),
      theme({ id: 'th-a', label: 'a second life for one id' }),
    ]),
  });
  const inv = await getThreadInventory(h);
  assert.deepEqual(inv.themes.map(t => t.id), ['th-a', 'th-d'], 'unknown kind/status, missing id, and a duplicate id all go');
  assert.equal(inv.themes[1].label, 'the shed');
});

test('a malformed loop row is dropped while its siblings survive', async () => {
  const h = '+15551110008';
  rawRow(h, {
    loops: JSON.stringify([
      loop({ id: 'lp-a' }),
      loop({ id: 'lp-b', status: 'pending' as never }),
      { id: 'lp-c', status: 'open' }, // no label — nothing anyone could ask about
      loop({ id: 'lp-d', label: 'the launch' }),
    ]),
  });
  assert.deepEqual((await getThreadInventory(h)).loops.map(l => l.id), ['lp-a', 'lp-d']);
});

test('a garbled counter is coerced back into range rather than costing the theme', async () => {
  const h = '+15551110009';
  const days = [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 4)];
  rawRow(h, {
    themes: JSON.stringify([theme({
      confidence: 480, uptakes: -3, passes: Number.NaN, pushbacks: 'lots' as never,
      firstSeenAt: -99, lastSeenAt: 'yesterday' as never, lastOutcome: 'shrugged' as never,
      evidenceDays: [days[0], 'tuesday' as never, days[1], null as never], evidenceCount: 0,
      mintedDistressed: 'yes' as never,
    })]),
    offers: JSON.stringify([
      { at: T0, themeId: 'th-1', material: 'theme' },
      { at: 'later', themeId: 'th-1', material: 'theme' },
      { at: T0, themeId: '', material: 'theme' },
      { at: T0, themeId: 'th-1', material: 'vibes' },
    ]),
    pending: JSON.stringify({ themeId: 'th-1', at: T0, phase: 'wondering', material: 'theme' }),
  });
  const inv = await getThreadInventory(h);
  const t = inv.themes[0];
  assert.equal(t.confidence, 100, 'clamped, not rejected — the direction it earned survives');
  assert.equal(t.uptakes, 0);
  assert.equal(t.passes, 0);
  assert.equal(t.pushbacks, 0);
  assert.equal(t.firstSeenAt, 0);
  assert.equal(t.lastSeenAt, 0);
  assert.equal(t.lastOutcome, null, 'an outcome word outside the union is no outcome');
  assert.deepEqual(t.evidenceDays, days, 'unreadable day stamps drop, real ones stay');
  assert.equal(t.evidenceCount, 2, 'and the count can never sit below the days actually on file');
  assert.equal(t.mintedDistressed, false, 'only a real boolean pins a theme to the bottom rung');
  assert.deepEqual(inv.offers, [{ at: T0, themeId: 'th-1', material: 'theme' }],
    'an offer that can be neither aged out nor billed to a budget is worthless');
  assert.equal(inv.pending, null, 'nothing is salvaged from a half-readable promise');
});

test('the forget epoch fence refuses a save that started before the wipe', async () => {
  const h = '+15551110010';
  const epoch0 = getForgetEpoch(h);
  assert.equal(await saveThreadInventory(h, rich(), { ifForgetEpoch: epoch0 }), true);
  assert.equal((await getThreadInventory(h)).themes.length, 2);

  // A /forget lands. The in-flight turn's save now carries a stale epoch.
  bumpForgetEpoch(h);
  await clearThreadInventory(h);
  const refused = await saveThreadInventory(h, rich(), { ifForgetEpoch: epoch0 });
  assert.equal(refused, false);
  assert.deepEqual(await getThreadInventory(h), defaultThreadInventory(), 'the wipe stands');
  const row = stmt('SELECT count(*) AS n FROM thread_inventory WHERE handle = ?').get(h) as { n: number };
  assert.equal(row.n, 0, 'and nothing at all was written');

  // Without the fence (or with a current one) the same write lands.
  assert.equal(await saveThreadInventory(h, rich(), { ifForgetEpoch: getForgetEpoch(h) }), true);
});

test('clear drops the row back to defaults', async () => {
  const h = '+15551110011';
  await saveThreadInventory(h, rich());
  await clearThreadInventory(h);
  assert.deepEqual(await getThreadInventory(h), defaultThreadInventory());
  // Clearing a handle that was never there is a no-op, not an error.
  await clearThreadInventory('+15551119999');
});

test('listThreadInventoryHandles reports every handle holding a row', async () => {
  assert.deepEqual(await listThreadInventoryHandles(), []);
  await saveThreadInventory('+15551110012', rich());
  await saveThreadInventory('+15551110013', defaultThreadInventory());
  assert.deepEqual((await listThreadInventoryHandles()).sort(), ['+15551110012', '+15551110013']);
  await clearThreadInventory('+15551110012');
  assert.deepEqual(await listThreadInventoryHandles(), ['+15551110013']);
});

// The key is the MEMORY handle. A group's shared identity is `group:<chatId>`, which must never
// collide with — or read from — the 1:1 inventory of anyone in the room, nor with the raw chat id.
test('a group pseudo-handle and a raw chat id are different rows', async () => {
  const chatId = 'chat-threads-1';
  const g = groupHandle(chatId);
  await saveThreadInventory(g, rich());
  assert.equal((await getThreadInventory(g)).themes.length, 2);
  assert.deepEqual(await getThreadInventory(chatId), defaultThreadInventory());
  assert.deepEqual(await getThreadInventory('+15551110014'), defaultThreadInventory());
});

// The flag is read at CALL time (no restart to flip it) and defaults ON, matching every sibling
// memory flag. Unset and empty both mean on; anything not in the truthy set means off.
test('the threading flag parses like its siblings', () => {
  const before = process.env.CONVO_THREADING_ENABLED;
  try {
    delete process.env.CONVO_THREADING_ENABLED;
    assert.equal(threadingEnabled(), true, 'unset is on');
    for (const on of ['', '  ', 'true', 'TRUE', '1', 'on', 'ON', 'yes', ' Yes ']) {
      process.env.CONVO_THREADING_ENABLED = on;
      assert.equal(threadingEnabled(), true, `${JSON.stringify(on)} is on`);
    }
    for (const off of ['false', '0', 'off', 'no', 'nope', 'disabled']) {
      process.env.CONVO_THREADING_ENABLED = off;
      assert.equal(threadingEnabled(), false, `${JSON.stringify(off)} is off`);
    }
  } finally {
    if (before === undefined) delete process.env.CONVO_THREADING_ENABLED;
    else process.env.CONVO_THREADING_ENABLED = before;
  }
});

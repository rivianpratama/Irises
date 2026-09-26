// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The familiarity pass, end to end against the ephemeral store: a replied turn is counted once and a
// day once, what she holds is read off the stores it lives in (a store behind a switch that is off
// holds nothing), the stored level moves at most two points toward what that adds up to, a room is
// never counted, and a band change files one receipt.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests } from '../db/sqlite.js';
import { getFamiliarity, saveFamiliarity, type FamiliarityRow } from '../db/repositories/familiarity.js';
import { upsertFact } from '../db/repositories/memoryMedium.js';
import { addUserFact, setUserName } from '../db/repositories/profiles.js';
import { writeMoments } from '../db/repositories/moments.js';
import { writeSelf, type SelfEntry, type SelfKind } from '../db/repositories/self.js';
import { saveThreadInventory } from '../db/repositories/threadInventory.js';
import { defaultThreadInventory, type OpenLoop, type ThreadTheme } from '../persona/threads.js';
import type { MomentEntry } from '../persona/moments.js';
import { emptyEvidence, FAMILIARITY_SLEW } from '../persona/familiarity.js';
import { SEED_SOURCE } from './provenance.js';
import { groupHandle } from './identity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { FAMILIARITY_BAND_LABEL, gatherFamiliarityEvidence, updateFamiliarity } from './familiarityPass.js';

const H = '+15550003131';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ENV = ['CONVO_FAMILIARITY_ENABLED', 'MEMORY_PROVENANCE_ENABLED', 'MEMORY_MOMENTS_ENABLED', 'MEMORY_SELF_ENABLED', 'CONVO_THREADING_ENABLED'];

beforeEach(() => {
  resetStorageForTests();
  clearTraces();
  for (const k of ENV) delete process.env[k];
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** The stored row without its write clock. */
async function row(handle: string): Promise<Omit<FamiliarityRow, 'updatedAt'> | null> {
  const r = await getFamiliarity(handle);
  return r && { level: r.level, turns: r.turns, activeDays: r.activeDays, lastDay: r.lastDay };
}

const bandReceipts = () => getTraces().filter(e => e.label === FAMILIARITY_BAND_LABEL);

function moment(id: string): MomentEntry {
  return { id, text: 'checked the volcano dashboard again and decided nothing', tag: 'habit', at: T0, count: 1, offered: 0, lastOfferedAt: 0 };
}
function selfEntry(id: string, kind: SelfKind): SelfEntry {
  return { id, kind, text: 'pineapple belongs on pizza, sweet and salt is the point', at: T0 };
}
function theme(id: string, uptakes: number): ThreadTheme {
  return {
    id, label: `speed vs craft ${id}`, kind: 'tension', note: 'ships fast, then hates the seams',
    evidenceDays: [T0 - 3 * DAY, T0], evidenceCount: 2, status: 'taggable', confidence: 40,
    firstSeenAt: T0 - 3 * DAY, lastSeenAt: T0, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null,
    soreAt: 0, uptakes, passes: 0, pushbacks: 0, mintedDistressed: false,
  };
}
function loop(id: string): OpenLoop {
  return {
    id, label: 'the interview', note: 'the thing on thursday', status: 'open',
    capturedAt: T0, lastSeenAt: T0, offeredAt: 0, askedAt: 0, resolvedAt: 0, passes: 0,
  };
}

/** One of everything, in every store the pass reads. */
async function seedEverything(): Promise<void> {
  process.env.MEMORY_PROVENANCE_ENABLED = 'true';
  await upsertFact(H, 'job', 'runs a plant nursery');                       // their words
  await upsertFact(H, 'pet', 'probably a cat person', 'convo', 'inferred');  // her guess
  await upsertFact(H, 'hometown', 'grew up near the coast', SEED_SOURCE);    // the engine's picture
  await addUserFact(H, 'likes golf');                                        // stated, the default basis
  await addUserFact(H, 'a night owl', 'inferred');
  await setUserName(H, 'Ada');
  await writeMoments(H, [moment('m1'), moment('m2')], 0, []);
  await writeSelf(H, [selfEntry('s1', 'stance'), selfEntry('s2', 'taste'), selfEntry('s3', 'learned'), selfEntry('s4', 'changed')], 0, []);
  await saveThreadInventory(H, { ...defaultThreadInventory(), themes: [theme('t1', 1), theme('t2', 0)], loops: [loop('l1')] });
}

// ── the counters ─────────────────────────────────────────────────────────────

test('a first replied turn opens a row at the bottom and counts the turn and the day', async () => {
  await updateFamiliarity(H, { now: T0 });
  assert.deepEqual(await row(H), { level: 1, turns: 1, activeDays: 1, lastDay: '2026-09-20' });
});

test('the same day is one day however many turns it holds, and the next day is another', async () => {
  await updateFamiliarity(H, { now: T0 });
  await updateFamiliarity(H, { now: T0 + 60_000 });
  await updateFamiliarity(H, { now: T0 + 3 * 60 * 60 * 1000 });
  assert.deepEqual(await row(H), { level: 1, turns: 3, activeDays: 1, lastDay: '2026-09-20' });
  await updateFamiliarity(H, { now: T0 + DAY });
  assert.deepEqual(await row(H), { level: 3, turns: 4, activeDays: 2, lastDay: '2026-09-21' });
});

test('passes fired together still count every turn', async () => {
  await Promise.all([updateFamiliarity(H, { now: T0 }), updateFamiliarity(H, { now: T0 + 1 }), updateFamiliarity(H, { now: T0 + 2 })]);
  assert.equal((await row(H))?.turns, 3, 'serialized per handle, so no tick is lost to a race');
});

// ── the slew ─────────────────────────────────────────────────────────────────

test('the stored level moves at most two points a turn, in either direction', async () => {
  // A long tenure: the target (forty on tenure alone) is far above the stored ten.
  await saveFamiliarity(H, { level: 10, turns: 200, activeDays: 30, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 10 + FAMILIARITY_SLEW);
  // Nothing lived and nothing held: the target is the bottom, and the fall is paced the same.
  await saveFamiliarity(H, { level: 60, turns: 0, activeDays: 0, lastDay: '' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 60 - FAMILIARITY_SLEW);
});

// ── the receipt ──────────────────────────────────────────────────────────────

test('a band change files one receipt with both bands and the level, and a steady band files none', async () => {
  await saveFamiliarity(H, { level: 24, turns: 100, activeDays: 10, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0, chatId: 'web:fam' });
  assert.equal((await row(H))?.level, 26);
  const receipts = bandReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].handle, H);
  assert.equal(receipts[0].chatId, 'web:fam');
  assert.deepEqual(receipts[0].detail, { from: 'stranger', to: 'acquaintance', level: 26 });
  clearTraces();
  await updateFamiliarity(H, { now: T0 + 60_000 });
  assert.equal((await row(H))?.level, 28);
  assert.equal(bandReceipts().length, 0, 'still acquaintance: nothing to report');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('a room is never counted, and with the switch off nobody is', async () => {
  const room = groupHandle('chat-fam-1');
  await updateFamiliarity(room, { now: T0 });
  assert.equal(await getFamiliarity(room), null);
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await updateFamiliarity(H, { now: T0 });
  assert.equal(await getFamiliarity(H), null);
});

// ── the evidence ─────────────────────────────────────────────────────────────

test('what she holds is read off each store, facts counted by who said so', async () => {
  await seedEverything();
  assert.deepEqual(await gatherFamiliarityEvidence(H, { turns: 7, activeDays: 3 }), {
    turns: 7, activeDays: 3, statedFacts: 2, inferredFacts: 2, seededFacts: 1, name: 1,
    moments: 2, themesTaken: 1, loops: 1, selfEntries: 3,
  });
});

test('a store behind a switch that is off holds nothing, and a person she holds nothing about is empty', async () => {
  await seedEverything();
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  process.env.MEMORY_SELF_ENABLED = 'off';
  process.env.CONVO_THREADING_ENABLED = 'off';
  const ev = await gatherFamiliarityEvidence(H, { turns: 0, activeDays: 0 });
  assert.deepEqual(
    { moments: ev.moments, selfEntries: ev.selfEntries, themesTaken: ev.themesTaken, loops: ev.loops },
    { moments: 0, selfEntries: 0, themesTaken: 0, loops: 0 },
  );
  assert.equal(ev.statedFacts, 2, 'facts have no switch and still count');
  assert.equal(ev.name, 1);
  assert.deepEqual(await gatherFamiliarityEvidence('+15550009898', { turns: 0, activeDays: 0 }), emptyEvidence());
});

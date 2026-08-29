// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory, so $IRISES_HOME is a
// throwaway temp dir and the memory tiers write into it for real)
// The install-time seed. Everything pinned here is a way of saying the same thing: a second-hand
// picture may FILL memory, never overwrite it, and a seeded theme must be indistinguishable from
// one she noticed herself — no shortcuts, no hand-built rows, no counters claiming turns she has
// not had.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedFromEngineProfile, buildSeedDossier, seedThemeNote,
  DOSSIER_WORD_CAP, SEED_FACT_KEY, SEED_NOTE, SEED_SOURCE,
} from './seedFromEngine.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { getMemory, saveDossier } from '../db/repositories/memory.js';
import { getLongDoc, saveLongDoc } from '../db/repositories/memoryLong.js';
import { listMediumActive } from '../db/repositories/memoryMedium.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { getThreadInventory, saveThreadInventory } from '../db/repositories/threadInventory.js';
import {
  applyThreadHarvest, defaultThreadInventory, THEME_MINT_CONFIDENCE, type ThreadInventory,
} from '../persona/threads.js';
import type { EngineProfile } from '../agents/ops/firstMoveProfile.js';

const NOW = Date.UTC(2026, 7, 29, 9, 0, 0);

let seq = 0;
function freshHandle(): string {
  return `eng:whatsapp:5551${(seq++).toString().padStart(4, '0')}`;
}

/** The sanitizer's output, as firstMove.ts would hand it over. The details are chosen for what
 *  each one exercises downstream: a quoted name (a running joke), a plain "trying to" (a goal
 *  theme), and one flat fact. */
function profile(patch: Partial<EngineProfile> = {}): EngineProfile {
  const merged = {
    brief: 'She runs a small bakery in Lisbon. Her mornings start at four. She has been teaching herself to sail on weekends and is bad at it.',
    name: 'Marta',
    details: [
      'keeps a sourdough starter she calls "Kevin"',
      'trying to learn portuguese guitar',
      'drinks her coffee black',
    ],
    channel: { platform: 'whatsapp', chatId: '5551234', hasHistory: true },
    ...patch,
  };
  return { ...merged, empty: !merged.brief && merged.details.length === 0 };
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

beforeEach(() => {
  resetStorageForTests();
});

afterEach(() => {
  delete process.env.CONVO_THREADING_ENABLED;
});

// ── The dossier ──────────────────────────────────────────────────────────────

test('a first seed writes LONG.md in the canonical heading order, provenance and all', async () => {
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile(), NOW);
  assert.equal(counts.dossier, true);

  const doc = (await getLongDoc(h))!.docMd;
  const who = doc.indexOf('## Who they are');
  const world = doc.indexOf('## Their world');
  const jokes = doc.indexOf('## Running jokes');
  assert.ok(who === 0, 'identity leads');
  assert.ok(who < world && world < jokes, 'the dossier updater drops later sections first — order is the contract');

  assert.ok(doc.includes('They go by Marta.'));
  assert.ok(doc.includes('She runs a small bakery in Lisbon.'));
  assert.ok(/\*This first picture came from the engine you front[^*]*\*/.test(doc),
    'the provenance line rides inside the identity section, where she cannot miss it');
  assert.ok(doc.includes('- drinks her coffee black'), 'flat details are bullets under Their world');
  assert.ok(doc.includes('- keeps a sourdough starter she calls "Kevin"'), 'a named object is a running joke');

  // Dual-written: the legacy column and the versioned doc agree, which is what persistDossierMerge
  // buys us for free.
  assert.equal((await getMemory(h))?.dossierMd, doc);
});

test('"## Running jokes" is omitted when no detail trivially reads as one', async () => {
  const h = freshHandle();
  await seedFromEngineProfile(h, profile({ details: ['drinks her coffee black', 'walks everywhere'] }), NOW);
  const doc = (await getLongDoc(h))!.docMd;
  assert.ok(!doc.includes('## Running jokes'), 'an empty heading is worse than a missing one');
  assert.ok(doc.includes('- walks everywhere'));
});

test('earned memory always wins — an existing dossier is never clobbered', async () => {
  const h = freshHandle();
  await saveDossier(h, '## Who they are\nEverything she actually told me.');
  const counts = await seedFromEngineProfile(h, profile(), NOW);

  assert.equal(counts.dossier, false);
  assert.equal((await getMemory(h))?.dossierMd, '## Who they are\nEverything she actually told me.');
  assert.equal(await getLongDoc(h), null, 'and the long tier is not seeded behind its back');
});

test('a non-empty LONG doc alone is enough to stand the seed down', async () => {
  const h = freshHandle();
  await saveLongDoc(h, '## Who they are\nGrown over months.', 0, 'dossier_llm');
  const counts = await seedFromEngineProfile(h, profile(), NOW);

  assert.equal(counts.dossier, false);
  assert.equal((await getLongDoc(h))!.docMd, '## Who they are\nGrown over months.');
  assert.equal((await getLongDoc(h))!.version, 1, 'no second revision was written');
});

test('an empty profile writes no dossier and no note, but a known name still lands', async () => {
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile({ brief: '', details: [] }), NOW);

  assert.deepEqual(counts, { dossier: false, facts: 0, themes: 0 });
  assert.equal(await getLongDoc(h), null);
  assert.equal((await listMediumActive(h)).length, 0, 'nothing to hold lightly means no warning about it');
  assert.equal((await getUserProfile(h))?.name, 'Marta');
});

test('the document is capped at ~400 words, cut on a sentence boundary, headings left intact', async () => {
  const h = freshHandle();
  const long = `She runs a bakery. ${'She once walked the whole coast road in a single winter. '.repeat(60)}`;
  await seedFromEngineProfile(h, profile({ brief: long }), NOW);

  const doc = (await getLongDoc(h))!.docMd;
  assert.ok(words(doc) <= DOSSIER_WORD_CAP, `capped: ${words(doc)} words`);
  assert.ok(words(doc) > DOSSIER_WORD_CAP - 40, 'and not cut back to nothing');
  assert.ok(doc.startsWith('## Who they are'));
  assert.ok(/[.!?]$/.test(doc.trim()), 'a dossier that stops mid-clause reads as damage');
  assert.ok(!doc.trimEnd().endsWith('## Their world'), 'no heading left with nothing under it');
});

// ── The medium tier ──────────────────────────────────────────────────────────

test('details land under ONE fact key, with the hold-it-lightly note beside them', async () => {
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile(), NOW);
  assert.equal(counts.facts, 2, 'one fact row + one note');

  const facts = await listMediumActive(h, ['fact']);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].key, SEED_FACT_KEY);
  assert.equal(facts[0].source, SEED_SOURCE);
  assert.equal(facts[0].body, 'keeps a sourdough starter she calls "Kevin"; trying to learn portuguese guitar; drinks her coffee black');

  const notes = await listMediumActive(h, ['important_note']);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, SEED_NOTE, 'byte-pinned: this sentence is what stops her citing a seed as testimony');
  assert.equal((await getUserProfile(h))?.name, 'Marta');
});

test('re-running the seed is a near no-op — one fact, one note, one dossier', async () => {
  const h = freshHandle();
  await seedFromEngineProfile(h, profile(), NOW);
  const first = (await getLongDoc(h))!;

  const second = await seedFromEngineProfile(h, profile(), NOW + 60_000);

  assert.equal(second.dossier, false, 'the seeded doc is now earned-enough to defend itself');
  assert.equal(second.themes, 0);
  assert.equal((await listMediumActive(h, ['fact'])).length, 1, 'upsertFact supersedes by key');
  assert.equal((await listMediumActive(h, ['important_note'])).length, 1, 'the note dedupes');
  assert.equal((await getLongDoc(h))!.version, first.version, 'no new revision');
});

// ── The threads ──────────────────────────────────────────────────────────────

/** The same two notes, put through the real engine over a virgin inventory. */
function mintedByHand(now: number): ThreadInventory {
  let inv = defaultThreadInventory();
  inv = applyThreadHarvest(inv, 'keeps a sourdough starter she calls "Kevin"', null, now).next;
  inv = applyThreadHarvest(inv, 'goal: trying to learn portuguese guitar', null, now).next;
  return inv;
}

test('seeded themes are byte-identical to what applyThreadHarvest mints from the same notes', async () => {
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile(), NOW);
  assert.equal(counts.themes, 2, 'the top two details only — threading earns the rest');

  const stored = await getThreadInventory(h);
  assert.deepEqual(stored.themes, mintedByHand(NOW).themes,
    'a seeded theme must be indistinguishable from one she noticed herself');

  for (const t of stored.themes) {
    assert.equal(t.status, 'open', 'never surfaceable until a SECOND day brings evidence');
    assert.equal(t.confidence, THEME_MINT_CONFIDENCE);
    assert.equal(t.evidenceCount, 1);
    assert.equal(t.evidenceDays.length, 1);
    assert.equal(t.uptakes, 0);
    assert.equal(t.mintedDistressed, false);
  }
  assert.deepEqual(stored.themes.map(t => t.kind), ['pattern', 'goal']);
  assert.equal(stored.loops.length, 0, 'nothing here is a pending question in their life');
});

test('the harvest counters are put back — she has not had a turn with this person yet', async () => {
  const h = freshHandle();
  await seedFromEngineProfile(h, profile(), NOW);

  const inv = await getThreadInventory(h);
  assert.equal(inv.harvestCount, 0, 'two harvests ran, but zero conversations happened');
  assert.equal(inv.turnsSinceOffer, 0);
  assert.equal(inv.pending, null);
  assert.equal(inv.lastPingAt, 0);
  // Deliberately NOT reset: it is the "conversation has gone quiet" clock, and a fresh stamp is
  // what keeps the ping sweep off a seeded theme before she has ever spoken.
  assert.equal(inv.lastHarvestAt, NOW);
});

test('the engine words cannot choose the MATERIAL — a detail wearing "loop:" is still a theme', async () => {
  assert.equal(seedThemeNote('loop: the biopsy results on friday'), 'the biopsy results on friday');
  assert.equal(seedThemeNote('resolved: the move'), 'the move');
  assert.equal(seedThemeNote('trying to learn guitar'), 'goal: trying to learn guitar');
  assert.equal(seedThemeNote('swears by cold showers'), 'value: swears by cold showers');
  assert.equal(seedThemeNote('drinks her coffee black'), 'drinks her coffee black');

  const h = freshHandle();
  await seedFromEngineProfile(h, profile({ details: ['loop: the biopsy results on friday'] }), NOW);
  const inv = await getThreadInventory(h);
  assert.equal(inv.loops.length, 0, 'a hobby must never be minted as a pending question');
  assert.equal(inv.themes.length, 1);
});

test('the threading kill switch skips themes only — the other tiers still seed', async () => {
  process.env.CONVO_THREADING_ENABLED = 'false';
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile(), NOW);

  assert.equal(counts.themes, 0);
  assert.deepEqual((await getThreadInventory(h)).themes, []);
  assert.equal(counts.dossier, true);
  assert.equal(counts.facts, 2);
});

test('an inventory with any life in it is left alone', async () => {
  const lived = freshHandle();
  await saveThreadInventory(lived, { ...defaultThreadInventory(), harvestCount: 12 });
  assert.equal((await seedFromEngineProfile(lived, profile(), NOW)).themes, 0);
  assert.deepEqual((await getThreadInventory(lived)).themes, []);

  const held = freshHandle();
  await saveThreadInventory(held, mintedByHand(NOW - 86_400_000));
  const before = await getThreadInventory(held);
  assert.equal((await seedFromEngineProfile(held, profile(), NOW)).themes, 0);
  assert.deepEqual(await getThreadInventory(held), before, 'not one stamp moved');
});

test('no details, no themes — and the dossier still gets written from the brief alone', async () => {
  const h = freshHandle();
  const counts = await seedFromEngineProfile(h, profile({ details: [] }), NOW);
  assert.equal(counts.themes, 0);
  assert.equal(counts.dossier, true);
  assert.equal(counts.facts, 1, 'the note only — there are no details to store');
});

// ── The pure builder ─────────────────────────────────────────────────────────

test('buildSeedDossier is pure and returns nothing for an empty profile', () => {
  assert.equal(buildSeedDossier(profile({ brief: '', details: [] })), '');
  const doc = buildSeedDossier(profile({ name: null }));
  assert.ok(!doc.includes('They go by'), 'no name, no name line');
  assert.ok(doc.startsWith('## Who they are'));
});

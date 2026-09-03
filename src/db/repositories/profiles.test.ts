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
import { getTraces, clearTraces } from '../../diagnostics/trace.js';

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

// ── Fact provenance (MEMORY_PROVENANCE_ENABLED) ────────────────────────────────────────────────
// facts_json is a JSON array of strings, so there is nowhere to put an attribute: the provenance
// rides IN BAND, as a prefix on the fact itself ("stated: likes golf"). Dedupe therefore compares
// BODIES, which is exactly what lets their own words promote a guess in place instead of stacking
// a near-twin beside it. No DDL.

async function withProvenance<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.MEMORY_PROVENANCE_ENABLED;
  process.env.MEMORY_PROVENANCE_ENABLED = on ? 'true' : 'false';
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.MEMORY_PROVENANCE_ENABLED;
    else process.env.MEMORY_PROVENANCE_ENABLED = prior;
  }
}

test('with provenance ON the basis rides in band; with it OFF the fact is stored exactly as given', async () => {
  const on = freshHandle();
  await withProvenance(true, async () => {
    assert.equal(await addUserFact(on, 'likes golf', 'inferred'), true);
    assert.equal(await addUserFact(on, 'has a dog named biscuit', 'stated'), true);
  });
  assert.deepEqual((await getUserProfile(on))?.facts, ['inferred: likes golf', 'stated: has a dog named biscuit']);

  const off = freshHandle();
  await withProvenance(false, async () => {
    assert.equal(await addUserFact(off, 'likes golf', 'inferred'), true);
  });
  assert.deepEqual((await getUserProfile(off))?.facts, ['likes golf'], 'the basis is offered and ignored');
});

test('a stated write PROMOTES a same-bodied inferred fact in place', async () => {
  const h = freshHandle();
  await withProvenance(true, async () => {
    await addUserFact(h, 'plays golf on thursdays', 'inferred');
    await addUserFact(h, 'keeps odd hours', 'stated');
    // They say it themselves. Same fact, stronger footing — and NOT a new fact, so the turn's
    // confirmation beat stays what it was for something she already knew.
    assert.equal(await addUserFact(h, 'Plays  golf on Thursdays ', 'stated'), false);

    const facts = (await getUserProfile(h))?.facts ?? [];
    assert.deepEqual(facts, ['stated: plays golf on thursdays', 'stated: keeps odd hours']);
  });
});

test('promote never demotes: a later guess leaves their own words alone', async () => {
  const h = freshHandle();
  await withProvenance(true, async () => {
    await addUserFact(h, 'lives in austin', 'stated');
    assert.equal(await addUserFact(h, 'lives in austin', 'inferred'), false);
    assert.deepEqual((await getUserProfile(h))?.facts, ['stated: lives in austin']);
  });
});

test('dedupe reads the BODY, so a prefixed row and a bare one are never twins', async () => {
  const h = freshHandle();
  await withProvenance(true, async () => { await addUserFact(h, 'drives a green truck', 'inferred'); });
  // The flag goes off (or never came on for this install) — the stored prefix must still be
  // recognised, or the very next write would stack a duplicate.
  await withProvenance(false, async () => {
    assert.equal(await addUserFact(h, 'drives a green truck'), false);
    assert.deepEqual((await getUserProfile(h))?.facts, ['inferred: drives a green truck']);
  });
});

test('every fact write leaves a memory:fact_provenance receipt — the no-op dedupe included', async () => {
  const h = freshHandle();
  await withProvenance(true, async () => {
    clearTraces();
    await addUserFact(h, 'trains for a marathon', 'inferred');
    await addUserFact(h, 'trains for a marathon', 'inferred');   // the no-op
    await addUserFact(h, 'trains for a marathon', 'stated');     // the promotion

    const receipts = getTraces()
      .filter(e => e.label === 'memory:fact_provenance')
      .map(e => e.detail as Record<string, unknown>);
    assert.equal(receipts.length, 3, 'one per write attempt, including the one that wrote nothing');
    assert.deepEqual(receipts.map(d => d.outcome), ['written', 'unchanged', 'promoted']);
    assert.deepEqual(receipts.map(d => d.prov), ['inferred', 'inferred', 'stated']);
    assert.deepEqual(receipts.map(d => d.prior), [null, 'inferred', 'inferred']);
    for (const d of receipts) {
      assert.equal(d.store, 'profile_fact');
      assert.equal(d.enabled, true);
      // Never the fact itself: the ring keeps 30 days of turns and a stored fact is their life.
      assert.ok(!JSON.stringify(d).includes('marathon'));
    }
    assert.equal(getTraces().find(e => e.label === 'memory:fact_provenance')?.handle, h);
  });
});

test('the receipt fires with the feature OFF too, and says so', async () => {
  const h = freshHandle();
  await withProvenance(false, async () => {
    clearTraces();
    await addUserFact(h, 'keeps bees', 'inferred');
    const d = (getTraces().find(e => e.label === 'memory:fact_provenance')?.detail ?? {}) as Record<string, unknown>;
    assert.equal(d.outcome, 'written');
    assert.equal(d.enabled, false, 'so a reader can tell "filed as a guess" from "nothing was filed"');
    assert.equal(d.prov, 'stated', 'and the row really does read as testimony — that is the legacy default');
  });
});

test('an unprefixed legacy fact reads as testimony, so a stated write is a plain no-op', async () => {
  const h = freshHandle();
  await withProvenance(false, async () => { await addUserFact(h, 'runs a lake cabin'); });
  await withProvenance(true, async () => {
    assert.equal(await addUserFact(h, 'runs a lake cabin', 'stated'), false);
    assert.deepEqual((await getUserProfile(h))?.facts, ['runs a lake cabin'], 'nothing to promote, nothing rewritten');
  });
});

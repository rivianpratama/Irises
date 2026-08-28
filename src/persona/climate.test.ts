// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The climate integrator is the CODE half of charter §10.1: the model contributes a sign and
// nothing else, and every bound that makes this safe — step size, floors, ceilings, the rolling
// weekly budget — is arithmetic in climate.ts. These tests pin all of it, plus the two properties
// the rest of the feature leans on: purity, and "a default climate renders NOTHING".
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIALS, CLIMATE_WINDOW_MS, CLIMATE_WINDOW_CAP, CLIMATE_MOVES_CAP,
  defaultClimate, coerceDials, applyDrift, climateLines, climateLinesForComposer,
  type DialKey, type RelationshipClimate,
} from './climate.js';

const T0 = Date.UTC(2026, 0, 1);
const WEEK = CLIMATE_WINDOW_MS;

/** A climate with hand-set dials and an empty ledger — the shape a stored row deserializes into. */
function at(dials: Partial<Record<DialKey, number>>): RelationshipClimate {
  const base = defaultClimate();
  return { ...base, dials: { ...base.dials, ...dials } };
}

// ── 1-2: the table and the tolerant coercion ─────────────────────────────────

test('defaults sit inside their own floors/ceilings and every step is a tiny one', () => {
  const d = defaultClimate();
  assert.deepEqual(d.moves, []);
  assert.equal(d.lastEvalAt, 0);
  assert.equal(d.evalCount, 0);
  for (const spec of DIALS) {
    assert.ok(spec.floor < spec.dflt && spec.dflt < spec.ceiling, `${spec.key} default outside its band`);
    assert.equal(d.dials[spec.key], spec.dflt);
    // A climate that could move more than 2 points per eval is weather, not climate.
    assert.ok(spec.up >= 1 && spec.up <= 2, `${spec.key} up step too large`);
    assert.ok(spec.down >= 1 && spec.down <= 2, `${spec.key} down step too large`);
  }
  // No `trust` dial. Deliberately rejected — the register is not a measure of how much they may lean.
  assert.ok(!DIALS.some(s => (s.key as string) === 'trust'));
});

test('coerceDials falls back per field, clamps out-of-range, and drops unknown keys', () => {
  const out = coerceDials({ ease: 999, candor: 'nonsense', playfulness: '40', trust: 100, extra: 1 });
  assert.equal(out.ease, 80);          // clamped to the ceiling, not reset
  assert.equal(out.candor, 45);        // garbled → that field alone falls back
  assert.equal(out.playfulness, 40);   // numeric string is fine
  assert.deepEqual(Object.keys(out).sort(), DIALS.map(d => d.key).sort()); // closed shape
  // Wholly hostile inputs still produce a usable, in-range set.
  assert.deepEqual(coerceDials(null), defaultClimate().dials);
  assert.deepEqual(coerceDials('[]'), defaultClimate().dials);
  assert.deepEqual(coerceDials([1, 2, 3]), defaultClimate().dials);
  assert.equal(coerceDials({ ease: -50 }).ease, 20); // clamped to the floor
});

// ── 3-6: the step arithmetic ─────────────────────────────────────────────────

test('each dial moves by its OWN asymmetric up/down step', () => {
  const up = applyDrift(defaultClimate(), { ease: 1, candor: 1, playfulness: 1 }, T0);
  assert.equal(up.next.dials.ease, 36);          // +1
  assert.equal(up.next.dials.candor, 47);        // +2 — honesty is quick to earn
  assert.equal(up.next.dials.playfulness, 26);   // +1
  assert.deepEqual(up.changed.sort(), ['candor', 'ease', 'playfulness']);
  assert.deepEqual(up.capped, []);

  const down = applyDrift(defaultClimate(), { ease: -1, candor: -1, playfulness: -1 }, T0);
  assert.equal(down.next.dials.ease, 33);        // -2 — attachment-risky registers are quick to lose
  assert.equal(down.next.dials.candor, 44);      // -1 — honesty is slow to lose
  assert.equal(down.next.dials.playfulness, 23); // -2

  // The eval itself is stamped, including on a run that moved nothing.
  const still = applyDrift(defaultClimate(), { ease: 0, candor: 0, playfulness: 0 }, T0);
  assert.deepEqual(still.changed, []);
  assert.equal(still.next.lastEvalAt, T0);
  assert.equal(still.next.evalCount, 1);
  assert.deepEqual(still.next.dials, defaultClimate().dials);
});

test('a dial never crosses its ceiling, however many fresh windows accumulate', () => {
  let c = defaultClimate();
  let now = T0;
  for (let i = 0; i < 60; i++) {                 // ≫20 evals, each in its own fresh budget window
    now += WEEK + 1;
    c = applyDrift(c, { ease: 1, candor: 1, playfulness: 1 }, now).next;
    for (const spec of DIALS) {
      assert.ok(c.dials[spec.key] <= spec.ceiling, `${spec.key} crossed its ceiling on eval ${i}`);
    }
  }
  // …and it actually GOT there, so this pins the clamp rather than a shortage of steps.
  for (const spec of DIALS) assert.equal(c.dials[spec.key], spec.ceiling);
});

// REGRESSION: the floor is the half that matters for safety. A relationship that keeps going badly
// must bottom out at "keep the full courtesy in place", never spiral into something colder.
test('REGRESSION: a dial never crosses its floor either', () => {
  let c = defaultClimate();
  let now = T0;
  for (let i = 0; i < 60; i++) {
    now += WEEK + 1;
    c = applyDrift(c, { ease: -1, candor: -1, playfulness: -1 }, now).next;
    for (const spec of DIALS) {
      assert.ok(c.dials[spec.key] >= spec.floor, `${spec.key} crossed its floor on eval ${i}`);
    }
  }
  for (const spec of DIALS) assert.equal(c.dials[spec.key], spec.floor);
});

test('only the SIGN of a suggestion is read — never its magnitude', () => {
  // 7, "3" and true all buy exactly one step; null, 0 and garbage buy none.
  const big = applyDrift(defaultClimate(), { ease: 7, candor: '3', playfulness: true }, T0);
  const one = applyDrift(defaultClimate(), { ease: 1, candor: 1, playfulness: 1 }, T0);
  assert.deepEqual(big.next.dials, one.next.dials);

  const none = applyDrift(defaultClimate(), { ease: null, candor: 0, playfulness: 'later' }, T0);
  assert.deepEqual(none.next.dials, defaultClimate().dials);
  assert.deepEqual(none.changed, []);

  // A negative magnitude is still exactly one down-step.
  const neg = applyDrift(defaultClimate(), { ease: -99, candor: '-4', playfulness: false }, T0);
  assert.equal(neg.next.dials.ease, 33);
  assert.equal(neg.next.dials.candor, 44);
  assert.equal(neg.next.dials.playfulness, 25); // false → no step, not a down-step
});

// ── 7-8: the rolling weekly budget ───────────────────────────────────────────

test('the rolling window caps total movement per dial: candor lands 3 steps, the 4th is capped', () => {
  let c = defaultClimate();
  let now = T0;
  for (let i = 0; i < 3; i++) {
    now += 60_000;
    const r = applyDrift(c, { candor: 1 }, now);
    assert.deepEqual(r.changed, ['candor'], `step ${i + 1} should land`);
    c = r.next;
  }
  assert.equal(c.dials.candor, 45 + CLIMATE_WINDOW_CAP); // 3 × +2 = the whole weekly budget

  now += 60_000;
  const fourth = applyDrift(c, { candor: 1 }, now);
  assert.deepEqual(fourth.changed, []);
  assert.deepEqual(fourth.capped, ['candor']);
  assert.equal(fourth.next.dials.candor, c.dials.candor, 'a capped dial does not move');
  assert.equal(fourth.next.moves.length, c.moves.length, 'and nothing is written to the ledger');
});

test('moves that age out of the window free the budget again', () => {
  let c = defaultClimate();
  let now = T0;
  for (let i = 0; i < 3; i++) { now += 60_000; c = applyDrift(c, { candor: 1 }, now).next; }
  assert.deepEqual(applyDrift(c, { candor: 1 }, now + 60_000).capped, ['candor']);

  // Step past the window: the three old moves no longer count, so a step lands and the stale
  // ledger rows are pruned away with them.
  const later = now + WEEK + 60_000;
  const r = applyDrift(c, { candor: 1 }, later);
  assert.deepEqual(r.changed, ['candor']);
  assert.equal(r.next.dials.candor, 45 + CLIMATE_WINDOW_CAP + 2);
  assert.deepEqual(r.next.moves.map(m => m.at), [later], 'aged-out moves are pruned');
});

// ── 9: purity ────────────────────────────────────────────────────────────────

test('applyDrift is pure: same inputs, same output, and the input is never mutated', () => {
  const before: RelationshipClimate = {
    dials: { ease: 40, candor: 50, playfulness: 30 },
    moves: [{ at: T0 - 1000, k: 'ease', d: 1 }],
    lastEvalAt: T0 - 1000,
    evalCount: 4,
  };
  const snapshot = structuredClone(before);

  const a = applyDrift(before, { ease: 1, candor: -1 }, T0);
  const b = applyDrift(before, { ease: 1, candor: -1 }, T0);
  assert.deepEqual(a.next, b.next);
  assert.deepEqual(a.changed, b.changed);
  assert.deepEqual(before, snapshot, 'the input climate was mutated');
  assert.notEqual(a.next.dials, before.dials, 'the dials object is a fresh one');
  assert.notEqual(a.next.moves, before.moves, 'the ledger array is a fresh one');
  assert.ok(a.next.moves.length <= CLIMATE_MOVES_CAP);
});

// ── 10-13: the rendered prose ────────────────────────────────────────────────

// THE no-regression pin. Everything downstream (the Convo prompt, the Composer block, the byte
// comparisons in status.test.ts) rests on this returning an empty array.
test('a default climate renders NOTHING at all', () => {
  assert.deepEqual(climateLines(defaultClimate()), []);
  assert.deepEqual(climateLines(undefined), []);
  assert.deepEqual(climateLinesForComposer(defaultClimate()), []);
  assert.deepEqual(climateLinesForComposer(undefined), []);
  // The silent band is ±3, so a dial that has barely twitched still renders nothing.
  assert.deepEqual(climateLines(at({ ease: 38, candor: 42, playfulness: 28 })), []);
  // One point past it does render.
  assert.ok(climateLines(at({ ease: 39 })).length > 0);
});

test('the rendered lines carry a band, never a number', () => {
  const moved = at({ ease: 70, candor: 80, playfulness: 60 });
  const lines = climateLines(moved);
  assert.ok(lines.length >= 5); // lead-in + three bullets + clamp
  for (const line of lines) {
    assert.doesNotMatch(line, /\d/, `a dial value leaked into the prompt: ${line}`);
  }
  // The lead-in leads, and says out loud that this does not move inside one conversation.
  assert.match(lines[0], /standing register/);
  assert.match(lines[0], /does not move inside one/);
});

test('the clamp sentence is always last whenever anything rendered', () => {
  for (const c of [at({ ease: 70 }), at({ candor: 25 }), at({ playfulness: 60, ease: 20 })]) {
    const lines = climateLines(c);
    assert.ok(lines.length > 0);
    const clamp = lines[lines.length - 1];
    assert.match(clamp, /register/i);
    assert.match(clamp, /never changes a fact/i);
    // §6.4: a warmer register is never a statement about reliance.
    assert.match(clamp, /lean on you/i);
  }
});

test('the composer subset renders ease + playfulness and NEVER candor', () => {
  const moved = at({ ease: 70, candor: 84, playfulness: 60 });
  const composer = climateLinesForComposer(moved).join('\n');
  assert.match(composer, /polite runway|drop straight in mid-thought/);
  assert.match(composer, /teasing|in-jokes/);
  // The Composer relays a decided answer; a candor register there could only sharpen it.
  assert.doesNotMatch(composer, /straight answer|unwelcome read|cushion/i);

  // A climate whose ONLY movement is candor is invisible to the Composer, clamp and all.
  assert.deepEqual(climateLinesForComposer(at({ candor: 84 })), []);
  assert.ok(climateLines(at({ candor: 84 })).length > 0, 'but Convo still sees it');
});

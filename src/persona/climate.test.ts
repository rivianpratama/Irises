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
  clampToSpec, signOf, spentInWindow, pruneLedger,
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

// A dial parked on a bound is the third way a suggestion can vanish, and the only PERMANENT one:
// it will swallow every step in that direction for as long as it sits there. Reported separately
// from `capped` (which frees up as the week rolls) so diagnostics can tell "this relationship is
// pinned" from "the model has gone quiet".
test('a dial at its ceiling reports atBound — not changed, not capped', () => {
  const spec = DIALS.find(d => d.key === 'ease')!;
  const r = applyDrift(at({ ease: spec.ceiling }), { ease: 1 }, T0);
  assert.deepEqual(r.atBound, ['ease']);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.capped, []);
  assert.equal(r.next.dials.ease, spec.ceiling, 'and it did not move');
  assert.deepEqual(r.next.moves, [], 'a step that never happened is not in the ledger');

  // The floor is the same story in the other direction, and a bound only swallows the step pointed
  // AT it — the other way still moves.
  const play = DIALS.find(d => d.key === 'playfulness')!;
  const floored = applyDrift(at({ playfulness: play.floor }), { playfulness: -1 }, T0);
  assert.deepEqual(floored.atBound, ['playfulness']);
  const away = applyDrift(at({ ease: spec.ceiling }), { ease: -1 }, T0);
  assert.deepEqual(away.atBound, []);
  assert.deepEqual(away.changed, ['ease']);
});

// When the weekly budget shortens a step without erasing it, the dial lands in `changed` like any
// other — `shortened` is what says it landed smaller than the table's step.
test('a step the budget shortens is reported with the magnitude that actually landed', () => {
  // Spend 5 of candor's 6 points: +2, +2, then a -1.
  let c = defaultClimate();
  let now = T0;
  for (const s of [1, 1, -1]) { now += 60_000; c = applyDrift(c, { candor: s }, now).next; }

  const r = applyDrift(c, { candor: 1 }, now + 60_000);
  assert.deepEqual(r.changed, ['candor'], 'one point was still available, so it moved');
  assert.deepEqual(r.capped, []);
  assert.deepEqual(r.shortened, { candor: 1 }, 'a +2 step that landed as +1');
  assert.equal(r.next.dials.candor - c.dials.candor, 1);

  // A full step reports nothing.
  assert.deepEqual(applyDrift(defaultClimate(), { candor: 1 }, T0).shortened, {});
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

// ── 8b: the three shared helpers ─────────────────────────────────────────────

// `clampToSpec`, `signOf` and `spentInWindow` are exported so `affectDrift.ts` can REUSE the
// bound arithmetic rather than grow a second, drifting copy of it. Their signatures are widened
// (a structural spec, a generic move key, an overridable window) precisely so a second gauge
// table with its own keys and its own shorter window can borrow them unchanged — this pins that
// the widening kept climate's own behavior exactly.
test('the shared bound helpers are exported and behave identically through the wider signatures', () => {
  const ease = DIALS.find(d => d.key === 'ease')!;
  assert.equal(clampToSpec(999, ease), ease.ceiling);
  assert.equal(clampToSpec(-999, ease), ease.floor);
  assert.equal(clampToSpec(35.6, ease), 36, 'rounds, it does not truncate');
  // A bare {floor, ceiling} is enough — no DialKey needed, which is what lets another table reuse it.
  assert.equal(clampToSpec(150, { floor: 1, ceiling: 100 }), 100);

  assert.equal(signOf(7), 1);
  assert.equal(signOf('-4'), -1);
  assert.equal(signOf(true), 1);
  assert.equal(signOf(false), 0);
  assert.equal(signOf(null), 0);
  assert.equal(signOf('later'), 0);

  const moves = [
    { at: T0 - 1000, k: 'ease' as DialKey, d: 2 },
    { at: T0 - 1000, k: 'candor' as DialKey, d: -1 },
    { at: T0 - WEEK - 1000, k: 'ease' as DialKey, d: 2 }, // outside the window
  ];
  assert.equal(spentInWindow(moves, 'ease', T0), 2, '|movement| inside the window only');
  assert.equal(spentInWindow(moves, 'candor', T0), 1, 'a down-step spends its magnitude');
  assert.equal(spentInWindow(moves, 'playfulness', T0), 0);
  // The window is overridable, and defaults to climate's own week.
  assert.equal(spentInWindow(moves, 'ease', T0, 2000), 2);
  assert.equal(spentInWindow(moves, 'ease', T0, 500), 0, 'a shorter window sees less');
  assert.equal(spentInWindow(moves, 'ease', T0, CLIMATE_WINDOW_MS), spentInWindow(moves, 'ease', T0));
});

// `pruneLedger` is the tail BOTH step functions end on: drop what the window has aged out, then
// bound the array by dropping the oldest rows nothing still reads. Climate pins nothing — its prune
// window IS its budget's window, so every row that survives the prune is one `spentInWindow` can
// still count, and the cap is a plain oldest-first trim. `affectDrift.ts` passes a predicate,
// because it prunes on six hours while two shorter budgets read particular rows out of that.
test('pruneLedger prunes to the window, then trims the oldest rows nothing pinned', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ at: T0 - (9 - i), k: 'ease' as DialKey, d: 1 }));
  const stale = { at: T0 - WEEK - 1, k: 'ease' as DialKey, d: 1 };

  // Everything past the window goes, whatever the cap allows.
  assert.deepEqual(pruneLedger([stale, ...rows], T0, CLIMATE_WINDOW_MS, 100), rows);
  // Under the cap the pruned array comes back as it is.
  assert.deepEqual(pruneLedger(rows, T0, CLIMATE_WINDOW_MS, 10), rows);
  // Over it, the OLDEST rows go and the survivors keep their newest-last order.
  assert.deepEqual(pruneLedger(rows, T0, CLIMATE_WINDOW_MS, 4), rows.slice(6));
  // A pinned row is kept on top of the cap, in place — this is the whole reason the seam exists.
  assert.deepEqual(
    pruneLedger(rows, T0, CLIMATE_WINDOW_MS, 2, m => m.at === rows[0].at),
    [rows[0], ...rows.slice(8)],
  );
  assert.equal(rows.length, 10, 'the ledger handed in is never mutated');
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

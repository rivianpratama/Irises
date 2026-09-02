// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The affect integrator is charter §10.1 applied to the per-turn gauges, the same way climate.ts
// applies it to the weeks-scale dials: the model contributes a DIRECTION (`mood_shift`) and a
// feeling WORD, and every bound that makes that safe — the step sizes, the floors and ceilings, the
// valence band, the per-turn cap, the rolling budgets — is arithmetic in affectDrift.ts. These
// tests mirror climate.test.ts item for item, and add the one property climate has no analog for:
// clock-target monotonicity, which is what catches a sign error in a coefficient.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOOD_CORES, WILLCOX_WHEEL, EXTENDED_WORDS, wheelWords, feelingWords,
  normalizeMoodLabel, coreForLabel, CORE_VALENCE_BAND,
} from './mood.js';

// ── coreForLabel: the inverse of the wheel ───────────────────────────────────

// `normalizeMoodLabel` already accepts any wheel word under any core, which is exactly what makes
// the core DERIVABLE from the word — so the model stops reporting a (core, label) pair it can
// contradict itself with, and `mood_core` becomes code's answer instead of a second judgment call.
test('coreForLabel round-trips every canonical wheel word back to its own core', () => {
  for (const core of MOOD_CORES) {
    for (const word of wheelWords(core)) {
      assert.equal(coreForLabel(word), core, `${word} should file under ${core}`);
    }
  }
  // 72 words, so this is the whole chart and not a sample of it.
  assert.equal(MOOD_CORES.flatMap(wheelWords).length, 72);
});

test('coreForLabel is case- and whitespace-tolerant, and takes the extra shades too', () => {
  assert.equal(coreForLabel('MISERABLE'), 'sad');
  assert.equal(coreForLabel('  serene  '), 'peaceful');
  assert.equal(coreForLabel('overwhelmed'), 'scared'); // an Irises extra, not on Willcox's chart
  assert.equal(coreForLabel('tender'), 'peaceful');
  assert.equal(coreForLabel('drained'), 'sad');
  assert.equal(coreForLabel('curious'), 'joyful');
});

// 'cheerful' is the one word that appears twice in the vocabulary: it is a canonical Willcox
// tertiary under `powerful` AND one of Irises's extra shades under `joyful`. The canonical chart
// wins, deliberately — otherwise the round-trip above would fail for a real wheel word, and the
// two nearly-identical bands ([65,95] vs [70,100]) make the choice nearly free either way.
test('a word in both the wheel and the extras files under its CANONICAL core', () => {
  assert.ok(WILLCOX_WHEEL.powerful.tertiary.includes('cheerful'));
  assert.ok(EXTENDED_WORDS.joyful.includes('cheerful'));
  assert.equal(coreForLabel('cheerful'), 'powerful');
});

test('an unrecognized word falls back to peaceful — the same fallback the prompt already had', () => {
  assert.equal(coreForLabel('zzzqqq'), 'peaceful');
  assert.equal(coreForLabel(''), 'peaceful');
  assert.equal(coreForLabel('   '), 'peaceful');
  // Hostile non-strings cannot throw: this runs on a label that came off a model envelope.
  assert.equal(coreForLabel(undefined as unknown as string), 'peaceful');
  assert.equal(coreForLabel(null as unknown as string), 'peaceful');
  assert.equal(coreForLabel(42 as unknown as string), 'peaceful');
});

// The pair that makes the derivation total: whatever `normalizeMoodLabel` lets through,
// `coreForLabel` can name a core for. No label can reach the band clamp without a band.
test('every label normalizeMoodLabel accepts has a core, and every core has a band', () => {
  for (const core of MOOD_CORES) {
    for (const word of feelingWords(core)) {
      const kept = normalizeMoodLabel(core, word);
      assert.equal(kept, word, 'a recognized word survives normalization');
      const band = CORE_VALENCE_BAND[coreForLabel(kept)];
      assert.ok(band && band[0] < band[1], `${word} has no usable band`);
    }
  }
});

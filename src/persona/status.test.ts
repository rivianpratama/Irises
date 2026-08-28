import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceStatus, extractStatus, clampGauge, mergeStatus, pushMood, renderStatusForPrompt,
  renderStatusForComposer,
  STATUS_SCHEMA_PROP, MOOD_HISTORY_CAP, type ComputedState, type EmittedStatus, type MoodPoint,
} from './status.js';
import { computeCycle } from './cycle.js';
import { computeCircadian } from './circadian.js';
import { defaultClimate, type RelationshipClimate } from './climate.js';

const RAW = {
  mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
  anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
  engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
  meta_prompt: 'they seem upbeat; keep it light and follow their lead',
  profile_note: 'warm, forward-looking, likes momentum', terminal_closure: false,
};

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 16, 0, 0), 'UTC'),
};

test('clampGauge coerces to a 1-100 integer, tolerant of strings/floats/out-of-range', () => {
  assert.equal(clampGauge(50), 50);
  assert.equal(clampGauge(0), 1);
  assert.equal(clampGauge(150), 100);
  assert.equal(clampGauge('42'), 42);
  assert.equal(clampGauge(73.6), 74);
  assert.equal(clampGauge('nope', 33), 33);
  assert.equal(clampGauge(undefined, 33), 33);
});

test('coerceStatus validates a good object and clamps the gauges', () => {
  const s = coerceStatus(RAW)!;
  assert.equal(s.mood_core, 'joyful');
  assert.equal(s.mood_label, 'hopeful');
  assert.equal(s.mood_level, 72);
  assert.equal(s.intent_mode, 'sharing_update');
  assert.equal(s.epistemic_trigger, 'logic_valid');
  assert.equal(s.terminal_closure, false);
});

test('coerceStatus falls back on invalid enums / mood, normalizes a stray label, clamps ranges', () => {
  const s = coerceStatus({ ...RAW, mood_core: 'grumpy', mood_label: 'zzz', intent_mode: 'nope', epistemic_trigger: 'x', anxiety: 999, patience: -4 })!;
  assert.equal(s.mood_core, 'peaceful');        // invalid core → default
  assert.equal(s.intent_mode, 'questioning');   // invalid intent → default
  assert.equal(s.epistemic_trigger, 'none');    // invalid trigger → default
  assert.ok(typeof s.mood_label === 'string' && s.mood_label.length > 0); // normalized to a real wheel word
  assert.equal(s.anxiety, 100);
  assert.equal(s.patience, 1);
});

test('coerceStatus returns undefined for null/missing/non-object', () => {
  assert.equal(coerceStatus(null), undefined);
  assert.equal(coerceStatus(undefined), undefined);
  assert.equal(coerceStatus('str' as unknown as Record<string, unknown>), undefined);
});

test('extractStatus unwraps the container .status', () => {
  assert.equal(extractStatus({ status: null }), undefined);
  assert.equal(extractStatus({}), undefined);
  assert.equal(extractStatus({ status: RAW })!.mood_core, 'joyful');
});

test('mergeStatus folds in the computed cycle/circadian + timestamp', () => {
  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, 1234);
  assert.equal(full.cycle_phase, COMPUTED.cycle.phase);
  assert.equal(full.cycle_day, COMPUTED.cycle.day);
  assert.equal(full.circadian_slot, COMPUTED.circadian.slot);
  assert.equal(full.circadian_energy, COMPUTED.circadian.energy);
  assert.equal(full.at, 1234);
  assert.equal(full.mood_core, 'joyful');
});

test('pushMood caps the trail at MOOD_HISTORY_CAP, newest last', () => {
  let hist: MoodPoint[] = [];
  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, 0);
  for (let i = 0; i < MOOD_HISTORY_CAP + 5; i++) {
    hist = pushMood(hist, { ...full, mood_level: i, at: i });
  }
  assert.equal(hist.length, MOOD_HISTORY_CAP);
  assert.equal(hist[hist.length - 1].level, MOOD_HISTORY_CAP + 4); // newest kept
});

test('STATUS_SCHEMA_PROP is a flat, nullable, strict object', () => {
  const p = STATUS_SCHEMA_PROP as { type: string[]; additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(p.type, ['object', 'null']);        // nullable so a weak model can opt out
  assert.equal(p.additionalProperties, false);
  assert.equal(p.required.length, 15);
  assert.ok('mood_core' in p.properties && 'meta_prompt' in p.properties && 'terminal_closure' in p.properties);
  assert.deepEqual(Object.keys(p.properties).sort(), [...p.required].sort()); // every required field is declared
});

test('renderStatusForPrompt always warns it is internal, and carries prior mood when present', () => {
  const cold = renderStatusForPrompt(undefined, COMPUTED);
  assert.match(cold, /INTERNAL weather/);
  assert.match(cold, /never say/i);

  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, 0);
  const warm = renderStatusForPrompt({ last: full, moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] }, COMPUTED);
  assert.match(warm, /hopeful/);
  assert.match(warm, /keep it light/); // the prior meta_prompt is re-injected
});

test('renderStatusForComposer returns "" for null/undefined and when there is no carried mood', () => {
  assert.equal(renderStatusForComposer(undefined), '');
  assert.equal(renderStatusForComposer(null), '');
  assert.equal(renderStatusForComposer({ moodHistory: [] }), ''); // no .last → nothing to carry
});

test('renderStatusForComposer returns "" for a stale (>45min) state — guards the proactive path', () => {
  const stale = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now() - 46 * 60_000);
  assert.equal(renderStatusForComposer({ last: stale, moodHistory: [] }), '');
  // right at the edge but still fresh (<45min) → a block, not ''
  const fresh = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now() - 44 * 60_000);
  assert.notEqual(renderStatusForComposer({ last: fresh, moodHistory: [] }), '');
});

test('renderStatusForComposer carries the mood + the leak-guard + the fidelity clause, and NOTHING excluded', () => {
  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now());
  const out = renderStatusForComposer({ last: full, moodHistory: [] });

  // mood label + the texture for its level (72 → the "Steady and open" band)
  assert.match(out, /hopeful/);
  assert.match(out, /joyful/);
  assert.match(out, /Steady and open/);
  // the carried voice-shaping gauges
  assert.match(out, /warmth 80/);
  assert.match(out, /patience 75/);

  // the proven leak-guard header + the added fidelity clause
  assert.match(out, /INTERNAL weather/);
  assert.match(out, /never say/i);
  assert.match(out, /never adds, drops, softens, or sharpens a fact/);

  // excluded fields must NOT leak into the composer block
  assert.doesNotMatch(out, /keep it light/);          // meta_prompt
  assert.doesNotMatch(out, /forward-looking/);         // profile_note
  assert.doesNotMatch(out, /sharing_update/);          // intent_mode
  assert.doesNotMatch(out, /conviction/i);             // excluded gauge
  assert.doesNotMatch(out, /engagement/i);             // excluded gauge
  assert.doesNotMatch(out, /re-report/i);              // no "re-report your status" instruction
  assert.doesNotMatch(out, /body-clock|longer rhythm/); // no cycle/circadian machinery
});

// ── Relationship climate spliced into the same block ─────────────────────────

/** A climate that has actually moved on every dial, well past the silent ±3 band. */
function movedClimate(): RelationshipClimate {
  return { ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30 };
}

test('a moved climate rides ONE weather block, after the momentum lines and before the re-report tail', () => {
  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, 0);
  const out = renderStatusForPrompt({ last: full, moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] }, COMPUTED, movedClimate());

  // Exactly one header — a second one would read as a second, competing block.
  assert.equal(out.split('INTERNAL weather').length - 1, 1);

  const momentum = out.indexOf('Your state has MOMENTUM');
  const meta = out.indexOf('Your read going into this message');
  const leadIn = out.indexOf('standing register');
  const reReport = out.indexOf('re-report your `status`');
  assert.ok(momentum !== -1 && meta !== -1 && leadIn !== -1 && reReport !== -1);
  assert.ok(leadIn > momentum, 'climate must sit after the momentum line');
  assert.ok(leadIn > meta, 'climate must sit after the carried meta-prompt');
  assert.ok(leadIn < reReport, 'the re-report instruction stays last');

  // Bands, never numbers — and the clamp that keeps a warmer register from touching the substance.
  assert.match(out, /polite runway|drop straight in mid-thought/);
  assert.match(out, /never changes a fact/);
  assert.doesNotMatch(out.slice(leadIn, reReport), /\d/);
});

// THE no-regression pin: the feature is inert until a relationship has moved.
test('a default climate leaves renderStatusForPrompt byte-identical to no climate at all', () => {
  const full = mergeStatus(coerceStatus(RAW)!, COMPUTED, 0);
  const state = { last: full, moodHistory: [{ level: 72, core: 'joyful' as const, label: 'hopeful', at: 0 }] };
  assert.equal(renderStatusForPrompt(state, COMPUTED, defaultClimate()), renderStatusForPrompt(state, COMPUTED));
  assert.equal(renderStatusForPrompt(state, COMPUTED, undefined), renderStatusForPrompt(state, COMPUTED));
  // Cold start too (no carried mood at all).
  assert.equal(renderStatusForPrompt(undefined, COMPUTED, defaultClimate()), renderStatusForPrompt(undefined, COMPUTED));
});

// The intended behaviour CHANGE: climate has no staleness gate, because a weeks-scale register
// cannot go stale in 45 minutes. A proactive delivery hours later still speaks in the right register.
test('composer: a stale mood plus a moved climate yields a climate-ONLY block', () => {
  const stale = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now() - 5 * 60 * 60_000);
  const out = renderStatusForComposer({ last: stale, moodHistory: [] }, movedClimate());

  assert.match(out, /INTERNAL weather/);
  assert.match(out, /standing register/);
  assert.match(out, /teasing|in-jokes/);
  // The stale mood is gone — its gate still holds.
  assert.doesNotMatch(out, /hopeful/);
  assert.doesNotMatch(out, /Gauges you carry in/);
  // And candor never reaches the Composer, which relays a decided answer.
  assert.doesNotMatch(out, /straight answer|unwelcome read/i);
});

test('composer: a stale mood plus a DEFAULT climate is still "" (both halves empty)', () => {
  const stale = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now() - 5 * 60 * 60_000);
  assert.equal(renderStatusForComposer({ last: stale, moodHistory: [] }, defaultClimate()), '');
  assert.equal(renderStatusForComposer({ last: stale, moodHistory: [] }), '');
  assert.equal(renderStatusForComposer(undefined, defaultClimate()), '');

  // And a FRESH mood with a default climate is byte-identical to the pre-climate output.
  const fresh = mergeStatus(coerceStatus(RAW)!, COMPUTED, Date.now());
  const state = { last: fresh, moodHistory: [] };
  assert.equal(renderStatusForComposer(state, defaultClimate()), renderStatusForComposer(state));
});

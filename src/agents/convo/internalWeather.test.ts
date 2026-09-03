// buildSystemPrompt injects Irises's hidden "internal weather" (cycle + circadian + carried-forward
// mood + last-turn meta-prompt) only when the computed state is passed. Proves the block appears,
// carries prior mood, and is absent on the legacy (no-affect) call path.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type ChatContext } from './shared.js';
import {
  coerceStatus, mergeStatus, STATUS_CONTRACT_HEADER, type AffectState, type ComputedState,
} from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { defaultClimate, type RelationshipClimate } from '../../persona/climate.js';

const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: '+15550001111' };

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),          // menstrual, day 1
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 2, 0, 0), 'UTC'),        // dead_night
};

function affect(): AffectState {
  const emitted = coerceStatus({
    mood_label: 'hopeful', mood_shift: 'lifted', intent_mode: 'sharing_update',
    terminal_closure: false, epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
  })!;
  // The gauges left the envelope in v2 — they are code's answer now (persona/affectDrift.ts) — so the
  // row she carried IN is STATED here rather than emitted into place. A prompt fixture is about what
  // the weather block renders, not about the drift arithmetic (persona/affectDrift.test.ts owns that).
  const last = {
    ...mergeStatus(emitted, COMPUTED, 0),
    mood_level: 72, anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, patience: 75,
  };
  return { last, moodHistory: [{ level: 72, core: 'powerful', label: 'hopeful', at: 0 }] };
}

test('the internal-weather block is injected when computed state is present', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, undefined, COMPUTED);
  assert.match(prompt, /## Where you are right now \(INTERNAL weather/);
  assert.match(prompt, /never say/i);
  assert.match(prompt, /First read of this person/);       // cold start (no prior status)
});

test('a prior mood + meta-prompt carry forward into the block', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  // 'hopeful' is a `powerful` word on the chart, and the core is derived from the word now
  // (coreForLabel) rather than reported beside it, so a fixture can no longer file it under `joyful`.
  assert.match(prompt, /hopeful \(powerful, 72\/100\)/);    // carried mood
  assert.match(prompt, /keep it light and follow their lead/); // carried meta-prompt
});

// The envelope contract (persona/status.ts renderStatusContract) is its OWN section, pushed under the
// same `computed` guard and immediately after the weather block — whose last line is now one pointer
// at it (63 chars) instead of a 382-character re-listing of the fields it describes. (Measured off
// the pre-change golden; "470" was the brief's estimate, and it stood in two comments until review.)

test('the status contract rides with the weather block, and the tail points at it', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  const weather = prompt.indexOf('## Where you are right now (INTERNAL weather');
  const contract = prompt.indexOf(STATUS_CONTRACT_HEADER);
  assert.ok(weather !== -1, 'the weather block is present');
  assert.ok(contract > weather, 'the contract follows it');
  assert.equal(
    prompt.slice(weather, contract).split('\n## ').length - 1, 0,
    'nothing is pushed between the weather block and the contract it points at',
  );

  assert.match(prompt, /- Re-report your `status` per the contract below; never spoken\./);
  assert.ok(!prompt.includes('After you read them, re-report'), 'the long re-report tail is gone');
  // What the tail used to spell out, the contract's bullets now do — once.
  assert.match(prompt, /- `meta_prompt` —/);
  assert.match(prompt, /joyful: excited/);
});

test('no computed state → no internal-weather block and no contract (legacy path unchanged)', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined);
  assert.ok(!prompt.includes('INTERNAL weather'));
  // The HEADING, `## ` and all: the persona still points at the block by name ("…arrive in your
  // per-turn context under 'Your hidden status — the contract'"), which is not the block itself.
  assert.ok(!prompt.includes(STATUS_CONTRACT_HEADER), 'nothing asked her to re-report, so no contract');
});

// The weeks-scale standing register (persona/climate.ts) rides the SAME block — one header, ever.
function movedClimate(): RelationshipClimate {
  return { ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30 };
}

test('a moved climate reaches the assembled prompt as prose, with no dial values leaked', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED, null, movedClimate());
  assert.equal(prompt.split('INTERNAL weather').length - 1, 1, 'still exactly one weather header');
  assert.match(prompt, /standing register you've settled into/);
  assert.match(prompt, /drop straight in mid-thought/);
  assert.match(prompt, /in-jokes and shorthand/);
  assert.match(prompt, /never changes a fact/);

  // A dial VALUE in the prompt is a thing to optimize; a band is a thing to speak in.
  const from = prompt.indexOf('standing register');
  const to = prompt.indexOf('Re-report your `status`');
  assert.ok(from !== -1 && to > from);
  assert.doesNotMatch(prompt.slice(from, to), /\d/);
});

// The no-regression pin at the assembly level: until a relationship has actually moved, the feature
// costs the prompt nothing at all.
test('a default climate leaves buildSystemPrompt byte-identical', () => {
  // The assembled prompt carries a clock line — a millisecond-precision instant AND a
  // minute-resolution local time — so two calls differ there and nowhere else. Blanking only the
  // ISO instant left the local time live, and two builds straddling a minute boundary would then
  // fail this on the clock rather than on the climate. Blank the whole clock line (it stops at the
  // newline, so the timezone sentence after it is still compared); everything else is byte for byte.
  const build = (climate?: RelationshipClimate) =>
    buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED, null, climate)
      .replace(/^Right now it's .*$/m, "Right now it's <now>")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<now>');

  const bare = build();
  assert.equal(build(defaultClimate()), bare);
  assert.equal(build(undefined), bare);
  // …and the comparison has teeth: a moved climate is NOT byte-identical.
  assert.notEqual(build(movedClimate()), bare);
});

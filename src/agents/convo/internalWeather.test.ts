// buildSystemPrompt injects Irises's hidden "internal weather" (cycle + circadian + carried-forward
// mood + last-turn meta-prompt) only when the computed state is passed. Proves the block appears,
// carries prior mood, and is absent on the legacy (no-affect) call path.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type ChatContext } from './shared.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../../persona/status.js';
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
    mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
    anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
    engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
    profile_note: 'warm, forward-looking', terminal_closure: false,
  })!;
  const last = mergeStatus(emitted, COMPUTED, 0);
  return { last, moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] };
}

test('the internal-weather block is injected when computed state is present', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, undefined, COMPUTED);
  assert.match(prompt, /## Where you are right now \(INTERNAL weather/);
  assert.match(prompt, /never say/i);
  assert.match(prompt, /First read of this person/);       // cold start (no prior status)
});

test('a prior mood + meta-prompt carry forward into the block', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  assert.match(prompt, /hopeful \(joyful, 72\/100\)/);      // carried mood
  assert.match(prompt, /keep it light and follow their lead/); // carried meta-prompt
});

test('no computed state → no internal-weather block (legacy path unchanged)', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined);
  assert.ok(!prompt.includes('INTERNAL weather'));
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
  const to = prompt.indexOf('re-report your `status`');
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

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
import { loadContext } from '../loadContext.js';
import { splitSections } from '../../memory/wrappers.js';

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

// P3: the gauges reach her as WORDS, and only the four she can feel. The fixture carries warmth 80,
// patience 75, social battery 65, anxiety 30 → two on the high band, one mid, one low.
test('the carried gauges reach the assembled prompt as words, not levels to optimize', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  assert.match(prompt, /- How you're running right now: warmth easy, patience long, social battery half, anxiety quiet\./);
  assert.ok(!prompt.includes('(all /100)'), 'the block hands her a 1-100 scale to grade her gauges on again');
  assert.ok(
    !prompt.includes('Your state has MOMENTUM'),
    'the momentum sentence is back — applyAffectDrift (persona/affectDrift.ts) enforces it now, so this is an instruction she cannot disobey',
  );
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

// ── the persona's half of the same subject ───────────────────────────────────
// Context.md's `## Your inner weather and hidden status` section is the prose half of everything
// above. P1 took the envelope's field list out of it (the generated contract owns that now); P3 part
// 3 takes the last claim left in it that CODE enforces, so the section states no rule the per-turn
// block also states.

/** The section, located by its heading through the same heading-splitter the memory sanitizer and
 *  the relevance router use (memory/wrappers.ts), so the boundary is one definition rather than a
 *  regex invented here. */
function innerWeatherSection(): string {
  const found = splitSections(loadContext('convo')).find(s => s.startsWith('## Your inner weather'));
  assert.ok(found, 'the inner-weather section is gone from Context.md, or its heading was renamed');
  return found;
}

/**
 * What that section stands at TODAY, in characters — the same measure-then-ratchet discipline as
 * PROMPT_BUDGET (promptPolicy.ts), at the granularity a persona editor actually works in. The whole
 * persona has a ceiling already, but at 138k it cannot tell this section growing back from any other
 * paragraph arriving: a sentence re-added here lands inside the +0.1% the persona line carries.
 *
 * 2,680 today, from 2,859 — the 179 characters of the momentum sentence. It is deliberately NOT the
 * 1,200 the task brief targeted: that estimate assumed this section's other paragraphs had already
 * moved out, and they have not. What is left is the leak guard, the list of what the per-turn block
 * contains, the standing-register and thread-offer framings, the pointer at the contract, and the
 * one rescued anti-sycophancy rule — five paragraphs of live persona, ~1,480 characters more than
 * the target, and not one of them a duplicate of anything the prompt says elsewhere. Reaching 1,200
 * means deciding which of those paragraphs the persona can lose, which is a phase of its own.
 */
const INNER_WEATHER_CEILING = 2_700;

test('the persona no longer claims her state has momentum — the drift engine enforces it', () => {
  const section = innerWeatherSection();
  assert.doesNotMatch(
    section, /Your state has momentum/i,
    'the momentum claim is back in the persona. applyAffectDrift (persona/affectDrift.ts) is what '
    + 'carries the state forward now, bounded by AFFECT_TURN_CAP and the two rolling windows — so '
    + 'this is prose telling her to do what she cannot help doing, in the most expensive 138k in the repo',
  );
  assert.doesNotMatch(section, /drifts by a few points|never resets to neutral/);

  // What the section still does, and all of it: name the block, hold the leak guard, point at the
  // contract for the fields. (The pointer's exact wording is promptPolicy.test.ts's pin.)
  assert.match(section, /where you are right now/i, 'it still names the block she is handed');
  assert.match(section, /None of it is ever named to the user/, "the leak guard is the section's reason to exist");
  assert.ok(
    section.includes(`under "${STATUS_CONTRACT_HEADER.replace(/^## /, '')}"`),
    'and it still points at the contract instead of describing the fields a second time',
  );

  assert.ok(
    section.length <= INNER_WEATHER_CEILING,
    `the inner-weather section is ${section.length} chars, over its ${INNER_WEATHER_CEILING}-char ceiling — `
    + 'ratchet it here in the same commit, or delete something the per-turn block already says',
  );
});

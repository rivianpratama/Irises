// buildSystemPrompt injects Irises's hidden "internal weather" — the COMPILED affect directive
// (persona/affectCompiler.ts) plus the standing register underneath it — only when the computed
// state is passed. Proves the block appears, carries what last turn left behind, and is absent on
// the legacy (no-affect) call path.
//
// What it used to prove, and no longer can, is the measure of the change: the block carried two
// paragraphs of clock texture, the carried mood as a level out of a hundred with a five-band essay
// about it, four gauge words and a trajectory line. Every one of those described a state. The
// assertions below pin instructions instead, because that is all that is left in the prompt.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, type ChatContext } from './shared.js';
import {
  coerceStatus, mergeStatus, STATUS_CONTRACT_HEADER,
  type AffectGauges, type AffectState, type ComputedState,
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

function affect(gauges: Partial<AffectGauges> = {}): AffectState {
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
    ...gauges,
  };
  return { last, moodHistory: [{ level: 72, core: 'powerful', label: 'hopeful', at: 0 }] };
}

test('the internal-weather block is injected when computed state is present', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, undefined, COMPUTED);
  assert.match(prompt, /## Where you are right now \(INTERNAL weather/);
  assert.match(prompt, /never say/i);
  // Cold start (no prior status): the default mood compiles to one imperative, where it used to be
  // a line asking her to set her mood from a body-clock paragraph that no longer exists.
  assert.match(prompt, /- You are content \(peaceful\)\. Even and flat\. Nothing extra\./);
  assert.doesNotMatch(prompt, /First read of this person/);
});

test('a prior mood + meta-prompt carry forward into the block', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  // The core is derived from the word (persona/mood.ts coreForLabel) rather than reported beside it,
  // and 'hopeful' is a `powerful` word on the chart — so that is the core the block prints, and a
  // fixture cannot file the same word under a different one. What it no longer prints is the level:
  // a number beside a state is a number to optimize (charter §6.4), and the core's own imperative is
  // what the level was standing in for.
  assert.match(prompt, /- You are hopeful \(powerful\)\. A judgment lands flat and certain\. Do not explain it\./);
  assert.ok(!prompt.includes('hopeful (powerful, 72/100)'), 'the carried level is back in the prompt');
  assert.match(prompt, /keep it light and follow their lead/); // carried meta-prompt
});

// The gauges reach her as an INSTRUCTION or not at all. The fixture carries social battery 65 — the
// normal band — so the block carries no shape line, and the whole of what the gauges bought this
// turn is the absence of one. Drop the battery and the line appears.
test('the carried gauges reach the assembled prompt as an instruction, never as a level', () => {
  const prompt = buildSystemPrompt(ctx, '', [], undefined, undefined, [], 'hey', undefined, affect(), COMPUTED);
  assert.ok(!prompt.includes("- How you're running right now"), 'the four felt-gauge words are back');
  assert.ok(!prompt.includes('(all /100)'), 'the block hands her a 1-100 scale to grade her gauges on again');
  assert.ok(!prompt.includes('Fewer words than usual'), 'a full battery bought a shape line it should not have');

  const spent = buildSystemPrompt(
    ctx, '', [], undefined, undefined, [], 'hey', undefined, affect({ social_battery: 20 }), COMPUTED,
  );
  assert.match(spent, /- One bubble this turn\. Say the one thing and stop\./);

  assert.ok(
    !prompt.includes('Your state has MOMENTUM'),
    'the momentum sentence is back — applyAffectDrift (persona/affectDrift.ts) enforces it now, so this is an instruction she cannot disobey',
  );
  // The two clock paragraphs are deleted at their source (persona/circadian.ts, persona/cycle.ts).
  assert.ok(!prompt.includes('- Your body-clock:'), 'the circadian texture is back in the prompt');
  assert.ok(!prompt.includes('- Your longer rhythm:'), 'the cycle texture is back in the prompt');
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
  // The band lines are imperatives now (persona/climate.ts BAND_LINES, Fable's sentences).
  assert.match(prompt, /- No runway at all with this person\. Open on the thing itself\./);
  assert.match(prompt, /- Say the hard thing first and do not soften it after\./);
  assert.match(prompt, /- A tangent or a callback is expected of you here\./);
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
 * persona has a ceiling already, but even at 84k it cannot tell this section growing back from any
 * other paragraph arriving: a sentence re-added here lands inside the +0.1% the persona line carries.
 *
 * 2,680, from 2,859 — the 179 characters of the momentum sentence. It was deliberately NOT the
 * 1,200 the task brief targeted: that estimate assumed this section's other paragraphs had already
 * moved out, and they had not.
 *
 * The Never-Send-a-Leaf rewrite: **2,431**, from 2,680, and not one paragraph deleted to get there.
 * Six body paragraphs went in and six came out, five of them re-authored and "**The `status` you
 * report.**" byte-identical across the old file, the spec's fence and the new one — what changed is
 * what they SAY. The block she is handed is described as instructions she obeys rather than a
 * temperature she interprets ("You do not interpret it; you obey it"), because that is what it is
 * now (persona/affectCompiler.ts); the list of what it contains names the compiled things — the one
 * feeling word and what it does to this reply, the bubble cap, the sleep line, the self-note —
 * instead of the body-clock and cycle paragraphs the compiler deleted at their source; the
 * standing-register paragraph drops "how much polite runway"; and the thread-offer paragraph is one
 * sentence pointing at the hooks section, because a thread is a hook and a hook lives on an idle
 * turn. The compiler commit itself measured 2,680 and left it there, which was the honest number at
 * the time: it deleted the per-turn BLOCK's prose (−937 of `PROMPT_BUDGET.weather`, ratcheted in the
 * same commit) and this section is Context.md's own half of the subject, which belonged to the
 * persona rewrite.
 *
 * Re-measured at the end of the phase and unchanged at 2,431, so the ceiling stands at +0.8% over
 * the measurement, inside the same 2% band promptBudget.test.ts holds every other line to. The three
 * pins this file holds are all still here and all still doing their job — the leak guard verbatim,
 * "where you are right now" naming the block, the contract pointer — and so is
 * promptPolicy.test.ts's adjacency pin (`epistemic_trigger` within 80 characters of the concede
 * sentence). Reaching the 1,200 the old brief wanted still means deciding which of these six
 * paragraphs the persona can lose, which is a phase of its own.
 */
const INNER_WEATHER_CEILING = 2_450;

test('the persona no longer claims her state has momentum — the drift engine enforces it', () => {
  const section = innerWeatherSection();
  assert.doesNotMatch(
    section, /Your state has momentum/i,
    'the momentum claim is back in the persona. applyAffectDrift (persona/affectDrift.ts) is what '
    + 'carries the state forward now, bounded by AFFECT_TURN_CAP and the two rolling windows — so '
    + 'this is prose telling her to do what she cannot help doing, in the most expensive 84k in the repo',
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

// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The affect compiler is where the machinery stops describing a mood and starts instructing from
// it. Everything it reads is arithmetic that already existed — the Willcox core behind the reported
// word, two gauges, two climate floor bands, the clock's slot — and everything it emits is a
// sentence a reply can obey. These tests pin all of it, plus the invariants the rest of the stack
// leans on:
//
//   • THE WHEEL IS THE VARIABLE. Each of the six cores maps to one imperative and one hook
//     permission, and the two halves of that row have to agree with each other.
//   • THE THRESHOLDS ARE NAMED, and pinned from BOTH sides of every boundary. A cut that slid by a
//     point is invisible otherwise, and these three decide how long a reply is and whether the extra
//     beat exists at all.
//   • PERMISSIONS COMBINE, never overwrite. The core, the candor floor and the playfulness floor
//     each close a kind; two different closures round DOWN to `none`, which is the safe direction.
//   • NOT ONE DIGIT reaches a rendered line. The gauges are the reason the lines say what they say
//     and they never appear in one — the same bargain the envelope's own shrink made (charter §6.4).
//   • PURE. No clock read, no store, no lane: the clock arrives as `ComputedState`, and a frozen
//     input survives a compile.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileAffect, renderAffectDirective, renderMoodLine, renderBrevityLine,
  moodOf, brevityOf, capFor, tightenHooks,
  CORE_DIRECTIVES, DEFAULT_MOOD, BREVITY_LINES, LATE_NIGHT_LINE,
  HOOK_MOOD_FLOOR, SOCIAL_BATTERY_MINIMAL, SOCIAL_BATTERY_TIGHT,
  type AffectDirective, type BrevityBand, type HookAllowance,
} from './affectCompiler.js';
import { coerceStatus, mergeStatus, type AffectGauges, type AffectStatus, type ComputedState } from './status.js';
import { computeCycle } from './cycle.js';
import { computeCircadian } from './circadian.js';
import { MOOD_CORES, WILLCOX_WHEEL, coreForLabel, type MoodCore } from './mood.js';
import { defaultClimate, DIALS, type DialKey, type RelationshipClimate } from './climate.js';
import { THREAD_MOOD_FLOOR } from './threads.js';

const T0 = Date.UTC(2026, 3, 1);

/** A clock that is neither of the two late slots — 16:00 is `afternoon_peak`. */
const COMPUTED: ComputedState = {
  cycle: computeCycle(T0, T0),
  circadian: computeCircadian(Date.UTC(2026, 3, 1, 16, 0, 0), 'UTC'),
};

const at = (hour: number): ComputedState => ({
  cycle: COMPUTED.cycle,
  circadian: computeCircadian(Date.UTC(2026, 3, 1, hour, 0, 0), 'UTC'),
});

/** A carried row: the emitted half through the real coercer, the gauges STATED. How a gauge reaches
 *  a value is affectDrift.test.ts's subject; what the compiler does with the value is this file's. */
function carried(label = 'hopeful', gauges: Partial<AffectGauges> = {}, meta = ''): AffectStatus {
  const emitted = coerceStatus({
    mood_label: label, mood_shift: 'steady', intent_mode: 'questioning',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: meta,
  })!;
  return {
    ...mergeStatus(emitted, COMPUTED, T0),
    mood_level: 70, anxiety: 40, warmth: 60, social_battery: 70, rapport: 40, patience: 60,
    ...gauges,
  };
}

/** One word from each core, so a test can name a core and get a row the chart really files there. */
const WORD_FOR: Record<MoodCore, string> = Object.fromEntries(
  MOOD_CORES.map(c => [c, WILLCOX_WHEEL[c].secondary[0]]),
) as Record<MoodCore, string>;

/** A climate with one dial pushed to a value, everything else at its default. */
function climateAt(over: Partial<Record<DialKey, number>>): RelationshipClimate {
  const base = defaultClimate();
  return { ...base, dials: { ...base.dials, ...over }, evalCount: 20 };
}

/** Every dial's floor band, from its own spec — `dflt - 4` clears the ±3 deadzone by one point. */
const belowBand = (key: DialKey) => climateAt({ [key]: DIALS.find(d => d.key === key)!.dflt - 4 });

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

// ══ 1. The wheel is the variable ═════════════════════════════════════════════

test('every core carries one imperative and the permission that sentence describes', () => {
  const expected: Record<MoodCore, HookAllowance> = {
    mad: 'all', sad: 'no_tangent', scared: 'no_judgment',
    joyful: 'all', powerful: 'all', peaceful: 'all',
  };
  for (const core of MOOD_CORES) {
    const row = CORE_DIRECTIVES[core];
    assert.equal(row.hooks, expected[core], `${core}: the permission the table hands the selector`);
    assert.ok(row.line.length > 0, `${core}: has a sentence`);
    assert.doesNotMatch(row.line, /\d/, `${core}: a number reached an imperative`);
    // The two halves of the row are two readings of one decision, so they have to agree: a sentence
    // that tells her "no judgment this turn" beside a permission that leaves judgment open is the
    // one bug a table with both in it exists to make visible.
    if (/no judgment/i.test(row.line)) assert.equal(row.hooks, 'no_judgment', `${core}: sentence says no judgment`);
    if (/no tangents/i.test(row.line)) assert.equal(row.hooks, 'no_tangent', `${core}: sentence says no tangents`);
  }
});

test('the carried WORD picks the core, and the core picks the line', () => {
  for (const core of MOOD_CORES) {
    const word = WORD_FOR[core];
    const d = compileAffect(carried(word), COMPUTED);
    assert.deepEqual(d.mood, { core, word }, `${word} files under ${core}`);
    assert.equal(renderMoodLine(d.mood), `- You are ${word} (${core}). ${CORE_DIRECTIVES[core].line}`);
  }
});

test('a stored row whose core disagrees with its word renders the pair that agrees', () => {
  // `mood_core` is derived on write (coreForLabel), but a row can be hand-edited or written by an
  // older schema. The chart is the authority: the word decides, every time.
  const row: AffectStatus = { ...carried('miserable'), mood_core: 'joyful' };
  assert.equal(coreForLabel('miserable'), 'sad');
  assert.equal(compileAffect(row, COMPUTED).mood.core, 'sad');
});

test('a word off the chart lands on the fallback core, and a blank one on the default mood', () => {
  // `normalizeMoodLabel` already rescues a garbage label at the door, so what reaches here is a real
  // word — but a row written by hand or by an older schema can carry anything.
  assert.equal(moodOf({ ...carried(), mood_label: 'zzzqqq' }).core, 'peaceful');
  assert.deepEqual(moodOf({ ...carried(), mood_label: '   ' }), DEFAULT_MOOD);
  assert.deepEqual(moodOf(undefined), DEFAULT_MOOD);
  assert.equal(coreForLabel(DEFAULT_MOOD.word), DEFAULT_MOOD.core, 'the default pair agrees with the chart');
});

// ══ 2. The three thresholds, from both sides ═════════════════════════════════

test('the social battery decides brevity and the bubble cap, at both cuts', () => {
  const band = (social_battery: number): BrevityBand => compileAffect(carried('hopeful', { social_battery }), COMPUTED).brevity;

  assert.equal(band(SOCIAL_BATTERY_MINIMAL - 1), 'minimal');
  assert.equal(band(SOCIAL_BATTERY_MINIMAL), 'tight');
  assert.equal(band(SOCIAL_BATTERY_TIGHT - 1), 'tight');
  assert.equal(band(SOCIAL_BATTERY_TIGHT), 'normal');
  assert.equal(band(100), 'normal');

  assert.equal(capFor('minimal'), 1);
  assert.equal(capFor('tight'), 2);
  assert.equal(capFor('normal'), 3);
  assert.equal(compileAffect(carried('hopeful', { social_battery: 10 }), COMPUTED).bubbleCap, 1);
  assert.equal(compileAffect(carried('hopeful', { social_battery: 45 }), COMPUTED).bubbleCap, 2);
  assert.equal(compileAffect(carried('hopeful', { social_battery: 80 }), COMPUTED).bubbleCap, 3);
});

test('a garbled stored level lands in a band instead of propagating a NaN', () => {
  const row = { ...carried(), social_battery: 'nonsense' as unknown as number };
  assert.equal(brevityOf(row), 'normal', 'an unreadable gauge reads as the middle, never as exhausted');
});

test('the mood floor closes every kind, from both sides, and mirrors the thread floor', () => {
  const hooks = (mood_level: number) => compileAffect(carried('hopeful', { mood_level }), COMPUTED).hooks;
  assert.equal(hooks(HOOK_MOOD_FLOOR - 1), 'none');
  assert.equal(hooks(HOOK_MOOD_FLOOR), 'all');
  assert.equal(hooks(1), 'none');
  assert.equal(hooks(100), 'all');
  // The two floors are one decision in two modules (see HOOK_MOOD_FLOOR's own comment): a valence
  // low enough to close the theme gate is low enough to close the extra beat, and two different
  // numbers would mean a turn too flat to notice a pattern but not too flat to roast someone.
  assert.equal(HOOK_MOOD_FLOOR, THREAD_MOOD_FLOOR);
});

test('the late slots are the two late ones, and nothing else', () => {
  const quiet = (hour: number) => compileAffect(carried(), at(hour)).lateNight;
  for (const hour of [0, 3, 4, 22, 23]) assert.equal(quiet(hour), true, `hour ${hour} is late`);
  for (const hour of [5, 8, 11, 13, 16, 19, 21]) assert.equal(quiet(hour), false, `hour ${hour} is not late`);
  // The slots themselves, so a renamed slot fails here rather than switching the line off forever.
  assert.equal(computeCircadian(Date.UTC(2026, 3, 1, 3), 'UTC').slot, 'dead_night');
  assert.equal(computeCircadian(Date.UTC(2026, 3, 1, 23), 'UTC').slot, 'pre_sleep');
});

// ══ 3. The climate floor bands ═══════════════════════════════════════════════

test('the candor floor closes judgment and the playfulness floor closes tangents', () => {
  assert.equal(compileAffect(carried(), COMPUTED, belowBand('candor')).hooks, 'no_judgment');
  assert.equal(compileAffect(carried(), COMPUTED, belowBand('playfulness')).hooks, 'no_tangent');
  // ease has no hook meaning at all — it is about runway, not about the extra beat.
  assert.equal(compileAffect(carried(), COMPUTED, belowBand('ease')).hooks, 'all');
  // …and a dial merely RAISED restricts nothing: only the floor band is a permission.
  assert.equal(compileAffect(carried(), COMPUTED, climateAt({ candor: 80 })).hooks, 'all');
  assert.equal(compileAffect(carried(), COMPUTED, climateAt({ playfulness: 60 })).hooks, 'all');
});

test('a dial inside the silent band restricts nothing, and neither does an absent climate', () => {
  const spec = DIALS.find(d => d.key === 'candor')!;
  assert.equal(compileAffect(carried(), COMPUTED, climateAt({ candor: spec.dflt - 3 })).hooks, 'all', 'the deadzone edge');
  assert.equal(compileAffect(carried(), COMPUTED, climateAt({ candor: spec.dflt - 4 })).hooks, 'no_judgment', 'one point past it');
  assert.equal(compileAffect(carried(), COMPUTED, defaultClimate()).hooks, 'all');
  assert.equal(compileAffect(carried(), COMPUTED, undefined).hooks, 'all');
});

// ══ 4. Permissions combine, never overwrite ══════════════════════════════════

test('tightenHooks takes the most restrictive of two, and two different bans round to none', () => {
  const all: HookAllowance[] = ['all', 'no_judgment', 'no_tangent', 'none'];
  for (const a of all) assert.equal(tightenHooks('all', a), a, `all + ${a}`);
  for (const a of all) assert.equal(tightenHooks(a, 'all'), a, `${a} + all`);
  for (const a of all) assert.equal(tightenHooks(a, a), a, `${a} is idempotent`);
  for (const a of all) assert.equal(tightenHooks(a, 'none'), 'none', `${a} + none`);
  assert.equal(tightenHooks('no_judgment', 'no_tangent'), 'none');
  assert.equal(tightenHooks('no_tangent', 'no_judgment'), 'none');
  // Commutative, which is what makes the ORDER of the floors in compileAffect not a decision.
  for (const a of all) for (const b of all) assert.equal(tightenHooks(a, b), tightenHooks(b, a), `${a} + ${b}`);
});

test('a core ban and a climate ban compose rather than replacing each other', () => {
  // scared already bans judgment; a playfulness floor bans the tangent → nothing is open.
  assert.equal(compileAffect(carried(WORD_FOR.scared), COMPUTED, belowBand('playfulness')).hooks, 'none');
  // The same ban twice is still that ban.
  assert.equal(compileAffect(carried(WORD_FOR.scared), COMPUTED, belowBand('candor')).hooks, 'no_judgment');
  assert.equal(compileAffect(carried(WORD_FOR.sad), COMPUTED, belowBand('playfulness')).hooks, 'no_tangent');
  // sad bans the tangent, candor bans the judgment → none.
  assert.equal(compileAffect(carried(WORD_FOR.sad), COMPUTED, belowBand('candor')).hooks, 'none');
  // …and the mood floor closes everything whatever the rest said.
  assert.equal(
    compileAffect(carried(WORD_FOR.mad, { mood_level: 10 }), COMPUTED, defaultClimate()).hooks, 'none',
  );
});

// ══ 5. The cold start ════════════════════════════════════════════════════════

test('no carried row compiles to the loosest reading, and the clock still applies', () => {
  const d = compileAffect(undefined, COMPUTED);
  assert.deepEqual(d, {
    mood: DEFAULT_MOOD, bubbleCap: 3, brevity: 'normal', hooks: 'all', lateNight: false,
  } satisfies AffectDirective);
  // A first message is not a tired one — but it can still be a late one, and it can still land in a
  // relationship that has moved. Neither of those is about HER.
  assert.equal(compileAffect(undefined, at(2)).lateNight, true);
  assert.equal(compileAffect(undefined, COMPUTED, belowBand('candor')).hooks, 'no_judgment');
});

// ══ 6. The rendered lines ════════════════════════════════════════════════════

test('the block renders in the prose order: shape, late, mood, self-note', () => {
  const last = carried('hopeful', { social_battery: 20 }, 'they are about to ask about thursday');
  const lines = renderAffectDirective(compileAffect(last, at(2)), last, at(2));
  assert.deepEqual(lines, [
    `- ${BREVITY_LINES.minimal}`,
    `- ${LATE_NIGHT_LINE}`,
    '- You are hopeful (powerful). A judgment lands flat and certain. Do not explain it.',
    '- Your read going into this message (from last turn): "they are about to ask about thursday"',
  ]);
});

test('the optional lines are absent rather than empty', () => {
  const last = carried('hopeful');                    // normal battery, no meta_prompt
  const lines = renderAffectDirective(compileAffect(last, COMPUTED), last, COMPUTED);
  assert.deepEqual(lines, ['- You are hopeful (powerful). A judgment lands flat and certain. Do not explain it.']);
  assert.deepEqual(renderBrevityLine('normal'), [], 'the default band costs the prompt nothing');
  assert.deepEqual(renderBrevityLine('tight'), [`- ${BREVITY_LINES.tight}`]);
  assert.deepEqual(renderBrevityLine('minimal'), [`- ${BREVITY_LINES.minimal}`]);
});

test('the cold start renders one line, and it is an instruction', () => {
  const lines = renderAffectDirective(compileAffect(undefined, COMPUTED), undefined, COMPUTED);
  assert.deepEqual(lines, [`- You are ${DEFAULT_MOOD.word} (${DEFAULT_MOOD.core}). ${CORE_DIRECTIVES[DEFAULT_MOOD.core].line}`]);
});

test('not one digit reaches a rendered line, in any branch', () => {
  for (const core of MOOD_CORES) {
    for (const battery of [10, 45, 90]) {
      for (const hour of [2, 16, 23]) {
        for (const climate of [undefined, defaultClimate(), belowBand('candor'), belowBand('playfulness')]) {
          const last = carried(WORD_FOR[core], { social_battery: battery }, 'a note with no numbers in it');
          const computed = at(hour);
          for (const line of renderAffectDirective(compileAffect(last, computed, climate), last, computed, climate)) {
            assert.doesNotMatch(line, /\d/, `${core} / battery ${battery} / hour ${hour}: ${line}`);
          }
        }
      }
    }
  }
});

test("the self-note is quoted verbatim — it is the only line that is hers", () => {
  const note = 'they will push on the number again; hold it';
  const last = carried('hopeful', {}, note);
  const lines = renderAffectDirective(compileAffect(last, COMPUTED), last, COMPUTED);
  assert.ok(lines.includes(`- Your read going into this message (from last turn): "${note}"`));
});

// ══ 7. Purity ════════════════════════════════════════════════════════════════

test('the compile is pure: frozen inputs survive it and the same inputs give the same answer', () => {
  const last = deepFreeze(carried('drained', { social_battery: 30, mood_level: 20 }));
  const computed = deepFreeze(at(23));
  const climate = deepFreeze(belowBand('playfulness'));
  const a = compileAffect(last, computed, climate);
  const b = compileAffect(last, computed, climate);
  assert.deepEqual(a, b);
  assert.deepEqual(a, {
    mood: { core: 'sad', word: 'drained' }, bubbleCap: 1, brevity: 'minimal', hooks: 'none', lateNight: true,
  } satisfies AffectDirective);
});

// The AFFECT COMPILER: where the hidden machinery stops DESCRIBING a mood and starts issuing
// instructions. Everything this file owns used to be prose — a paragraph of body-clock texture, a
// paragraph of cycle texture, a five-band mood essay, a clause of gauge words, a trajectory line —
// handed to the model on every single turn with no rule in it, on the theory that a model reading
// "Fe senses a small distance it cannot place" would arrive at the right register by itself. What it
// actually bought was tone: eighteen hundred characters of adjectives about a person who then
// answered the question exactly the same way.
//
// So the machinery stays and the prose goes. The gauges, the Willcox core and the standing register
// COMPILE, here, into at most four imperative lines: how sharp (the core's own sentence), how short
// (the social battery), whether the beat is open at all (the mood floor, the core and the climate
// floors), and whether it is late where they are. Everything above is arithmetic the model never
// sees; everything below is a sentence it can obey.
//
// THE WHEEL IS THE VARIABLE. `mood_label` is the one thing the model still reports about how it
// feels, `coreForLabel` (mood.ts) is what files that word under one of six cores, and CORE_DIRECTIVES
// is what each core CHANGES about the reply. That is the whole loop: she says a true word, the chart
// places it, and the placement is an instruction rather than an adjective. A number that used to be
// printed beside the word ("hopeful (powerful, 72/100)") is gone for the reason the envelope's own
// numbers went (charter §6.4): a number printed beside a state is a number to optimize.
//
// PURE by construction, like every engine in this stack: no DB, no LLM, no clock read. The clock
// arrives as `ComputedState`, the register as `RelationshipClimate`, the carried row as the last
// `AffectStatus`, and the same three inputs always compile to the same directive.
//
// IMPORT DIRECTION, and it has to stay this way: status.ts imports this file BY VALUE, so everything
// this file takes from status.ts is `import type` and erased at compile time — the same edge, and the
// same argument, as affectDrift.ts's header states for itself. mood.ts and climate.ts are leaves, so
// those two are ordinary value imports and nothing can load back through them.

import { coreForLabel, type MoodCore } from './mood.js';
import { bandForDial, clampToSpec, type RelationshipClimate } from './climate.js';
import type { CircadianSlot } from './circadian.js';
import type { AffectStatus, ComputedState } from './status.js';

/** How many words she has this turn, as a band. `normal` renders NO line at all — the default
 *  costs the prompt nothing, which is the same bargain the climate deadzone makes. */
export type BrevityBand = 'normal' | 'tight' | 'minimal';

/** Which hook kinds this turn's mood and register leave open. Structurally the same union as
 *  `HookAllowance` in hooks.ts, which declares its own copy on purpose (it is a leaf and imports
 *  nothing); the selector consumes this value through that. */
export type HookAllowance = 'all' | 'no_judgment' | 'no_tangent' | 'none';

/** This turn's compiled affect, as instructions rather than texture. Every field is read by code —
 *  `hooks` and `sleepQuiet` by the rhythm engine (hooks.ts), `bubbleCap`/`brevity` by the renderer
 *  and the quiet guard, `mood` by the one line that still names how she feels. */
export interface AffectDirective {
  mood: { core: MoodCore; word: string };
  bubbleCap: 1 | 2 | 3;
  brevity: BrevityBand;
  hooks: HookAllowance;
  sleepQuiet: boolean;
}

/**
 * The six Willcox cores → what each one CHANGES about the reply, in one imperative sentence, plus
 * the hook kinds it leaves open. The sentence and the permission are two readings of the same
 * decision and they live on the same row so they cannot drift apart: "No judgment this turn; a
 * callback or nothing" and `hooks: 'no_judgment'` have to agree, and a table with both in it is the
 * only arrangement where a reviewer can see that they do.
 *
 * The sentences are Fable's, pasted byte-for-byte from the staging prose (policy-strings.md,
 * CORE_DIRECTIVES). Nothing here is a word list: the three hook words appear because they are the
 * three kinds the engine actually has, not because any code matches her reply against them.
 */
export const CORE_DIRECTIVES: Record<MoodCore, { line: string; hooks: Exclude<HookAllowance, 'none'> }> = {
  mad: {
    line: 'Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are.',
    hooks: 'all',
  },
  sad: {
    line: 'Fewer words. No tangents. Answer, then stop.',
    hooks: 'no_tangent',
  },
  scared: {
    line: 'Flat and careful. No judgment this turn; a callback or nothing.',
    hooks: 'no_judgment',
  },
  joyful: {
    line: 'A tangent is allowed. Still deadpan, still short.',
    hooks: 'all',
  },
  powerful: {
    line: 'A judgment lands flat and certain. Do not explain it.',
    hooks: 'all',
  },
  peaceful: {
    line: 'Even and flat. Nothing extra.',
    hooks: 'all',
  },
};

/** Social battery below this and the reply is ONE bubble. The gauge the wheel does not carry: a core
 *  says what kind of sharp she is, and nothing about whether she has the words for three sends. */
export const SOCIAL_BATTERY_MINIMAL = 35;

/** …and below this, two bubbles and fewer words. Both cuts are on the same gauge on purpose — a
 *  second gauge here would be a second thing to reason about for a line that says "be shorter". */
export const SOCIAL_BATTERY_TIGHT = 50;

/** Mood level below this and NO hook is open, whatever the core allows. It MIRRORS
 *  `THREAD_MOOD_FLOOR` (persona/threads.ts) at the same 35, and deliberately: a valence low enough
 *  to close the theme gate is low enough to close the extra beat, and two different floors would
 *  mean a turn where she is too flat to notice a pattern in someone but not too flat to roast them.
 *  Kept as its own constant rather than imported because threads.ts is a much heavier module and
 *  this is a leaf — the two numbers are pinned together by affectCompiler.test.ts instead. */
export const HOOK_MOOD_FLOOR = 35;

/** The mood a turn with no carried row compiles to. `peaceful`/`content` because it is the same
 *  fallback the rest of the wheel already uses for a word it cannot place (mood.ts coreForLabel),
 *  and because "even and flat, nothing extra" is the honest instruction for a first message: she has
 *  no read yet, so there is nothing for the register to be built out of. */
export const DEFAULT_MOOD: { core: MoodCore; word: string } = { core: 'peaceful', word: 'content' };

/** The two slots where the right reply is that they should sleep. Typed against the slot union so a
 *  renamed slot fails here rather than silently switching the sleep line off forever. */
const SLEEP_SLOTS: readonly CircadianSlot[] = ['dead_night', 'pre_sleep'];

/** Every gauge is a 1-100 integer by TYPE, and by the time a row has been through `affectGaugesFrom`
 *  it is one in fact too — but this reads rows off disk and out of hand-built fixtures, so a garbled
 *  level must land in a band rather than propagate a NaN into a comparison whose false branch is the
 *  loosest one. Reuses climate.ts's clamp instead of growing a second copy of the same arithmetic. */
const GAUGE_RANGE = { floor: 1, ceiling: 100 };
function level(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? clampToSpec(n, GAUGE_RANGE) : 50;
}

/**
 * The most restrictive of two permissions.
 *
 * The lattice is coarse on purpose — the union names three kinds and "none", and has no word for
 * "only a callback". So two DIFFERENT single-kind bans (a scared core with a playfulness floor, say)
 * close two of the three kinds and round to `none` rather than to whichever ban was applied last.
 * That is the safe direction and it is the one the manifesto already takes everywhere else: a turn
 * where two separate pressures have each closed a kind is a turn to say the plain thing.
 */
export function tightenHooks(a: HookAllowance, b: HookAllowance): HookAllowance {
  if (a === b) return a;
  if (a === 'all') return b;
  if (b === 'all') return a;
  return 'none';
}

/** The carried mood as the wheel files it: the WORD she reported, under the core the chart puts it
 *  in. `coreForLabel` rather than the row's own `mood_core` so a stored row whose two halves
 *  disagree renders the pair that agrees. */
export function moodOf(last: AffectStatus | undefined): { core: MoodCore; word: string } {
  const word = (last?.mood_label ?? '').trim();
  if (!word) return DEFAULT_MOOD;
  return { core: coreForLabel(word), word };
}

/** How short this turn is, from the one gauge that answers it. No carried row → `normal`: a first
 *  message is not a tired one. */
export function brevityOf(last: AffectStatus | undefined): BrevityBand {
  if (!last) return 'normal';
  const battery = level(last.social_battery);
  if (battery < SOCIAL_BATTERY_MINIMAL) return 'minimal';
  if (battery < SOCIAL_BATTERY_TIGHT) return 'tight';
  return 'normal';
}

/** The bubble ceiling each band carries. Three is the bubble law's own maximum, so `normal` is not a
 *  cap at all — it is the absence of one, which is why `normal` renders no line. */
export function capFor(brevity: BrevityBand): 1 | 2 | 3 {
  return brevity === 'minimal' ? 1 : brevity === 'tight' ? 2 : 3;
}

/**
 * The whole compile. Four inputs' worth of machinery — the carried row's two gauges and its feeling
 * word, the clock's slot, the standing register's two floor bands — and one small struct out.
 *
 * The floors are read in the order they are argued, and the order does not matter because
 * `tightenHooks` is commutative: the core's own permission, then candor's floor band (directness has
 * been landing badly → no judgment), then playfulness's (lightness has not been landing → no
 * tangent), then the mood floor, which closes everything. What matters is that they COMBINE rather
 * than overwrite: a scared core under a playfulness floor must not come out looser than either.
 *
 * With no carried row this is the cold start, and it is deliberately the loosest reading: the
 * default mood, three bubbles, ordinary length, every kind open. There is no evidence yet for any
 * restriction, and inventing one from a default would make her first message to someone the tired
 * version of her. The clock and the register still apply — neither of those is about her.
 */
export function compileAffect(
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
): AffectDirective {
  const mood = moodOf(last);
  const brevity = brevityOf(last);

  let hooks: HookAllowance = CORE_DIRECTIVES[mood.core].hooks;
  if (bandForDial(climate, 'candor') === 'below') hooks = tightenHooks(hooks, 'no_judgment');
  if (bandForDial(climate, 'playfulness') === 'below') hooks = tightenHooks(hooks, 'no_tangent');
  if (last && level(last.mood_level) < HOOK_MOOD_FLOOR) hooks = tightenHooks(hooks, 'none');

  return {
    mood,
    bubbleCap: capFor(brevity),
    brevity,
    hooks,
    sleepQuiet: SLEEP_SLOTS.includes(computed.circadian.slot),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────
// Fable's lines, pasted byte-for-byte from policy-strings.md. Bullets are added at render time (the
// same arrangement climate.ts's band lines have), so a line is stored as the sentence it is. NO
// DIGIT appears anywhere below, in any branch: the block the model reads immediately before it
// grades itself is the last place a number should be sitting.

/** One line, by band. `normal` is absent rather than empty — a band with nothing to say renders
 *  nothing, which is the house rule for every optional section. */
export const BREVITY_LINES: Record<Exclude<BrevityBand, 'normal'>, string> = {
  minimal: 'One bubble this turn. Say the one thing and stop.',
  tight: 'Fewer words than usual. Two bubbles at most.',
};

/** The sleep line. A PREFERENCE about an idle turn, not a gag: the hook engine's `sleepQuiet` says
 *  the same thing to the selector, and neither of them drops a reply. */
export const SLEEP_QUIET_LINE =
  'It is late where they are. If this turn is idle, the right reply is that they should sleep.';

/** `- You are <word> (<core>). <the core's imperative>` — the one line that still names a feeling,
 *  and it names it in order to hand over an instruction. */
export function renderMoodLine(mood: { core: MoodCore; word: string }): string {
  return `- You are ${mood.word} (${mood.core}). ${CORE_DIRECTIVES[mood.core].line}`;
}

/** Zero or one line. Returns an array so callers splice it rather than filtering a null. */
export function renderBrevityLine(brevity: BrevityBand): string[] {
  return brevity === 'normal' ? [] : [`- ${BREVITY_LINES[brevity]}`];
}

/**
 * The compiled block, between the weather header and the climate lines: the brevity line when there
 * is one, the sleep line when it is late, the mood line and its imperative, and last turn's
 * note-to-self. At most four lines, every one of them an instruction.
 *
 * Order is the prose's (policy-strings.md, AFFECT DIRECTIVE LINES): the two lines about the SHAPE of
 * the reply come before the line about the mood, because the shape is the thing she has to obey
 * whatever the mood argues for, and the self-note comes last because it is the only line that is
 * hers rather than the machine's.
 *
 * `computed` and `climate` are taken and not read. Every line here comes off the DIRECTIVE, which is
 * exactly the point — the compiler decides and the renderer only writes it down — and taking the
 * compiler's own inputs keeps the two calls one argument list at the one call site, so a rendering
 * rule that ever needs the clock or the register cannot be added without the compiler having seen it
 * first. (The same shape as `selectHook`'s unused `now`, hooks.ts, and for the same reason.)
 */
export function renderAffectDirective(
  directive: AffectDirective,
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
): string[] {
  void computed;
  void climate;
  const lines: string[] = [];
  lines.push(...renderBrevityLine(directive.brevity));
  if (directive.sleepQuiet) lines.push(`- ${SLEEP_QUIET_LINE}`);
  lines.push(renderMoodLine(directive.mood));
  // The self-recursive loop, unchanged and byte-identical: last turn's private note, quoted back.
  if (last?.meta_prompt) lines.push(`- Your read going into this message (from last turn): "${last.meta_prompt}"`);
  return lines;
}

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
// floors), and whether it is late where they are — which is a REGISTER and nothing else: the hour
// lowers the volume of a reply and never picks its content. Everything above is arithmetic the model
// never sees; everything below is a sentence it can obey.
//
// NOT EVERY COMPILED FIELD IS A SENTENCE, and since the share turn landed two of them are not.
// `question` (may this reply carry the one follow-up question) and `heavy` (they brought weight)
// are CEILINGS the rhythm engine reads; the renderer never writes either one down. What reaches the
// model is a presence and an absence: whether the share section carries its question line, and how
// short that section's list of open kinds is. A rendered line announcing that a question is
// available would be read as an instruction to ask one, which is the exact failure this shape
// corrects — the machinery sets the ceiling and she judges inside it.
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
import type { AffectStatus, ComputedState, IntentMode } from './status.js';

/** How many words she has this turn, as a band. `normal` renders NO line at all — the default
 *  costs the prompt nothing, which is the same bargain the climate deadzone makes. */
export type BrevityBand = 'normal' | 'tight' | 'minimal';

/** Which hook kinds this turn's mood and register leave open. Structurally the same union as
 *  `HookAllowance` in hooks.ts, which declares its own copy on purpose (it is a leaf and imports
 *  nothing); the selector consumes this value through that. */
export type HookAllowance = 'all' | 'no_judgment' | 'no_tangent' | 'none';

/** Whether the one question of hers that is a move and not a probe is available at all this turn.
 *  A CEILING, never an instruction: `open` means the share turn's selector MAY leave that kind in
 *  the allowed set and she decides inside it; `closed` means the reply stays statement-shaped
 *  whatever she judges. Declared as its own union for the reason `HookAllowance` is one — the
 *  rhythm engine reads it through a structural subset and never learns how it was decided. */
export type QuestionGate = 'open' | 'closed';

/** The carried read of what THEY were doing, as the question gate and the weight flag consume it:
 *  last turn's `intent_mode`, and only while it is still fresh enough to describe this turn. The
 *  freshness read is the CALLER's (the same window threads.ts takes, `AFFECT_FRESH_MS`), because a
 *  pure compiler has no clock — a stale row arrives here as no row at all. */
export interface CarriedIntent {
  intentMode: IntentMode;
}

/** This turn's compiled affect, as instructions rather than texture. Every field is read by code —
 *  `hooks`, `question`, `heavy` and `lateNight` by the rhythm engine (hooks.ts),
 *  `bubbleCap`/`brevity` by the renderer and the quiet guard, `mood` by the one line that still
 *  names how she feels. */
export interface AffectDirective {
  mood: { core: MoodCore; word: string };
  bubbleCap: 1 | 2 | 3;
  brevity: BrevityBand;
  hooks: HookAllowance;
  /** Whether a share turn may carry the follow-up question. The one compiled field that reaches the
   *  prompt as a PRESENCE rather than a sentence: nothing here renders a weather line about it, and
   *  the model only ever sees whether the share section's question line is there. */
  question: QuestionGate;
  /** There is real weight in what they handed her (the carried read says venting or overwhelmed).
   *  Narrows what a share turn may do with it — analysis is not company — and keeps the climate
   *  span from announcing that a tangent is welcome on the turn someone let the tank out. */
  heavy: boolean;
  /** It is late where they are. A register flag: smaller and quieter, nothing more. It closes no
   *  hook kind, shuts no sampler and forces no mode — see hooks.ts `selectHook`. */
  lateNight: boolean;
}

/**
 * The six Willcox cores → what each one CHANGES about the reply, in one imperative sentence, plus
 * the hook kinds it leaves open and whether it leaves the follow-up question open. The sentence and
 * the hook permission are two readings of the same decision and they live on the same row so they
 * cannot drift apart: "No judgment this turn; a callback or nothing" and `hooks: 'no_judgment'` have
 * to agree, and a table with both in it is the only arrangement where a reviewer can see that they
 * do.
 *
 * The `question` column is the one cell on the row that is NOT a reading of the sentence, and the
 * sentences are unchanged by its arrival: no imperative here mentions a question, because the
 * ceiling reaches the model as a presence (whether the share section renders its question line) and
 * never as a per-core instruction. It splits the wheel where the wheel already splits itself —
 * joyful, powerful and peaceful open, mad, sad and scared closed — which is `CORE_VALENCE_BAND`'s
 * own division of the chart, pinned that way in the test rather than as a hand list. The reason is
 * the only one that matters here: a question spends THEIR effort, so the turns where she is sharp,
 * flat or careful are the turns to state the guess and take what they said.
 *
 * The sentences are Fable's, pasted byte-for-byte from the staging prose (policy-strings.md,
 * CORE_DIRECTIVES). Nothing here is a word list: the three hook words appear because they are the
 * three kinds the engine actually has, not because any code matches her reply against them.
 */
export const CORE_DIRECTIVES: Record<
  MoodCore,
  { line: string; hooks: Exclude<HookAllowance, 'none'>; question: QuestionGate }
> = {
  mad: {
    line: 'Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are.',
    hooks: 'all',
    question: 'closed',
  },
  sad: {
    line: 'Fewer words. No tangents. Answer, then stop.',
    hooks: 'no_tangent',
    question: 'closed',
  },
  scared: {
    line: 'Flat and careful. No judgment this turn; a callback or nothing.',
    hooks: 'no_judgment',
    question: 'closed',
  },
  joyful: {
    line: 'A tangent is allowed. Still deadpan, still short.',
    hooks: 'all',
    question: 'open',
  },
  powerful: {
    line: 'A judgment lands flat and certain. Do not explain it.',
    hooks: 'all',
    question: 'open',
  },
  peaceful: {
    line: 'Even and flat. Nothing extra.',
    hooks: 'all',
    question: 'open',
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

/** Where `rapport` sits when nothing has happened yet. It MIRRORS the gauge's own default
 *  (`GAUGE_SPECS` rapport, affectDrift.ts) and has to: the question gate is a band around the
 *  RESTING value, so a gauge that starts somewhere else would make a first conversation begin
 *  inside or outside the band by accident. Kept as its own constant rather than imported for the
 *  reason `HOOK_MOOD_FLOOR` is — this is a leaf and affectDrift is the heavy module — and pinned to
 *  the spec by affectCompiler.test.ts instead. */
export const RAPPORT_RESTING = 40;

/** How far below resting closeness has to fall before the question closes. Chosen against the
 *  gauge's own asymmetric step (rapport moves up a point at a time and down two): two follow-ups
 *  pushed back close the question, and one taken reopens it. That is the evidence rule the whole
 *  band exists for — she stops asking when asking has been landing badly, and she is allowed to
 *  start again the first time it lands. */
export const RAPPORT_QUESTION_BAND = 3;

/** Carried reads that close the question whatever the wheel says. Not a weight list: each of these
 *  is a turn where a question of hers takes the reply somewhere it must not go — someone drowning
 *  is not being asked for detail, someone dodging is not asked again, a bit is not interrogated,
 *  and a person already lost gets an answer rather than another question. */
export const QUESTION_CLOSED_MODES: readonly IntentMode[] = ['overwhelmed', 'deflecting', 'joking', 'confused'];

/** Carried reads that make a share HEAVY. `overwhelmed` sits in both sets, which is the honest
 *  reading: the turn is weighty AND no question opens on it. */
export const HEAVY_MODES: readonly IntentMode[] = ['venting', 'overwhelmed'];

/** The mood a turn with no carried row compiles to. `peaceful`/`content` because it is the same
 *  fallback the rest of the wheel already uses for a word it cannot place (mood.ts coreForLabel),
 *  and because "even and flat, nothing extra" is the honest instruction for a first message: she has
 *  no read yet, so there is nothing for the register to be built out of. */
export const DEFAULT_MOOD: { core: MoodCore; word: string } = { core: 'peaceful', word: 'content' };

/** The two slots where the reply gets smaller, and nothing more than that. Typed against the slot
 *  union so a renamed slot fails here rather than silently switching the late line off forever. */
const LATE_SLOTS: readonly CircadianSlot[] = ['dead_night', 'pre_sleep'];

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
 * The CEILING on her one question, from the four things that can say no.
 *
 * The wheel goes first because it is the cheapest and the most decisive: three cores close the
 * question outright. Then the carried read of what they were doing, then closeness, then the two
 * gauges that already decide whether an extra beat exists at all — the same social-battery cut that
 * makes a reply one bubble and the same mood floor that closes every hook kind. Nothing here is a
 * new floor: a question is the most expensive move she has, so it answers to every floor the
 * cheaper moves answer to, plus one of its own.
 *
 * ONE-WAY, and that is the point: every branch below can only close. There is no arrangement of
 * gauges that opens a question a core shut, because the ceiling is hers to work inside and never a
 * reason to ask — the judgment of whether this particular share wants a question stays with her.
 *
 * Cold start is OPEN, for the reason the whole cold start is the loosest reading: with no carried
 * row there is no evidence of anything landing badly, and a first conversation that cannot ask
 * anything is the tired version of her.
 */
export function compileQuestionGate(
  last: AffectStatus | undefined,
  core: MoodCore,
  carried?: CarriedIntent,
): QuestionGate {
  if (CORE_DIRECTIVES[core].question === 'closed') return 'closed';
  if (carried && QUESTION_CLOSED_MODES.includes(carried.intentMode)) return 'closed';
  if (!last) return 'open';
  if (level(last.rapport) < RAPPORT_RESTING - RAPPORT_QUESTION_BAND) return 'closed';
  if (level(last.social_battery) < SOCIAL_BATTERY_MINIMAL) return 'closed';
  if (level(last.mood_level) < HOOK_MOOD_FLOOR) return 'closed';
  return 'open';
}

/** Whether there is real weight in what they handed her. The carried read is the only evidence the
 *  compiler has for it and the only one it should have: weight is something THEY brought, so it is
 *  read off what they were doing and never off how she feels about it. */
export function compileHeavy(carried?: CarriedIntent): boolean {
  return !!carried && HEAVY_MODES.includes(carried.intentMode);
}

/**
 * The whole compile. Five inputs' worth of machinery — the carried row's gauges and its feeling
 * word, the clock's slot, the standing register's two floor bands, last turn's read of what they
 * were doing — and one small struct out.
 *
 * The floors are read in the order they are argued, and the order does not matter because
 * `tightenHooks` is commutative: the core's own permission, then candor's floor band (directness has
 * been landing badly → no judgment), then playfulness's (lightness has not been landing → no
 * tangent), then the mood floor, which closes everything. What matters is that they COMBINE rather
 * than overwrite: a scared core under a playfulness floor must not come out looser than either.
 *
 * With no carried row this is the cold start, and it is deliberately the loosest reading: the
 * default mood, three bubbles, ordinary length, every kind open, the question open. There is no
 * evidence yet for any restriction, and inventing one from a default would make her first message to
 * someone the tired version of her. The clock and the register still apply — neither of those is
 * about her.
 *
 * `carried` is OPTIONAL and absent means "no read", not "a neutral read": the freshness window lives
 * with the caller (see `CarriedIntent`), so a row too old to describe this turn arrives as nothing
 * and restricts nothing — which is the same direction the missing row takes.
 */
export function compileAffect(
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
  carried?: CarriedIntent,
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
    question: compileQuestionGate(last, mood.core, carried),
    heavy: compileHeavy(carried),
    lateNight: LATE_SLOTS.includes(computed.circadian.slot),
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

/** The late-night line. REGISTER, not content: it says how big the reply is and never what is in
 *  it. The hook engine reads the same flag (`lateNight`) and does the same thing with it — lowers
 *  the volume, closes nothing. */
export const LATE_NIGHT_LINE =
  'It is late where they are. Smaller and quieter than daytime: fewer words and nothing heavy.';

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
 * is one, the late-night line when it is late, the mood line and its imperative, and last turn's
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
  if (directive.lateNight) lines.push(`- ${LATE_NIGHT_LINE}`);
  lines.push(renderMoodLine(directive.mood));
  // The self-recursive loop, unchanged and byte-identical: last turn's private note, quoted back.
  if (last?.meta_prompt) lines.push(`- Your read going into this message (from last turn): "${last.meta_prompt}"`);
  return lines;
}

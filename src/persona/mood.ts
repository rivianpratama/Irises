// Irises's mood, modelled on the Gloria Willcox "feelings wheel": six core emotions, each
// branching into secondary/tertiary words. Mood is a GENUINE affective state here — deliberately
// SEPARATE from `confidence_level` (which is the analyst's certainty score, not a feeling). The
// model reports one honest word; this module owns the taxonomy it picks from and the chart that
// files that word under a core (`coreForLabel`). None of it is ever spoken to the user.
//
// THE TAXONOMY IS ALL THAT LIVES HERE NOW. This file used to also carry `moodTexture`, five bands
// of prose describing how a valence level feels from the inside ("Fe senses a small distance it
// cannot place"), injected on every turn. The wheel is the VARIABLE, not the essay: the word gets
// filed under a core and the core is what CHANGES about the reply, which is a table of six
// imperatives in persona/affectCompiler.ts (CORE_DIRECTIVES) rather than a paragraph of adjectives
// here. Nothing in the prompt describes a mood any more; one line instructs from it.

export type MoodCore = 'mad' | 'scared' | 'joyful' | 'powerful' | 'peaceful' | 'sad';

export const MOOD_CORES: readonly MoodCore[] = ['mad', 'scared', 'joyful', 'powerful', 'peaceful', 'sad'];

/** A core's two outer rings on the wheel: the middle ring (secondary) and the outer ring (tertiary). */
export interface WheelBranch { secondary: string[]; tertiary: string[]; }

/**
 * The COMPLETE Gloria Willcox feeling wheel — every one of the 72 words, in its exact ring. Each
 * core has 6 secondary (middle-ring) and 6 tertiary (outer-ring) feelings. The model reports a core
 * plus any one of these words as `mood_label` (all internal, never spoken to the user).
 */
export const WILLCOX_WHEEL: Record<MoodCore, WheelBranch> = {
  mad: {
    secondary: ['hurt', 'hostile', 'angry', 'rage', 'hateful', 'critical'],
    tertiary: ['jealous', 'selfish', 'frustrated', 'furious', 'irritated', 'skeptical'],
  },
  scared: {
    secondary: ['rejected', 'confused', 'helpless', 'submissive', 'insecure', 'anxious'],
    tertiary: ['bewildered', 'discouraged', 'insignificant', 'weak', 'foolish', 'embarrassed'],
  },
  joyful: {
    secondary: ['excited', 'sexy', 'energetic', 'playful', 'creative', 'aware'],
    tertiary: ['daring', 'fascinating', 'stimulating', 'amused', 'extravagant', 'delightful'],
  },
  powerful: {
    secondary: ['proud', 'respected', 'appreciated', 'important', 'faithful', 'hopeful'],
    tertiary: ['cheerful', 'satisfied', 'valuable', 'worthwhile', 'intelligent', 'confident'],
  },
  peaceful: {
    secondary: ['content', 'thoughtful', 'intimate', 'loving', 'trusting', 'nurturing'],
    tertiary: ['thankful', 'sentimental', 'serene', 'responsive', 'relaxed', 'pensive'],
  },
  sad: {
    secondary: ['guilty', 'ashamed', 'depressed', 'lonely', 'bored', 'sleepy'],
    tertiary: ['apathetic', 'inferior', 'inadequate', 'miserable', 'stupid', 'bashful'],
  },
};

/** All 12 canonical wheel words (secondary + tertiary) under a core. */
export function wheelWords(core: MoodCore): string[] {
  return [...WILLCOX_WHEEL[core].secondary, ...WILLCOX_WHEEL[core].tertiary];
}

/**
 * Irises's own extra shades ON TOP of the canonical wheel — variants and near-synonyms that aren't
 * literally on Willcox's chart but read true for her (kept deliberately, alongside the full wheel).
 * Folded into the recognized-label set so she may report any of them too.
 */
export const EXTENDED_WORDS: Record<MoodCore, string[]> = {
  mad: ['snapped'],
  scared: ['overwhelmed'],
  joyful: ['cheerful', 'delighted', 'stimulated', 'curious', 'fascinated'],
  powerful: [],
  peaceful: ['tender'],
  sad: ['drained', 'withdrawn', 'tired'],
};

/** The FULL vocabulary under a core: the canonical wheel words plus Irises's extra shades. */
export function feelingWords(core: MoodCore): string[] {
  return [...wheelWords(core), ...EXTENDED_WORDS[core]];
}

/** Positive-valence cores sit high on the 1-100 level; negative cores sit low. Guidance, not a clamp. */
export const CORE_VALENCE_BAND: Record<MoodCore, [number, number]> = {
  joyful: [70, 100],
  powerful: [65, 95],
  peaceful: [55, 85],
  mad: [20, 45],
  scared: [12, 42],
  sad: [1, 35],
};

export function isMoodCore(v: unknown): v is MoodCore {
  return typeof v === 'string' && (MOOD_CORES as readonly string[]).includes(v);
}

/** Every recognized feeling word across all cores — the full wheel PLUS the extra shades. */
const ALL_WHEEL_WORDS: ReadonlySet<string> = new Set(MOOD_CORES.flatMap(feelingWords));

/**
 * Keep the model's label when it's a real feeling word ANYWHERE on the wheel (the core is the
 * bucket, the label is descriptive colour — a word filed under a neighbouring core is still a valid
 * feeling), else fall back to the declared core's first secondary. Guards against garbage labels.
 */
export function normalizeMoodLabel(core: MoodCore, label: unknown): string {
  if (typeof label === 'string') {
    const l = label.trim().toLowerCase();
    if (ALL_WHEEL_WORDS.has(l)) return l;
  }
  return WILLCOX_WHEEL[core].secondary[0];
}

/**
 * Word → core: the INVERSE of the wheel, built from the same two tables so it can never disagree
 * with them. The canonical wheel is laid down last, so a word that appears both on Willcox's chart
 * and in `EXTENDED_WORDS` files under its chart core ('cheerful' is the only such word today:
 * `powerful` tertiary and a `joyful` extra) and every one of the 72 wheel words round-trips.
 */
const CORE_BY_WORD: ReadonlyMap<string, MoodCore> = new Map<string, MoodCore>([
  ...MOOD_CORES.flatMap(c => EXTENDED_WORDS[c].map(w => [w, c] as [string, MoodCore])),
  ...MOOD_CORES.flatMap(c => wheelWords(c).map(w => [w, c] as [string, MoodCore])),
]);

/**
 * Which core a feeling word belongs to. This is what makes `mood_core` code's answer rather than a
 * second thing the model has to report (and can contradict its own label with): the model says one
 * honest word, and the core — and through it the valence band — follows from the chart.
 *
 * An unrecognized word gives `'peaceful'`, the same fallback the rest of the module already uses
 * for a label it cannot place. Non-strings cannot throw: this reads a field off a model envelope.
 */
export function coreForLabel(label: string): MoodCore {
  if (typeof label === 'string') {
    const hit = CORE_BY_WORD.get(label.trim().toLowerCase());
    if (hit) return hit;
  }
  return 'peaceful';
}

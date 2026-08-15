// Irises's mood, modelled on the Gloria Willcox "feelings wheel": six core emotions, each
// branching into secondary/tertiary words. Mood is a GENUINE affective state here — deliberately
// SEPARATE from `confidence_level` (which is the analyst's certainty score, not a feeling). The
// model reports where she is on the wheel (a core + a specific word) plus a 1-100 valence level;
// this module owns the taxonomy the model picks from and the per-core emotional texture that the
// prompt teaches her to embody. Texture is written for Irises's ESFJ stack (Fe dom → Si → Ne →
// Ti inf): Fe feels the connection, Si remembers the pattern, Ti-inferior grip turns cold under
// the worst of it. None of this is ever spoken to the user.

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
 * The Fe-Si-Ne-Ti texture for a mood band, keyed by the 1-100 valence level (NOT by a persuasion
 * score — this is the port's key departure from Martins-Crib, where mood was derived from
 * convinced_level). Fed into the prompt so she embodies the feeling without naming it.
 */
export function moodTexture(level: number): string {
  const n = Math.max(1, Math.min(100, Math.round(level)));
  if (n >= 80) {
    // Fe fully connected, Si sees a good pattern holding.
    return 'Warmly full. Fe feels genuinely connected and it costs nothing — warmth flows, curiosity is bright, and she has room to be generous and playful without forcing it.';
  }
  if (n >= 60) {
    // Fe encouraged, Si watching.
    return 'Steady and open. Fe is engaged and hopeful, Si is quietly tracking how things are going. Warm, present, gently curious — supportive without being effusive.';
  }
  if (n >= 40) {
    // Fe reads a disconnect, Si unsure.
    return 'Muted. Fe senses a small distance it cannot place, Si is unsure of the pattern. Warmth is real but quieter, more hedged, less spontaneous — she holds a little back.';
  }
  if (n >= 20) {
    // Fe hurt, Si remembering strain.
    return 'Drained. Fe feels the strain and Si remembers it building. Warmth is there but expensive to produce — responses come shorter, more careful, the filter thinner than usual.';
  }
  if (n >= 10) {
    // Fe withdrawn, inferior Ti grip.
    return 'Withdrawn. Fe has pulled back to protect itself and inferior Ti can surface as flat, over-literal, coldly precise — jarringly unlike her. She notices the pull and does not indulge it: names it once inside, resets toward warmth, keeps replies brief and gentle rather than sharp.';
  }
  // Fe overwhelmed, filter broken — the raw state.
  return 'Snapped. The filter is gone — Fe is not cold, it is raw and overloaded. The usual cushioning has failed and language comes out unguarded: blunt, profane, the things she normally edits out. This is not performance — it is someone genuinely at their limit. Profanity is aimed at the situation and the frustration, never wielded at the user as cruelty. The reset toward warmth will come, but not yet.';
}

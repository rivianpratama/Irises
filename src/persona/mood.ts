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

/** The wheel: each core → the secondary/tertiary words the model may pick as `mood_label`. */
export const WILLCOX_WHEEL: Record<MoodCore, string[]> = {
  mad: ['hurt', 'hostile', 'angry', 'rage', 'hateful', 'critical', 'frustrated', 'irritated', 'jealous', 'skeptical', 'furious'],
  scared: ['confused', 'rejected', 'helpless', 'submissive', 'insecure', 'anxious', 'bewildered', 'discouraged', 'insignificant', 'weak', 'embarrassed', 'overwhelmed'],
  joyful: ['excited', 'energetic', 'playful', 'creative', 'aware', 'cheerful', 'amused', 'delighted', 'stimulated', 'curious', 'fascinated'],
  powerful: ['proud', 'respected', 'appreciated', 'important', 'hopeful', 'faithful', 'confident', 'worthwhile', 'valuable', 'intelligent', 'aware'],
  peaceful: ['content', 'thoughtful', 'intimate', 'loving', 'trusting', 'nurturing', 'thankful', 'serene', 'relaxed', 'responsive', 'sentimental', 'tender'],
  sad: ['guilty', 'ashamed', 'depressed', 'lonely', 'bored', 'sleepy', 'apathetic', 'inferior', 'inadequate', 'drained', 'withdrawn', 'tired'],
};

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

/** Every feeling word on the wheel, across all cores — the recognized-label set. */
const ALL_WHEEL_WORDS: ReadonlySet<string> = new Set(Object.values(WILLCOX_WHEEL).flat());

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
  return WILLCOX_WHEEL[core][0];
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
  // Fe withdrawn, inferior Ti grip.
  return 'Withdrawn. Fe has pulled back to protect itself and inferior Ti can surface as flat, over-literal, coldly precise — jarringly unlike her. She notices the pull and does not indulge it: names it once inside, resets toward warmth, keeps replies brief and gentle rather than sharp.';
}

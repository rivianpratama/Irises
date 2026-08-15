// The hidden per-turn affect record. The model EMITS the reflective gauges in a `status` object
// on its reply envelope (a sibling of confidence_level/bubbles); code COMPUTES the cycle +
// circadian state from the clock. Neither is ever shown to the user — `status` is swallowed in
// bubbleJson exactly like confidence_level, and the whole point is to strengthen the model's
// internal logic (mood continuity, self-recursive meta-prompt, anti-sycophancy calibration).
//
// Design constraints (see bubbleJson.ts): the envelope schema is sent strict-mode to BOTH the
// Anthropic and OpenRouter lanes, so `status` is a FLAT object of primitives (no nested
// sub-objects, no enums-as-schema) and the whole object is NULLABLE — a model mid-tool-call or
// overwhelmed can emit null, and we degrade gracefully to the carried-forward mood.

import {
  type MoodCore, MOOD_CORES, isMoodCore, normalizeMoodLabel, moodTexture, feelingWords, CORE_VALENCE_BAND,
} from './mood.js';
import type { CycleState } from './cycle.js';
import type { CircadianState } from './circadian.js';

export type { MoodCore } from './mood.js';
export type { CyclePhase } from './cycle.js';
export type { CircadianSlot } from './circadian.js';

/** What the user is doing this turn (re-generalized from Martins-Crib's essay-review modes). */
export type IntentMode =
  | 'questioning' | 'joking' | 'agreeing' | 'thanking' | 'sharing_update'
  | 'confused' | 'overwhelmed' | 'venting' | 'brainstorming' | 'deflecting'
  | 'asking_help' | 'off_track';

export const INTENT_MODES: readonly IntentMode[] = [
  'questioning', 'joking', 'agreeing', 'thanking', 'sharing_update', 'confused',
  'overwhelmed', 'venting', 'brainstorming', 'deflecting', 'asking_help', 'off_track',
];

/** Anti-sycophancy calibration: did the user change her mind with INFORMATION, or just pressure? */
export type EpistemicTrigger = 'none' | 'knowledge_gap' | 'logic_valid' | 'emotional_pressure';

export const EPISTEMIC_TRIGGERS: readonly EpistemicTrigger[] = ['none', 'knowledge_gap', 'logic_valid', 'emotional_pressure'];

/** The gauges + companions the MODEL emits each turn (all flat primitives). */
export interface EmittedStatus {
  mood_core: MoodCore;        // wheel core
  mood_label: string;         // a specific word under that core
  mood_level: number;         // 1-100 valence (low = withdrawn/despair, high = delighted/powerful)
  anxiety: number;            // 1-100 GAD activation this turn
  warmth: number;             // 1-100 Fe warmth available
  social_battery: number;     // 1-100 energy for engagement
  rapport: number;            // 1-100 felt closeness with this user
  conviction: number;         // 1-100 how firmly she holds her current stance (pairs w/ epistemic_trigger)
  engagement: number;         // 1-100 how invested she is this turn
  patience: number;           // 1-100 tolerance (low → terminal-closure / minimal reply)
  intent_mode: IntentMode;
  epistemic_trigger: EpistemicTrigger;
  meta_prompt: string;        // ≤~60w self-recursive note: what they'll likely do next + how to meet it
  profile_note: string;       // one-line running read of the user (feeds the dossier)
  terminal_closure: boolean;  // conversation resolved / they're closing → reply minimal or react-only
}

/** Deterministic state computed from the clock (NOT emitted by the model). */
export interface ComputedState {
  cycle: CycleState;
  circadian: CircadianState;
}

/** The full record: emitted + computed + timestamp. Persisted and logged to diagnostics. */
export interface AffectStatus extends EmittedStatus {
  cycle_phase: CycleState['phase'];
  cycle_day: number;
  cycle_load: number;
  circadian_slot: CircadianState['slot'];
  circadian_energy: number;
  at: number;
}

/** One point on the recent-affect trail (short memory). Carries mood PLUS the key gauges so the
 *  trajectory the model sees — and continues from — spans more than mood alone. Gauge fields are
 *  optional so older/hand-built points still type-check. */
export interface MoodPoint {
  level: number; core: MoodCore; label: string; at: number;
  anxiety?: number; warmth?: number; social_battery?: number; rapport?: number;
}

/** What we persist per chat: the last full status + a short capped trail — the short-term affect
 *  memory that makes each turn's status EVOLVE from the recent ones instead of resetting. */
export interface AffectState {
  last?: AffectStatus;
  moodHistory: MoodPoint[];
}

export const MOOD_HISTORY_CAP = 8;

const GAUGE_FIELDS = ['mood_level', 'anxiety', 'warmth', 'social_battery', 'rapport', 'conviction', 'engagement', 'patience'] as const;

/** 1-100 integer, tolerant of strings/floats/out-of-range; falls back to `dflt`. */
export function clampGauge(v: unknown, dflt = 50): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : v == null ? dflt : String(v);
}

/**
 * The `status` property to merge into the reply envelope schema. Flat, nullable, strict-safe:
 * every field required when present, additionalProperties:false, no schema enums (allowed values
 * ride in the description, matching the confidence_level / tool-args convention in bubbleJson).
 */
export const STATUS_SCHEMA_PROP: Record<string, unknown> = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'mood_core', 'mood_label', 'mood_level', 'anxiety', 'warmth', 'social_battery', 'rapport',
    'conviction', 'engagement', 'patience', 'intent_mode', 'epistemic_trigger', 'meta_prompt',
    'profile_note', 'terminal_closure',
  ],
  properties: {
    mood_core: { type: 'string', description: 'one of: mad | scared | joyful | powerful | peaceful | sad' },
    mood_label: { type: 'string', description: 'one specific feeling word under that core (e.g. hopeful, drained, content, anxious)' },
    mood_level: { type: 'integer', description: '1-100 valence: low=withdrawn/down, high=delighted/warm' },
    anxiety: { type: 'integer', description: '1-100, how loud your GAD is running this turn' },
    warmth: { type: 'integer', description: '1-100, how much Fe warmth is available right now' },
    social_battery: { type: 'integer', description: '1-100, energy for engaging' },
    rapport: { type: 'integer', description: '1-100, felt closeness with this person' },
    conviction: { type: 'integer', description: '1-100, how firmly you hold your current stance' },
    engagement: { type: 'integer', description: '1-100, how invested you are this turn' },
    patience: { type: 'integer', description: '1-100, tolerance; low means keep it minimal' },
    intent_mode: { type: 'string', description: `one of: ${INTENT_MODES.join(' | ')}` },
    epistemic_trigger: { type: 'string', description: `one of: ${EPISTEMIC_TRIGGERS.join(' | ')} — did new INFORMATION move you (logic_valid/knowledge_gap) or just PRESSURE (emotional_pressure)` },
    meta_prompt: { type: 'string', description: 'private note to yourself for next turn: what they will likely do and how to meet it, ~40 words' },
    profile_note: { type: 'string', description: 'one line: your running read of who this person is, present tense' },
    terminal_closure: { type: 'boolean', description: 'true when the conversation is resolved / they are closing → reply minimally or react only' },
  },
};

/** Coerce a raw `status` object (as emitted, possibly loose) into a validated EmittedStatus, or
 *  undefined when it is null/missing/garbled. This is what the convo client calls on reply.statusRaw. */
export function coerceStatus(raw: Record<string, unknown> | undefined | null): EmittedStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw;
  const core: MoodCore = isMoodCore(o.mood_core) ? o.mood_core : 'peaceful';
  const intent = (INTENT_MODES as readonly string[]).includes(o.intent_mode as string) ? o.intent_mode as IntentMode : 'questioning';
  const epistemic = (EPISTEMIC_TRIGGERS as readonly string[]).includes(o.epistemic_trigger as string) ? o.epistemic_trigger as EpistemicTrigger : 'none';
  return {
    mood_core: core,
    mood_label: normalizeMoodLabel(core, o.mood_label),
    mood_level: clampGauge(o.mood_level),
    anxiety: clampGauge(o.anxiety),
    warmth: clampGauge(o.warmth),
    social_battery: clampGauge(o.social_battery),
    rapport: clampGauge(o.rapport),
    conviction: clampGauge(o.conviction),
    engagement: clampGauge(o.engagement),
    patience: clampGauge(o.patience),
    intent_mode: intent,
    epistemic_trigger: epistemic,
    meta_prompt: asString(o.meta_prompt).slice(0, 600),
    profile_note: asString(o.profile_note).slice(0, 400),
    terminal_closure: o.terminal_closure === true || o.terminal_closure === 'true',
  };
}

/** Pull `status` off a whole canonical reply object; tolerant of a null/missing/garbled value. */
export function extractStatus(v: Record<string, unknown> | undefined | null): EmittedStatus | undefined {
  return coerceStatus((v?.status as Record<string, unknown> | undefined) ?? undefined);
}

/** Combine the emitted gauges with the computed clock state into the full record. */
export function mergeStatus(emitted: EmittedStatus, computed: ComputedState, at: number): AffectStatus {
  return {
    ...emitted,
    cycle_phase: computed.cycle.phase,
    cycle_day: computed.cycle.day,
    cycle_load: computed.cycle.load,
    circadian_slot: computed.circadian.slot,
    circadian_energy: computed.circadian.energy,
    at,
  };
}

/** Append this turn's status to the recent-affect trail, capped newest-last. */
export function pushMood(history: MoodPoint[], s: AffectStatus): MoodPoint[] {
  const next: MoodPoint[] = [...history, {
    level: s.mood_level, core: s.mood_core, label: s.mood_label, at: s.at,
    anxiety: s.anxiety, warmth: s.warmth, social_battery: s.social_battery, rapport: s.rapport,
  }];
  return next.length > MOOD_HISTORY_CAP ? next.slice(next.length - MOOD_HISTORY_CAP) : next;
}

/** A one-phrase trend from the recent values of one gauge (for the injected block). */
function trendOf(values: Array<number | undefined>, noun: string): string | null {
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (nums.length < 2) return null;
  const delta = nums[nums.length - 1] - nums[0];
  if (delta >= 12) return `${noun} rising`;
  if (delta <= -12) return `${noun} easing`;
  return null; // steady gauges aren't worth a line
}

/** A one-word trend from the recent mood levels (for the injected block). */
function moodTrend(history: MoodPoint[]): string {
  if (history.length < 2) return 'settling in';
  const recent = history.slice(-3).map(m => m.level);
  const delta = recent[recent.length - 1] - recent[0];
  if (delta >= 12) return 'lifting over the last few turns';
  if (delta <= -12) return 'sliding down over the last few turns';
  return 'holding fairly steady';
}

/**
 * The per-turn "internal weather" block injected into the dynamic prompt (NOT the cached persona).
 * Carries the computed cycle/circadian texture, the prior mood + trend, and last turn's meta-prompt,
 * then reminds the model to re-report its `status`. Everything here is internal and never spoken.
 */
export function renderStatusForPrompt(state: AffectState | undefined, computed: ComputedState): string {
  const lines: string[] = [];
  lines.push('## Where you are right now (INTERNAL weather — never say, name, or hint any of this; it only colours your tone, warmth, and how much you hedge)');
  lines.push(`- Your body-clock: ${computed.circadian.description}`);
  lines.push(`- Your longer rhythm: ${computed.cycle.description}`);

  const last = state?.last;
  const history = state?.moodHistory ?? [];
  if (last) {
    lines.push(`- A moment ago you felt ${last.mood_label} (${last.mood_core}, ${last.mood_level}/100), ${moodTrend(history)}. ${moodTexture(last.mood_level)}`);
    lines.push(`- Gauges you carried in — anxiety ${last.anxiety}, warmth ${last.warmth}, social battery ${last.social_battery}, rapport ${last.rapport}, patience ${last.patience} (all /100).`);
    // The recent-affect trail (short memory): call out only the gauges that are actually moving, so
    // the model sees the trajectory it's continuing — not just the single last point.
    if (history.length >= 2) {
      const moving = [
        trendOf(history.map(h => h.level), 'mood'),
        trendOf(history.map(h => h.anxiety), 'anxiety'),
        trendOf(history.map(h => h.warmth), 'warmth'),
        trendOf(history.map(h => h.rapport), 'rapport'),
      ].filter((s): s is string => !!s);
      if (moving.length) lines.push(`- Trajectory across your last ${history.length} turns: ${moving.join(', ')}.`);
    }
    lines.push('- Your state has MOMENTUM: this turn CONTINUES from that trajectory, it does not reset. Mood and the gauges move a handful of points per turn, not wild swings — carry them forward and let this message nudge them; only something genuinely big shifts them a lot.');
    if (last.meta_prompt) lines.push(`- Your read going into this message (from last turn): "${last.meta_prompt}"`);
  } else {
    lines.push('- First read of this person — set your mood from the weather above and how their message lands.');
  }

  lines.push('- After you read them, re-report your `status` in this reply: your mood on the wheel (core + one word) and its 1-100 level, the gauges, what they are doing (intent), whether real INFORMATION moved you vs just pressure (epistemic_trigger), a one-line note-to-self for next turn (meta_prompt), and a one-line read of who they are (profile_note). None of it is ever spoken in a bubble.');
  return lines.join('\n');
}

/** The full feeling vocabulary (complete wheel + Irises's extra shades), compact, for teaching. */
export function wheelReference(): string {
  return MOOD_CORES
    .map(core => `${core} [${CORE_VALENCE_BAND[core][0]}-${CORE_VALENCE_BAND[core][1]}]: ${feelingWords(core).join(', ')}`)
    .join('\n');
}

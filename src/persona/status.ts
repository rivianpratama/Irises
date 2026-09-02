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
//
// The same envelope is also where conversational threading CAPTURES its material (`thread_note` /
// `thread_outcome`): riding a field the model already fills costs zero extra LLM calls, which is
// why both are schema fields rather than a second pass. They are model PROSE, so they are
// sanitized at the door (sanitizeThreadText) rather than at render time, and — unlike the gauges —
// they never fall back to a default: an unusable value is simply absent, because a made-up thread
// is worse than no thread. Nothing here reads them yet; renderStatusForPrompt is untouched.

import {
  type MoodCore, MOOD_CORES, isMoodCore, normalizeMoodLabel, moodTexture, feelingWords, CORE_VALENCE_BAND,
} from './mood.js';
import type { CycleState } from './cycle.js';
import type { CircadianState } from './circadian.js';
import { climateLines, climateLinesForComposer, type RelationshipClimate } from './climate.js';

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

/** How the LAST reply's thread offer landed — the only feedback the threading engine ever gets. */
export type ThreadOutcome = 'took' | 'passed' | 'pushed_back';

export const THREAD_OUTCOMES: readonly ThreadOutcome[] = ['took', 'passed', 'pushed_back'];

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
  profile_note: string;       // one-line running read of the user (emitted + persisted; no reader yet)
  terminal_closure: boolean;  // conversation resolved / they're closing → reply minimal or react-only
  // Threading capture. OPTIONAL on purpose: hand-built fixtures keep type-checking, and an absent
  // field is dropped by JSON.stringify instead of persisting an empty string on every affect row.
  thread_note?: string;           // usually absent: a pending thing (`loop:`/`resolved:`) or a recurring theme
  thread_outcome?: ThreadOutcome; // only after her last reply tagged a thread or asked about a pending thing
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

/** One field of the hidden envelope, described ONCE. */
export interface EnvelopeField {
  key: keyof EmittedStatus;
  /** Its JSON-schema `type`, verbatim: a primitive name, or `['string', 'null']` for a field whose
   *  "not this turn" has to be expressible as null (strict mode wants every field in `required`). */
  type: string | readonly string[];
  /** What the field means, in the words the MODEL reads — the only copy. STATUS_SCHEMA_PROP sends it
   *  on the response schema; renderStatusContract() renders it into the per-turn prompt. */
  description: string;
  /** Every field is required, and the literal `true` is the whole point: strict mode admits no
   *  optional property, so "not this turn" has to be expressible in `type` (above) rather than by
   *  absence. The TYPE is therefore what stops a row opting out — the schema can list every key with
   *  no runtime filter in between, which is a filter that could never have dropped one anyway. */
  required: true;
  /** The code that reads this field BACK to change something — a render, a gate, a stored trail —
   *  named by function so it is greppable. The receipts are deliberately not listed: `convo:status`
   *  and the turn trace carry the whole record, so listing them would put the same two names on all
   *  seventeen rows. An EMPTY list therefore means exactly that: the field is emitted for her own
   *  reasoning and persisted on the affect row, and nothing branches on it. */
  consumers: readonly string[];
}

/**
 * Every field of the hidden `status` envelope: what it means, its schema type, and who reads it.
 * THE one place it is described — STATUS_SCHEMA_PROP and renderStatusContract() are both generated
 * from this, so the schema the lanes validate against and the prose the model is taught cannot drift
 * apart (the THEME_KINDS single-source pattern, persona/threads.ts).
 *
 * Order is load-bearing twice: it is the schema's `required` order AND the contract's bullet order.
 * The two threading fields stay LAST — `status` is the envelope's last property, and these are its
 * newest, least-often-filled ones.
 */
export const ENVELOPE_FIELDS: readonly EnvelopeField[] = [
  {
    key: 'mood_core', type: 'string', required: true,
    description: 'one of: mad | scared | joyful | powerful | peaceful | sad',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood'],
  },
  {
    key: 'mood_label', type: 'string', required: true,
    description: 'one specific feeling word under that core (e.g. hopeful, drained, content, anxious)',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood'],
  },
  {
    key: 'mood_level', type: 'integer', required: true,
    description: '1-100 valence: low=withdrawn/down, high=delighted/warm',
    // The most-read field in the envelope: it also floors the thread offer and marks a theme minted
    // while she was low, so a bad turn can never hand back a named pattern.
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood', 'selectThreadCandidate', 'updateThreadInventory'],
  },
  {
    key: 'anxiety', type: 'integer', required: true,
    description: '1-100, how loud your GAD is running this turn',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood'],
  },
  {
    key: 'warmth', type: 'integer', required: true,
    description: '1-100, how much Fe warmth is available right now',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood'],
  },
  {
    key: 'social_battery', type: 'integer', required: true,
    description: '1-100, energy for engaging',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer', 'pushMood'],
  },
  {
    key: 'rapport', type: 'integer', required: true,
    description: '1-100, felt closeness with this person',
    // Not the Composer's: it re-voices a decided answer, so only the voice-shaping gauges reach it.
    consumers: ['renderStatusForPrompt', 'pushMood'],
  },
  {
    key: 'conviction', type: 'integer', required: true,
    description: '1-100, how firmly you hold your current stance',
    consumers: [],
  },
  {
    key: 'engagement', type: 'integer', required: true,
    description: '1-100, how invested you are this turn',
    consumers: [],
  },
  {
    key: 'patience', type: 'integer', required: true,
    description: '1-100, tolerance; low means keep it minimal',
    consumers: ['renderStatusForPrompt', 'renderStatusForComposer'],
  },
  {
    key: 'intent_mode', type: 'string', required: true,
    // "what THEY are doing" is the only field in this table that is NOT a self-report, and it has to
    // say so here: the contract's lead line asks her to read HERSELF, and `confused`, `overwhelmed`,
    // `venting`, `deflecting` and `off_track` all describe her own state as naturally as the user's.
    // Context.md's deleted bullet and the deleted re-report tail were the only two places that named
    // the subject. It matters because both consumers GATE on the value (THREAD_BLOCKING_MODES in
    // threads.ts, DISTRESSED_MODES in memory/threadHarvest.ts): a mode read off her closes threading
    // on a turn the person is fine, and pins a theme to the fact rung for a distress that was hers.
    description: `what THEY are doing this turn — one of: ${INTENT_MODES.join(' | ')}`,
    consumers: ['selectThreadCandidate', 'updateThreadInventory'],
  },
  {
    key: 'epistemic_trigger', type: 'string', required: true,
    description: `one of: ${EPISTEMIC_TRIGGERS.join(' | ')} — did new INFORMATION move you (logic_valid/knowledge_gap) or just PRESSURE (emotional_pressure)`,
    consumers: [],
  },
  {
    key: 'meta_prompt', type: 'string', required: true,
    description: 'private note to yourself for next turn: what they will likely do and how to meet it, ~40 words',
    // The self-recursive loop: last turn's note is re-injected into this turn's weather block.
    consumers: ['renderStatusForPrompt'],
  },
  {
    key: 'profile_note', type: 'string', required: true,
    description: 'one line: your running read of who this person is, present tense',
    consumers: [],
  },
  {
    key: 'terminal_closure', type: 'boolean', required: true,
    description: 'true when the conversation is resolved / they are closing → reply minimally or react only',
    consumers: ['selectThreadCandidate'],
  },
  {
    key: 'thread_note', type: ['string', 'null'], required: true,
    // Two of the sentences here are CAPTURE rules re-homed from the field list P1 deleted out of
    // Context.md — the venting clause and the bare-fact exclusion. They were in the persona only, so
    // the deletion would have taken them with it: nothing else in the prose tells her to mint a loop
    // on a heavy turn (Context.md's other word on venting closes theme READS, which is the opposite
    // instruction one paragraph away), and nothing else keeps a diary entry out of the inventory. A
    // rule that governs one field belongs on that field, where both channels carry it.
    description: 'null most turns. Three uses, one per turn, prefixed: (1) "loop: <thing>" — something pending in their life with a how-did-it-go attached (an interview, a surgery, a launch, a dreaded talk), in their own word for it; one mention is enough. Catch a loop even on a venting or overwhelmed turn — a loop is asked about later, never in the moment. (2) "resolved: <thing>" — a pending thing you were tracking just got its outcome, whatever it was. (3) a recurring theme of theirs as "kind: theme", kind one of value | tension | goal | phrase (e.g. "tension: speed vs craft"); only for things likely to recur, never something they merely CLAIM is a pattern. A loop is an unanswered outcome and a theme is a because — neither is ever a bare fact ("has a meeting friday" belongs to your memory tools, not here). Precedence when more than one fits: "resolved:" > "loop:" > theme — a resolution outranks a pending loop, a pending loop outranks a fresh theme, one note per turn.',
    consumers: ['updateThreadInventory'],
  },
  {
    key: 'thread_outcome', type: ['string', 'null'], required: true,
    // The anti-optimism clause is the third of those re-homed rules, and it is the one with teeth in
    // code: a `took` steps the theme's confidence up and counts an uptake, and two uptakes promote it
    // taggable → shorthand (threads.ts). The per-turn ask prose de-biases the same reading ("passed
    // if they let it lie (that is fine)"), but only on the turn it renders.
    description: 'only when your LAST reply tagged a standing thread or asked about something pending of theirs: how they just took it — one of: took (they picked it up) | passed (they let it lie, fine) | pushed_back (they corrected it or bristled). Read it from their message alone, never from hope — a pass reported as a take poisons the thread. Otherwise null, including when you were offered a thread and chose not to use it.',
    consumers: ['updateThreadInventory'],
  },
];

/**
 * The `status` property to merge into the reply envelope schema — GENERATED from ENVELOPE_FIELDS, so
 * a field is added, reworded or re-typed in exactly one place. Flat, nullable, strict-safe: every
 * field required, additionalProperties:false, no schema enums (allowed values ride in the
 * description, matching the confidence_level / tool-args convention in bubbleJson).
 */
export const STATUS_SCHEMA_PROP: Record<string, unknown> = {
  type: ['object', 'null'],
  additionalProperties: false,
  // Every key, in table order. This used to run through `.filter(f => f.required)` and claim a row
  // could opt out — but `required` is the literal `true` (see EnvelopeField), so the filter could
  // never drop anything: dead code describing behaviour its own type forbids. The type does that job.
  required: ENVELOPE_FIELDS.map(f => f.key),
  properties: Object.fromEntries(ENVELOPE_FIELDS.map(f => [f.key, {
    // The type array is COPIED, not shared: this object is handed to the lanes' SDKs, and a table row
    // must not be mutable through it.
    type: typeof f.type === 'string' ? f.type : [...f.type],
    description: f.description,
  }])),
};

/**
 * Sanitize a model-authored thread string at the door. This text is later quoted back INTO a prompt
 * block, so three things are non-negotiable: it stays ONE line (a note that carried newlines could
 * pose as several instruction lines), it loses `<` `>` backtick `{` `}` (no tags, no fences, no
 * template holes), and it is capped. Stripping runs BEFORE the whitespace collapse so a removed
 * character can't leave a double space behind. Empty after all of it — or not a string at all —
 * returns undefined: the field is absent, never a blank one.
 */
export function sanitizeThreadText(v: unknown, cap: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const out = v
    .replace(/[<>`{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
    .trim(); // the cap can land mid-gap; don't keep a dangling space
  return out || undefined;
}

/** Coerce a raw `status` object (as emitted, possibly loose) into a validated EmittedStatus, or
 *  undefined when it is null/missing/garbled. This is what the convo client calls on reply.statusRaw. */
export function coerceStatus(raw: Record<string, unknown> | undefined | null): EmittedStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw;
  const core: MoodCore = isMoodCore(o.mood_core) ? o.mood_core : 'peaceful';
  const intent = (INTENT_MODES as readonly string[]).includes(o.intent_mode as string) ? o.intent_mode as IntentMode : 'questioning';
  const epistemic = (EPISTEMIC_TRIGGERS as readonly string[]).includes(o.epistemic_trigger as string) ? o.epistemic_trigger as EpistemicTrigger : 'none';
  // Threading has NO default: unlike the gauges, a wrong guess here would invent a fact about the
  // person's life, so anything outside the exact three words (or an empty note) drops the field.
  const rawOutcome = typeof o.thread_outcome === 'string' ? o.thread_outcome.trim().toLowerCase() : '';
  const outcome = (THREAD_OUTCOMES as readonly string[]).includes(rawOutcome) ? rawOutcome as ThreadOutcome : undefined;
  const note = sanitizeThreadText(o.thread_note, 200); // a thread is a phrase, not a paragraph
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
    // Spread rather than assigned: an absent field must not exist as an `undefined` key, or every
    // silent turn would persist two dead keys onto the affect row.
    ...(note ? { thread_note: note } : {}),
    ...(outcome ? { thread_outcome: outcome } : {}),
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

// The PROVEN leak-guard header for every internal-weather block: the parenthetical is the line that
// keeps this state from ever surfacing in a bubble. Shared verbatim by the Convo and Composer
// injectors (renderStatusForPrompt / renderStatusForComposer) so the wording can never drift apart.
const INTERNAL_WEATHER_HEADER =
  '## Where you are right now (INTERNAL weather — never say, name, or hint any of this; it only colours your tone, warmth, and how much you hedge)';

/**
 * The per-turn "internal weather" block injected into the dynamic prompt (NOT the cached persona).
 * Carries the computed cycle/circadian texture, the prior mood + trend, last turn's meta-prompt, and
 * — underneath all of it — the weeks-scale standing register (climate.ts), then reminds the model to
 * re-report its `status`. Everything here is internal and never spoken.
 *
 * The climate lines splice in AFTER the momentum/meta-prompt lines and BEFORE the re-report tail:
 * the weather is what she carries into THIS turn, the climate is the ground it sits on, and the tail
 * has to stay last (it is the instruction the reply obeys). ONE header for the whole block, ever.
 * With `climate` undefined or at its defaults, climateLines returns [] and this output is
 * byte-identical to what it was before the feature existed (pinned in status.test.ts).
 */
export function renderStatusForPrompt(
  state: AffectState | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
): string {
  const lines: string[] = [];
  lines.push(INTERNAL_WEATHER_HEADER);
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

  // The standing register underneath the moment. Empty at defaults, so nothing changes until a
  // relationship has actually moved.
  lines.push(...climateLines(climate));

  // The tail stays last (it is the instruction the reply obeys) and is now one POINTER: it used to
  // re-list six of the seventeen fields in its own words, which was a fourth description of the
  // envelope and the one nobody could edit — the contract block right below it is the list.
  lines.push('- Re-report your `status` per the contract below; never spoken.');
  return lines.join('\n');
}

/** The contract's heading. Its own section (`status_contract`, agents/convo/promptSections.ts),
 *  pushed immediately after the weather block, whose last line points at it by this name — and named
 *  in Context.md's inner-weather section, which now says where the fields are described instead of
 *  describing them a second time.
 *
 *  EXPORTED for the tests that hold those two pointers to it: promptPolicy.test.ts derives Context.md's
 *  quoted name from this string rather than repeating it, and internalWeather.test.ts locates the
 *  section by it. Nothing at runtime reads it from outside — renderStatusContract is the only caller —
 *  but a rename here has to fail in the places that quote the heading, and the way to guarantee that
 *  is for them to read the heading instead of spelling it again. */
export const STATUS_CONTRACT_HEADER = '## Your hidden status — the contract';

/**
 * The envelope's hidden `status` field, as PROSE for the model — one bullet per field, in envelope
 * order, from the same ENVELOPE_FIELDS descriptions that build the response schema, plus the feeling
 * vocabulary the schema has no room for. Pure, static, and identical on every turn; it rides the
 * per-turn block rather than the persona because it is the operational contract for THIS reply and
 * the weather block above it is what asks her to fill it (charter §11.3's recency edge, the same
 * arrangement the bubble law has: the section teaches, the edge states the law).
 *
 * It replaced ~3.7k characters of Context.md (a hand-copied feelings wheel plus a second field list
 * that had already drifted from the schema). It is not small — the descriptions are the schema's own,
 * which is the point of one source — so a shorter contract means shortening THEM, in the table, where
 * both copies change together.
 */
export function renderStatusContract(): string {
  return [
    STATUS_CONTRACT_HEADER,
    'Every reply ends with this hidden `status` object — never seen by them, never spoken, never hinted at. It is what keeps you the same person from one turn to the next: read yourself honestly, then fill every field.',
    ...ENVELOPE_FIELDS.map(f => `- \`${f.key}\` — ${f.description}`),
    'Your feeling words, by core — pick the one that is actually true, not the flattering one:',
    feelingVocabulary(),
  ].join('\n');
}

/**
 * The Composer's READ-ONLY internal weather. The Composer re-voices the engine's answer on every
 * delegated turn; without this it composes in a mood vacuum, so a delegated reply lands tonally
 * reset even though the persisted mood trail is intact. This threads the CARRIED affect in so the
 * re-voiced reply keeps mood continuity — the Composer never re-reports or persists it (no writer
 * racing Convo's saveAffectState).
 *
 * Only the voice-SHAPING fields are subset (mood + warmth/patience/social_battery/anxiety). The
 * rest is deliberately excluded: conviction/engagement/intent_mode/epistemic_trigger are about
 * FORMING a stance (the Composer forms none — it relays given facts), and meta_prompt/profile_note
 * are Convo's private notes-to-self that could contradict the compose instruction. No cycle/
 * circadian machinery and no "re-report your status" line either.
 *
 * TWO INDEPENDENT PARTS, and this is the point of the split. The MOOD part keeps its staleness gate
 * (>45min): the proactive path is a delivery no one just asked for, and dressing it in an hours-old
 * mood is exactly the failure that gate exists for. The CLIMATE part has NO staleness gate, because
 * a weeks-scale register cannot go stale in 45 minutes — that's the whole difference between weather
 * and climate. So a stale mood plus a moved climate now yields a climate-only block, where it used
 * to yield nothing. Only `candor` is withheld here (see climateLinesForComposer).
 *
 * Returns '' only when BOTH parts are empty — no fresh mood AND a climate still at its defaults,
 * which is byte-for-byte the old behaviour for every caller that passes no climate.
 */
export function renderStatusForComposer(
  state: AffectState | null | undefined,
  climate?: RelationshipClimate,
): string {
  const last = state?.last;
  const moodPart = last && Date.now() - last.at <= 45 * 60_000
    ? [
        `- A moment ago you felt ${last.mood_label} (${last.mood_core}, ${last.mood_level}/100). ${moodTexture(last.mood_level)}`,
        `- Gauges you carry in — warmth ${last.warmth}, patience ${last.patience}, social battery ${last.social_battery}, anxiety ${last.anxiety} (all /100).`,
      ]
    : [];
  const climatePart = climateLinesForComposer(climate);
  if (!moodPart.length && !climatePart.length) return '';
  return [
    // The proven leak-guard wording PLUS one fidelity clause Convo doesn't need: the Composer's one
    // job is faithful re-voicing, so tone may bend word choice but must never move a fact.
    `${INTERNAL_WEATHER_HEADER}. It colours word choice and how much you hedge; it never adds, drops, softens, or sharpens a fact you relay.`,
    ...moodPart,
    ...climatePart,
  ].join('\n');
}

/**
 * The feeling vocabulary the model picks `mood_label` from: one line per core, the complete Willcox
 * wheel plus Irises's own shades (mood.ts), and NO valence bands. The bands are guidance for code,
 * not for her — a number printed beside a feeling is a number to optimize, and the level she reports
 * carries its own range in its own field description. This is the half of the contract the response
 * schema has no room for, which is why the contract exists at all.
 */
export function feelingVocabulary(): string {
  return MOOD_CORES.map(core => `${core}: ${feelingWords(core).join(', ')}`).join('\n');
}

/** The same vocabulary WITH each core's valence band — written for a teaching surface that wants the
 *  numbers. Nothing calls it; renderStatusContract deliberately uses the band-less version above. */
export function wheelReference(): string {
  return MOOD_CORES
    .map(core => `${core} [${CORE_VALENCE_BAND[core][0]}-${CORE_VALENCE_BAND[core][1]}]: ${feelingWords(core).join(', ')}`)
    .join('\n');
}

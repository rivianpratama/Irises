// `turn:trace` — ONE receipt per user-visible turn, saying what was in front of the model.
//
// The rest of the trace is per-subsystem: `threads:select` says what threading decided,
// `convo:status` says what the envelope emitted, the `llm` events carry the prompt text. None of
// them attributes ONE delivered reply to the whole state that produced it, which is what a drifted
// reply needs — was the persona buried under a 40k dossier, did a theme get offered, did the
// envelope come back garbled and get defaulted, did the bubble law hold. This is that record, and
// it fires on EVERY turn including the ones that shipped nothing: a turn with no receipt and a turn
// that never ran look identical afterwards.
//
// NAMES AND NUMBERS ONLY. The detail persists for 30 days (diagnostic_turn_history), so nothing
// here may carry prompt text — not a section's body, not the persona, not the internal weather, not
// the user's dossier. Sections travel as `{ name, chars }`; that is the whole discipline, and
// turnTrace.test.ts's leak guard is what enforces it.
//
// Two builders, both PURE, because the two halves of a turn are known in two places:
//   • buildTurnTraceDraft — in processConvoResult (agents/convo/shared.ts), which knows the prompt,
//     the gates, the envelope and what the turn produced;
//   • buildTurnTrace — at the send boundary (src/index.ts), the only place that knows which bubbles
//     actually went out, where the draft becomes the recorded detail.
// recordTurnTrace is the one impure function: the flag, the emit, and the never-throw guard.

import { isDynSection, type PromptSection } from '../agents/convo/promptSections.js';
import { record } from './trace.js';
import type { BubbleReport } from '../pipeline/bubbleJson.js';
import type { EmittedStatus } from '../persona/status.js';
import type { ThreadSelectReport } from '../persona/threads.js';

/** The trace label, in one place — the dashboard and any later reader match on this string. */
export const TURN_TRACE_LABEL = 'turn:trace';

/**
 * Hard bound on the recorded section list. A build can carry at most one entry per section id
 * (SECTION_IDS, currently 20), so this can never fire on an assembled prompt — it exists so a future
 * repeated push can't put an unbounded list into a 30-day store. Because it never fires in practice,
 * `sectionsTotalChars(sections) === systemChars` stays exhaustive rather than approximate
 * (turnTrace.test.ts pins both halves of that sentence).
 */
export const TRACE_SECTIONS_CAP = 32;

/** What buildSystemPromptSections returns, structurally — the assembler's own result type is
 *  declared in agents/convo/shared.ts, and diagnostics must not import that 1.7k-line module. The
 *  `system` string is READ for its length and never stored. */
export interface MeasuredPrompt {
  system: string;
  sections: readonly PromptSection[];
  personaChars: number;
  anchorChars: number;
}

/** The one thing this needs from a message: how much text it puts in front of the model. Structural
 *  (not `LlmMessage`) so the diagnostics layer stays free of the llm types. Block content is
 *  measured by its text blocks — an image block contributes no characters, which is true. */
export interface TranscriptMessage {
  content: string | readonly unknown[];
}

/** How the freshest held research look reached the model this turn (memory/wrappers.ts):
 *  - `full` — its whole body is in the prompt; the one held thing the stack PROVED touches this turn.
 *  - `digest` — a memory block rendered, but no look is in front of her in full (every held look, if
 *    there was one, collapsed to its settled one-liner).
 *  - `none` — no memory block at all this turn (no memory identity, or nothing held). */
export type ShortHotLook = 'full' | 'digest' | 'none';

/** Which pre-turn gates fired, as they were decided — nothing is re-derived here. */
export interface TurnTraceGates {
  /** The threading engine's own receipt for this turn (persona/threads.ts), or null when threading
   *  did not run at all (flag off, a group identity, or a read that failed). */
  threads: ThreadSelectReport | null;
  memory: { shortHotLook: ShortHotLook };
  extras: {
    /** A pending version note was woven into this reply (update/announce.ts). */
    updateNote: boolean;
    /** This turn carried the one-shot install introduction (agents/ops/firstMove.ts). */
    introWeave: boolean;
    /** Research already running for this chat when the turn started. */
    activeOps: number;
  };
}

/** Every reason a coerced field can differ from what the model wrote. Closed vocabulary, single
 *  source (the THEME_KINDS pattern), so a scan of the ring can bucket them:
 *  - `absent` / `null` — the model left it out, or wrote null, and the coercer defaulted it;
 *  - `parsed` — a numeric string became the number it names;
 *  - `clamped` — a number was rounded and/or pulled into 1-100;
 *  - `not_a_number` — the value could not be read as a number at all;
 *  - `truncated` — a string was cut to its cap;
 *  - `replaced` — an unknown enum value (or an unreadable one) became the default;
 *  - `dropped` — a threading field the coercer refused outright, leaving the field absent. */
export const STATUS_COERCION_REASONS = [
  'absent', 'null', 'parsed', 'clamped', 'not_a_number', 'truncated', 'replaced', 'dropped',
] as const;
export type StatusCoercionReason = typeof STATUS_COERCION_REASONS[number];

/** One field the coercer had to fix, and what it did. `from`/`to` are the model's own status values
 *  (mood words, gauges, its private note-to-self) — never prompt text. */
export interface StatusCoercion {
  field: string;
  from: unknown;
  to: unknown;
  reason: StatusCoercionReason;
}

/** The hidden affect envelope as it arrived and as it was read. `defaulted` is the interesting case:
 *  the reply carried no usable `status`, so everything downstream (mood continuity, the threading
 *  capture, the meta-prompt) ran on defaults — invisible in a bubble, obvious in a receipt. */
export interface TurnTraceAffect {
  source: 'emitted' | 'defaulted';
  rawEmitted: Record<string, unknown> | null;
  coerced: EmittedStatus | null;
  coercions: StatusCoercion[];
}

/** What the turn actually did. `silent` is settled at the boundary — see buildTurnTrace. */
export interface TurnTraceOutcome {
  /** The reply validated as the JSON bubble envelope. False means a garbled/legacy reply. */
  wasEnvelope: boolean;
  /** This pass IS the silent-turn retry (processConvoResult's one extra call). */
  retried: boolean;
  /** The turn put nothing on their screen and did nothing on their behalf. */
  silent: boolean;
  /** Tool names the model called this turn, in order. Names only — never their arguments. */
  toolCalls: string[];
}

/** The prompt, measured. `transcriptShare` is the transcript's slice of everything the model read —
 *  the number that says whether the conversation or the scaffolding is winning the context. */
export interface TurnTracePrompt {
  sections: PromptSection[];
  personaChars: number;
  /** The per-turn block only (`<prompt>…</prompt>`'s sections) — persona and anchors excluded. */
  dynChars: number;
  /** The trailing JSON envelope anchor. The behaviour anchor is a section in the list. */
  anchorChars: number;
  systemChars: number;
  messagesChars: number;
  transcriptRows: number;
  /** messagesChars / (systemChars + messagesChars), to four decimals. */
  transcriptShare: number;
}

/** The recorded detail — the shape that persists, and the single source for the draft below.
 *  Declared as a type literal rather than an interface on purpose: that is what lets it satisfy
 *  `record`'s `Record<string, unknown>` detail without a cast. */
export type TurnTraceDetail = {
  prompt: TurnTracePrompt;
  gates: TurnTraceGates;
  affect: TurnTraceAffect;
  hits: string[];
  outcome: TurnTraceOutcome;
  bubbles: BubbleReport;
};

/** Everything the Convo turn itself knows: the detail minus the one field only the send boundary
 *  can fill in. */
export type TurnTraceDraft = Omit<TurnTraceDetail, 'bubbles'>;

/** What convo/client.ts hands processConvoResult: the prompt it built and the reads behind it. */
export interface TurnTraceTurnInputs {
  prompt: MeasuredPrompt;
  messages: readonly TranscriptMessage[];
  gates: TurnTraceGates;
  /** Task 3's turn-focus hit labels — the held things this turn's prompt said touch the message. */
  hits: readonly string[];
}

// ── the coercion diff ────────────────────────────────────────────────────────

/** The only two fields coerceStatus can leave ABSENT rather than default (persona/status.ts: a
 *  wrong guess about a person's pending thing would invent a fact), so they are the only ones whose
 *  disappearance the diff has to look for by name. */
const DROPPABLE_FIELDS = ['thread_note', 'thread_outcome'] as const;

function reasonFor(from: unknown, to: unknown): StatusCoercionReason {
  if (from === undefined) return 'absent';
  if (from === null) return 'null';
  if (typeof to === 'number') {
    if (typeof from === 'number') return Number.isFinite(from) ? 'clamped' : 'not_a_number';
    const n = typeof from === 'string' ? Number(from) : NaN;
    return Number.isFinite(n) ? 'parsed' : 'not_a_number';
  }
  if (typeof from === 'string' && typeof to === 'string') {
    return to.length < from.length && from.startsWith(to) ? 'truncated' : 'replaced';
  }
  return 'replaced';
}

/**
 * Diff what the model wrote against what coerceStatus made of it — the receipt for every silent
 * repair on the affect path. PURE: it reads the two values it is given and coerces nothing itself,
 * so it can never disagree with the coercion that actually ran.
 *
 * An unusable envelope (no `status`, or a non-object one) reports the whole-object default as a
 * single `status` entry rather than seventeen field entries: nothing was emitted, so no field was
 * coerced — the object was.
 */
export function describeStatusCoercions(
  raw: Record<string, unknown> | null | undefined,
  coerced: EmittedStatus | null | undefined,
): StatusCoercion[] {
  if (!coerced) return [{ field: 'status', from: raw ?? null, to: null, reason: 'absent' }];
  const from = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const to = coerced as unknown as Record<string, unknown>;
  const out: StatusCoercion[] = [];
  // The coerced object IS the field list (it defaults everything it keeps), plus the two it can drop.
  for (const field of new Set<string>([...Object.keys(to), ...DROPPABLE_FIELDS])) {
    const wrote = from[field];
    const read = to[field];
    if (wrote === read) continue;
    if (read === undefined) {
      // null/absent is the sanctioned "not this turn" for the droppable fields — only a value the
      // coercer REFUSED is news.
      if (wrote == null) continue;
      out.push({ field, from: wrote, to: null, reason: 'dropped' });
      continue;
    }
    out.push({ field, from: wrote === undefined ? null : wrote, to: read, reason: reasonFor(wrote, read) });
  }
  return out;
}

// ── the builders ─────────────────────────────────────────────────────────────

function contentChars(content: string | readonly unknown[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce<number>((n, block) => {
    const text = (block as { text?: unknown } | null | undefined)?.text;
    return n + (typeof text === 'string' ? text.length : 0);
  }, 0);
}

function measurePrompt(prompt: MeasuredPrompt, messages: readonly TranscriptMessage[]): TurnTracePrompt {
  const systemChars = prompt.system.length;
  const messagesChars = messages.reduce((n, m) => n + contentChars(m.content), 0);
  const total = systemChars + messagesChars;
  return {
    sections: prompt.sections.slice(0, TRACE_SECTIONS_CAP).map(s => ({ name: s.name, chars: s.chars })),
    personaChars: prompt.personaChars,
    // Measured off the WHOLE list, so the cap above can only shorten the listing, never the sizes.
    dynChars: prompt.sections.reduce((n, s) => n + (isDynSection(s.name) ? s.chars : 0), 0),
    anchorChars: prompt.anchorChars,
    systemChars,
    messagesChars,
    transcriptRows: messages.length,
    transcriptShare: total > 0 ? Math.round((messagesChars / total) * 10_000) / 10_000 : 0,
  };
}

/**
 * Everything the Convo turn knows about itself, measured. PURE — every value is already decided by
 * the time this runs; nothing is fetched, no clock is read, and the inputs are not mutated.
 */
export function buildTurnTraceDraft(inputs: {
  turn: TurnTraceTurnInputs;
  affect: { raw: Record<string, unknown> | null | undefined; coerced: EmittedStatus | null | undefined };
  outcome: TurnTraceOutcome;
}): TurnTraceDraft {
  const { turn, affect, outcome } = inputs;
  return {
    prompt: measurePrompt(turn.prompt, turn.messages),
    gates: turn.gates,
    affect: {
      source: affect.coerced ? 'emitted' : 'defaulted',
      rawEmitted: affect.raw && typeof affect.raw === 'object' ? affect.raw : null,
      coerced: affect.coerced ?? null,
      coercions: describeStatusCoercions(affect.raw, affect.coerced),
    },
    hits: [...turn.hits],
    outcome: { ...outcome, toolCalls: [...outcome.toolCalls] },
  };
}

/**
 * The draft plus what actually shipped — the detail that gets recorded. PURE.
 *
 * `silent` is settled here, and the boundary has the last word: the Convo turn's own reading (no
 * text, no reaction, no action — the same condition the `convo:silent_turn` tripwire fires on) only
 * stands if nothing came out the other end either. A turn whose bubbles went out is never silent,
 * whatever the turn thought it produced.
 */
export function buildTurnTrace(inputs: { draft: TurnTraceDraft; bubbles: BubbleReport }): TurnTraceDetail {
  const { draft, bubbles } = inputs;
  return {
    prompt: { ...draft.prompt, sections: [...draft.prompt.sections] },
    gates: draft.gates,
    affect: draft.affect,
    hits: [...draft.hits],
    outcome: { ...draft.outcome, silent: draft.outcome.silent && bubbles.count === 0 },
    bubbles,
  };
}

// ── the flag and the emit ────────────────────────────────────────────────────

/**
 * The feature gate (env: TURN_TRACE_ENABLED). Default ON, read at CALL time so flipping it needs no
 * restart — the same parse shape as every sibling flag (threadingEnabled, turnFocusBlockEnabled,
 * relationshipClimateEnabled).
 *
 * Subordinate to DIAGNOSTICS_ENABLED, which `record` already honors: this switch turns off ONE
 * event, and off means the draft is never built either (processConvoResult checks it too), so the
 * turn does exactly the work it did before this record existed.
 */
export function turnTraceEnabled(): boolean {
  const v = (process.env.TURN_TRACE_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * File the turn's receipt. Called from the send boundary (src/index.ts) and nowhere else — that is
 * the only point that knows both halves, and calling it once there is what makes the event
 * per-turn.
 *
 * A missing draft is not an event: the command fast paths (/help, /clear, /forget me) never build a
 * prompt or reach the model, so there is nothing to attribute. Never throws — diagnostics must not
 * be able to break a reply that already went out.
 */
export function recordTurnTrace(
  draft: TurnTraceDraft | undefined,
  ctx: { chatId: string; handle?: string; bubbles: BubbleReport },
): void {
  if (!draft || !turnTraceEnabled()) return;
  try {
    record({
      type: 'event',
      label: TURN_TRACE_LABEL,
      chatId: ctx.chatId,
      handle: ctx.handle,
      detail: buildTurnTrace({ draft, bubbles: ctx.bubbles }),
    });
  } catch (err) {
    console.error('[diagnostics] turn:trace failed', err);
  }
}

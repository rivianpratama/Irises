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
import { TURN_TRACE_LABEL } from './traceLabels.js';
import type { BubbleReport } from '../pipeline/bubbleJson.js';
import type { EmittedStatus } from '../persona/status.js';
import type { RelevanceHitKind } from '../memory/relevance.js';
import type { RoutingGateDecision } from '../agents/routingGate.js';
import type { ThreadSelectReport } from '../persona/threads.js';

/**
 * The trace label, in one place — the dashboard and any later reader match on this string. It is
 * DEFINED in ./traceLabels.js, a module with no imports, and re-exported here so that every reader
 * of this file keeps naming it in the same place: importing the label alone should not pull `record`
 * and the two db repositories behind it (see that file's header).
 */
export { TURN_TRACE_LABEL };

/**
 * Hard bound on the recorded section list. A build can carry at most one entry per section id
 * (SECTION_IDS, currently 21), so this can never fire on an assembled prompt — it exists so a future
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
 *  - `digest` — a memory block rendered and no look is in front of her in full. Read it as exactly
 *    that and no more: the call site (convo/client.ts) sees only whether the assembled context block
 *    came back non-empty — dossier plus tiers — which it is on essentially every turn with a memory
 *    identity, so this is NOT a claim that a look was held and collapsed to its one-liner.
 *    Distinguishing those needs `buildContextBlockWithHot` to report the short tier's own verdict; it
 *    is a two-line widening in memory/wrappers.ts, for whenever a task owns that file.
 *  - `none` — no memory block at all this turn (no memory identity, or nothing held). */
export type ShortHotLook = 'full' | 'digest' | 'none';

/** One held thing the turn relevance router found touching this message (memory/relevance.ts), as
 *  the receipt carries it: what it is called, and which channel it came off. The label is already
 *  clipped to the width the turn-focus block renders, which is what keeps this bounded — see the
 *  header on what may persist for 30 days. */
export interface MemoryHit {
  label: string;
  kind: RelevanceHitKind;
}

/**
 * The memory blocks the gate table decides about, one receipt each. Single-sourced array → type
 * (the THEME_KINDS pattern). Where each is decided:
 *   `emails` `notes` `facts` `long` `directives` — memory/wrappers.ts, while rendering;
 *   `clarification` — memory/dossier.ts (the steering-question marker);
 *   `update_note` — agents/convo/client.ts (whether the pending version note was claimed at all).
 *
 * Two memory blocks are deliberately absent. The short tier's research look has had its own gate
 * since before this table and reports through `shortHotLook` above. The discovery scaffold has no
 * gate at all: what it renders is a function of which slots are still open, never of the turn.
 */
export const MEMORY_GATE_BLOCKS = [
  'emails', 'notes', 'facts', 'long', 'directives', 'clarification', 'update_note',
] as const;
export type MemoryGateBlock = typeof MEMORY_GATE_BLOCKS[number];

/** How much of a block reached the model: everything it holds, a shortened stand-in for some or all
 *  of it, or nothing at all. `dropped` and the reason say which — a block reporting `dropped` with
 *  `nothing_held` had nothing to render in the first place. */
export type MemoryGateVerdict = 'full' | 'digest' | 'dropped';

/** Why a block landed where it did. Closed vocabulary, disjoint per decision, so a scan of the ring
 *  can bucket a month of turns:
 *  - `nothing_held` — the block had no content this turn (and so no gate to run);
 *  - `kept_always` — the block is not gated on the turn at all (medium facts);
 *  - `all_kept` — everything it holds qualified and rendered in full;
 *  - `partly_kept` — some of it qualified; the rest was shortened or left out;
 *  - `none_kept` — nothing it holds qualified, so all of it is standing in as a digest;
 *  - `short_turn` — kept because the turn was too thin to gate on (the fail-open path);
 *  - `ttl_expired` — the marker aged out before the gate was reached;
 *  - `gap_open` — a real opening in the conversation, so the note was claimed;
 *  - `mid_conversation` — no opening, so the claim was left for a later turn. */
export const MEMORY_GATE_REASONS = [
  'nothing_held', 'kept_always', 'all_kept', 'partly_kept', 'none_kept',
  'short_turn', 'ttl_expired', 'gap_open', 'mid_conversation',
] as const;
export type MemoryGateReason = typeof MEMORY_GATE_REASONS[number];

/** One block's verdict for this turn. `dropped` counts held items that reached the prompt in no
 *  form at all — a cap or a gate left them out — and is absent where the block cannot drop one. */
export interface MemoryGateReport {
  verdict: MemoryGateVerdict;
  reason: MemoryGateReason;
  dropped?: number;
}

/** The gate table's receipt: a report per block that actually ran a gate. EMPTY when
 *  CONVO_MEMORY_RELEVANCE is off — no gate ran, so the receipt claims nothing rather than claiming
 *  a decision nobody made. */
export type MemoryGateReports = Partial<Record<MemoryGateBlock, MemoryGateReport>>;

/** Which pre-turn gates fired, as they were decided — nothing is re-derived here. */
export interface TurnTraceGates {
  /** The threading engine's own receipt for this turn (persona/threads.ts), or null when threading
   *  did not run at all (flag off, a group identity, or a read that failed). */
  threads: ThreadSelectReport | null;
  memory: {
    shortHotLook: ShortHotLook;
    /** Everything the memory stack held that touched this turn, best first — the router's whole
     *  ranked set, not only the two the turn-focus block had room to print (`hits` on the detail is
     *  what the block actually said). Empty is the interesting reading, and it fires on every turn:
     *  a full memory stack in front of her with nothing in it about the message in hand. Empty also
     *  on a turn the router could not read (a caption-less media turn, where every gate fails open
     *  but nothing counts as evidence) and on every turn with CONVO_MEMORY_RELEVANCE off. */
    hits: MemoryHit[];
    /** What each gated memory block did with what it held — the gate table's own receipt. Every
     *  block that ran a gate reports, including the ones that changed nothing, so "she never saw
     *  the note" and "there was no note" are different readings. Empty with the flag off. */
    blocks: MemoryGateReports;
  };
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
  /** The status object VERBATIM, whatever the model put there — including keys the schema never
   *  named. Nothing here bounds its size: `trunc` in trace.ts is governed by DIAGNOSTICS_STR_CAP,
   *  whose default is 0 = unlimited, so a model that writes a 10k `meta_prompt` (or invents fields)
   *  persists all of it for 30 days. The cap is available rather than applied; if
   *  diagnostic_turn_history ever grows unexpectedly, this is the first place to look — the hit
   *  labels beside it are bounded at both ends (RELEVANCE_HITS_MAX entries, each clipped to
   *  TURN_FOCUS_LABEL_CHARS by the router that produces them). */
  rawEmitted: Record<string, unknown> | null;
  /** The same status as READ — every string here is already capped by coerceStatus (600/400). */
  coerced: EmittedStatus | null;
  coercions: StatusCoercion[];
}

/** What the turn actually did. `silent` is settled at the boundary — see buildTurnTrace. */
export interface TurnTraceOutcome {
  /** The reply validated as the JSON bubble envelope. False means a garbled/legacy reply. */
  wasEnvelope: boolean;
  /** The silent-turn floor's one extra call was SPENT on this turn — either this pass IS that retry,
   *  or it was tried here and the call died into the voiced floor. Reads the same as the
   *  `convo:silent_turn` event's `recovery: 'retry'`, which is the point: a spent recovery is never
   *  invisible in the receipt. */
  retried: boolean;
  /** The turn put nothing on their screen and did nothing on their behalf. */
  silent: boolean;
  /** The unkept-promise guard fired on this turn (convo/unkeptPromise.ts): the reply promised work
   *  with no tool call and nothing running, so it got its one corrective re-ask. Set ONLY when it
   *  fired — absence means it did not, and the receipt that carries the phrase and how the re-ask
   *  landed is the always-on `convo:unkept_promise` event, not this field. */
  unkeptPromise?: boolean;
  /** Which way the routing floor went on this turn (agents/routingGate.ts), set on every turn it was
   *  EVALUATED on and absent on the turns that never reached it (a delegation the model already
   *  built, the recall second pass, no memory identity). One name, so a scan of the ring can bucket
   *  a month of turns by it; the always-on `convo:routing_gate` event carries the hits behind the
   *  decision, which is where "she held two notes about this and it delegated anyway" is read. */
  routingGate?: RoutingGateDecision;
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
  /** The turn-focus block's hit labels — the held things the PROMPT said touch the message, in the
   *  order and number it printed them (convo/client.ts slices to TURN_FOCUS_MAX_HITS). Distinct
   *  from `gates.memory.hits`, which is everything the router found: this is what she was actually
   *  shown, that is what there was to show. */
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
 *
 * COPYING, stated so it can't be read as an accident: every container this function owns is rebuilt
 * (prompt, its section list, gates and both of its leaves, affect and its coercion list, hits,
 * outcome), so a draft mutated afterwards can never change a detail already built from it. Three
 * payloads pass through by reference — `gates.threads` (the selection engine's finished report),
 * `affect.rawEmitted` and `affect.coerced` (the model's own status objects) — because they are
 * settled values owned elsewhere and deep-cloning a foreign shape here would go stale the moment
 * that shape changed. Nothing downstream aliases them either way: `record` (diagnostics/trace.ts)
 * rebuilds the whole detail through `trunc` before it enters the ring.
 */
export function buildTurnTrace(inputs: { draft: TurnTraceDraft; bubbles: BubbleReport }): TurnTraceDetail {
  const { draft, bubbles } = inputs;
  return {
    prompt: { ...draft.prompt, sections: [...draft.prompt.sections] },
    gates: {
      threads: draft.gates.threads,
      memory: {
        ...draft.gates.memory,
        hits: draft.gates.memory.hits.map(h => ({ ...h })),
        blocks: Object.fromEntries(
          Object.entries(draft.gates.memory.blocks).map(([block, report]) => [block, { ...report }]),
        ) as MemoryGateReports,
      },
      extras: { ...draft.gates.extras },
    },
    affect: { ...draft.affect, coercions: draft.affect.coercions.map(c => ({ ...c })) },
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

// What the live batteries are allowed to assume about the engine — one import surface, zero
// retyped numbers.
//
// A battery scores a running instance off its receipts, so every number and every field name it
// compares against is a claim about code it cannot see. Retyped, those claims rot silently: a
// renamed receipt field or a tightened ceiling turns into a mis-scored round that still exits 0,
// which is worse than no battery at all. Everything a battery asserts against therefore comes
// through here, and here imports it from `src/` — so a rename upstream is a compile error in an
// editor (and in the batteries' own `*.test.ts`) rather than a quiet pass.
//
// TYPE-ONLY where the battery only needs the SHAPE of a receipt, VALUE where it has to compare a
// number. That split is the whole design: a type-only re-export costs nothing at runtime, and a
// value re-export is a deliberate statement that some battery does arithmetic with it.
//
// This file holds no logic and no thresholds of its own. The one thing it adds is the PROSE / DATA
// split over `PROMPT_BUDGET` (below), which is not a new number — it is a reading of promptPolicy's
// own comment about which of its ceilings a LIVE turn may legitimately exceed.
//
// Not a `*.test.ts`, and imported by files that are not either: `npm test` only ever reaches this
// module through `focusBattery.test.ts`, which exercises the pure scorers and touches no service.

// ── the bubble law (pipeline/bubbleJson.ts, pipeline/bubbles.ts) ─────────────────────────────────
// `BubbleReport` is what the send boundary files on every delivered reply; the two constants are
// what the model was TOLD. A battery compares the report against them.
export { BUBBLE_LAW_MAX, BUBBLE_HARD_CAP } from '../../src/pipeline/bubbleJson.js';
export type { BubbleReport } from '../../src/pipeline/bubbleJson.js';
export { MAX_BUBBLE_WORDS } from '../../src/pipeline/bubbles.js';

// ── the prompt's shape and its ceilings (agents/convo/promptSections.ts, promptPolicy.ts) ────────
export { SECTION_IDS } from '../../src/agents/convo/promptSections.js';
export type { SectionId, PromptSection } from '../../src/agents/convo/promptSections.js';
export { PROMPT_BUDGET, MIN_TRANSCRIPT_SHARE } from '../../src/agents/convo/promptPolicy.js';
export type { BudgetKey } from '../../src/agents/convo/promptPolicy.js';

// ── the threading engine's clocks and its receipt (persona/threads.ts) ───────────────────────────
// The three clocks a battery has to know about because they decide whether a probe could POSSIBLY
// have surfaced anything: below the turn gate no theme is even considered, below the opening gap no
// loop is, and inside the quiet window a loop is not yet askable. A probe scored without checking
// them reads "nothing leaked" off a turn where nothing could have.
export {
  THREAD_MIN_TURNS_BETWEEN_OFFERS,
  LOOP_OPENING_GAP_MS,
  LOOP_QUIET_MS,
} from '../../src/persona/threads.js';
export type { ThreadSelectReport, ThreadHarvestReport, ThreadTheme, OpenLoop } from '../../src/persona/threads.js';

// ── the per-turn receipt (diagnostics/turnTrace.ts) ──────────────────────────────────────────────
// NOTE: this is the one VALUE import here that pulls a runtime chain behind it —
// diagnostics/turnTrace.js imports `record`, which reaches the db layer, so merely importing a
// battery prints the driver line. Worth it: the label is the string the SQL and the ring filter
// match on, and a battery that retypes it scores an empty round as clean.
export { TURN_TRACE_LABEL } from '../../src/diagnostics/turnTrace.js';
export type {
  TurnTraceDetail,
  MemoryGateBlock,
  MemoryGateReason,
  MemoryGateReport,
  MemoryGateReports,
  MemoryGateVerdict,
  MemoryHit,
  ShortHotLook,
} from '../../src/diagnostics/turnTrace.js';

import { PROMPT_BUDGET, type BudgetKey } from '../../src/agents/convo/promptPolicy.js';

/**
 * The one trace label a battery reads that `src/` does not name in a constant of its own — it is a
 * literal at the `record` call in memory/threadHarvest.ts. Retyped HERE, once, so that when it grows
 * a constant this is the single line to re-point; `TURN_TRACE_LABEL` above is what that looks like
 * once it has one.
 */
export const THREADS_SELECT_LABEL = 'threads:select';

/**
 * The `PROMPT_BUDGET` keys a LIVE round may score, and the ones it may only report.
 *
 * promptPolicy.ts says it plainly about its own table: the numbers are measured on five fixtures,
 * and "a real turn whose dossier is longer than the fixture's is not an error". So a live battery
 * has to split the table in two, exactly the way that comment does:
 *
 *   • PROSE keys are turn-INDEPENDENT — the persona, the anchors, the generated status contract, the
 *     fixed lines. Their size is a property of the checkout, not of the turn, so a live overshoot
 *     means the prose grew (or the instance is running an older binary than the tree that measured
 *     it). Those are scored.
 *   • DATA keys grow with the person, not with the editing: the dossier and its memory stack, a
 *     burst of three messages, two looks in flight, a tapped reply. A live turn legitimately carries
 *     more than a fixture, so an overshoot is REPORTED with the number and never failed.
 *
 * `memory_stack` sits with the data keys and is not readable from the receipt at all — it is a part
 * of `context_block`, not a section of its own — so nothing reads it out here; it stays in the union
 * only because it is a `BudgetKey` and this split has to cover all of them. focusBattery.test.ts
 * pins that these two sets partition `PROMPT_BUDGET`, so a key added upstream cannot land
 * unclassified.
 */
export const DATA_BUDGET_KEYS: readonly BudgetKey[] = [
  'context_block', 'memory_stack', 'burst', 'group', 'active_ops', 'tapped_reply',
  // Host-dependent by promptPolicy's own note: its text is built from the resolved model map, so a
  // bare checkout and a configured install legitimately differ.
  'model_map',
  // The tool set differs by deployment (the group lane carries 13 tools, the 1:1 lane 11), so this
  // is a property of the install rather than of the prose.
  'tool_docs',
];

const DATA_KEYS: ReadonlySet<string> = new Set(DATA_BUDGET_KEYS);

/** Every other budget key: the ceilings a live turn is held to. */
export const PROSE_BUDGET_KEYS: readonly BudgetKey[] =
  (Object.keys(PROMPT_BUDGET) as BudgetKey[]).filter(k => !DATA_KEYS.has(k));

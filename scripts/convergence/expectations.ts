// What the live batteries are allowed to assume about the engine — one import surface, zero
// retyped numbers.
//
// A battery scores a running instance off its receipts, so every number and every field name it
// compares against is a claim about code it cannot see. Retyped, those claims rot silently: a
// renamed receipt field or a tightened ceiling turns into a mis-scored round that still exits 0,
// which is worse than no battery at all. Everything a battery asserts against therefore comes
// through here, and here imports it from `src/` — so a rename upstream breaks something loudly
// instead of passing quietly. Exactly what breaks, because half-true guarantees are how this rots:
// a renamed VALUE fails `npm test` at import time, and a renamed TYPE fails
// `npm run typecheck:scripts` (tsconfig.scripts.json). Plain `npx tsc --noEmit` does NOT see this
// file — the repo tsconfig's `include` is `src/**/*` — and `npm test` runs tsx, which strips types
// rather than checking them, so neither of those two catches a renamed type on its own.
//
// TYPE-ONLY where the battery only needs the SHAPE of a receipt, VALUE where it has to compare a
// number. That split is the whole design: a type-only re-export costs nothing at runtime, and a
// value re-export is a deliberate statement that some battery does arithmetic with it.
//
// Everything below is imported by a battery or by one of the two battery test files
// (focusBattery.test.ts, hookBattery.test.ts). A surface nobody reads from is how a re-export
// outlives the thing it was for, so when a name here stops being used, delete it — the import it
// stands in for is one line away in `src/`.
//
// This file holds no logic and no thresholds of its own. The one thing it adds is the PROSE / DATA
// split over `PROMPT_BUDGET` (below), which is not a new number — it is a reading of promptPolicy's
// own comment about which of its ceilings a LIVE turn may legitimately exceed.
//
// Not a `*.test.ts`, and imported by files that are not either: `npm test` only ever reaches this
// module through `focusBattery.test.ts` and `hookBattery.test.ts`, which exercise the pure scorers
// and touch no service.

// ── the bubble law (pipeline/bubbleJson.ts, pipeline/bubbles.ts) ─────────────────────────────────
// `BubbleReport` is what the send boundary files on every delivered reply; the two constants are
// what the model was TOLD. A battery compares the report against them.
export { BUBBLE_LAW_MAX, BUBBLE_HARD_CAP } from '../../src/pipeline/bubbleJson.js';
export { MAX_BUBBLE_WORDS } from '../../src/pipeline/bubbles.js';

// ── the prompt's shape and its ceilings (agents/convo/promptSections.ts, promptPolicy.ts) ────────
export { SECTION_IDS } from '../../src/agents/convo/promptSections.js';
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
// The label is the string the SQL and the ring filter match on, so it is imported rather than
// retyped — a battery that retypes it scores an empty round as clean. From the LEAF module that
// defines it (diagnostics/traceLabels.ts), not from turnTrace.ts, which re-exports it: turnTrace
// imports `record`, which reaches db/client and db/sqlite, and taking the label from there made
// `npm test` print the driver banner and a SQLite warning for a battery that opens no store.
// focusBattery.test.ts pins that, off require.cache.
export { TURN_TRACE_LABEL } from '../../src/diagnostics/traceLabels.js';
export type { TurnTraceDetail, MemoryGateBlock, MemoryGateReports } from '../../src/diagnostics/turnTrace.js';

// ── the rhythm engine's receipts (diagnostics/traceLabels.ts) ────────────────────────────────────
// The five labels hookBattery.ts matches on, from the same leaf and for the same reason as
// TURN_TRACE_LABEL above: a battery that retyped one would score an empty round as clean the first
// time it was renamed. All five are constants at their `record` call sites now (agents/convo's
// client.ts, shared.ts and idleClassify.ts), so there is nothing left here to retype.
export {
  HOOKS_SELECT_LABEL,
  IDLE_CLASSIFY_LABEL,
  QUIET_GUARD_LABEL,
  HOOK_OFF_TURN_LABEL,
  MOMENTS_OFFER_LABEL,
} from '../../src/diagnostics/traceLabels.js';

// ── the rhythm engine's numbers and vocabulary (persona/hooks.ts) ────────────────────────────────
// VALUES, every one of them, because hookBattery does arithmetic with all four: the run limit is
// how many seed turns the kill-switch probe has to fill the ledger with, the word list is what a
// receipt's `emitted` is checked against, the quiet ceiling is what a forced-quiet reply is measured
// by, and the moment interval is how far apart two offers must sit before a round can test the
// 24-hour no-repeat at all. Retyped, each of them would be a threshold that silently stopped
// describing the engine — a "clean" round measuring a rule nobody enforces any more.
export {
  HOOK_WORDS,
  HOOK_RUN_LIMIT,
  QUIET_MAX_WORDS,
  MOMENT_IDLE_INTERVAL,
} from '../../src/persona/hooks.js';
export type {
  HookWord,
  HookKind,
  HookMode,
  HookSelectReason,
  HookSelectReport,
} from '../../src/persona/hooks.js';

// ── the idle gate (persona/idle.ts) ──────────────────────────────────────────────────────────────
// A VALUE, because the battery has to be able to say which of its probes the English fast path can
// answer on its own: a stall the examples already hold could never exercise the classify layer, and
// a probe aimed at layer 3 has to be written against a token that is NOT in this list. The list is
// documented upstream as examples rather than a law, and the battery treats it as exactly that.
export { LEAF_EXAMPLES } from '../../src/persona/idle.js';
export type { IdleLayer, IdleVerdict } from '../../src/persona/idle.js';

// ── the moment store's one clock (persona/moments.ts) ────────────────────────────────────────────
// A VALUE: the "never offered twice" probe divides it to print a window in hours, and the sentence
// it prints is the instruction an operator acts on.
export { MOMENT_RECENT_EXCLUDE_MS } from '../../src/persona/moments.js';

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
 * promptPolicy.ts says it plainly about its own table: the numbers are measured on seven fixtures,
 * and "a real turn whose dossier is longer than the fixture's is not an error". So a live battery
 * has to split the table in two, exactly the way that comment does:
 *
 *   • PROSE keys are turn-INDEPENDENT — the persona, the anchors, the generated status contract, the
 *     fixed lines. Their size is a property of the checkout, not of the turn, so a live overshoot
 *     means the prose grew (or the instance is running an older binary than the tree that measured
 *     it). Those are scored.
 *   • DATA keys grow with the person, not with the editing: the dossier and its memory stack, a
 *     burst of three messages, two looks in flight, a tapped reply. A live turn legitimately carries
 *     more than a fixture, so an overshoot is REPORTED with the number and never failed. Reported
 *     where: focusBattery's `memory_ceiling` prints every one of these keys that the receipt carries,
 *     with its ceiling beside it, and warns (never fails) on an overshoot. A promise like this one is
 *     worth nothing unless some check keeps it — it used to read `context_block` alone.
 *
 * `memory_stack` sits with the data keys and is not readable from the receipt at all — it is a part
 * of `context_block`, not a section of its own — so nothing reads it out here; it stays in the union
 * only because it is a `BudgetKey` and this split has to cover all of them. focusBattery.test.ts
 * pins that these two sets partition `PROMPT_BUDGET`, so a key added upstream cannot land
 * unclassified.
 */
export const DATA_BUDGET_KEYS: readonly BudgetKey[] = [
  'context_block', 'memory_stack', 'burst', 'group', 'active_ops', 'tapped_reply',
  // Her one read on this person, written per person by the weekly pass (memory/thesisEngine.ts).
  // Two to four sentences about somebody with nine months of history is legitimately longer than
  // two to four about somebody with three weeks, so an overshoot here is a fact about them and is
  // reported with its number rather than failed.
  'thesis',
  // Host-dependent by promptPolicy's own note: its text is built from the resolved model map, so a
  // bare checkout and a configured install legitimately differ.
  'model_map',
  // Same reason, one line further down the prompt: the running build's sha and branch, and whether
  // this install checks at all. A live turn on somebody's feature branch legitimately measures wider
  // than a fixture on `main`.
  'update_status',
  // The tool set differs by deployment (the group lane carries 14 tools, the 1:1 lane 12), so this
  // is a property of the install rather than of the prose.
  'tool_docs',
];

const DATA_KEYS: ReadonlySet<string> = new Set(DATA_BUDGET_KEYS);

/** Every other budget key: the ceilings a live turn is held to. */
export const PROSE_BUDGET_KEYS: readonly BudgetKey[] =
  (Object.keys(PROMPT_BUDGET) as BudgetKey[]).filter(k => !DATA_KEYS.has(k));

// What the Convo prompt is ALLOWED to be — today's sizes, today's rule statements, today's
// duplication, all written down in one place.
//
// Convo's system prompt is ~180k characters, of which ~146k is the persona. Every block in it was
// added by someone with a good reason, and nothing has ever said no. This module is the "no": a set
// of numbers and phrases measured against the live assembler, held by three tests
// (promptBudget.test.ts, promptPolicy.test.ts, clauseInventory.test.ts).
//
// It ENFORCES NOTHING AT RUNTIME. No prompt path reads any of this — the assembler will happily
// build a prompt twice this size, and a real turn whose dossier is longer than the fixture's is not
// an error. These are test-time ceilings measured on five representative turns, so the failure they
// produce is "a prose block grew since someone last looked", which is exactly the failure that has
// no other detector.
//
// Its whole design point is that TIGHTENING IS A ONE-LINE DIFF. P0 (this task) measures and pins.
// P1 deletes the duplicated clauses and drops the counts in CLAUSE_INVENTORY; the later phases pull
// the PROMPT_BUDGET numbers down as the prose shrinks. Nothing here is an aspiration — every number
// is a measurement, and the comment beside a number says which fixture produced it.

import type { SectionId } from './promptSections.js';

/** A budget line: every part of the assembled prompt (promptSections.ts SECTION_IDS — which already
 *  includes `persona`, `behavior_anchor` and `json_anchor`), plus the one part that is not a section
 *  of its own. */
export type BudgetKey = SectionId | 'memory_stack';

/**
 * The size each part of the prompt stands at TODAY, in characters — measured through the real
 * `buildSystemPromptSections` on the five fixtures in promptBudget.test.ts (cold thin profile ·
 * mature profile with a plain question · media turn · burst + tapped reply in a group · thread
 * offer), then rounded UP to a tidy number.
 *
 * How much headroom: at most 5%, and much less than that on the big prose blocks, where 5% would be
 * thousands of characters — i.e. room for a whole new section to arrive unnoticed, which is the thing
 * this table exists to notice. `persona` therefore carries ~150 characters of slack: a sentence added
 * to Context.md is meant to fail here and be ratcheted deliberately, not absorbed.
 *
 * `model_map` is the one deliberate exception, at ~2× its measured size: its text is built from the
 * host's resolved model map (MODELS/PROVIDERS plus whatever engine discovery found), so a bare
 * checkout and a configured install legitimately differ. A tight ceiling there would fail on somebody
 * else's machine and teach everyone to ignore the test.
 *
 * `memory_stack` is the wrapped memory tiers inside `context_block` (memory/wrappers.ts:
 * preamble → short → medium → discovery → flexible). It has its own line because it is the part that
 * grows with USE rather than with editing — every look, note and directive lands in it — and because
 * a `context_block` ceiling alone cannot say whether the dossier or the tiers moved.
 *
 * The data-shaped sections (`context_block`, `memory_stack`, `burst`, `group`, `active_ops`,
 * `tapped_reply`) are measured on their fixture's data, so changing a fixture re-measures the number
 * rather than breaking the test's meaning. The prose-shaped ones (`persona`, both anchors,
 * `intro_weave`, `weather`, `thread`, `turn_focus`, the timing reads) are the ratchet proper.
 */
export const PROMPT_BUDGET: Record<BudgetKey, number> = {
  persona: 146_000,            // 145,851 — Context.md, every fixture
  tool_docs: 16_500,           // 16,288 — the group fixture (13 tools; the 1:1 lane carries 11)
  capability: 248,             // 237 — all six capability classes minus inbox, the longest line
  model_map: 800,              // 387 on a bare checkout — HOST-DEPENDENT, see above
  name_nudge: 171,             // 163 — fixed prose
  intro_weave: 795,            // 760 — INTRO_WEAVE_BLOCK (agents/ops/firstMove.ts)
  context_block: 12_500,       // 12,290 — the cold fixture (a thin profile is not a small prompt)
  active_ops: 2_040,           // 1,946 — two looks in flight, one queued
  group: 109,                  // 104 — a named group, three participants
  tapped_reply: 2_290,         // 2,190 — kind 'assistant' beyond the visible window (the largest of the four)
  burst: 1_160,                // 1,110 — three messages, group-labelled
  current_time: 305,           // 291 — fixed prose plus the formatted instant
  weather: 2_700,              // 2,581 — affect + cycle + circadian + a moved climate
  thread: 1_270,               // 1,211 — a pattern-rung theme offer plus a loop outcome ask
  conversation_timing: 278,    // 266 — the widest of the gap/regime readings on these fixtures
  reply_order: 640,            // 613 — renderArrivalGap (the backward-order variant, the larger one)
  extra: 610,                  // 583 — the pending version note (update/announce.ts)
  turn_focus: 570,             // 544 — a 400-char restatement plus two hits
  behavior_anchor: 1_740,      // 1,659 — the persona retelling at the recency edge
  json_anchor: 3_050,          // 2,908 — the envelope contract, last in the prompt
  memory_stack: 12_500,        // 12,290 — the cold stack (discovery + default stance), the biggest measured
};

/**
 * The floor under the live conversation's slice of everything the model reads —
 * `messagesChars / (systemChars + messagesChars)`, the same number the per-turn receipt reports
 * (diagnostics/turnTrace.ts).
 *
 * Measured at **0.0066** on the mature fixture — a full 40-row window against a 182k-character
 * prompt — and pinned a hair below it. Read that number twice: two thirds of one percent of what the
 * model reads is the actual conversation. That is the finding this whole phase exists to move, and
 * the floor is what stops it moving the wrong way in the meantime.
 *
 * It rises as the prose shrinks, so this line ratchets UP in the later phases while PROMPT_BUDGET
 * ratchets down.
 */
export const MIN_TRANSCRIPT_SHARE = 0.0065;

/**
 * Phrases that must exist in the persona, verbatim — the rules whose deletion would be silent.
 *
 * Every one of these was ADDED to Context.md deliberately (see the commits behind "Predict, don't
 * interview", the banter frame and the three-check gate), and every one of them is a behaviour the
 * live thread depends on. Prose has no test, so a rewrite that drops a clause looks like a tidy-up in
 * review. These strings are that test: promptPolicy.test.ts checks each one against
 * `loadContext('convo')` and names the id that went missing.
 *
 * A phrase here is an ANCHOR, not a quotation of the whole rule: the shortest fragment that could
 * only come from that clause. Rewording the paragraph around it is fine and expected; losing the
 * anchor means the rule itself is gone, or has been paraphrased into something that no longer says
 * the same thing. If you meant to change it, change it here in the same commit.
 */
export const RULE_ANCHORS: Array<{ id: string; personaAnchor: string }> = [
  // Guess before you ask — the default for every open turn (Context.md ~581).
  { id: 'predict_dont_interview', personaAnchor: "Predict, don't interview — a guess from your model of them is how knowing them shows." },
  // …and when something genuinely must be resolved, it still lands as a statement (~589).
  { id: 'probe_as_statement', personaAnchor: "The probe wears a statement's clothes." },
  // The three-check gate every remembered thing passes before it reaches a bubble (~572).
  { id: 'three_check_gate', personaAnchor: 'The gate — run three checks before any memory enters a bubble' },
  // The play frame: a tease carries the real layer AND the play layer (~652).
  { id: 'banter_play_frame', personaAnchor: 'Banter — the play frame.' },
  // The four safe bends, which is what keeps teasing off their wound (~654).
  { id: 'four_safe_bends', personaAnchor: 'Four bends that stay safe' },
  // Their read of the joke outranks hers, immediately (~662).
  { id: 'response_overrules', personaAnchor: 'Their response overrules your framing, instantly.' },
  // Rich memory plus "hey" still equals "hey" (~667).
  { id: 'greeting_gets_greeting', personaAnchor: 'A greeting gets a greeting.' },
  // The threading default, stated as a default rather than a fallback (~648).
  { id: 'when_unsure_dont', personaAnchor: "When unsure, don't" },
];


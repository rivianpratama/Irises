// The Convo system prompt, named by section.
//
// buildSystemPromptSections (agents/convo/shared.ts) assembles the front-line prompt out of a fixed
// vocabulary of parts; this module owns their NAMES, the type derived from those names, and the
// arithmetic that turns a measured section list back into the assembled length. Nothing here renders
// anything or knows what a section says — it is deliberately tiny and near dependency-free (one
// import, for the wrapper tag) so the per-turn trace and the prompt-budget test can measure the
// prompt without importing the 1.7k-line assembler.

import { PROMPT_TAG } from '../../llm/promptTag.js';

/**
 * The sections assembled INSIDE `<prompt>…</prompt>`, in the exact order the assembler pushes them.
 * The order is load-bearing twice over: charter §11.3's placement rule (static first, volatile
 * per-turn data last) IS this order, and the size arithmetic below counts the `\n\n` joins between
 * whichever of them actually rendered. Every entry is conditional except `model_map` and
 * `current_time`, so a real build carries a subsequence of this list, never all of it.
 *
 * `turn_focus` is last on purpose and must STAY last: it restates the message the whole prompt is
 * there to answer, and the recency edge is what makes it a counterweight rather than one more voice
 * in the pile (convo/turnFocus.ts). A new section belongs before it, never after.
 */
export const DYN_SECTION_IDS = [
  'tool_docs',            // renderToolDocs — under toolsViaJson, the model's only view of its tools
  'capability',           // renderCapabilityLine — what the deep look can do this deployment
  'model_map',            // renderModelMapAwareness — unconditional
  'name_nudge',           // "Getting their name" — no name on file yet
  'intro_weave',          // the one-shot install introduction (agents/ops/firstMove.ts)
  'context_block',        // buildContextBlock — the dossier plus the wrapped memory tiers
  'active_ops',           // renderActiveOps — research already running for this chat
  'group',                // "Group chat"
  'tapped_reply',         // whichever ONE of the four ResolvedReply kinds rendered
  'burst',                // the numbered incoming messages of a burst
  'current_time',         // unconditional
  'weather',              // renderStatusForPrompt — affect + cycle/circadian + climate
  'status_contract',      // renderStatusContract — the hidden envelope's fields, where weather points
  'thread',               // renderThreadForPrompt — the one standing thread on offer
  'conversation_timing',  // renderConversationTiming
  'reply_order',          // renderArrivalGap OR renderReplyOrder — never both
  'extra',                // the caller's addendum (`extraSection`)
  'turn_focus',           // renderTurnFocus — LAST, always: what they just said and what touches it
] as const;

/**
 * Every part of the assembled prompt, in assembly order: the static persona head, the dyn sections
 * inside the wrapper, then the two anchors that bookend it after `</prompt>`. The persona and the
 * anchors are not dyn sections — they frame the block rather than living in it — but they are the
 * two biggest costs in the prompt, so the budget test needs them named and measured too.
 */
export const SECTION_IDS = ['persona', ...DYN_SECTION_IDS, 'behavior_anchor', 'json_anchor'] as const;

export type DynSectionId = typeof DYN_SECTION_IDS[number];
export type SectionId = typeof SECTION_IDS[number];

/** One measured part of the assembled prompt. Names and NUMBERS only, never prompt text — this
 *  shape travels into the turn trace, which persists. */
export interface PromptSection {
  name: SectionId;
  chars: number;
}

const DYN_IDS: ReadonlySet<string> = new Set(DYN_SECTION_IDS);

/** True for a section that lives inside `<prompt>…</prompt>` — and therefore pays a `\n\n` join to
 *  each neighbour — rather than framing the block. */
export function isDynSection(name: SectionId): name is DynSectionId {
  return DYN_IDS.has(name);
}

/** The one separator the assembler uses, between every pair of adjacent parts: `\n\n`. */
const SEPARATOR_CHARS = 2;

/** The fixed cost of wrapPrompt around the dyn block: `<prompt>\n` ahead of it, `\n</prompt>` after.
 *  Derived from PROMPT_TAG, so renaming the tag re-measures instead of drifting. */
export const PROMPT_WRAPPER_CHARS = `<${PROMPT_TAG}>\n`.length + `\n</${PROMPT_TAG}>`.length;

/** persona ⏎⏎ ‹the wrapped dyn block› ⏎⏎ behavior_anchor ⏎⏎ json_anchor — three joins, always. */
const FRAME_JOINS = 3;

/**
 * The `system.length` a measured section list implies — the exhaustiveness check, and the one place
 * the prompt's separator overhead is written down.
 *
 * The assembled prompt is
 *   `${persona}\n\n${wrapPrompt(dyn.join('\n\n'))}\n\n${behaviorAnchor}\n\n${anchor}`
 * so the overhead on top of the section texts themselves is exactly:
 *   • one `\n\n` between each pair of dyn sections that RENDERED — `max(0, n - 1)` of them, since a
 *     section that rendered to nothing was never pushed and pays no join;
 *   • PROMPT_WRAPPER_CHARS for the `<prompt>` wrapper (a build with no dyn sections at all still
 *     pays it — wrapPrompt('') is `<prompt>\n\n</prompt>`, and the arithmetic gets that right
 *     because the wrapper's own two newlines are its opening and closing ones);
 *   • three more `\n\n` for the frame joins around the block and between the two anchors.
 *
 * Exact so long as every dyn section's text is already trimmed: wrapPrompt trims the JOINED body, so
 * a leading blank line on the first rendered section (or a trailing one on the last) would be
 * dropped from `system` yet still counted here. Every renderer returns trimmed text today —
 * renderActiveOps, the one that doesn't, is `.trim()`ed at its push site — and
 * promptSections.test.ts pins that invariant so this stays arithmetic rather than an estimate.
 */
export function sectionsTotalChars(sections: readonly PromptSection[]): number {
  const body = sections.reduce((total, s) => total + s.chars, 0);
  const dynCount = sections.reduce((n, s) => n + (isDynSection(s.name) ? 1 : 0), 0);
  const joins = Math.max(0, dynCount - 1) + FRAME_JOINS;
  return body + joins * SEPARATOR_CHARS + PROMPT_WRAPPER_CHARS;
}

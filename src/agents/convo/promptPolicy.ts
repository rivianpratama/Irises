// What the Convo prompt is ALLOWED to be — today's sizes, today's rule statements, today's
// duplication, all written down in one place.
//
// Convo's system prompt assembled to ~177k characters, of which ~138k was the persona. Every block
// in it was added by someone with a good reason, and nothing had ever said no. This module is the
// "no": a set of numbers and phrases measured against the live assembler, held by three tests
// (promptBudget.test.ts, promptPolicy.test.ts, clauseInventory.test.ts).
//
// Since P4a the persona is two things, and the numbers below distinguish them: the always-on core
// (`persona`, Context.md — 114k) and the craft pages that load per-turn (`craft_modules`,
// convo/craft/*.md — up to 23k of them on the turn that needs the most). A phrase check reads BOTH,
// because a rule in a page is still a rule the model reads; a size check reads them apart, because
// the whole point of a page is the turns it stays out of.
//
// It ENFORCES NOTHING AT RUNTIME. No prompt path reads any of this — the assembler will happily
// build a prompt twice this size, and a real turn whose dossier is longer than the fixture's is not
// an error. These are test-time ceilings measured on five representative turns, so the failure they
// produce is "a prose block grew since someone last looked", which is exactly the failure that has
// no other detector.
//
// Its whole design point is that TIGHTENING IS A ONE-LINE DIFF. P0 measured and pinned; P1 deleted
// the duplicated clauses, dropped every count in CLAUSE_INVENTORY to one, and then re-measured — the
// numbers below are that second measurement, each ceiling now within 2% of what the fixtures assemble.
// Nothing here is an aspiration — every number is a measurement, and the comment beside a number says
// which fixture produced it and what it used to be.

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
 * How much headroom: at most 2%, and less than that wherever a tidy number allows — 2% of `persona`
 * is already 2,700 characters, i.e. room for a whole new section to arrive unnoticed, which is the
 * thing this table exists to notice. `persona` carries ~100 characters of slack: a sentence added to
 * Context.md is meant to fail here and be ratcheted deliberately, not absorbed.
 *
 * The 2% is checked, not promised. promptBudget.test.ts fails on a ceiling that sits further than that
 * above its measurement, so a phase that deletes prose cannot leave its old ceiling behind as slack
 * for the next arrival to land in — the deletion pulls the number down in the same commit.
 *
 * `model_map` is the one deliberate exception, at ~2× its measured size: its text is built from the
 * host's resolved model map (MODELS/PROVIDERS plus whatever engine discovery found), so a bare
 * checkout and a configured install legitimately differ. A tight ceiling there would fail on somebody
 * else's machine and teach everyone to ignore the test.
 *
 * `memory_stack` is the wrapped memory tiers inside `context_block` (memory/wrappers.ts:
 * identity card → short → medium → discovery → flexible). It has its own line because it is the part that
 * grows with USE rather than with editing — every look, note and directive lands in it — and because
 * a `context_block` ceiling alone cannot say whether the dossier or the tiers moved. That second
 * reason is only true while some fixture carries a context block that is MORE than its stack: P2
 * folded the plain tenure section into the card, which left the steering-question section as the one
 * plain part a routed block can still have, and the thread-offer fixture carries one so that the two
 * numbers keep measuring two things.
 *
 * `status_contract` is prose too, but GENERATED prose: the eight ENVELOPE_FIELDS descriptions plus
 * the feeling wheel (persona/status.ts), identical on every turn. It is the one line here that cannot
 * be tightened in the prompt alone — those descriptions are also the response schema both lanes
 * validate against, so shrinking this number means editing the table and moving both copies at once.
 * P3 is what that looks like from this side: the envelope shrank from seventeen fields to eight, and
 * the two copies moved together in the same commit.
 *
 * The data-shaped sections (`context_block`, `memory_stack`, `burst`, `group`, `active_ops`,
 * `tapped_reply`) are measured on their fixture's data, so changing a fixture re-measures the number
 * rather than breaking the test's meaning. The prose-shaped ones (`persona`, both anchors,
 * `intro_weave`, `weather`, `thread`, `turn_focus`, the timing reads) are the ratchet proper.
 *
 * `craft_modules` is a third kind: a SUM over whichever craft pages the turn's gates fired
 * (personaModules.ts), so its ceiling is the widest such sum across the fixtures rather than the size
 * of any one thing. Editing a page moves it; so does a fixture whose facts fire a different set. The
 * pages' own bytes are held elsewhere — personaModules.test.ts reconstructs the pre-P4a Context.md
 * out of them and pins its sha256 — which is why this line is a budget and not a ratchet.
 */
export const PROMPT_BUDGET: Record<BudgetKey, number> = {
  persona: 99_700,             // 99,611 — P4b's second half shrank "When to delegate (and how)" from 14,348 to 8,888 by deleting the ten runs of prose that the delegate_to_ops tool doc (tools.ts) already ships on every turn: the kind lanes, the meta_prompt skeleton, media_scope, the holding-text examples, "Answer YOURSELF". Every deleted byte is enumerated in personaModules.test.ts (DELETED_PROSE), which puts them back and re-checks the pre-P4a sha256. Was 105,200 for 105,071 after P4b split "Connect the dots": the thread-tagging craft (9,120 chars across nineteen paragraphs) went to craft/threading.md behind the thread section, and a 366-char pointer stayed behind because the BANTER half of that section is deliberately still always-on. Was 114,000 for 113,858 after P4a moved seven sections (24,065 chars) out to convo/craft/. Was 138,020 for 137,923 after P3 part 3 took the inner-weather section's momentum sentence (−179): applyAffectDrift enforces it now. Was 138,200 for 138,102 after P1 deleted the envelope's field list + the copied wheel (was 141,600 for 141,474)
  craft_modules: 30_000,       // 29,660 — the THREAD-OFFER fixture now, and this line went UP while `persona` went down, which is the whole trade: threading + send-order + reminders + onboarding + email-flag is the widest craft a turn can carry (9,223 of it the threading page). The media turn measures 23,100, the mature turn 20,435, the cold turn 15,865, the group burst 7,150 — and a turn with no thread, no file and a filled-in profile carries none of it. Was 23,400 for the media fixture's 23,100. NOT a prose ratchet like the lines below it — it is a SUM over whichever pages the turn's gates fired, so the number moves when a fixture's facts change, and the pages' own bytes are pinned by the sha256 golden in personaModules.test.ts
  tool_docs: 16_450,           // 16,245 — the group fixture (13 tools; the 1:1 lane carries 11) (was 16,500 for 16,288, before remember_user's `handle` doc stopped asking "whose info this is" and named the messaging handle instead)
  capability: 240,             // 237 — all six capability classes minus inbox, the longest line (was 248)
  model_map: 800,              // 387 on a bare checkout — HOST-DEPENDENT, see above
  name_nudge: 165,             // 163 — fixed prose (was 171)
  intro_weave: 770,            // 760 — INTRO_WEAVE_BLOCK (agents/ops/firstMove.ts) (was 795)
  context_block: 6_700,        // 6,623 — the thread-offer fixture: the mature stack (5,973) plus the one plain section a routed block still carries, a steering question outstanding. Was 6,050 for 5,967 while no fixture carried a plain part at all, and 5,950 for 5,837 before the medium tier took back the hard-personal-rules line the ladder deletion dropped with nowhere to land. Was 12,500 for 12,290; P2 sent the discovery scaffold's craft coaching to craft/onboarding.md, gated every memory block on the turn, folded the plain tenure section into the identity card, replaced each tier's You-should/You-MUST-NOT ladder with the two or three lines that tier alone decides, and retired the three seed stances
  active_ops: 1_980,           // 1,946 — two looks in flight, one queued (was 2,040)
  group: 225,                  // 222 — a named group, three participants, plus the sentence that gives a fact about ANOTHER participant its write route (their handle from the list this section prints, never the sender's — remember_user's own doc is written for the 1:1 case). Was 105 for 104 (and 109 before that)
  tapped_reply: 2_230,         // 2,190 — kind 'assistant' beyond the visible window (the largest of the four) (was 2,290)
  burst: 1_130,                // 1,110 — three messages, group-labelled (was 1,160)
  current_time: 295,           // 291 — fixed prose plus the formatted instant (was 305)
  weather: 2_030,              // 1,995 — affect + cycle + circadian + a moved climate. P3 part 3 took −269: the momentum sentence is deleted (applyAffectDrift enforces it now) and the five carried gauges are four words instead of five numbers. Was 2,300 for 2,264 (+2 when the mood core became derived and 'powerful' cost two characters more than 'joyful'); was 2,700 for 2,581, before P1 pointed the block's tail at the status contract instead of re-listing the fields
  status_contract: 3_950,      // 3,878 — STATIC (ENVELOPE_FIELDS + the wheel), the same on every turn. P3 part 3 added +251: one line saying the level and the gauges are kept FOR her, which is the half of the bargain no surviving field can state. Was 3,690 for 3,627 after the envelope shrink took −349 (ten bullets deleted, one added, `mood_label` reworded off the core it can no longer point at); was 4,000 for 3,976; was 3,650 for 3,591 before +353 re-homed three capture rules onto the two threading descriptions and +32 said whose mode `intent_mode` reads
  thread: 1_230,               // 1,211 — a pattern-rung theme offer plus a loop outcome ask (was 1,270)
  conversation_timing: 270,    // 266 — the widest of the gap/regime readings on these fixtures (was 278)
  reply_order: 620,            // 613 — renderArrivalGap (the backward-order variant, the larger one) (was 640)
  extra: 590,                  // 583 — the pending version note (update/announce.ts) (was 610)
  turn_focus: 550,             // 544 — a 400-char restatement plus two hits (was 570)
  behavior_anchor: 705,        // 699 — P1: six lines that drift first (was 1,740 for 1,659 / 14 lines)
  json_anchor: 2_950,          // 2,928 — the envelope contract, last in the prompt (+20 in P3: the one-line description of `status` stopped asking for the gauges the schema no longer carries). Was 3,050 for 2,908
  memory_stack: 6_050,         // 5,973 — the mature stack, card through long doc, on a turn that touches none of it (+6 when law (b) started naming the layers that are really in the prompt). Was 5,950 for 5,837; +130 gave the medium tier back its hard-personal-rules line. Was 12,500 for 12,290; the card is +43 on the preamble it replaced and absorbed the tenure section, then the three ladders and the three seed stances came off)
};

/**
 * The floor under the live conversation's slice of everything the model reads —
 * `messagesChars / (systemChars + messagesChars)`, the same number the per-turn receipt reports
 * (diagnostics/turnTrace.ts).
 *
 * Measured at **0.0068** on the mature fixture — 1,207 characters of a full 40-row window against a
 * 177k-character prompt — and pinned a hair below it. Read that number twice: two thirds of one
 * percent of what the model reads is the actual conversation. That is the finding this whole phase
 * exists to move, and the floor is what stops it moving the wrong way in the meantime.
 *
 * It rises as the prose shrinks, so this line ratchets UP in the later phases while PROMPT_BUDGET
 * ratchets down. P0 measured **0.0066** against a 182k prompt and pinned 0.0065; the rise to 0.0068 is
 * P1's persona deletions (the two restated envelope paragraphs, the collapsed behaviour anchor, the
 * copied feelings wheel and field list), and it is now held.
 *
 * What the rise is NOT is P1's second half. The status contract that replaced the deleted field list
 * is generated prose of very nearly the same size, so part 2 moved this fixture's whole prompt by
 * **+255 characters** — −3,372 of persona and −319 of weather tail against +3,946 of contract — and
 * this number not at all at four decimal places. That is the honest accounting: part 2 bought ONE
 * editable description of the envelope, and it did not buy size. Every four-decimal point of the floor
 * above came from part 1.
 *
 * P2 re-measured it at **0.0068** and it stayed there through parts 1 and 2. Those deletions are
 * real — the discovery scaffold's craft coaching, and the memory gate table — but they come off the
 * memory stack, which is nine thousand characters of a hundred and seventy-seven thousand. Part 3
 * takes that stack to **5,837** and moves this to **0.0070**: two four-decimal points for five
 * renderers, three ladders and three seed stances, which is the honest exchange rate. The persona
 * is what stands between this number and anything better, and P2 never touched it. Worth stating
 * plainly rather than letting a barely-moved floor read as a phase that did nothing: this phase
 * bought RELEVANCE, not size.
 *
 * P4a is the first phase to touch the persona since P1, and it measures **0.0072** (1,207 characters
 * of transcript against a 167,527-character prompt, down from 171,157). Read the exchange rate
 * honestly: twenty-four thousand characters left Context.md, and twenty thousand of them came
 * straight back on THIS turn as craft pages the gates fired — because a mature turn with an open
 * identity slot and a flagged email loads four of the seven. What P4a bought is not this number; it
 * is that the number now MOVES with the turn instead of standing still. A turn that taps no
 * craft — no history to order, no file, no burst, a filled-in profile — carries 24k less prompt for
 * the same conversation, and nothing before this could tell those two turns apart.
 *
 * P4b's split measured **0.0075** on the same fixture (1,207 characters against a 158,740-character
 * prompt, down from 167,527), and that time the mature turn kept the whole saving: it carries no
 * thread, so the nine thousand characters of thread-tagging craft that used to stand in the persona
 * on every turn are simply not there. The turn that DOES carry a thread still pays for them — and
 * that is the turn where they are about to be used.
 *
 * P4b's delegate shrink measures **0.0078** (1,207 against 153,280), and this one every turn keeps:
 * 5,460 characters the delegate tool's own doc was already saying left the persona, so nothing
 * anywhere gates them back in.
 */
export const MIN_TRANSCRIPT_SHARE = 0.0077;

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
 *
 * Scanned against the whole CORPUS — Context.md plus every craft page (personaModules.ts
 * convoPersonaWithCraft) — rather than the core file alone: P4a moved seven sections out into pages,
 * and a rule that lands in one of them is still a rule she reads. Every anchor below happens to live
 * in the core today, and this is what would say so if one moved.
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
  // Anti-sycophancy, and the persona's ONLY statement of it. It used to be the tail of the
  // `epistemic_trigger` bullet in the envelope's field list, so P1's deletion of that list would have
  // taken a behaviour rule with it; it was kept as its own sentence (~174) and anchored here so the
  // next rewrite of that paragraph cannot lose it quietly.
  { id: 'concede_to_information', personaAnchor: 'you concede to information, never to insistence' },
];


/**
 * The four `confidence_level` bands and the reply each one buys.
 *
 * P1 deleted the two restatements of this mapping — Context.md's opening `ABSOLUTE RULE` and its
 * `FINAL REMINDER` — which left it stated only in the JSON anchor. That is one home, and the one at
 * the recency edge, but it is a code file: the persona's own confidence section then taught how to
 * SCORE at length and never said what the score BUYS, so a persona editor reading Context.md end to
 * end could not find the mapping at all. It is back in that section as one compressed sentence, and
 * the JSON anchor keeps its copy last. That is the same arrangement as the bubble law — the section
 * owns the teaching, the anchor states the operational law at the edge — and, like the bubble law,
 * two copies need a test to keep them in step.
 *
 * Each row pins what its band buys IN EACH COPY, because the two are deliberately worded for their
 * own place rather than duplicated byte for byte. Read the two columns side by side: they have to
 * describe the same reply. Reword the prose around a phrase freely; losing one means that copy now
 * promises a different reply than the other, which is the drift no other test can see.
 */
export const CONFIDENCE_BANDS: ReadonlyArray<{ band: string; personaShape: string; anchorShape: string }> = [
  { band: '0-30', personaShape: 'get the missing details', anchorShape: 'ask for the missing details' },
  { band: '30-60', personaShape: 'one short confirm', anchorShape: 'confirm with ONE short question' },
  { band: '60-80', personaShape: 'walk it through', anchorShape: 'walk it through' },
  { band: '80-100', personaShape: 'straight answer', anchorShape: 'straight answer, first bubble, no preamble' },
];

/** One counted clause: the phrase, how many times the assembled prompt carries it today, and how
 *  that total splits between the per-turn body and the two static anchors after `</prompt>`. */
export interface ClauseCount {
  id: string;
  /** Counted as a plain substring of the assembled prompt (`String.split(phrase).length - 1`). */
  phrase: string;
  /** TODAY's total. This number is the ratchet: P1 deletes a duplicate and drops the count by one. */
  count: number;
  /** How many of those copies live in the behaviour/JSON anchors rather than ahead of them — i.e.
   *  how many are the recency-edge RETELLING rather than the clause's own home in Context.md. The
   *  remainder (`count - anchorCopies`) is what the persona itself carries, so a 2/1 row is a rule
   *  plus its anchor and a 2/0 row is two copies inside Context.md. Checked rather than annotated:
   *  clauseInventory.test.ts counts both halves. */
  anchorCopies: number;
  /** Which copies make up `count`, so a later pass tightens the right one — and any copy the count
   *  CANNOT see. A clause whose text is an ENVELOPE_FIELDS description also reaches the model on the
   *  response schema every turn, which is not part of the system prompt, so only this string can say
   *  so (clauseInventory.test.ts checks that it does). */
  where: string;
}

/**
 * How many times each load-bearing clause reaches the model on one turn.
 *
 * P0 measured four of these arriving TWICE — once in the persona's own section, once in the
 * behaviour anchor at the recency edge. The second copy was a deliberate retelling of rules that
 * decay across a 146k-character prompt (charter §11.3), but a retelling can drift from its source,
 * and a rule stated twice is a rule nobody can edit. P1 collapsed those four: the behaviour anchor
 * now holds six identity lines and states no rule that has its own section, so every row below is
 * pinned at exactly ONE copy, in the one place that owns it.
 *
 * Read `anchorCopies` and `where` before changing a `count`. `predict_named` in particular is 2/0
 * for a reason that is NOT duplication: both copies are in Context.md because the second one is a
 * cross-reference pointing at the section, and deleting a pointer is not a tightening.
 *
 * Counted over the whole corpus, not one turn's prompt: clauseInventory.test.ts assembles its fixture
 * with CONVO_PERSONA_MODULES off, so every craft page is present exactly once (see that file's
 * header). A page that loads on some turns and not others must not make a pinned count flicker.
 */
export const CLAUSE_INVENTORY: readonly ClauseCount[] = [
  {
    id: 'predict_clause',
    phrase: 'from your model of them',
    count: 1,
    anchorCopies: 0,
    where: "Context.md's \"Predict, don't interview\" header — P1 deleted the behaviour anchor's retelling",
  },
  {
    id: 'predict_named',
    phrase: "Predict, don't interview",
    count: 2,
    anchorCopies: 0,
    where: 'the section itself + the cross-reference to it from "Answer first" — a POINTER, not a duplicate',
  },
  {
    id: 'probe_clause',
    phrase: "probe wears a statement's clothes",
    count: 1,
    anchorCopies: 0,
    where: "its own section header in Context.md — P1 deleted the behaviour anchor's copy",
  },
  {
    id: 'four_bends_clause',
    phrase: 'Four bends that stay safe',
    count: 1,
    anchorCopies: 0,
    where: 'Context.md only — the behaviour anchor carries the same rule in its own words',
  },
  {
    id: 'tease_wound_clause',
    phrase: 'never their wound',
    count: 1,
    anchorCopies: 0,
    where: "the four-bends parenthetical — P1 deleted the behaviour anchor's tease line",
  },
  {
    id: 'response_overrules_clause',
    phrase: 'Their response overrules your framing, instantly.',
    count: 1,
    anchorCopies: 0,
    where: 'Context.md only',
  },
  {
    id: 'three_check_gate_clause',
    phrase: 'The gate — run three checks before any memory enters a bubble',
    count: 1,
    anchorCopies: 0,
    where: 'Context.md only',
  },
  {
    id: 'greeting_clause',
    phrase: 'A greeting gets a greeting.',
    count: 1,
    anchorCopies: 0,
    where: 'the "what you never do with what you know" list — P1 deleted the behaviour anchor\'s copy',
  },
  {
    id: 'greeting_example_wrong',
    phrase: 'WRONG, "hey" after four quiet days, you inventoried their life:',
    count: 1,
    anchorCopies: 0,
    where: 'the WRONG half of the greeting demo pair',
  },
  {
    id: 'greeting_example_right',
    phrase: 'RIGHT, a greeting, one light callback max:',
    count: 1,
    anchorCopies: 0,
    where: 'the RIGHT half of the greeting demo pair',
  },
  {
    // The one clause P1 found actually CONTRADICTING itself rather than merely repeating: the schema
    // ranked a pending thing over a theme and never mentioned a resolution, Context.md ranked a
    // resolution over a theme and never mentioned a loop. The full order is now stated once.
    id: 'thread_note_precedence',
    phrase: 'a resolution outranks a pending loop',
    count: 1,
    anchorCopies: 0,
    where: "the status contract's thread_note bullet — and, off-prompt, the response schema built from the same description (ENVELOPE_FIELDS, persona/status.ts); the persona's half-rule is gone",
  },
  {
    // The capture rule with no other home. P1 deleted Context.md's `thread_note` bullet as a duplicate
    // of the schema, but this clause was in the persona ONLY — and the nearest surviving line pushes
    // the other way ("Venting or distress → theme reads stay closed completely", about SURFACING). So
    // its deletion would have quietly stopped loops being minted on exactly the turns worth catching.
    // Pinned here for the same reason a RULE_ANCHORS phrase is: the next tidy-up fails out loud.
    id: 'thread_note_capture_when_heavy',
    phrase: 'Catch a loop even on a venting or overwhelmed turn',
    count: 1,
    anchorCopies: 0,
    where: "the status contract's thread_note bullet — and, off-prompt, the response schema built from the same description (ENVELOPE_FIELDS, persona/status.ts)",
  },
];

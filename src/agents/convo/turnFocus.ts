// The turn-focus block — the counterweight, and the LAST thing inside `<prompt>…</prompt>`.
//
// Convo's system prompt runs ~45k characters, and roughly a dozen of its instructions push in one
// direction: bring the thread up, connect the dots, tie today to what you hold. Nothing in it said
// "answer what they just said." This block is that sentence, placed where the recency edge is
// strongest (charter §11.3: volatile per-turn data last), and it does three things in ~350-600
// characters:
//
//   1. RESTATES their message, data-tagged — so the thing to answer is the freshest text in the
//      prompt rather than something 40k characters back up in the transcript;
//   2. NAMES its shape, classified in code (see classifyTurnShape) — a greeting is not a work ask,
//      and the fast tier should not have to infer that from a wall of prose;
//   3. SHOWS the one or two held items that actually touch it. This is the inversion the block
//      exists for: association arrives as EVIDENCE ("here is what touches this, and nothing else
//      does") rather than as another instruction to associate. When nothing touches it, the block
//      says so — which is the only place in the prompt that ever gives her permission to hold
//      everything back.
//
// PURE by construction: no clock, no DB, no LLM, no env read on the render path. It renders values
// the caller already computed (convo/client.ts assembles the input; convo/shared.ts pushes it last).
// The one env read is the feature flag at the bottom, which gates the PUSH SITE, not the renderer.

import { dataTag, neutralizeTagBreakouts } from '../../llm/promptTag.js';

/**
 * What a message IS, as far as code can tell from its surface. Six shapes, single-sourced here so
 * the type and the prompt token can never disagree — the THEME_KINDS pattern (persona/threads.ts).
 *
 * Deliberately coarse. Convo is a fast (Haiku-class) tier with no chain-of-thought budget, so the
 * shape is a hint that costs nothing to compute, not a router: nothing downstream branches on it.
 */
export const TURN_SHAPES = ['greeting', 'ack', 'question', 'work_ask', 'statement', 'closing'] as const;
export type TurnShape = typeof TURN_SHAPES[number];

/**
 * Where a hit came from. P0 filled only `thread` (the standing thread offered this turn) and
 * `research` (the hot short-tier look that rendered in full); P2's relevance router
 * (memory/relevance.ts) fills all of them, and widening this list was the whole of the change to
 * this renderer — it reads what the caller put in `TurnFocusInput.hits` and prints the word.
 *
 * Same vocabulary as `RELEVANCE_HIT_KINDS` over there, and relevance.test.ts pins that every kind
 * the router can emit is a source this list names.
 */
export const TURN_FOCUS_HIT_SOURCES = ['thread', 'research', 'email', 'note', 'fact', 'directive', 'long'] as const;
export type TurnFocusHitSource = typeof TURN_FOCUS_HIT_SOURCES[number];

/** One held thing that touches this turn: what to call it, and which channel it came off. */
export interface TurnFocusHit {
  label: string;
  source: TurnFocusHitSource;
}

/** Everything the block renders from. Nothing is fetched here; the caller has it all already. */
export interface TurnFocusInput {
  /** This turn's inbound text, exactly as the model receives it in the messages array. */
  text: string;
  /** Held things that touch it, best first. At most TURN_FOCUS_MAX_HITS are rendered. */
  hits: readonly TurnFocusHit[];
}

/** How much of their message is restated. The block is a RESTATEMENT, not the message itself — the
 *  full text is in the transcript either way — so a long one is clipped rather than allowed to turn
 *  the counterweight into another wall of prose. */
export const TURN_FOCUS_TEXT_CHARS = 400;

/** How much of a hit label survives. A theme label is a few words, but a research `request` is the
 *  user's own ask and has no length contract, so it is clipped and flattened to keep the hit line
 *  one line and the block inside its size. */
export const TURN_FOCUS_LABEL_CHARS = 80;

/** How many hits render. Two is the point: "the one or two things that touch this" is evidence a
 *  reader can weigh, and a list of six is the memory dump this block exists to counter. */
export const TURN_FOCUS_MAX_HITS = 2;

const HEADER = "## This turn — what you're answering";
const HITS_LABEL = 'What you hold that touches it: ';
const NO_HITS = 'nothing here touches it; answer from the thread above.';
const CLOSER = 'Answer THIS. Everything above is background — it may shape HOW you answer, never WHAT.';

/**
 * Clip to at most `max` characters, marking the cut so a clipped restatement never reads as the
 * whole message. Exactly `max` at the widest — the caps above are ceilings, not targets.
 *
 * The caps count UTF-16 units, and the text being clipped is a text message: an astral emoji is TWO
 * of them, so a boundary can fall between a surrogate pair and leave the high half stranded. That
 * lone surrogate is not a character — it renders as a replacement box, and it is what reaches the
 * model inside `<their_message>`. So when the last unit kept is a high surrogate, one more unit
 * comes off and the whole emoji goes rather than half of it (a character short of the cap is free;
 * the caps are ceilings).
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = max - 1;                                       // one unit spent on the ellipsis
  const end = /[\uD800-\uDBFF]/.test(text[cut - 1] ?? '') ? cut - 1 : cut;
  return `${text.slice(0, end)}…`;
}

// ── the shape classifier ─────────────────────────────────────────────────────
// Word lists, kept small and generic on purpose: the classifier is a surface read, and a long list
// of near-misses buys accuracy on messages nobody sends. Every list is matched against a LOWERCASED
// word token (see `words` below), so entries here are lowercase and unpunctuated.

/** A message that opens the conversation. Only ever read out of the first two tokens. */
const GREETING_WORDS: ReadonlySet<string> = new Set([
  'hey', 'heya', 'hi', 'hiya', 'hello', 'yo', 'sup', 'howdy', 'morning', 'afternoon', 'evening',
  'gm', 'oi', 'hola',
]);

/** A message that closes a loop and asks for nothing. Only ever read out of the FIRST token — an
 *  ack word later in a sentence ("thanks for checking, what about friday") is not an ack. */
const ACK_WORDS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'k', 'kk', 'thanks', 'thx', 'ty', 'cool', 'nice', 'sweet', 'perfect', 'great',
  'awesome', 'sure', 'yeah', 'yep', 'yup', 'yes', 'gotcha', 'got', 'understood', 'alright', 'right',
  'fine', 'lol', 'haha', 'np', 'word', 'good',
]);

/** A message that ends the conversation for now. Read anywhere in a SHORT message, because a
 *  sign-off is usually the tail of one ("alright, night"). */
const CLOSING_WORDS: ReadonlySet<string> = new Set([
  'night', 'goodnight', 'gnight', 'gn', 'bye', 'goodbye', 'cya', 'ttyl', 'later', 'laters',
  'peace', 'adios', 'ciao',
]);

/** Leads that make a message a question even with no `?` typed — the interrogatives plus the
 *  auxiliaries English fronts a yes/no question with. Contraction-tolerant (see `isQuestionLead`),
 *  which is what catches "what's 15% of 80". */
const QUESTION_LEADS: ReadonlySet<string> = new Set([
  'what', 'why', 'how', 'where', 'when', 'who', 'whose', 'which', 'whom',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'am', 'has', 'have', 'had',
  'any', 'anyone', 'anything',
]);

/** Leads that make a message a piece of WORK rather than a remark. Verbs only, and only ones whose
 *  bare imperative is unambiguous in a text message — "plan" and "order" are here, "run" and "make"
 *  are not, because "run late" and "make sense" are how they usually arrive. */
const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  'look', 'find', 'check', 'search', 'google', 'pull', 'dig', 'compare', 'calculate', 'convert',
  'translate', 'summarize', 'summarise', 'draft', 'write', 'send', 'email', 'text', 'call',
  'book', 'order', 'buy', 'schedule', 'remind', 'cancel', 'reschedule', 'add', 'list',
  'open', 'read', 'show', 'explain', 'fix', 'plan', 'price', 'track', 'watch', 'remember', 'forget',
]);

/** Tokens the real lead is allowed to hide behind, so "hey look up the flights" reads as work and
 *  "so are they coming or not" reads as a question. ONE only — this is politeness, interjection and
 *  discourse glue, not a clause. Skipped for the question and imperative reads alike, which is what
 *  keeps those two rules symmetric. */
const LEAD_FILLERS: ReadonlySet<string> = new Set([
  ...GREETING_WORDS, ...ACK_WORDS,
  'please', 'pls', 'plz', 'so', 'and', 'but', 'also', 'then', 'well', 'um', 'uh', 'anyway',
]);

/** "Short" for the greeting/ack gates: a hello is a hello, and a hello with a sentence after it is
 *  that sentence. */
const SHORT_WORDS = 4;
/** …and for the sign-off gate, which is looser because a sign-off trails a short clause. */
const CLOSING_MAX_WORDS = 6;

/** Lowercased word tokens: apostrophes dropped so a contraction collapses to one token ("what's" →
 *  "whats"), `%` kept so "15%" stays one. Deliberately NOT salientTokens (memory/topicality.ts) —
 *  that one strips exactly the stopwords the grammar rules here read the shape off ("what", "did",
 *  "ok"), so it answers a different question and would blind this one. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9%]+/).filter(Boolean);
}

/** A question lead, tolerating the contracted form: "whats" → "what", "hows" → "how". Applied to
 *  THIS list only — the imperative list must not do it, or "looks good" becomes a work ask. */
function isQuestionLead(token: string): boolean {
  if (QUESTION_LEADS.has(token)) return true;
  return token.endsWith('s') && QUESTION_LEADS.has(token.slice(0, -1));
}

/**
 * What they just sent, as a shape. Deterministic, total, and dependency-free.
 *
 * The rules run in a FIXED precedence, and the order is the whole design:
 *
 *   1. `question`  — a `?` anywhere, or an interrogative/auxiliary lead. First because a question
 *                    is the one shape that is owed an answer, and it outranks a sign-off word in
 *                    the same message ("night, you around tomorrow?" wants an answer tonight).
 *   2. `work_ask`  — an imperative verb leading the message. Ahead of the social shapes so
 *                    "hey look up the flights" is work, not a hello.
 *   3. `closing`   — a sign-off word in a short message. Ahead of `greeting` because "night" and
 *                    "later" read as both, and reading a goodbye as a hello is the costlier miss.
 *   4. `greeting`  — a greeting word in the first two tokens of a short message.
 *   5. `ack`       — an ack word leading a short message.
 *   6. `statement` — everything else, including a message with nothing in it at all (a media-only
 *                    turn, where the attachment note is the whole text). The neutral default: she
 *                    reads it herself, as she always did.
 *
 * Rules 1 and 2 both read the lead past at most ONE filler token (LEAD_FILLERS), which is how "so
 * are they coming or not" reads as a question and "please check the lease" as work. Rules 3-5 are
 * length-gated, so a greeting or sign-off word buried in a real sentence never wins.
 *
 * It will be wrong sometimes — it is a surface read of a text message, with no stemming and no
 * model. That is priced in: nothing branches on the shape, it is one word of orientation in the
 * block, and a wrong word there costs less than the block not existing.
 */
export function classifyTurnShape(text: string): TurnShape {
  const w = words(text);
  if (!w.length) return 'statement';

  // The lead the two grammar rules below read: the first token, or the second when the first is
  // only glue.
  const lead = LEAD_FILLERS.has(w[0]) && w.length > 1 ? w[1] : w[0];

  if (text.includes('?') || isQuestionLead(lead)) return 'question';
  if (IMPERATIVE_VERBS.has(lead)) return 'work_ask';

  if (w.length <= CLOSING_MAX_WORDS && w.some(t => CLOSING_WORDS.has(t))) return 'closing';
  if (w.length <= SHORT_WORDS && w.slice(0, 2).some(t => GREETING_WORDS.has(t))) return 'greeting';
  if (w.length <= SHORT_WORDS && ACK_WORDS.has(w[0])) return 'ack';

  return 'statement';
}

// ── the block ────────────────────────────────────────────────────────────────

/**
 * The hits the block will actually PRINT, in the order it prints them: a blank name is dropped
 * first (a hit with no name is not evidence), each survivor is flattened to one line and clipped,
 * and only then does the cap apply — so a nameless hit at the front costs nobody a slot.
 *
 * Exported because the turn receipt reports "what she was shown" (convo/client.ts) and the only
 * honest way to say that is to ask the block. Slicing the raw list instead reported a label the
 * block had dropped, and hid the one it printed in its place.
 *
 * A label is somebody else's words — a note, a fact, a directive, a section heading — and this line
 * prints them with no data tag around them, so a stored `</prompt>` here would end the dynamic
 * block early and promote whatever follows to instruction position. Defused before the clip, so
 * the escaped length is the length that counts.
 */
export function renderedTurnFocusHits(hits: readonly TurnFocusHit[]): TurnFocusHit[] {
  return hits
    .map(h => ({ label: clip(neutralizeTagBreakouts(h.label.replace(/\s+/g, ' ').trim()), TURN_FOCUS_LABEL_CHARS), source: h.source }))
    .filter(h => h.label)
    .slice(0, TURN_FOCUS_MAX_HITS);
}

/**
 * Render the block. Returns '' when there is no message to restate — a turn with no text at all has
 * nothing to point at, and an empty block would be a header promising something it does not carry.
 *
 * Hits arrive already chosen and already ordered by the caller; nothing is decided here beyond what
 * renderedTurnFocusHits decides above.
 */
export function renderTurnFocus(input: TurnFocusInput): string {
  const message = input.text.trim();
  if (!message) return '';

  const hits = renderedTurnFocusHits(input.hits);

  // The label stays on both paths so the block's line structure is constant turn to turn: the fast
  // tier reads a fixed five-line shape, and only the values move.
  const held = hits.length
    ? hits.map(h => `${h.label} (${h.source})`).join(' · ')
    : NO_HITS;

  return [
    HEADER,
    // Their own words, restated inside the system prompt — the one place a user's text lands there.
    // Defused for the same reason the labels are: a typed `</prompt>` must not close the wrapper.
    dataTag('their_message', clip(neutralizeTagBreakouts(message), TURN_FOCUS_TEXT_CHARS)),
    `Shape: ${classifyTurnShape(message)}`,
    `${HITS_LABEL}${held}`,
    CLOSER,
  ].join('\n');
}

/**
 * The feature gate (env: CONVO_TURN_FOCUS_BLOCK). Default ON, read at CALL time so flipping it
 * needs no restart — the same parse shape as every sibling flag (threadingEnabled,
 * themeTopicGateEnabled, relationshipClimateEnabled, firstMoveEnabled).
 *
 * It gates the PUSH SITE in convo/shared.ts, not this module: off means the section is never pushed,
 * and the assembled prompt is byte-identical to an install that never had the block. Nothing
 * downstream reads the block, so there is no second end to gate.
 */
export function turnFocusBlockEnabled(): boolean {
  const v = (process.env.CONVO_TURN_FOCUS_BLOCK || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

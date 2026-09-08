// The idle gate: does this turn ask for anything, or is it a stall?
//
// One boolean, and the whole hook engine hangs off it. An idle turn is the one turn a reply may
// carry a hook (persona/hooks.ts); a task turn gets the answer, flat, with the real numbers, and
// nothing else. So a gate that reads "deploy prod" as idle spends a work turn on a clever line, and
// a gate that reads "hmm" as work produces the leaf this whole build is named after.
//
// LANGUAGE-AGNOSTIC, THREE LAYERS, FAILING TOWARD TASK. This is the 2026-09-04 rule (see the header
// of agents/ops/consent.ts, which reads a reply the same way): no hand-written word list is ever the
// last word on what a person's message means, because a person may text in any language and a list
// only ever knows one.
//
//   1. STRUCTURAL VETOES — script-independent facts about the message and the turn around it. A
//      question mark, a digit, a link, length; a file that arrived, a burst, a look already running,
//      an outstanding question of hers, and — only against that question — a reply the consent
//      reader settled. Any one of them and the turn is work. These are the layer that carries the
//      weight, and none of them reads a word.
//   2. THE ENGLISH FAST PATH — LEAF_EXAMPLES below. EXAMPLES, NOT A LAW: a short message every one
//      of whose tokens is a known English stall is idle, for free, with no call. The list is small
//      on purpose and extensible without a code change (LEAF_EXAMPLES_EXTRA), because it is a
//      shortcut for the commonest case and never a definition of the case. It may only speak for a
//      message it can READ WHOLE — see `fastPathCanRead`, and the paragraph under it.
//   3. THE CLASSIFY FALLBACK — everything short and veto-free the fast path could not read: a
//      Spanish "nada", an Indonesian "bosan", a Japanese stall with no Latin tokens at all. The
//      caller injects it (T7 wires the classify lane); this module only knows it returns one of
//      three words. `stall` is idle. Anything else — `ask`, `unclear`, a garbled answer, a thrown
//      call, a lane that timed out — is a task.
//
// AND THE FAST PATH NEVER HALF-READS A MESSAGE. A person may text in any language, and a real
// message is often MIXED: one English ack and a clause in another script ("ok 볼래", "hmm 明日は").
// `words` below drops every non-Latin character, so a message like that tokenizes down to its one
// ASCII token — and a fast path that judged those tokens alone would read a request as a stall on
// the strength of the single word it happened to be able to see. The English list is English by
// design; the honest consequence is that layer 2 may decide ONLY a message with nothing in it the
// tokenizer would drop (`fastPathCanRead`). Everything else belongs to layer 3, which reads any
// script — one small call, never a wrong reading.
//
// This file is a LEAF: it imports nothing, from anywhere. `words` below is MIRRORED from
// convo/turnFocus.ts rather than imported for exactly that reason (that module imports the prompt
// tagger), and the consent reading arrives as a plain union rather than as ops/consent.ts's `Consent`
// (that module imports the LLM client). Both duplications are two lines and are named here so the
// day one of them drifts is a day somebody reads this paragraph.
//
// PURE: no clock, no DB, no LLM of its own. The one env read is LEAF_EXAMPLES_EXTRA, parsed at CALL
// time so a live install can widen the fast path without a restart.

/** The three readings the injected classifier may come back with. Deliberately its own tiny union:
 *  the fallback is a seam, and a caller that wires a different classifier still has to answer this
 *  question in these words. */
export type IdleVerdict = 'stall' | 'ask' | 'unclear';

/** Which layer decided, for the receipt (`hooks:select` carries it, persona/hooks.ts). Four values,
 *  disjoint and exhaustive: `veto` a structural fact, `fast_path` the English examples, `classify`
 *  the injected fallback (whatever it answered, including a failure), and `none` a turn with no text
 *  to read at all. A receipt that could not tell a fast-path idle from a classified one could not
 *  tell a working fallback from a dead one. */
export const IDLE_LAYERS = ['veto', 'fast_path', 'classify', 'none'] as const;
export type IdleLayer = typeof IDLE_LAYERS[number];

/** What the consent reader made of this message, mirrored from ops/consent.ts's `Consent`. Only the
 *  caller can produce it (the reading may cost a lane call), so it arrives as a fact. */
export type IdleConsent = 'yes' | 'no' | 'unclear';

/**
 * The turn around the message, as facts somebody else already computed. Nothing here is an opinion
 * and nothing here is derived from what the message MEANS — the same discipline the craft-module
 * gates keep (convo/personaModules.ts).
 */
export interface IdleFacts {
  /** describeAttachments produced a note this turn — a file, photo or memo really arrived. A file is
   *  a thing to do, whatever the caption says. */
  attachmentNote: boolean;
  /** How many messages arrived in this turn's burst (1 on a normal turn). Somebody who sent three
   *  texts in a row is not stalling, they are mid-thought. */
  burstSize: number;
  /** A look of theirs is running or queued for this chat. Their short message is landing on it —
   *  "ok" while she is mid-research is bookkeeping, not a stall. */
  activeOps: boolean;
  /** SHE asked something and has not been answered: an approval or steering question is outstanding,
   *  or her previous turn ended in a question mark of any script (see `endsInQuestion`). Their next
   *  short message is an ANSWER, and answering is work. */
  pendingQuestion: boolean;
  /** What the consent reader made of this message (ops/consent.ts). A settled yes or no is an answer
   *  to a parked action — which is why it only vetoes alongside `pendingQuestion`, there being no
   *  parked action without one; `unclear` settles nothing and vetoes nothing either way. */
  consent: IdleConsent;
}

/**
 * The English fast path — EXAMPLES, NOT A LAW.
 *
 * Greetings, acks, closings, laughter, stalls: the tokens a stall is made of in the one language
 * this file can afford to hard-code. A short message every one of whose tokens is in here is idle
 * with no call at all, which is the commonest idle turn and the cheapest.
 *
 * READ THE NAME. This is not the definition of an idle turn and it is not allowed to become one:
 * the same message in Spanish, Indonesian, Tagalog or Japanese is exactly as idle and reaches the
 * same answer through the classify layer below. Nothing here is a veto either — a token missing
 * from this list costs one small call, never a wrong reading. That is what makes it safe to keep
 * SHORT: a longer list buys speed on messages nobody sends and risks swallowing a real ask.
 *
 * Extensible without a code change through LEAF_EXAMPLES_EXTRA (below), which is the pressure valve
 * that keeps anybody from being tempted to grow this into a lexicon.
 */
export const LEAF_EXAMPLES: readonly string[] = [
  // greeting
  'hey', 'hi', 'hello', 'yo', 'sup', 'morning',
  // acknowledgement
  'ok', 'okay', 'k', 'yeah', 'yep', 'yup', 'cool', 'nice', 'thanks', 'ty', 'sure',
  // closing
  'night', 'bye', 'later', 'cya', 'gn',
  // laughter
  'lol', 'lmao', 'haha', 'hehe',
  // stall
  'hmm', 'hm', 'meh', 'eh', 'idk', 'im', 'bored', 'same', 'nothing', 'nothin', 'much', 'nvm',
];

/** Built once: the examples never change inside a process. The env extras are folded in per call. */
const BASE_EXAMPLES: ReadonlySet<string> = new Set(LEAF_EXAMPLES);

/**
 * The whole message's worth of tokens: lowercased, apostrophes dropped so a contraction collapses to
 * one token ("i'm" → "im"), split on everything else.
 *
 * MIRRORED from convo/turnFocus.ts `words` (see the file header for why it is not imported), which
 * means it is an ASCII-Latin tokenizer and knows it: a message in a non-Latin script tokenizes to
 * NOTHING here. A WHOLLY non-Latin message is therefore harmless — zero tokens can never match the
 * English examples, so it falls straight through to the classify layer, which is exactly where it
 * belongs. A MIXED one is the dangerous case, and `fastPathCanRead` below is what handles it.
 * All of this is also why the token cap below is not the load-bearing length veto: the CHARACTER cap
 * is, and that one counts every script.
 */
function words(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9%]+/).filter(Boolean);
}

/**
 * Everything `words` can read without dropping any of it: ASCII letters, digits, whitespace and
 * ASCII punctuation, plus the curly apostrophe an iPhone types (which `words` strips exactly the way
 * it strips the straight one, so "I’m bored" is still two tokens and still the fast path's).
 */
const FAST_PATH_READABLE = /^[\t\n\r\x20-\x7e’]*$/;

/**
 * May the English fast path speak for this message at all?
 *
 * Only if the message holds nothing the tokenizer would silently drop. "ok 볼래" tokenizes to
 * ['ok'] — one perfect example token and a request the tokenizer never saw — and a fast path reading
 * those tokens alone calls that idle. So the fast path is barred from any message with a character
 * outside what `words` reads, and those go to the classify layer, which reads every script.
 *
 * Deliberately a read of the RAW characters rather than of the tokens: the whole failure is that the
 * tokens no longer contain the evidence. An emoji or an accented letter costs one classify call for
 * the same reason, which is the cheap side of the trade.
 */
export function fastPathCanRead(text: string): boolean {
  return FAST_PATH_READABLE.test(text);
}

/**
 * LEAF_EXAMPLES_EXTRA: a comma-separated list of extra fast-path tokens, read at CALL time.
 *
 * The whole point of the examples being examples: an install whose person says "mkay" and "yeh"
 * twenty times a day can add them without a deploy, and nothing about the gate's shape changes.
 * Normalised exactly the way a token is (see `words`), so an entry that could never match a token
 * simply never matches one.
 */
export function leafExamplesExtra(): string[] {
  return (process.env.LEAF_EXAMPLES_EXTRA || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/['’]/g, ''))
    .filter(Boolean);
}

/** The fast path's set for THIS call: the examples plus whatever the env adds. */
export function leafTokens(): ReadonlySet<string> {
  const extra = leafExamplesExtra();
  return extra.length ? new Set([...BASE_EXAMPLES, ...extra]) : BASE_EXAMPLES;
}

// ── the structural layer ─────────────────────────────────────────────────────

/**
 * The question marks, in the three scripts a text message actually arrives in: ASCII, the fullwidth
 * form CJK keyboards produce, and the inverted mark Spanish opens with. Not a word list — a
 * punctuation set, which is the same thing in every language that uses it.
 */
export const QUESTION_MARKS = ['?', '？', '¿'] as const;

/** Does this text carry a question mark of any script? */
function hasQuestionMark(text: string): boolean {
  return QUESTION_MARKS.some(mark => text.includes(mark));
}

/**
 * Did HER last turn end on a question? Exported because it is how the caller computes
 * `IdleFacts.pendingQuestion` for the commonest case, and computing it twice in two places is how
 * the two copies end up disagreeing about the fullwidth mark. Trailing whitespace and a closing
 * bracket or quote are ignored, because "so, thursday then?" survives being quoted.
 */
export function endsInQuestion(text: string | null | undefined): boolean {
  const trimmed = (text ?? '').replace(/[\s"'’)\]}»”]+$/u, '');
  const last = trimmed.slice(-1);
  return !!last && QUESTION_MARKS.some(mark => mark === last);
}

/**
 * A link, structurally: a scheme, a `www.` host, or a host with a path after it. A BARE domain with
 * no scheme and no path is deliberately not matched — the shape `<word>.<word>` is also how a person
 * types "ok.thanks" with no space, and reading that as a link would turn a stall into a task for the
 * sake of a URL that the classify layer reads correctly anyway.
 */
const URL_SHAPE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/)/i;

/** Any decimal digit, in any script (`\p{Nd}`, not `\d`): a number is a fact, and a message carrying
 *  one is carrying something to act on. Arabic-Indic digits count the same as ASCII ones. */
const DIGIT_SHAPE = /\p{Nd}/u;

/** How many tokens a stall may be. Six is generous for "nothing much just tired" and short of any
 *  sentence with a subject and an object in it. An English-side convenience — see `words`. */
export const IDLE_MAX_TOKENS = 6;

/** …and how many characters, counted in code points so an astral emoji costs what a person thinks
 *  it costs. This is the LANGUAGE-AGNOSTIC length veto: it reads a script the tokenizer cannot. */
export const IDLE_MAX_CHARS = 40;

/**
 * Every structural reason this turn is work, by name, in a fixed order. Empty means nothing
 * structural stands in the way of calling it idle — which is NOT the same as calling it idle.
 *
 * Named rather than boolean because the receipt has to be able to say WHICH fact decided: a gate
 * reporting only "task" cannot tell a burst from a pending question, and the battery scores the
 * layer, not the text (M11).
 *
 * PURE and total. The message-side reads come first (they are free and they are about the thing the
 * person actually typed), the turn-side facts after, each named for the fact rather than for its
 * effect.
 */
export function idleVetoes(text: string, facts: IdleFacts): string[] {
  const t = (text ?? '').trim();
  const out: string[] = [];

  // A question is the one shape that is owed an answer, and answering is work — whatever else the
  // message looks like.
  if (hasQuestionMark(t)) out.push('question_mark');
  if (DIGIT_SHAPE.test(t)) out.push('digit');
  if (URL_SHAPE.test(t)) out.push('url');
  if (words(t).length > IDLE_MAX_TOKENS) out.push('too_many_tokens');
  if ([...t].length > IDLE_MAX_CHARS) out.push('too_long');

  if (facts.attachmentNote) out.push('attachment_note');
  if (facts.burstSize > 1) out.push('burst');
  if (facts.activeOps) out.push('active_ops');
  // Her question is outstanding, so their next short message is an ANSWER: "yes please" after
  // "want me to send it?" is the most load-bearing task turn there is.
  if (facts.pendingQuestion) out.push('pending_question');
  // …and the same message read as a settled yes or no by the consent gate is an answer twice over —
  // but only where there was an answer to give. A consent word answers something only when there is
  // something to answer: the reader says what "ok" WOULD mean if it settled something, which on its
  // own is not a fact about the turn. Read unconditionally it made "ok", "yes" and "sure"
  // permanently un-idle, and those are the commonest stalls there are (live: a bare "ok" after a
  // line of hers that asked nothing). So the veto is conditional on her question being outstanding:
  // with one open, `pending_question` fires and consent joins it — "yes please" after "want me to
  // send it?" is named by both — and with nothing open a bare "ok" is a stall, which is what it
  // looks like.
  if ((facts.consent === 'yes' || facts.consent === 'no') && facts.pendingQuestion) out.push('consent');

  return out;
}

// ── the three layers, in order ───────────────────────────────────────────────

/** What the gate decided, and which layer decided it. Both halves ride the receipt. */
export interface IdleReading {
  idle: boolean;
  layer: IdleLayer;
}

/**
 * Is this turn idle? The three layers in order, failing toward task at every step.
 *
 * `classify` is INJECTED: this module never picks a lane, never sets a timeout and never caches, so
 * a test can drive all three layers without a network and the production wiring (T7) owns the model,
 * the budget and the deadline. A classifier that rejects — including one that rejected because it
 * timed out — is read as a task, which is the same answer a dead lane gives and the same answer an
 * `unclear` gives: the cost of a wrong task turn is one flat reply; the cost of a wrong idle turn is
 * a clever line answering a piece of work.
 *
 * The `none` layer is the turn with nothing in it: a media-only message whose whole text is the
 * attachment note the caller stripped, or an empty string. There is no message to read, so no layer
 * reads one, and a turn nobody can read is a task.
 */
export async function isIdleTurn(
  text: string,
  facts: IdleFacts,
  classify: (text: string) => Promise<IdleVerdict>,
): Promise<IdleReading> {
  const t = (text ?? '').trim();
  if (!t) return { idle: false, layer: 'none' };

  if (idleVetoes(t, facts).length) return { idle: false, layer: 'veto' };

  // Two conditions before the examples are even consulted. The message has to be one the tokenizer
  // read WHOLE (`fastPathCanRead`) — otherwise "ok 볼래" is judged on its one ASCII token and a
  // request is read as a stall. And it has to have produced at least one token: a message that
  // tokenizes to nothing would otherwise pass "every token is an example" vacuously, and a non-Latin
  // stall would be called idle for the wrong reason — right answer, unreadable receipt, and wrong on
  // the first message that isn't one.
  const tokens = words(t);
  const examples = leafTokens();
  if (fastPathCanRead(t) && tokens.length && tokens.every(tok => examples.has(tok))) {
    return { idle: true, layer: 'fast_path' };
  }

  try {
    const verdict = await classify(t);
    // Normalised rather than compared: a lane answers with a word, and a word with a newline or a
    // capital on it is the same answer. Anything that is not exactly `stall` is a task.
    const word = String(verdict ?? '').trim().toLowerCase();
    return { idle: word === 'stall', layer: 'classify' };
  } catch {
    // A thrown call, a spent budget, an install with no classify lane, a deadline that fired. The
    // gate is not the place to log it — the caller owns the receipt and the error report, the same
    // way resolveConsent's caller does.
    return { idle: false, layer: 'classify' };
  }
}

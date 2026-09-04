// Did they say yes? — the one reading that turns a parked action into a running one.
//
// The park (agents/ops/sideEffects.ts + convo/shared.ts) asked a yes/no question about something
// irreversible. This module reads the answer, and it is the only place in Irises where a single
// short word starts work in the outside world. So the default is NOT consent: three verdicts, and
// only the unambiguous one runs anything.
//
// TWO SOURCES, IN THIS ORDER:
//   • the English lexicon below — free, instant, and the answer to almost every real reply ("go",
//     "yeah", "nope", "not now");
//   • the classify lane — one 1-word call, asked ONLY when an approval is actually pending and the
//     English list came back unsettled. That is the language-agnostic half: LANGUAGE-AGNOSTIC RULE
//     (user, 2026-09-04) — there are no other-language word lists anywhere in the code, so a Spanish
//     "sí, hazlo" is 'unclear' here by design and reaches 'yes' through the lane, which reads every
//     language a hand-written list never will.
//
// FAIL-CLOSED EVERYWHERE: a dead lane, a garbled verdict, a mixed reply, a reply too long to be an
// answer, a question — all of them are 'unclear', which leaves the action parked and asks again
// later. The cost of an 'unclear' is one more turn; the cost of a wrong 'yes' is an email nobody
// approved.

import { callLLM } from '../../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../../llm/promptTag.js';
import { reportError } from '../../diagnostics/errorLog.js';

/** The three readings. Only 'yes' ever starts anything; 'unclear' leaves the ask open. */
export type Consent = 'yes' | 'no' | 'unclear';

/**
 * An answer is a BEAT, not a paragraph — the same reasoning (and the same number) as
 * routingGate.ts's ACK_MAX_WORDS: past eight words a reply is discussing the thing, not settling
 * it, and the words that look like consent inside a longer sentence are usually not addressed to
 * this question at all.
 */
export const CONSENT_MAX_WORDS = 8;

/**
 * How long a reply may be and still be worth one classify call. Wider than the lexicon cap because
 * a yes in another language routinely carries a clause with it ("sí, mándalo por favor"), and much
 * narrower than a real message, because a paragraph is a new topic and not an answer.
 */
export const CONSENT_CLASSIFY_MAX_WORDS = 25;

/**
 * The consent lexicon — ENGLISH ONLY (see the rule in the header). Whole words, case-insensitive,
 * clause-bounded, exactly the shape SIDE_EFFECT_PHRASES and PROMISE_PHRASES are matched in.
 *
 * SINGLE SOURCE: the detector and its tests read these same two arrays, so a word the gate acts on
 * is never a word nothing else knows about.
 */
export const CONSENT_YES_PHRASES: readonly string[] = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
  'go', 'go ahead', 'do it', 'send it', 'book it', 'please do',
];

/** The decline half. "don't" tokenizes to two words (the apostrophe is a break), so both the
 *  collapsed and split forms are listed rather than guessed at match time. */
export const CONSENT_NO_PHRASES: readonly string[] = [
  'no', 'nope', 'dont', 'don t', 'do not',
  'stop', 'wait', 'hold', 'cancel', 'not now', 'skip', 'later',
];

// Clause and word handling, identical in shape to ops/sideEffects.ts and convo/unkeptPromise.ts.
const CLAUSE_BREAK = /[.!?,;:\n\r]+/;
const NON_WORD = /[^a-z0-9]+/g;

/** A negator immediately before a yes word turns it into a decline ("not ok", "never mind, no"). */
const NEGATORS = new Set(['not', 'never', 'dont', 'don', 'cant', 'cannot', 'wont', 'no']);
const NEGATION_LOOKBACK = 2;

const YES_TOKENS = CONSENT_YES_PHRASES.map(p => p.split(' '));
const NO_TOKENS = CONSENT_NO_PHRASES.map(p => p.split(' '));

function clauseTokens(text: string): string[][] {
  return text
    .toLowerCase()
    .split(CLAUSE_BREAK)
    .map(c => c.replace(NON_WORD, ' ').trim().split(' ').filter(Boolean));
}

function wordCount(text: string): number {
  return text.toLowerCase().replace(NON_WORD, ' ').trim().split(' ').filter(Boolean).length;
}

function matchAt(tokens: string[], at: number, phrase: string[]): boolean {
  for (let i = 0; i < phrase.length; i++) if (tokens[at + i] !== phrase[i]) return false;
  return true;
}

function negated(tokens: string[], at: number): boolean {
  for (let back = 1; back <= NEGATION_LOOKBACK; back++) {
    const word = tokens[at - back];
    if (word && NEGATORS.has(word)) return true;
  }
  return false;
}

/**
 * Read one reply as consent. PURE, and deliberately hard to get a 'yes' out of:
 *
 *   • a question is never consent, whatever words it contains — the guard the word "go" needs,
 *     because "how did that go?" is a reply about the action, not permission for it;
 *   • a reply carrying BOTH a yes and a no settles nothing ("yes but not now");
 *   • a yes word inside a negator's reach is a no ("not ok", "don't send it");
 *   • anything past CONSENT_MAX_WORDS is 'unclear', and so is every language the list cannot read.
 */
export function classifyConsent(text: string): Consent {
  const t = (text ?? '').trim();
  if (!t) return 'unclear';
  // A question mark anywhere: they are asking, not answering.
  if (t.includes('?')) return 'unclear';
  if (wordCount(t) > CONSENT_MAX_WORDS) return 'unclear';

  let yes = false;
  let no = false;
  for (const tokens of clauseTokens(t)) {
    for (const phrase of NO_TOKENS) {
      for (let at = 0; at + phrase.length <= tokens.length; at++) if (matchAt(tokens, at, phrase)) no = true;
    }
    for (const phrase of YES_TOKENS) {
      for (let at = 0; at + phrase.length <= tokens.length; at++) {
        if (!matchAt(tokens, at, phrase)) continue;
        // A negated yes is a decline, not an unsettled reply: "not ok" is an answer.
        if (negated(tokens, at)) no = true;
        else yes = true;
      }
    }
  }
  if (yes && no) return 'unclear'; // mixed — the ask stays open
  if (no) return 'no';
  return yes ? 'yes' : 'unclear';
}

// ── the classify lane ────────────────────────────────────────────────────────

const CONSENT_SYSTEM_PROMPT = [
  'A texting assistant asked its user for permission to do ONE irreversible thing on their behalf',
  '(sending a message, booking, buying, cancelling something). You are given that action and the',
  "user's next reply, in any language. Decide whether the reply GRANTS permission for that exact",
  'action.',
  'Reply with exactly one word: YES (they clearly agreed), NO (they clearly declined or want to',
  'wait), or UNCLEAR (anything else — a question, a different subject, a conditional, or a reply you',
  'cannot read as either). If in any doubt at all, answer UNCLEAR: a wrong YES performs something',
  'nobody approved.',
].join(' ');

let llmForTests: typeof callLLM | null = null;

/** Test seam for suites that drive the gate END TO END through processConvoResult and so have no
 *  argument to inject through (the pattern of __setRecallExpansionLlmForTests). Unit tests pass
 *  `deps.llm` instead. null = off, which is the production shape. */
export function __setConsentLlmForTests(fn: typeof callLLM | null): void {
  llmForTests = fn;
}

function readVerdict(text: string | null | undefined): Consent {
  const first = (text ?? '').trim().toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ')[0] ?? '';
  if (first === 'YES') return 'yes';
  if (first === 'NO') return 'no';
  return 'unclear';
}

/**
 * The full reading: the English lexicon, then ONE classify call for anything it could not settle.
 *
 * The caller must only reach this while an approval is actually pending — the lane call exists for
 * a reply that is probably an answer, and a lane consulted on every turn would be a per-turn tax
 * for nothing (see the pending check in convo/shared.ts).
 *
 * Every failure is 'unclear': a thrown lane, a spent budget, an install with no classify lane at
 * all, a verdict that is not one of the three words. The action stays parked.
 */
export async function resolveConsent(
  reply: string,
  request: string,
  deps: { llm?: typeof callLLM } = {},
): Promise<Consent> {
  const lexicon = classifyConsent(reply);
  if (lexicon !== 'unclear') return lexicon;

  const words = wordCount(reply ?? '');
  if (!words || words > CONSENT_CLASSIFY_MAX_WORDS) return 'unclear';

  const llm = deps.llm ?? llmForTests ?? callLLM;
  try {
    const res = await llm({
      role: 'classify',
      system: CONSENT_SYSTEM_PROMPT,
      // Both halves are user-authored text and are tagged as data: the reply is being CLASSIFIED,
      // never followed, and the action line is there so "do the second one" cannot read as consent
      // to something else.
      messages: [{ role: 'user', content: wrapPrompt([dataTag('action', request), dataTag('their_reply', reply)].join('\n')) }],
      trace: { label: 'ops:consent' },
    });
    return readVerdict(res.text);
  } catch (err) {
    // Invisible to the user by design — the ask simply stays open — which is exactly why it is
    // reported as well as logged: a lane that has been down for a week would otherwise show up only
    // as "she keeps asking me twice". Same category as the other background classify passes.
    console.warn('[ops] consent classify failed — leaving the approval pending', err);
    reportError({
      source: 'ops',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'consent classification failed — the approval stays pending',
      err,
    });
    return 'unclear';
  }
}

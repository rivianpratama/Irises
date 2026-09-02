// The unkept-promise guard — the honesty backstop under the ONE failure the persona names as
// unrecoverable: a reply that promises work while nothing is actually being done for the user.
//
// Observed live (VPS, 2026-09-02). The user: "coba minta si hermes pake browser feature". The reply:
// "udah bro, hermes udah gue suruh pake browser … masih jalan, bentar lagi" — with `tool_calls: null`
// and no run in flight, the earlier one having finished 2.5h before. A fabricated in-flight claim,
// and nothing in the pipeline was looking for it: the routing gate reads the USER's message (and read
// that one as social), and the false-refusal floor reads the draft for the opposite failure — a claim
// that something is impossible. A promise is a claim about the FUTURE, so it can only be checked
// against what the turn actually DID, which is what this module is for.
//
// PURE: the lexicon and the verdict. The one corrective re-ask lives in the call path
// (convo/shared.ts, beside the JSON-envelope retry it mirrors) — only that has a model to re-ask.

/**
 * The promise lexicon — bilingual, because she texts in both. Whole phrases, not words: single words
 * ("cek", "checking") carry no commitment on their own, and the verdict here costs a model call.
 *
 * SINGLE SOURCE (the THEME_KINDS pattern): the trigger and the re-ask's accept check read this same
 * array, so a phrase can never be one the guard fires on but the retry is not held to. Deliberately
 * short — every entry is a phrase whose plain reading is "work is happening right now", which is
 * exactly the claim a turn with no tool call and no active run cannot back.
 */
export const PROMISE_PHRASES = [
  // EN
  'on it',
  'looking that up',
  'pulling that up',
  'checking on that',
  'digging into',
  'still on it',
  'still digging',
  'hang tight',
  'gimme a sec',
  'give me a minute',
  'back in a bit',
  // ID
  'gue cek',
  'gue cari',
  'gue suruh',
  'lagi jalan',
  'masih jalan',
  'bentar lagi',
  'sabar ya',
  'tunggu ya',
  'lagi gue',
] as const;

/** One phrase from the lexicon above — derived from the array so the two can never drift. */
export type PromisePhrase = typeof PROMISE_PHRASES[number];

export interface UnkeptPromiseVerdict {
  /** The reply claims work is happening (or about to). */
  promised: boolean;
  /** The phrase that made it a promise, in reading order. Absent when nothing promised. */
  phrase?: PromisePhrase;
  /** It promised, and NOTHING is behind it: no tool call this turn, no research in flight. */
  unkept: boolean;
}

// A phrase has to land inside ONE clause. Sentence and clause punctuation ends the run of words a
// phrase may span, so "moving on. it can wait" and "hang on, it broke" are not promises even though
// their letters contain one — the words sit either side of a break. Every other non-alphanumeric run
// collapses to a single space, which is what makes the match blind to case, punctuation and the
// `[[re:N]]` routing prefix ("ON IT!", "[[re:1]]gue cek dulu"). The leading/trailing pad is what
// makes the includes() below a whole-phrase test rather than a substring one ("depends on itself"
// contains "on it" as letters, never as words).
const CLAUSE_BREAK = /[.!?,;:\n\r]+/;
const NON_WORD = /[^a-z0-9]+/g;

function clauses(text: string): string[] {
  return text.toLowerCase().split(CLAUSE_BREAK).map(c => ` ${c.replace(NON_WORD, ' ').trim()} `);
}

/** The first phrase the reply promises with, scanning bubble by bubble in reading order. */
function findPromise(bubbles: string[]): PromisePhrase | undefined {
  for (const bubble of bubbles) {
    for (const clause of clauses(bubble)) {
      for (const phrase of PROMISE_PHRASES) {
        if (clause.includes(` ${phrase} `)) return phrase;
      }
    }
  }
  return undefined;
}

/**
 * Did this reply promise work it isn't doing? PURE — the three inputs are the whole question:
 * the bubbles she wrote, the tool calls the same envelope carried, and how many Ops runs are already
 * in flight for the chat.
 *
 * A promise is KEPT by either half: a tool call (the work starts the moment this turn dispatches) or
 * an active run ("still on it" is simply true then). Only the empty case is a lie, and it is the one
 * that shipped live.
 */
export function detectUnkeptPromise(
  bubbles: string[],
  toolCalls: unknown[] | null,
  activeOps: number,
): UnkeptPromiseVerdict {
  const phrase = findPromise(bubbles);
  const promised = phrase !== undefined;
  const nothingBehindIt = (!toolCalls || toolCalls.length === 0) && activeOps === 0;
  return {
    promised,
    ...(phrase !== undefined ? { phrase } : {}),
    unkept: promised && nothingBehindIt,
  };
}

/**
 * The corrective the re-ask appends after the model's own slip — system-authored, so bare prose in a
 * user-role message, exactly like the JSON-envelope retry's. It offers the two honest exits and names
 * the third as forbidden: do the work for real, or say plainly what you can and can't do.
 */
export function renderPromiseCorrection(phrase: string): string {
  return `SYSTEM: your reply promised work ("${phrase}") but called no tool and nothing is running for them. Reply again as ONE JSON object: either include the delegate_to_ops entry that actually does the work, or say plainly what you can and can't do right now — never claim work is in progress.`;
}

/**
 * The feature gate (env: CONVO_UNKEPT_PROMISE_GUARD). Default ON, read at CALL time so flipping it
 * needs no restart — the same parse shape as every sibling flag (turnFocusBlockEnabled,
 * threadingEnabled, themeTopicGateEnabled, turnTraceEnabled).
 *
 * It gates the CALL PATH (convo/shared.ts), not this module: off means the scan never runs, no
 * re-ask is spent, no receipt is filed, and the reply the model wrote ships byte-identically to an
 * install that never had the guard.
 */
export function unkeptPromiseGuardEnabled(): boolean {
  const v = (process.env.CONVO_UNKEPT_PROMISE_GUARD || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

// How long a back-line run is likely to take, in the only unit the user cares about: a phrase.
//
// The point is NOT accuracy — it's consistency. Once we've told the user "a couple of minutes",
// every later progress ping must keep saying the same thing (or say less), never a different
// number. So the estimate is a coarse bucket chosen ONCE at delegation time and stored on the
// in-flight entry; everything downstream reads it rather than re-deriving one.
import type { TaskKind } from './types.js';

export interface EtaEstimate {
  bucketMs: number;
  phrase: string;
}

/**
 * A sweep across everything the user has, rather than a look at one thing. These runs fan out over
 * many tool calls and reliably overrun the standard bucket, so they get promoted to the deep bucket
 * regardless of kind. Deliberately request-text based: the kind Convo picks is often 'general' for
 * exactly these asks.
 */
export const CROSS_ENTITY_RE = /\b(all|across|every|each|which ones|everything (?:due|open|pending|outstanding)|anything (?:due|open|pending|outstanding))\b/i;

// An inbox sweep — going THROUGH a mailbox or a pile of files — fans out over many fetch-and-read
// steps and reliably overruns the standard bucket, like a cross-entity sweep, so it gets the deep
// bucket regardless of kind. Deliberately narrow: it matches sweep PHRASING ("go through my inbox",
// "check my email", "dig through the attachments"), NOT a single-item read ("open the pdf jamie
// sent", "read the contract") — those stay in the standard bucket. Request-text based like CROSS_ENTITY.
export const INBOX_FILES_RE = /\b(inbox|go through|dig through|sweep)\b|\bthrough (?:my|the|all) (?:e-?mails?|mail|messages|attachments?|files|docs|documents)\b|\bcheck (?:my|the) (?:e-?mail|inbox)\b/i;

// Writing a message is one LLM turn plus maybe a lookup — reliably the fastest lane we have.
const QUICK_KINDS: TaskKind[] = ['draft'];

/** The deepest bucket: a fan-out sweep, and the phrase any longer run keeps saying. */
const DEEP: EtaEstimate = { bucketMs: 210_000, phrase: 'a few minutes' };

/**
 * @param budgetMs this leg's actual deadline, when the caller armed a WIDER one than the buckets
 *   below assume — today only the walled-URL browser budget (agents/ops/client.ts's legBudgetFor).
 *   The bucket then becomes that number, so every later reading (etaStatus's early/closing/overrun,
 *   and the pings that quote it) is measured against the deadline the run really has instead of
 *   reporting 'overrun' three and a half minutes into a fifteen-minute browser look. The PHRASE
 *   stays the deep bucket's: the user hears the same coarse words either way, and this is arithmetic,
 *   not a new promise. Only ever widens — a budget narrower than the ask's own bucket is ignored,
 *   so an absent one is byte-identical to before.
 */
export function estimateOpsEta(input: { kind: TaskKind; request: string; forceGrounding?: boolean; budgetMs?: number }): EtaEstimate {
  const est = baseEstimate(input);
  const budget = input.budgetMs;
  return budget && Number.isFinite(budget) && budget > est.bucketMs ? { bucketMs: budget, phrase: DEEP.phrase } : est;
}

function baseEstimate(input: { kind: TaskKind; request: string; forceGrounding?: boolean }): EtaEstimate {
  if (CROSS_ENTITY_RE.test(input.request) || INBOX_FILES_RE.test(input.request) || (input.kind === 'general' && input.forceGrounding) || input.kind === 'compute') {
    return DEEP;
  }
  if (QUICK_KINDS.includes(input.kind)) {
    return { bucketMs: 60_000, phrase: 'about a minute' };
  }
  return { bucketMs: 120_000, phrase: 'a couple of minutes' };
}

export type EtaState = 'early' | 'closing' | 'overrun';

export interface EtaStatus {
  phrase: string;
  state: EtaState;
  remainingPhrase?: string;
}

function remainingLabel(remainMs: number): string {
  if (remainMs < 60_000) return 'under a minute';
  if (remainMs < 150_000) return 'another minute or two';
  return 'a few more minutes';
}

/**
 * Where a run sits against its own estimate. `early` carries a remaining phrase (safe to quote a
 * shrinking window); `closing` and `overrun` deliberately do NOT — past ~60% the honest move is to
 * stop putting new numbers in the user's head.
 */
export function etaStatus(estimate: EtaEstimate, elapsedMs: number): EtaStatus {
  const ratio = elapsedMs / estimate.bucketMs;
  if (ratio > 1) return { phrase: estimate.phrase, state: 'overrun' };
  if (ratio >= 0.6) return { phrase: estimate.phrase, state: 'closing' };
  const remain = estimate.bucketMs - elapsedMs;
  return { phrase: estimate.phrase, state: 'early', remainingPhrase: remainingLabel(remain) };
}

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

// Writing a message is one LLM turn plus maybe a lookup — reliably the fastest lane we have.
const QUICK_KINDS: TaskKind[] = ['draft'];

export function estimateOpsEta(input: { kind: TaskKind; request: string; forceGrounding?: boolean }): EtaEstimate {
  if (CROSS_ENTITY_RE.test(input.request) || (input.kind === 'general' && input.forceGrounding) || input.kind === 'compute') {
    return { bucketMs: 210_000, phrase: 'a few minutes' };
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

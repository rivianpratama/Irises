// Canonical tool-call order — one turn's calls run in the order the RESULT needs, not the order
// the model happened to write them.
//
// Observed shape (the 2026-09-23 action-honesty audit). "Stop that and look it up again" comes back
// as `[delegate_to_ops X, cancel_research]`, written the way a person says it. Run in that order,
// the delegate went first, found the identical ask X still in flight and suppressed itself as a
// duplicate; the cancel then stopped that very run. Nothing was left running, the "still on it"
// line for the run that was gone was dropped as stale, and the turn went silent. The same audit
// found the model writing the same cancel twice in one envelope: the second found nothing left to
// cancel, and its miss replaced a correct "dropped it".
//
// The fix is an order, not a special case. Cancels run first, so a cancel frees what it frees — the
// in-flight entry, the dedupe key (requestOpsCancel clears it), the delegation slot — before
// anything new is judged against it. Revisions of live things (an update, a steer) run next, while
// what they revise still stands; then the creates and delegations, against the state the cancels and
// updates left; then everything else in the order written. And one exact duplicate of a call is the
// same call: it runs once.
//
// PURE, like toolCallGuard.ts beside it: shared.ts applies it to the list the guards left standing
// and records the receipt; this module only answers which calls run, and in what order.

import type { LlmToolCall } from '../../llm/types.js';

const CANCELS = new Set(['cancel_automation', 'cancel_research']);
const UPDATES = new Set(['update_automation', 'steer_research']);
const CREATES = new Set(['schedule_automation', 'delegate_to_ops']);

function rank(name: string): number {
  if (CANCELS.has(name)) return 0;
  if (UPDATES.has(name)) return 1;
  if (CREATES.has(name)) return 2;
  return 3;
}

/**
 * What makes two calls the same call: the tool name plus its non-null args, keys sorted. Nulls are
 * dropped because an absent arg and a null one mean the same thing to every handler (and the parse
 * boundary already strips most of them). Values are compared as written, arrays in their own order.
 */
export function toolCallKey(call: LlmToolCall): string {
  const input = call.input ?? {};
  const args = Object.keys(input)
    .filter(k => input[k] != null)
    .sort()
    .map(k => [k, input[k]]);
  return `${call.name}:${JSON.stringify(args)}`;
}

/**
 * The turn's calls in canonical order with exact duplicates dropped. Order: cancels, then updates
 * and steers, then creates and delegations, then everything else — each group in the order the
 * model wrote it (the sort is stable). The FIRST of a set of duplicates is the one kept.
 * `duplicates` names each dropped call's tool, for the receipt.
 */
export function orderToolCalls(calls: readonly LlmToolCall[]): { calls: LlmToolCall[]; duplicates: string[] } {
  const seen = new Set<string>();
  const kept: LlmToolCall[] = [];
  const duplicates: string[] = [];
  for (const call of calls) {
    const key = toolCallKey(call);
    if (seen.has(key)) {
      duplicates.push(call.name);
      continue;
    }
    seen.add(key);
    kept.push(call);
  }
  return {
    calls: kept.map((call, i) => ({ call, i })).sort((a, b) => rank(a.call.name) - rank(b.call.name) || a.i - b.i).map(x => x.call),
    duplicates,
  };
}

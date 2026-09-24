// The early-emit gate: the PURE decisions behind sending a bubble before the reply that carries it
// has finished generating. A later task (streaming the reply sentence-by-sentence, Task 15) is the
// impure half — it owns the model connection, the send timing and the fallback when the gate says
// no partway through. Everything here is a function of its arguments alone, on purpose: the ONE
// failure this whole feature must never cause is a sentence reaching the user that a downstream
// guard would have discarded or rewritten, and a gate that is pure is a gate a test can pin down to
// every combination without a model in the loop.
//
// Three questions, three functions:
//   • streamArmed  — before the call even starts, is this turn's shape one where an early sentence
//     is safe at ALL? (a whole-turn question, decided once)
//   • sentenceBlocker — for one sentence that already streamed out of the model, does it carry a
//     failure shape the send path would have caught downstream? (a per-sentence question, decided
//     once per candidate)
//   • cleanEarlySentence — the cosmetic cleanup sendBubbles already applies to every bubble
//     (routing-tag strip, echoed-timestamp strip, tool-name redaction, Ops-scaffolding strip).
//     Reused verbatim so an early-sent bubble and a normally-sent bubble are byte-identical for the
//     same input — two cleanup paths for one bubble is how they drift.
//
// REUSE, NOT REIMPLEMENTATION. Every check below calls the same function the non-streamed path
// already trusts (unkeptPromise.ts's two detectors, routingGate.ts's refusal map, guardrails.ts's
// two scrubs, replyThreading.ts's tag strip, chatTime.ts's marker strip). A second lexicon here would
// only ever be a second place for the first one to go stale against.

import { detectUnkeptPromise, detectUnbackedClaim } from '../agents/convo/unkeptPromise.js';
import { refusedCapabilities } from '../agents/routingGate.js';
import { redactInternalTools, stripOpsScaffolding } from '../agents/guardrails.js';
import { stripReplyTag } from '../state/replyThreading.js';
import { stripTimestampMarker } from './chatTime.js';

/**
 * Everything `streamArmed` needs, gathered before the model call starts (Task 15 builds this from
 * values `chat()` already has on hand — a parked-approval DB read, the hook directive picked for
 * this turn, the routing gate's own pre-check, and the chat/turn shape).
 */
export interface PreCallFacts {
  /** A delegation is parked on this chat awaiting a yes/no — the routing/approval floor may replace
   *  the whole draft with the parked question, so nothing of the model's own draft may ship early. */
  hasParkedApproval: boolean;
  /** The hook mode picked for this turn (persona/hooks.ts `HookMode`, or `undefined` with no hook
   *  directive at all — which reads as a plain task turn, same as `client.ts`'s own `anchorMode`
   *  fallback). Streaming is armed on a task turn only: a share or idle (hook/quiet) turn carries its
   *  own downstream law — one hook, the share turn's gated follow-up, the quiet guard's retry — that
   *  reads the WHOLE draft before deciding what ships, and an early sentence would already be on the
   *  user's screen before that law had a turn to act on it. */
  hookMode: 'task' | 'share' | 'idle' | 'quiet' | string | undefined;
  /** The routing gate's pre-check, and ONLY the pre-check: `needsGrounding(textToSend) === 'yes'`,
   *  with NO freshness read alongside it. The freshness TTL can flip between this read and the gate's
   *  own later one, and `holdsTheAnswer` only ever stands the gate down — it never rewrites what
   *  ships — so a flag computed here that also weighed freshness could arm on a turn the gate goes on
   *  to force-delegate, which discards the draft this flag is guarding. */
  groundingFlagged: boolean;
  /** A group chat. */
  isGroupChat: boolean;
  /** The turn is an intro weave or a first-move message rather than an ordinary reply. */
  introOrFirstMove: boolean;
  /** More than one message landed in the same burst (`chatContext.burstManifest.length > 1`).
   *  Bubble order in a burst reply is `text` first, `re` (which incoming message it answers) second
   *  — so the moment bubble 0's FIRST sentence closes, its thread target is still unknown. A burst
   *  turn never arms. */
  isBurst: boolean;
  /** `STREAM_FIRST_BUBBLE` — see `streamFirstBubbleEnabled` below. */
  enabled: boolean;
}

/**
 * `STREAM_FIRST_BUBBLE` — the master switch for early-emit, read at CALL time so a flip needs no
 * restart (same house shape as `persona/featureFlags.ts`, read fresh on every use rather than cached
 * at import time). Default ON, and — unlike the whitelist those four flags parse against — disabled
 * by exactly one word, `off`: this switch is the one an operator reaches for FIRST if a live turn
 * ships a bad early sentence, so it has to come back off with the plainest possible value, not a
 * word chosen from a list nobody has memorized at 3am.
 */
export function streamFirstBubbleEnabled(): boolean {
  const v = (process.env.STREAM_FIRST_BUBBLE || '').trim().toLowerCase();
  if (v === '') return true;
  return v !== 'off';
}

/**
 * May THIS TURN stream at all? A whole-turn decision, made once before the model call starts — every
 * fact has to read clean, because any one of them is a downstream pass that may still rewrite or
 * discard the draft this gate is about to let out early.
 */
export function streamArmed(f: PreCallFacts): boolean {
  return f.enabled
    && !f.hasParkedApproval
    && (f.hookMode === undefined || f.hookMode === 'task')
    && !f.groundingFlagged
    && !f.isGroupChat
    && !f.introOrFirstMove
    && !f.isBurst;
}

/**
 * Stateless per-sentence scans: may THIS sentence, already out of the model, go out early? Returns
 * the reason it must NOT (the same shape the send path's own downstream guards would have caught it
 * under), or `null` when it's clean.
 *
 * Checked in the same order the honesty backstop runs its own two detectors (convo/shared.ts's
 * `enforcePromiseKept`, promise before claim), then the refusal floor, then the internal-leak
 * tripwires — cheapest and most likely first, though the checks are independent and a sentence can
 * only ever carry one of these at a time in practice.
 */
export function sentenceBlocker(text: string, ask: string): 'promise' | 'claim' | 'refusal' | 'internal' | null {
  // A promise ("lemme check that") with nothing behind it — no tool call and no active run — reads
  // one sentence early exactly the way it would read as a whole reply: it can't be backed by a call
  // that hasn't happened yet, because the envelope carrying the tool call hasn't finished streaming.
  if (detectUnkeptPromise([text], null, 0).unkept) return 'promise';
  // A claim of a change ("revised it") is judged the same way: no mutating call and nothing an
  // earlier pass of this turn already backed it with, both of which are true by construction — the
  // envelope this sentence is streaming out of hasn't run anything yet either.
  if (detectUnbackedClaim([text], [], false).unbacked) return 'claim';
  // The false-refusal floor's own subject map, read against this one sentence and the user's ask —
  // the same signature the whole-reply floor uses (routingGate.ts:283).
  if (refusedCapabilities(text, ask).length > 0) return 'refusal';
  // An internal-machinery leak or raw Ops scaffolding: block whenever either scrub would actually
  // CHANGE the text, which is the same "did it fire" test each scrub's own doc comment describes.
  if (redactInternalTools(text) !== text || stripOpsScaffolding(text) !== text) return 'internal';
  return null;
}

/**
 * The same per-bubble cleanup `sendBubbles` (index.ts) applies to every outbound bubble, run over a
 * single early sentence: strip a leaked `[[re:N]]` routing tag, strip a leaked echoed timestamp
 * marker, then the two scrubs `sentenceBlocker` above already checked for a CHANGE (here they're
 * applied, not just probed). Byte-identical to the normal send path by construction — both call the
 * same four functions in the same order — which is the whole point: an early sentence and its later,
 * normally-sent siblings must read as one voice, not two cleanup paths that can drift apart.
 */
export function cleanEarlySentence(text: string): string {
  const stripped = stripReplyTag(text);
  const unstamped = stripTimestampMarker(stripped);
  return stripOpsScaffolding(redactInternalTools(unstamped));
}

// The thread harvest: the two ends of associative threading that touch the world. One WRITER that
// folds what she noticed this turn into the stored inventory, and one READER that picks at most one
// thing to put in front of her before the turn runs. Every decision — what a note routes to, what an
// outcome is worth, which candidate wins, which rung it may be delivered at — lives in
// persona/threads.ts; this file is the plumbing around it.
//
// Doctrine, inherited wholesale from the climate drift eval beside it:
//   • The model is a SUGGESTER inside an envelope it already emits. It writes at most one short note
//     and one of three outcome words into `status`; every count, transition, budget, cooldown and cap
//     is applyThreadHarvest's and selectThreadCandidate's, in code (charter §10.1).
//   • ZERO new LLM calls. Capture piggybacks the status envelope, selection is pure arithmetic.
//   • Failure is a total no-op and NEVER user-visible: nothing written, no candidate offered, and the
//     turn proceeds exactly as it would on an install that never had the feature.
//
// NO FAILURE BACKOFF, deliberately — the one place this diverges from climateDrift.ts. That backoff
// exists because a sticky failure there (a dead lane, an open budget breaker) bills one classify call
// per reply, forever, down a path that is silent by design. Nothing here reaches a lane: a failure
// costs a SQLite round trip that already logged itself, so the expensive kind of silence this guards
// against cannot happen, and retrying every turn is simply the right behaviour.
//
// GROUP CHATS ARE SKIPPED ENTIRELY, at BOTH ends. Structural privacy, not tuning: a theme is one
// person's recurring value/tension/goal and a loop is one person's pending thing. Harvested in a room
// they would be a read of whoever happened to be talking; offered in a room they would put one
// member's private thread in front of everyone else in it. Themes never form in a room.

import { getForgetEpoch } from '../db/repositories/memory.js';
import {
  getThreadInventory, saveThreadInventory, threadingEnabled, themeTopicGateEnabled,
} from '../db/repositories/threadInventory.js';
import {
  applyThreadHarvest, selectThreadCandidate,
  type ThreadCandidate, type ThreadMaterial,
} from '../persona/threads.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { AffectState, EmittedStatus, IntentMode } from '../persona/status.js';

/** One harvest per handle at a time. A burst of replies must not have two passes read the same
 *  pre-harvest row and double-count the same turn — the tick alone (turnsSinceOffer, harvestCount)
 *  is enough for that to matter, since both feed budgets a second reader would then mis-bill. */
const inFlight = new Set<string>();

/** Test seam: drop the in-flight guard (repo convention — see __resetClimateInFlightForTests). */
export function __resetThreadInFlightForTests(): void {
  inFlight.clear();
}

/** The intent modes that mark a theme minted HERE as minted-in-distress. Narrower than selection's
 *  THREAD_BLOCKING_MODES (which also closes on `confused`/`deflecting`): being lost or evasive is a
 *  bad moment to SPEAK a pattern, but it is not the kind of moment that should permanently hold
 *  everything noticed in it at the bottom rung. Venting and overwhelm are. */
const DISTRESSED_MODES: readonly IntentMode[] = ['venting', 'overwhelmed'];

/** And the valence below which the same holds regardless of mode. Its own constant rather than a
 *  reuse of THREAD_MOOD_FLOOR: that one decides whether to speak a pattern in THIS moment, this one
 *  decides whether a theme born in this moment is held at the fact rung for the rest of its life.
 *  They agree on the number today and are free to disagree later. */
const DISTRESS_MOOD_FLOOR = 35;

/** What the pre-turn read hands the prompt builder. Both halves are independent and both default to
 *  null, which renders to the empty string — the byte-inertness the whole feature rests on. */
export interface ThreadTurn {
  offer: ThreadCandidate | null;
  outcomeAsk: { label: string; material: ThreadMaterial } | null;
}

const NOTHING: ThreadTurn = { offer: null, outcomeAsk: null };

/**
 * Fold this turn's emitted material into the stored inventory. Fire-and-forget from the reply path
 * (`void updateThreadInventory(...)`); never awaited, never surfaced, never throws.
 *
 * The gate order is binding:
 *   0. the feature flag → skip. FIRST, before everything, so a disabled install pays nothing at all —
 *      not a read, not a write. The pre-turn read is gated by the same flag, so with it off the
 *      prompt is byte-identical to an install that never had threading.
 *   1. group identity → skip (see the header — structural, not tuning)
 *   2. …and NO gate on `emitted`. A turn whose status came back garbled still HAPPENED: the tick
 *      (turnsSinceOffer++, harvestCount++, the loop clock, the pending machine's expiry) has to run
 *      on every turn where selection could have run, or the budgets that pace her drift out of step
 *      with the conversation and a pending offer never times out. A missing status is simply a
 *      harvest with no note and no outcome — applyThreadHarvest's tick-only path.
 *   3. already in flight → skip
 *   4. fence the /forget epoch, read, apply, save, receipt.
 */
export async function updateThreadInventory(
  handle: string,
  emitted: EmittedStatus | undefined,
  opts: { chatId?: string; now?: number } = {},
): Promise<void> {
  if (!threadingEnabled()) return;
  if (!handle || isGroupHandle(handle)) return;
  if (inFlight.has(handle)) return;

  const now = opts.now ?? Date.now();
  const chatId = opts.chatId;

  inFlight.add(handle);
  try {
    // Read BEFORE the read-modify-write and passed into the save: a /forget that lands while this
    // turn is in flight must not have its wipe undone by a write that read the pre-forget inventory.
    const epoch0 = getForgetEpoch(handle);
    const inventory = await getThreadInventory(handle);

    // A theme first noticed while they were venting or low is bait forever: `mintedDistressed` is one
    // of the four conditions that hold a theme at the fact rung, so what she captured in a hard
    // moment can only ever be handed back as a plain question, never as a named pattern.
    const distressed = !!emitted
      && (DISTRESSED_MODES.includes(emitted.intent_mode) || emitted.mood_level < DISTRESS_MOOD_FLOOR);

    const { next, report } = applyThreadHarvest(
      inventory, emitted?.thread_note, emitted?.thread_outcome, now, { distressed },
    );
    const saved = await saveThreadInventory(handle, next, { ifForgetEpoch: epoch0 });

    // The BARE TICK IS NOT TRACED. Every single turn runs one, so recording them would put a
    // threads:harvest event on every reply in the ring buffer and drown the dashboard in the one
    // shape that carries no information. Per-turn visibility already rides `convo:status`, which
    // carries the two emitted fields; this event is for the turns where something actually MOVED.
    if (report.note !== 'none' || report.outcome !== 'none' || report.transitions.length > 0) {
      record({
        type: 'event',
        label: 'threads:harvest',
        chatId,
        handle,
        // The model's own words for the thing (`label`) live HERE and in the prompt block, nowhere
        // else — a receipt is where prose belongs. `saved` is false when the /forget fence refused
        // the write: a wipe must never show in diagnostics as an applied harvest.
        detail: { ...report, saved },
      });
    }
  } catch (err) {
    // Nothing was written and nothing is owed: the next reply harvests again from whatever the row
    // still says. No backoff — see the header.
    reportError({
      source: 'memory',
      category: 'other',
      severity: 'warn',
      message: 'thread harvest failed — nothing written',
      err,
      handle,
    });
  } finally {
    inFlight.delete(handle);
  }
}

/**
 * The pre-turn read: at most one thing to offer, plus the bookkeeping ask for whatever was offered
 * last turn. Runs on the hot path, so it degrades to `NOTHING` on any failure — a thread that cannot
 * be read costs a callback and nothing else.
 *
 * Two writes-adjacent facts worth stating plainly:
 *   • An offer is BILLED HERE, on the offer and not on her using it. A model that ignores every
 *     suggestion still spends the budget — that is the whole Detective backstop, and it only works
 *     if this persists `next` even though nothing downstream reports back.
 *   • The save is fire-and-forget but effectively synchronous (better-sqlite3), which matters for
 *     ORDER: the harvest at the END of this same turn reads the row this write just made, and that
 *     read is what advances the pending slot from `offered` to `awaiting`.
 */
export async function pickThreadForTurn(
  handle: string,
  affect: AffectState | null | undefined,
  opts: { incomingText: string; gapMs: number; chatId?: string; now?: number },
): Promise<ThreadTurn> {
  if (!threadingEnabled()) return NOTHING;
  if (!handle || isGroupHandle(handle)) return NOTHING;

  const now = opts.now ?? Date.now();
  const chatId = opts.chatId;

  try {
    const epoch0 = getForgetEpoch(handle);
    const inventory = await getThreadInventory(handle);

    // The outcome-ask for LAST turn's offer. `awaiting` means the offer was actually put in front of
    // her and a turn has passed, so asking how it landed is honest; `offered` means the harvest has
    // not run yet and she cannot know how something went that she has not said. A pending id whose
    // theme or loop has since been evicted, retired or pruned renders NOTHING rather than a question
    // about a thread that no longer exists.
    const pending = inventory.pending;
    let outcomeAsk: ThreadTurn['outcomeAsk'] = null;
    if (pending && pending.phase === 'awaiting') {
      const held = pending.material === 'loop'
        ? inventory.loops.find(l => l.id === pending.themeId)
        : inventory.themes.find(t => t.id === pending.themeId);
      if (held) outcomeAsk = { label: held.label, material: pending.material };
    }

    // Selection reads only the last-turn affect record, and only four of its fields (ThreadAffect) —
    // the gauges she was carrying when she last spoke, which is what "were they venting an hour ago"
    // actually means. A chat with no affect row yet passes null and every mode/mood gate stands down.
    // The engine is pure, so the ONE env read the selection needs happens here and is injected.
    const { candidate, next, report } = selectThreadCandidate(
      inventory, affect?.last ?? null, opts.incomingText, opts.gapMs, now,
      { topicGate: themeTopicGateEnabled() },
    );

    if (candidate) {
      // Fenced like the harvest: a /forget that landed between the read above and here must not have
      // an offer ledger written back over its wipe. Not awaited — the turn must not wait on a write
      // whose only reader is the next turn.
      void saveThreadInventory(handle, next, { ifForgetEpoch: epoch0 })
        .catch(err => console.warn('[memory] thread offer persist failed', err));
    }

    // EVERY run is traced, including — especially — the one where nothing qualified. The healthy
    // no-op IS the receipt: an inventory that keeps finding nothing to say and an inventory that
    // stopped being read look identical without it, and `filtered` accounts for every candidate that
    // vanished in exactly one disjoint bucket, so "why was she quiet" always has an answer.
    record({
      type: 'event',
      label: 'threads:select',
      chatId,
      handle,
      detail: {
        ...report,
        // Present only on an offer, so a scan of the ring never has to guess which reason won.
        ...(candidate
          ? { material: candidate.material, rungCeiling: candidate.rungCeiling, label: candidate.label, id: candidate.id }
          : {}),
        // Independent of the offer: an ask can render on a turn that offers nothing new.
        outcomeAsk: outcomeAsk ? outcomeAsk.material : null,
      },
    });

    return { offer: candidate, outcomeAsk };
  } catch (err) {
    reportError({
      source: 'memory',
      category: 'other',
      severity: 'warn',
      message: 'thread selection failed — nothing offered this turn',
      err,
      handle,
    });
    return NOTHING;
  }
}

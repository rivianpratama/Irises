// The reply-language slot's ONE write path — the repo glue over the pure core in
// memory/standingSettings.ts.
//
// Three things have to move together for a standing setting to actually stand, and every caller
// that moved only some of them is why the bug existed:
//   1. the medium-tier FACT row (`key=reply_language`) — the durable value, with the date it was
//      asked for, which is what the addressing header renders;
//   2. the PREFS copy — because the render's `factView` is `{...facts, ...prefs}`, prefs-wins
//      (memory/wrappers.ts): a value written to one store only either never renders or renders
//      stale forever;
//   3. the old language RULES — the medium-tier directives from the era when a language was a
//      directive. Leaving one standing is the whole 2026-09-04 failure: Convo answered "switching
//      now" in English while `always reply in Indonesian` stayed active, and the relay lanes, which
//      see eight to ten messages and never the reversal, obeyed the rule four times out of four.
//
// So there is exactly one function that writes the slot, and it does all three, in order, and
// records one receipt saying which input decided it.
//
// LOCKING: `withHandleLock` is a non-re-entrant promise queue (db/repositories/memory.ts), and
// every mutator here — `upsertFact`, `setPreference`, `supersedeEntries`, `retractEntry` — takes it
// at its own export boundary. They are therefore called SEQUENTIALLY from unlocked code, never
// nested; this module must never itself hold the lock.
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import { setPreference } from '../db/repositories/memory.js';
import {
  MediumWriteError, listMediumActive, retractEntry, supersedeEntries, upsertFact,
  type MediumEntry,
} from '../db/repositories/memoryMedium.js';
import type { Provenance } from './provenance.js';
import { REPLY_LANGUAGE_KEY, parseLanguageDirective } from './standingSettings.js';

/** Which input decided the slot this turn. Rides the `memory:reply_language` receipt, so the fast
 *  path's hit rate is readable next to the model tag's and the fold's is separable from both. */
export type ReplyLanguageVia = 'tool' | 'fast_path' | 'tag' | 'fold';

export interface SetReplyLanguageResult {
  /** False when the slot already held this language — the caller's "switching now" is still true,
   *  it just cost no write. */
  changed: boolean;
  /** The language rules retired in favour of the slot. Length is what the receipt reports. */
  retiredDirectiveIds: string[];
}

const NOTHING: SetReplyLanguageResult = { changed: false, retiredDirectiveIds: [] };

/** The active `reply_language` fact row, or undefined. */
function slotRow(rows: readonly MediumEntry[]): MediumEntry | undefined {
  return rows.find(e => e.status === 'active' && e.kind === 'fact' && e.key === REPLY_LANGUAGE_KEY);
}

/** Every active directive that is really a language rule (memory/standingSettings.ts reads the
 *  SHAPE — there is no lexicon of languages in `src/`, by the language-agnostic rule). */
function languageRules(rows: readonly MediumEntry[]): MediumEntry[] {
  return rows.filter(e => e.status === 'active' && e.kind === 'directive' && parseLanguageDirective(e.body) !== null);
}

/**
 * Set the standing reply language: fact row, prefs copy, and the retirement of any older language
 * rule, in that order, under one receipt.
 *
 * Never throws into a reply. A durable-write failure is logged and reported — the user's ask was
 * real and the reply that answers it is already composed, so the worst honest outcome is that the
 * setting has to be asked for again, not that the turn dies.
 */
export async function setReplyLanguage(
  handle: string,
  value: string,
  opts: {
    source: 'convo' | 'fold';
    prov?: Provenance;
    via: ReplyLanguageVia;
    at?: number;
    chatId?: string;
  },
): Promise<SetReplyLanguageResult> {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!handle || !clean) return NOTHING;
  try {
    // Read BEFORE the write: this is the only point where "was this already the setting?" and
    // "which rules predate it?" have an answer, and both ride the same single listing.
    const before = await listMediumActive(handle, ['fact', 'directive']);
    const changed = slotRow(before)?.body.trim() !== clean;
    const stale = languageRules(before).map(e => e.id);

    await upsertFact(handle, REPLY_LANGUAGE_KEY, clean, opts.source, opts.prov, opts.at != null ? { at: opts.at } : {});
    // Re-listed rather than assumed: upsertFact mints a NEW id whenever the value changed, and
    // that id is what the retired rules point at.
    const factId = slotRow(await listMediumActive(handle, ['fact']))?.id;
    await setPreference(handle, REPLY_LANGUAGE_KEY, clean);

    let retiredDirectiveIds: string[] = [];
    if (factId && stale.length) {
      const moved = await supersedeEntries(handle, stale, factId);
      // One rewrite over rows listed off the same per-handle queue: every id either moves or the
      // whole batch found nothing left to move. `moved` rides the receipt so a disagreement is
      // visible rather than inferred.
      retiredDirectiveIds = moved ? stale : [];
    }

    record({
      type: 'event',
      label: 'memory:reply_language',
      handle,
      chatId: opts.chatId,
      detail: { value: clean, via: opts.via, changed, retired: retiredDirectiveIds.length },
    });
    return { changed, retiredDirectiveIds };
  } catch (err) {
    if (!(err instanceof MediumWriteError)) throw err;
    console.warn(`[memory] reply-language write failed for ${handle}`, err);
    reportError({
      source: 'memory',
      category: 'write_failure',
      severity: 'warn',
      message: 'reply-language slot write failed — the standing setting did not move',
      err,
      handle,
      chatId: opts.chatId,
      detail: { value: clean, via: opts.via },
    });
    return NOTHING;
  }
}

/**
 * Empty the slot in both stores — "stop replying in a set language, go back to your default".
 *
 * Reached when the model REMOVES a directive that was a language rule (a user changing their mind
 * through the old vocabulary), so the removal has to reach the slot too or the rule comes back on
 * the next render.
 */
export async function clearReplyLanguage(handle: string): Promise<void> {
  if (!handle) return;
  try {
    const row = slotRow(await listMediumActive(handle, ['fact']));
    if (row) await retractEntry(handle, row.id);
    // `undefined` DELETES the key: prefs are serialized with JSON.stringify, which drops it. A
    // stored empty string would keep rendering an authority line with nothing in it.
    await setPreference(handle, REPLY_LANGUAGE_KEY, undefined);
    record({ type: 'event', label: 'memory:reply_language', handle, detail: { value: null, via: 'tool', cleared: true } });
  } catch (err) {
    if (!(err instanceof MediumWriteError)) throw err;
    console.warn(`[memory] reply-language clear failed for ${handle}`, err);
    reportError({
      source: 'memory',
      category: 'write_failure',
      severity: 'warn',
      message: 'reply-language slot clear failed — the old setting may still render',
      err,
      handle,
    });
  }
}

// ── the legacy fold ──────────────────────────────────────────────────────────
//
// Migration, done by Irises' own code rather than by hand (per Rivian: no hand edits to the VPS
// memory files). A language directive written before the slot existed is folded INTO the slot with
// its own date and superseded, so nothing is lost and nothing is invented: after deploy the live
// instance reads `Reply language: Indonesian (they asked on Aug 30)`, and one "english" ask flips
// it deterministically for every lane.

/** Per-process, per-handle: the fold is a write-on-read, and a read happens on every turn. */
const folding = new Map<string, Promise<void>>();

/** Test seam — the memo is per PROCESS, and a test that wants to prove the fold is idempotent at
 *  the DATA level (not just memoised) has to be able to ask twice. */
export function __resetLanguageFoldForTests(): void {
  folding.clear();
}

/**
 * Fold this handle's legacy language directives into the slot, once.
 *
 * Idempotent both ways: the memo stops the second call in a process, and the data itself stops the
 * second call in a later process (the directive is superseded, so nothing parses as a language rule
 * any more). Degrades to a no-op — a fold that cannot run leaves today's render exactly as it is.
 */
export function foldLanguageDirectives(handle: string): Promise<void> {
  const running = folding.get(handle);
  if (running) return running;
  const run = foldOnce(handle).catch(err => {
    console.warn(`[memory] language fold failed for ${handle}`, err);
    reportError({
      source: 'memory',
      category: 'write_failure',
      severity: 'warn',
      message: 'legacy language directive fold failed — the old rule still stands',
      err,
      handle,
    });
    // Drop the memo so a later turn can try again; a single hiccup must not pin the migration off
    // for the life of the process.
    folding.delete(handle);
  });
  folding.set(handle, run);
  return run;
}

async function foldOnce(handle: string): Promise<void> {
  if (!handle) return;
  const rows = await listMediumActive(handle, ['fact', 'directive']);
  const rules = languageRules(rows);
  if (!rules.length) return;

  // Newest ask wins — the same "more recent wins" the tier already applies, made applicable by
  // reading the row's own date instead of the text.
  const newest = rules.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const value = parseLanguageDirective(newest.body);
  if (!value) return;

  const slot = slotRow(rows);
  if (slot && slot.createdAt >= newest.createdAt) {
    // The slot already holds a NEWER answer (the user switched after that rule was written, and
    // code caught it). Folding would walk the setting backwards; only the dead rule goes.
    const moved = await supersedeEntries(handle, rules.map(r => r.id), slot.id);
    record({
      type: 'event',
      label: 'memory:reply_language',
      handle,
      detail: { value: slot.body, via: 'fold', changed: false, retired: moved },
    });
    return;
  }

  await setReplyLanguage(handle, value, { source: 'fold', via: 'fold', at: newest.createdAt });
}

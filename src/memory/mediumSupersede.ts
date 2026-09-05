// The medium tier's contradiction pass: when a NEW standing rule or remembered fact lands, retire
// the entries it replaces, reverses, or makes obsolete — with lineage, so "why is that rule gone"
// still reads off the row.
//
// WHY THIS EXISTS. The tier only ever APPENDED. `addDirective` dedupes exact text and nothing else,
// so "never be sarcastic" and "full sarcasm mode always" sat active side by side, and every lane
// read both. The reply-language slot fixed that for ONE dimension by owning it in code; this is the
// general case for every other subject a user can change their mind about — sarcasm, proactivity,
// what to flag in an inbox, where they live. Keyed facts (`comms_style`, `reply_language`) already
// replace by key and need nothing here.
//
// DOCTRINE, inherited from the note groomer and the dossier updater:
//   • The model is a SUGGESTER. It names NUMBERS from a list this module built; every number is
//     re-validated against that list here, and an id it could not have been shown cannot come back.
//   • Fail open to NOTHING. Garbage, a truncated array, a dead lane, a timeout, the flag off — every
//     one of them retires zero rows and leaves the tier byte-identical. A contradiction that
//     survives is the status quo; a row retired in error is a memory the user has to restate.
//   • Never user-visible, never awaited by a reply: callers fire it with `void`, and it never throws.
//
// ORDER, relative to the note groomer (memory/noteGroomer.ts): this pass runs FIRST. The groomer
// folds near-DUPLICATES into one synthesized note, so a note that is about to be retired for
// contradicting the new one must not be merged INTO something first — the merged text would carry
// the stale half of the fact forward under a fresh timestamp.
//
// LOCKING: `supersedeEntries` takes the per-handle lock at its own boundary, so it is called from
// unlocked code here, exactly once, after the plan is validated.

import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import {
  MediumWriteError, listMediumActive, supersedeEntries, type MediumEntry,
} from '../db/repositories/memoryMedium.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import { withTimeout } from './noteGroomer.js';

/** The two kinds a user can restate. `fact` is absent deliberately: a keyed slot replaces by key. */
export type SupersedeKind = 'directive' | 'important_note';

/** What the entry is CALLED in the prompt — the model is comparing rules or facts, and the two
 *  questions are not the same one ("changed instruction" vs "changed fact"). */
const KIND_NOUN: Record<SupersedeKind, string> = {
  directive: 'standing rule',
  important_note: 'remembered fact',
};

/** The answer is a JSON array of a handful of small integers; anything longer is not an answer. */
const PLAN_MAX_TOKENS = 40;
/** Wall clock for the one call, the same bound the note groomer puts on its classify. Nothing
 *  awaits this pass, but a hung lane would hold rows it read against a tier that has moved on. */
const PLAN_TIMEOUT_MS = 15_000;

/**
 * Kill switch (env: MEMORY_MEDIUM_SUPERSEDE), read at CALL time so flipping it needs no restart.
 * Default ON — the same parse shape as every sibling flag (affectDeterministicEnabled,
 * noteGroomEnabled, dossierFactGuardEnabled).
 */
export function mediumSupersedeEnabled(): boolean {
  const v = (process.env.MEMORY_MEDIUM_SUPERSEDE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Test seam: the live entry points (agents/convo/shared.ts) call this pass with no deps, so an
 *  end-to-end test has no other way to hand it a lane. Null restores the real one. */
let llmForTests: typeof callLLM | null = null;
export function __setSupersedeLlmForTests(llm: typeof callLLM | null): void {
  llmForTests = llm;
}

/** Model text → the numbers it named. STRICT: the whole reply (fences aside — they carry no
 *  meaning) has to be a JSON array of integers. A reply that argues, explains, or wraps the array
 *  in an object is not a plan, and a plan retires memory. */
function parseNumbers(text: string | null): number[] {
  const clean = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!clean) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  if (!parsed.every(n => Number.isInteger(n))) return []; // "1", 1.5, null — the shape is wrong
  return parsed as number[];
}

/**
 * Which of `existing` does `newText` retire? ONE classify call; the returned ids are always a subset
 * of the ids passed in.
 *
 * `llm` and `timeoutMs` are seams for tests; production passes neither.
 */
export async function planSupersessions(
  kind: SupersedeKind,
  newText: string,
  existing: { id: string; text: string }[],
  llm: typeof callLLM = callLLM,
  timeoutMs = PLAN_TIMEOUT_MS,
): Promise<string[]> {
  if (!existing.length || !newText.trim()) return [];
  const kindNoun = KIND_NOUN[kind];
  const system = `You compare a NEW ${kindNoun} a user just gave their assistant against the assistant's EXISTING ${kindNoun}s for that user. List the existing entries the new one REPLACES, REVERSES, or MAKES OBSOLETE: same subject, changed instruction or changed fact ("be sarcastic" replaces "never be sarcastic"; "moved to Bandung" replaces "lives in Bekasi"). An entry on a different subject is never listed, even if related. Entries may be written in any language. Reply with ONLY a JSON array of the numbers of the entries to retire, e.g. [2] or [1,4]. Nothing to retire → [].`;
  // 1..N in the order given, which is listMediumActive's (oldest first). Both payloads are
  // USER-AUTHORED text, so both ride inside their own data tag.
  const numberedList = existing.map((e, i) => `${i + 1}. ${e.text}`).join('\n');

  try {
    const res = await withTimeout(
      llm({
        role: 'classify',
        maxTokens: PLAN_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: wrapPrompt(`${dataTag('existing', numberedList)}\n${dataTag('new', newText)}`) }],
        trace: { label: 'memory:medium_supersede' },
      }),
      timeoutMs,
      'medium supersede',
    );
    // A cut-off array is MANGLED, not shorter: `[1,2` parses to nothing, and a repaired `[1]` would
    // retire a row the model had not finished deciding about.
    if (res.truncated) return [];
    const wanted = new Set<string>();
    for (const n of parseNumbers(res.text)) {
      const row = existing[n - 1];
      if (row) wanted.add(row.id);
    }
    return [...wanted];
  } catch (err) {
    // No lane, no budget, a throw, a timeout — all the same outcome (nothing retired) and all
    // invisible to the user, which is exactly why it is reported. Same category and severity the
    // groomer's own classify failure uses, so the two read alike on the Errors tab.
    console.warn('[memory] medium supersede plan failed — nothing retired', err);
    reportError({
      source: 'memory',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'medium-tier supersede pass failed — no entries retired',
      err,
      detail: { kind },
    });
    return [];
  }
}

/**
 * Retire whatever the just-created entry contradicts. Fire-and-forget from the reply path
 * (`void supersedeContradicted(...)`); never throws, never surfaces, and does nothing at all when
 * the flag is off, the entry is a keyed fact, or the handle has no other entry of that kind.
 */
export async function supersedeContradicted(
  handle: string,
  created: MediumEntry,
  chatId?: string,
  deps: { llm?: typeof callLLM } = {},
): Promise<void> {
  if (!mediumSupersedeEnabled()) return;
  if (!handle || !created?.id) return;
  if (created.kind !== 'directive' && created.kind !== 'important_note') return;
  const kind: SupersedeKind = created.kind;

  try {
    // The comparison set is the ACTIVE rows of the same kind, minus the entry that triggered this.
    // Read after the write, so a row the same turn already retired (an `update`'s own predecessor)
    // is not offered up a second time.
    const existing = (await listMediumActive(handle, [kind]))
      .filter(e => e.id !== created.id)
      .map(e => ({ id: e.id, text: e.body }));
    if (!existing.length) return;

    const ids = (await planSupersessions(kind, created.body, existing, deps.llm ?? llmForTests ?? callLLM))
      .filter(id => id !== created.id); // belt: the trigger is not in `existing`, and cannot retire itself
    const retired = ids.length ? await supersedeEntries(handle, ids, created.id) : 0;

    // Recorded even when nothing was retired: "it looked and found no contradiction" is the healthy
    // answer, and a pass that has stopped finding anything must be distinguishable from one that
    // stopped running.
    record({
      type: 'event',
      label: 'memory:medium_supersede',
      handle,
      chatId,
      detail: { kind, newId: created.id, retired, considered: existing.length },
    });
  } catch (err) {
    // A MediumWriteError here is the tier failing to write; anything else is a bug in this pass.
    // Either way the new entry is already saved and the reply is already composed — the honest
    // degradation is a contradiction that survives one more turn.
    console.warn(`[memory] medium supersede failed for ${handle}`, err);
    reportError({
      source: 'memory',
      category: err instanceof MediumWriteError ? 'write_failure' : 'classifier_failure',
      severity: 'warn',
      message: 'medium-tier supersede pass failed — the contradicted entry still stands',
      err,
      handle,
      chatId,
      detail: { kind, newId: created.id },
    });
  }
}

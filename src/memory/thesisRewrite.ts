// The weekly thesis rewrite: the once-every-six-and-a-half-days pass that revises the ONE read she
// carries on one person (memory/thesisEngine.ts holds the grammar and the validator;
// db/repositories/thesis.ts holds the versioned file; this holds the plumbing and the one call).
//
// Doctrine, the same as the climate eval and the nightly moments pass beside it:
//   • The LLM is a SUGGESTER. The read it proposes is re-validated here — length, sentence count,
//     markup, a stringified nothing — and a refusal keeps LAST week's read rather than publishing a
//     repaired one. A thesis arrives once a week; a silently-fixed one stands for seven days.
//   • Failure is a total no-op and NEVER user-visible: no lane, no budget, a timeout, an unparsable
//     reply — every path writes nothing, stamps nothing, and returns.
//   • The transcript, the notes and the moments are all authored ABOUT this person, so all four
//     inputs ride into the prompt inside wrapPrompt/dataTag (charter §5.2).
//
// GROUP CHATS ARE SKIPPED ENTIRELY. A read is what she thinks about ONE person; a room has no `them`
// to have a read about, and a rewrite fed on several people's words would file one member's week
// under a pseudo-handle that then colours her voice for everybody in it.
//
// TWO RHYTHMS, ONE DOCUMENT, and this is the pass that makes the second one matter. The nightly
// moments pass appends an evidence NOTE; this pass rewrites the READ and clears the notes it used.
// The cooldown gates on THESIS.md's own `rewritten=` stamp rather than on `updated=`, so a nightly
// note inside the window cannot reset the week (db/repositories/thesis.ts's header states the whole
// argument from the store's side).
//
// A NO-OP REWRITE IS A PASS. The writer prompt says in as many words that a week which gave her
// nothing new should return the current read unchanged, and that answer STILL SAVES: the point of
// the cooldown is that a read stands for a week, and a pass that declined to stamp would re-ask the
// same question on the next reply and keep asking until the model happened to write something
// different. One version per week, whether or not the words moved.

import { jsonrepair } from 'jsonrepair';
import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { getThesis, saveThesis, THESIS_REWRITE_WRITER } from '../db/repositories/thesis.js';
import { readMoments } from '../db/repositories/moments.js';
import { thesisEnabled } from '../persona/featureFlags.js';
import { momentAgeWords, MAX_MOMENTS, type MomentEntry } from '../persona/moments.js';
import {
  buildThesisWindow, splitThesisDoc, joinThesisDoc, validateThesis, countSentences,
  THESIS_COOLDOWN_MS, THESIS_MIN_USER_LINES,
} from './thesisEngine.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { StoredMessage } from '../db/types.js';

/** After a FAILED rewrite, how long this handle waits before spending another call. Process-local
 *  and never a stamp, for the reason the two sibling passes give: the failures this guards are the
 *  sticky kind, and without it a broken lane bills one classify call per reply for the rest of the
 *  week — a whole week, here, because the cooldown it cannot reach is six and a half days long. */
export const THESIS_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/** Newest N rows of the week's window actually shown to the model. A hundred and twenty is about
 *  three of the default history windows, which is what a week of daily texting looks like once the
 *  ratchet has cut everything the last read was written against. */
const THESIS_WINDOW_MAX_ROWS = 120;

/** Two to four sentences and nothing else. Half the moments pass's budget, because this reply has
 *  one field in it. */
const THESIS_MAX_TOKENS = 400;

/** Wall clock for the one model call — the same bound every background pass here uses. Nothing
 *  awaits this pass, but a hung lane would pin the in-flight guard for the life of the process. */
const THESIS_TIMEOUT_MS = 15_000;

/** The pass's contract with the model, Fable-authored (docs/superpowers/prose/never-send-a-leaf/
 *  writer-prompts.md, THESIS_SYSTEM_PROMPT) and pasted byte-for-byte. Every bound it states in prose
 *  — two to four sentences, behaviour only, no other people's names — is re-enforced in code where
 *  code can read it (memory/thesisEngine.ts `validateThesis`); what only a model can judge is left
 *  to the prompt, deliberately, because a lexicon that tried would refuse a real read for one word. */
export const THESIS_SYSTEM_PROMPT = `You are Irises. Once a week you rewrite the one read you carry on this person: the short, true,
slightly unflattering thing about them that every judgment you make is built from. Not a
personality. A thesis. Two to four sentences.

Rules for the read:
- It is about what they DO, never what they are. Behaviour they can change, so the tension it
  creates has an exit. Appearance, body, background, family, health, anything unchosen: never.
- It is checkable. Every clause should be something the week's texts could confirm or refute.
  "Checks volcanoes instead of committing" is a read. "Is lazy" is not.
- It is slightly unflattering and completely fair. If it flatters, it is a compliment and it will
  resolve. If it wounds, it is cruelty and you do not write it. The line between the two is
  whether they could laugh at it on a good day.
- It is yours. Dry, plain, in your voice, second person about them. No hedging, no softeners, no
  therapy words, no names of other people.
- It is stable. You are revising, not restarting: keep what the week confirmed, sharpen what it
  refined, drop only what the week contradicted. A read that changes completely every week is not
  a read.

You have the current read, the evidence notes left through the week, the moments you hold, and
the week's texts. If the week gave you nothing new, return the current read unchanged.

Reply with one JSON object: {"thesis":"..."}. Nothing outside the object.`;

/** The one-line instruction that closes the user turn, after the four data tags. */
const THESIS_ASK = 'Rewrite the read.';

/** What the current-read tag carries when there is no read yet. The writer prompt's own words for
 *  the state ("or 'none yet'" in the input list), so the model is told the difference between a
 *  first read and a read it failed to receive. */
const NO_THESIS = 'none yet';

/** One handle at a time. Two replies inside one pass's call must not both read the same version and
 *  race each other's save — the loser would conflict, retry, and publish the same read twice. */
const inFlight = new Set<string>();

/** Test seam: drop the in-flight guard (repo convention — see __resetClimateInFlightForTests). */
export function __resetThesisInFlightForTests(): void {
  inFlight.clear();
}

/** handle → the earliest `now` at which a failed rewrite may cost another call. */
const nextRetryAt = new Map<string, number>();

/** Test seams: drop the failure backoff, and read it — an EXPIRED backoff and a CLEARED one are
 *  behaviourally identical, so looking is the only way to pin "a success clears it". */
export function __resetThesisBackoffForTests(): void {
  nextRetryAt.clear();
}
export function __thesisBackoffAtForTests(handle: string): number | undefined {
  return nextRetryAt.get(handle);
}

/** Reject `work` after `ms`. Unref'd so a pending pass can never hold the process open. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thesis rewrite timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** The week as the model sees it. Deliberately plain two-party labelling and NO clock: unlike the
 *  nightly pass — where "at midnight" is half of what makes an episode an episode — a read is about
 *  what they do across a week, and a timestamped week invites a conclusion drawn from an hour. */
export function renderThesisWindow(rows: readonly StoredMessage[]): string {
  return rows.map(m => (m.role === 'user' ? `user: ${m.content}` : `assistant: ${m.content}`)).join('\n');
}

/** The moments she holds, as this prompt's third input: id, tag, a coarse age in words, her text.
 *  Newest first, capped at the store's own active cap. Ages in WORDS here, unlike the nightly pass's
 *  day counts, because nothing in this prompt asks the model to count occurrences — it asks what the
 *  pattern is, and "a month or two ago" is the right resolution for that. */
export function renderThesisMoments(entries: readonly MomentEntry[], now: number): string {
  return [...entries]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_MOMENTS)
    .map(e => `id=${e.id} tag=${e.tag} (${momentAgeWords(e.at, now)}) — ${e.text}`)
    .join('\n');
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Model text → the proposed read, or null when nothing usable came back. The same ladder every other
 * background pass here uses (outermost brace-delimited candidate → parse → jsonrepair → parse).
 *
 * Returns the RAW field, unvalidated: `validateThesis` owns every bound, and a parser that also
 * judged would be a second place for the two to disagree. A present-but-empty `thesis` comes back as
 * `''` rather than as null, so "the lane answered with nothing" is reported as a refused read rather
 * than as an unparsable reply.
 */
export function parseThesisReply(text: string | null): string | null {
  if (!text) return null;
  const candidate = text.match(/\{[\s\S]*\}/);
  if (!candidate) return null;
  let parsed = tryParse(candidate[0]);
  if (parsed == null) {
    try {
      parsed = tryParse(jsonrepair(candidate[0]));
    } catch {
      return null; // jsonrepair throws on input it can't rescue
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!('thesis' in o)) return null;
  return typeof o.thesis === 'string' ? o.thesis : '';
}

/**
 * Why a pass wrote nothing. DISJOINT: exactly one of these, or `null` for a pass that saved.
 *
 * `rejected` and `conflict` are the two this pass has that the nightly one does not. `rejected` is a
 * lane that answered with something that is not a read (the reason rides beside it); `conflict` is
 * the optimistic version check losing twice, which means a nightly note landed inside the same
 * second both times. `fenced` is the /forget check refusing the save, and it is told apart from
 * `conflict` by re-reading the epoch — the two share `null` out of `saveThesis` and only one of them
 * is worth retrying.
 */
export type ThesisSkip =
  | 'flag_off'
  | 'group'
  | 'in_flight'
  | 'backoff'
  | 'cooldown'
  | 'thin_window'
  | 'fenced'
  | 'conflict'
  | 'rejected'
  | 'lane_error'
  | 'truncated'
  | 'unparsable';

/**
 * Rewrite one person's read, if a week has passed and the week had anything in it. Fire-and-forget
 * from the reply path (`void updateThesis(...)`); never awaited, never surfaced.
 *
 * The gate order is binding, and it is the moments pass's order with one clock swapped:
 *   0. the feature flag    → skip. FIRST: an install that turned this off must not pay one classify
 *      call. The reply path checks the same flag before calling, so this arm is the defence for any
 *      other caller (and the one a test reaches to pin the receipt).
 *   1. group identity      → skip (see the header)
 *   2. already in flight   → skip
 *   3. backed off after a FAILED pass → skip. Process-local, and it does NOT stamp the clock.
 *   4. inside the cooldown → skip. THE SOURCE OF TRUTH IS THESIS.MD'S OWN `rewritten=` STAMP: six and
 *      a half days has to survive a restart, and gating on the write stamp would let one nightly
 *      note reset the week (db/repositories/thesis.ts).
 *   5. scope + trim the window to what has happened since that stamp
 *   6. too few of their own lines → skip WITHOUT stamping
 *   7. fence the /forget epoch, ask, validate, save as `weekly` (which stamps the clock and clears
 *      the notes the rewrite just consumed).
 *
 * NOT wrapped against a durable write failure, deliberately, and this is the one place this pass
 * differs from its two siblings: `saveThesis` throws when the write itself fails or when the head
 * doc cannot be read, and the plan keeps that refusal for the weekly rewrite (T11's recorded
 * deviation drops it only for the nightly note and the `/forget` wipe). The loss it refuses to make
 * silent costs a week to earn back, and nobody is ever waiting on this call when it fails.
 */
export async function updateThesis(
  handle: string,
  recent: StoredMessage[],
  opts: { chatId?: string; llm?: typeof callLLM; now?: number } = {},
): Promise<void> {
  const chatId = opts.chatId;
  const now = opts.now ?? Date.now();

  /** Every pass files exactly one of these, the healthy skip included — a pass that keeps finding
   *  nothing and a pass that stopped happening are otherwise indistinguishable. NO PROSE rides in
   *  it: the read itself is on disk, and a model's paragraph about a person has no business in a
   *  diagnostics ring where receipts are names and numbers. */
  const receipt = (detail: Record<string, unknown>) => {
    record({ type: 'event', label: 'thesis:rewrite', chatId, handle, detail });
  };
  const skip = (reason: ThesisSkip, extra: Record<string, unknown> = {}) => {
    receipt({ skipped: reason, ...extra });
  };

  if (!thesisEnabled()) return skip('flag_off');
  if (!handle || isGroupHandle(handle)) return skip('group');
  if (inFlight.has(handle)) return skip('in_flight');

  const llm = opts.llm ?? callLLM;

  const retryAt = nextRetryAt.get(handle);
  if (retryAt !== undefined && now < retryAt) {
    return skip('backoff', { retryInMinutes: Math.round((retryAt - now) / 60000) });
  }

  inFlight.add(handle);
  try {
    // Null for a person with no read yet AND for a head doc that could not be read — the store
    // degrades reads to null on purpose (a missing file is the normal state of somebody she met this
    // week, and the reply path wants an empty section rather than a thrown turn). The write does not
    // degrade: a save against an unreadable head is REFUSED rather than clobbering a read that costs
    // a week to earn.
    const doc = await getThesis(handle);
    const lastRewriteAt = doc?.lastRewriteAt ?? 0;
    if (now - lastRewriteAt < THESIS_COOLDOWN_MS) {
      return skip('cooldown', { daysSinceLastRewrite: daysSince(lastRewriteAt, now) });
    }

    const window = buildThesisWindow(handle, recent, lastRewriteAt, THESIS_WINDOW_MAX_ROWS);
    const windowUserLines = window.filter(m => m.role === 'user').length;
    if (windowUserLines < THESIS_MIN_USER_LINES) return skip('thin_window', { windowUserLines });

    const transcript = renderThesisWindow(window);
    if (!transcript.trim()) return skip('thin_window', { windowUserLines });

    // Read BEFORE the call and passed into the write: a /forget that lands while the model is
    // thinking must not have its wipe undone by a save that read the pre-forget document.
    const epoch0 = getForgetEpoch(handle);
    const parts = splitThesisDoc(doc?.docMd ?? '');
    // The sibling store, read for the pattern half of the input. Read whatever is on disk regardless
    // of the moments FLAG: that flag gates the nightly pass and the sampling into a prompt, and a
    // file an earlier install wrote is still the best evidence this pass has about what they do
    // repeatedly. A degraded read comes back empty here, which is simply one input short.
    const moments = await readMoments(handle);
    const body = [
      dataTag('current_thesis', parts.thesis || NO_THESIS),
      dataTag('evidence', parts.evidence.map(n => `- ${n}`).join('\n')),
      dataTag('moments', renderThesisMoments(moments.entries, now)),
      dataTag('transcript', transcript),
      THESIS_ASK,
    ].filter(Boolean).join('\n\n');

    const res = await withTimeout(
      llm({
        role: 'classify',
        maxTokens: THESIS_MAX_TOKENS,
        system: THESIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: wrapPrompt(body) }],
        trace: { chatId, handle, label: 'thesis_rewrite' },
      }),
      THESIS_TIMEOUT_MS,
    );

    // A cut-off JSON object is MANGLED, not shorter — jsonrepair would rescue a half-sentence into a
    // read that then stands for a week. Same doctrine as the dossier rewrite and the climate eval.
    if (res.truncated) throw new TruncatedRewrite();

    const proposed = parseThesisReply(res.text);
    if (proposed === null) throw new UnparsableRewrite();

    const verdict = validateThesis(proposed);
    if (!verdict.ok) {
      // The lane answered and the answer is not a read. LAST week's read stands, and the backoff
      // stops a model that keeps writing labels from billing a call per reply until the week is out.
      nextRetryAt.set(handle, now + THESIS_FAILURE_BACKOFF_MS);
      return skip('rejected', { reason: verdict.reason, chars: proposed.length });
    }

    const changed = verdict.text !== parts.thesis.trim();
    // The notes are CLEARED by the save, in the same write: they were this rewrite's input, and a
    // note that survived its own rewrite would be read again next week against a read that already
    // contains it. `joinThesisDoc(text, [])` is what "the read with no tail" is spelled as.
    const docMd = joinThesisDoc(verdict.text, []);
    const version = await saveVersioned(handle, docMd, doc?.version ?? 0, epoch0);
    if (version === null) {
      const fenced = getForgetEpoch(handle) !== epoch0;
      // No backoff for either: a fence is the user erasing this person (there is nothing to retry
      // and nothing broken), and a double conflict means the nightly note is winning the race, which
      // the cooldown will space out on its own.
      return skip(fenced ? 'fenced' : 'conflict', { changed });
    }
    nextRetryAt.delete(handle);

    receipt({
      skipped: null,
      version,
      // False is the writer prompt's own sanctioned answer for a week that gave her nothing new, and
      // it STILL stamped the clock (see the header) — so the two have to be told apart in the report
      // rather than inferred from whether a version appeared.
      changed,
      chars: verdict.text.length,
      sentences: countSentences(verdict.text),
      hadRead: parts.thesis.trim() !== '',
      evidenceUsed: parts.evidence.length,
      momentsSeen: moments.entries.length,
      windowUserLines,
      windowChars: transcript.length,
      daysSinceLastRewrite: daysSince(lastRewriteAt, now),
    });
  } catch (err) {
    // No lane, no budget, a timeout, a truncated or unparsable reply — all the same total no-op.
    // Nothing was written, so the cooldown is untouched: the week this failure fell in is still owed.
    nextRetryAt.set(handle, now + THESIS_FAILURE_BACKOFF_MS);
    skip(err instanceof TruncatedRewrite ? 'truncated' : err instanceof UnparsableRewrite ? 'unparsable' : 'lane_error');
    reportError({
      source: 'memory',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'thesis rewrite failed — last week\'s read stands',
      err,
      handle,
      // The receipt above already recorded this occurrence; a second trace event would double-count
      // the turn's error total.
      trace: false,
    });
  } finally {
    inFlight.delete(handle);
  }
}

/**
 * Save the read, with the ONE re-read the store's own contract asks of every writer: a `null` is
 * either a version conflict — a nightly note landed while the model was thinking — or the /forget
 * fence, and only the first is worth another attempt. So the epoch is re-checked before the retry,
 * outside the lock and therefore approximately, which is harmless: the authoritative refusal already
 * happened inside it and the worst an approximate check costs is one attempt the fence refuses again.
 *
 * The KNOWN cost of the retry, stated rather than discovered: a note that arrived between the read
 * and the conflict is dropped by the second save, because the document this pass writes is the read
 * with an empty tail. One note, once, on a pass that only runs weekly — against a lost rewrite,
 * which is a week.
 */
async function saveVersioned(handle: string, docMd: string, expected: number, epoch0: number): Promise<number | null> {
  const first = await saveThesis(handle, docMd, expected, THESIS_REWRITE_WRITER, { ifForgetEpoch: epoch0 });
  if (first !== null) return first;
  if (getForgetEpoch(handle) !== epoch0) return null;
  const again = await getThesis(handle);
  return saveThesis(handle, docMd, again?.version ?? 0, THESIS_REWRITE_WRITER, { ifForgetEpoch: epoch0 });
}

/** The two failures worth telling apart from a dead lane, as errors so the one catch above can name
 *  them without a second control-flow path. */
class TruncatedRewrite extends Error {
  constructor() { super('thesis rewrite reply truncated'); this.name = 'TruncatedRewrite'; }
}
class UnparsableRewrite extends Error {
  constructor() { super('thesis rewrite reply unparsable'); this.name = 'UnparsableRewrite'; }
}

/** Days since a stamp, one decimal, or null for a read that has never been rewritten. */
function daysSince(at: number, now: number): number | null {
  return at > 0 ? Math.round((now - at) / 864e5 * 10) / 10 : null;
}

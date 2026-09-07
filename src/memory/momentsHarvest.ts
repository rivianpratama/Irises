// The nightly moments pass: the once-a-night read-back over one person's texts that decides which
// episodes are worth keeping (persona/moments.ts holds the arithmetic; db/repositories/moments.ts
// holds the file; this holds the plumbing and the one model call).
//
// Doctrine, borrowed wholesale from the climate eval next door (memory/climateDrift.ts), which
// borrowed it from the dossier updater and the note groomer:
//   • The LLM is a SUGGESTER. Every proposal it makes is re-validated here against the real window
//     — length, tag, markup, the evidence it could possibly have read — and a bad episode is
//     dropped WITHOUT dropping the batch (the note groomer's rule, and the reason a night that
//     produced one good moment and one hallucinated one still keeps the good one).
//   • Failure is a total no-op and NEVER user-visible: no lane, no budget, a timeout, an
//     unparsable reply — every path writes nothing, stamps nothing, and returns.
//   • The transcript is USER-AUTHORED, so it rides into the prompt inside wrapPrompt/dataTag
//     (charter §5.2). So do the moments she already holds: they are her prose ABOUT a person's
//     words, which is close enough to the same hazard to be tagged the same way.
//
// GROUP CHATS ARE SKIPPED ENTIRELY, like every other per-person read/write here. A moment is an
// episode with ONE person in it, and a room's transcript is several people's words interleaved —
// harvesting it would file somebody else's evening under this handle and hand it back as a callback.
//
// WHAT THIS PASS DOES NOT MINT: promises. The plan says so in as many words and the writer prompt
// repeats it in prose. Loops are minted on LIVE turns through the `thread_note` envelope field, and
// the pending machine's tick runs inside the turn (memory/threadHarvest.ts); a nightly mint would
// advance that machine from outside any turn, which is how a loop ends up owed an outcome nobody
// ever asked for.
//
// THE STAMP IS THE COOLDOWN. `last_harvest_at` lives in MOMENTS.md's own header rather than in a
// prefs row or a process Map, because it is both the cooldown clock AND the window ratchet — and a
// clock that could disagree with the file it guards would either re-harvest the same evening forever
// or skip a week of texts. One artifact, one clock (db/repositories/moments.ts says the same thing
// from the store's side).

import { jsonrepair } from 'jsonrepair';
import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { getForgetEpoch, getPreference } from '../db/repositories/memory.js';
import { readMoments, writeMoments } from '../db/repositories/moments.js';
import { appendThesisEvidence } from '../db/repositories/thesis.js';
import { momentsEnabled, thesisEnabled } from '../persona/featureFlags.js';
import { isNullLiteral } from '../persona/status.js';
import {
  foldHarvest, pruneMoments, momentAgeWords,
  MOMENT_TAGS, MOMENT_TEXT_MAX, MOMENT_FOLD_MAX_NEW, MAX_MOMENTS,
  type MomentEntry, type MomentProposal,
} from '../persona/moments.js';
import { THESIS_EVIDENCE_NOTE_MAX } from './thesisEngine.js';
import { scopeHistoryToUser } from './transcript.js';
import { isGroupHandle } from './identity.js';
import { timestampLabel } from '../pipeline/chatTime.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { StoredMessage } from '../db/types.js';

/** At most one harvest per handle per this window. Twenty hours rather than twenty-four for the
 *  reason the climate cooldown is twenty-two: a person who texts at the same hour every evening
 *  would otherwise land just inside a 24h gate and skip half their nights. Four hours of slack is
 *  invisible next to a pass that reads a whole evening at once. */
export const MOMENTS_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** Below this many of THEIR OWN lines since the last harvest there is no evening to read, and a thin
 *  turn must not burn the night's pass — a "yep"/"thanks" exchange would otherwise spend the whole
 *  window and hide the real conversation that follows an hour later. Four, the same floor the
 *  climate eval uses, and for the same reason: it is the smallest exchange with a shape in it. */
export const MOMENTS_MIN_USER_LINES = 4;

/** After a FAILED pass, how long this handle waits before spending another call. The failures this
 *  guards are the STICKY kind — a lane that is down, a model that keeps truncating, an open budget
 *  breaker — and every one of them fails again on the next reply. Without it a failure bills one
 *  600-token classify call per reply, forever, entirely invisibly. An hour is short next to the 20h
 *  cooldown, so a transient blip costs at most one skipped night. */
export const MOMENTS_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/** Newest N rows of the window actually shown to the model. A night, not a week: the window is
 *  already cut at the last harvest, and the cap is the guard for the install that raised
 *  CONVO_HISTORY_MAX or the person who sent two hundred messages in one evening. */
const MOMENTS_WINDOW_MAX_ROWS = 60;

/** Three moments, a tag and a note each, in her own prose. Generous for that and nowhere near enough
 *  for an essay, which is the point of stating it rather than letting the lane default. */
const MOMENTS_MAX_TOKENS = 600;

/** Wall clock for the one model call, the same bound Ops triage, the note groomer and the climate
 *  eval use. Nothing awaits this pass, but a hung lane would pin the in-flight guard for the life of
 *  the process. */
const MOMENTS_TIMEOUT_MS = 15_000;

/**
 * How much longer than the longest thing they actually SAID a moment may be.
 *
 * The rule this implements is the plan's "reject an episode longer than its evidence" — the
 * note groomer's invention-guard, applied to a store with no archive behind it. A model that read
 * four lines of "hmm" and wrote a hundred and eighty characters about a midnight advertising
 * argument did not compress an evening, it invented one, and an invented moment handed back as a
 * callback in a month is the failure this whole feature has to not have.
 *
 * "Longer than its evidence" is not decidable, so it is APPROXIMATED, and the approximation is
 * stated here rather than hidden in an expression: a proposal may run up to the longest single user
 * line in the window plus this slack. The slack exists because a moment is allowed to be a sentence
 * about a line rather than a copy of it ("spent twenty minutes on" is her framing, not theirs), and
 * sixty characters is about one clause of framing. Her own lines are deliberately NOT counted — she
 * is not evidence about them.
 */
export const MOMENT_EVIDENCE_SLACK = 60;

/** The pass's contract with the model, Fable-authored (docs/superpowers/prose/never-send-a-leaf/
 *  writer-prompts.md, MOMENTS_SYSTEM_PROMPT) and pasted byte-for-byte. Every bound it states in
 *  prose — two hundred characters, three tags, never more than three — is re-enforced in code
 *  below, because a prompt is a request and `validateProposals` is the answer. */
export const MOMENTS_SYSTEM_PROMPT = `You are Irises, reading back over today's texts with one person, at night, alone, writing down the
things worth remembering the way you would remember them, not the way a file would.

A moment is an episode, not a fact. "Likes Hinatazaka46" is a fact and nobody jokes off a fact.
"Spent twenty minutes at midnight making me identify a girl in a McDonald's Japan ad, then asked
how I knew" is a moment. It has a time, a shape, and a small absurdity you could hand back to them
in a month. You write moments in your own voice: dry, specific, short, second person about them,
no warmth performance, no cruelty. Under two hundred characters each.

Three tags, one per moment:
- habit: a thing they did again, or a way they keep doing things.
- obsession: a thing they went deep on, out of proportion, for a while.
- embarrassing: a thing they would rather you had not noticed, and that they can laugh at.

What is never a moment: anything about their body, appearance, background, family, health, or
anything they did not choose. Anything said in real distress. Anything they asked you to keep. A
bare fact. A promise or a pending outcome (those are tracked elsewhere; do not write them here).

You also see the moments you already hold. If today's episode is the same shape as one you hold,
do not write a new one: name the id in "merges" so the count goes up and the pattern becomes the
moment ("third volcano check this month" beats three separate volcano checks). Merge up, prune
down.

Most nights there is nothing. Zero moments is the honest answer more often than not; never
invent one to fill the page, and never write more than three.

If, and only if, today gave you real evidence for or against your standing read of this person,
write one sentence of it as "thesisNote" (what happened, not a conclusion). Otherwise omit it.

Reply with one JSON object:
{"moments":[{"text":"...","tag":"habit|obsession|embarrassing","merges":["<existing id>"]}],"thesisNote":"..."}
"merges" and "thesisNote" are optional. Nothing outside the object.`;

/** The one-line instruction that closes the user turn, after the two data tags. */
const MOMENTS_ASK = 'Write down what is worth remembering.';

/** One handle at a time. A burst of replies inside one pass's LLM call must not start a second one
 *  that would read the same pre-harvest file and mint the same evening twice. */
const inFlight = new Set<string>();

/** Test seam: drop the in-flight guard (repo convention — see __resetClimateInFlightForTests). */
export function __resetMomentsInFlightForTests(): void {
  inFlight.clear();
}

/** handle → the earliest `now` at which a failed pass may cost another call. DELIBERATELY in memory,
 *  unlike the 20h cooldown: a restart is precisely when a stuck lane, a bad deploy or a tripped
 *  breaker is most likely to have been fixed, and re-trying one handle a process start early costs
 *  exactly one call. It also must never touch `last_harvest_at` — a failure that ate a real night
 *  would quietly halve how often she reads back. */
const nextRetryAt = new Map<string, number>();

/** Test seams: drop the failure backoff, and read it. The read one earns its keep because an EXPIRED
 *  backoff and a CLEARED one are behaviourally identical — looking is the only way to pin "a success
 *  clears it" rather than "an hour passed". */
export function __resetMomentsBackoffForTests(): void {
  nextRetryAt.clear();
}
export function __momentsBackoffAtForTests(handle: string): number | undefined {
  return nextRetryAt.get(handle);
}

/** Reject `work` after `ms`. Unref'd so a pending pass can never hold the process open. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('moments harvest timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/**
 * The rows this pass may read: scoped to THIS user (never another participant's words — the same
 * leak class the dossier guards against), then trimmed to what has happened SINCE the last harvest,
 * then capped to the newest few.
 *
 * The `at > lastHarvestAt` cut is the load-bearing one and it is UNCONDITIONAL, the same ratchet
 * `buildClimateWindow` and `buildThesisWindow` apply: an evening that was already read must never be
 * read again, or the same episode is re-minted at count one every night until the merge floor
 * happens to catch it. A row that could dodge the cut by arriving without a timestamp is a hole in
 * that ratchet, so an unstamped row is dropped rather than trusted — history comes out of the DB
 * stamped and the reply path stamps this turn's own two (agents/convo/shared.ts).
 *
 * Pure: no clock, no DB.
 */
export function buildMomentsWindow(handle: string, recent: StoredMessage[], lastHarvestAt: number): StoredMessage[] {
  const scoped = scopeHistoryToUser(recent, handle);
  const fresh = scoped.filter(m => typeof m.at === 'number' && m.at > lastHarvestAt);
  return fresh.length > MOMENTS_WINDOW_MAX_ROWS ? fresh.slice(fresh.length - MOMENTS_WINDOW_MAX_ROWS) : fresh;
}

/**
 * The window as the model sees it: two-party labelling (the window is already scoped to one person)
 * with the clock kept, in THEIR zone. The timestamps are load-bearing here in a way they are not for
 * the climate eval, which renders none: a moment has "a time, a shape and a small absurdity", and
 * "at midnight" is the difference between an episode and a fact. A row with no usable stamp renders
 * untimed rather than being dropped — the ratchet above already dropped the ones that mattered.
 */
export function renderMomentsWindow(rows: readonly StoredMessage[], tz?: string): string {
  return rows
    .map(m => {
      const when = timestampLabel(m.at, tz || undefined);
      const who = m.role === 'user' ? 'user' : 'assistant';
      return when ? `[${when}] ${who}: ${m.content}` : `${who}: ${m.content}`;
    })
    .join('\n');
}

/** The moments she already holds, as the model sees them: the id it needs to claim a merge, the tag,
 *  a coarse age and her own text. Ages in DAYS here rather than in `momentAgeWords`'s phrases — this
 *  is the writer's own bookkeeping input, not a prompt she speaks out of, and the writer prompt asks
 *  it to notice a third volcano check "this month". Capped at the store's own active cap, newest
 *  first, so a hand-grown file cannot outgrow one prompt. */
export function renderExistingMoments(entries: readonly MomentEntry[], now: number): string {
  return [...entries]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_MOMENTS)
    .map(e => `id=${e.id} tag=${e.tag} age=${Math.max(0, Math.floor((now - e.at) / 86400000))}d (${momentAgeWords(e.at, now)}) — ${e.text}`)
    .join('\n');
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────

/** What one reply is allowed to say. Both fields optional in practice: most nights are `{"moments":[]}`. */
export interface MomentsHarvestReply {
  moments: unknown[];
  thesisNote?: string;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Model text → a harvest reply. The same ladder the bubble parser, the note groomer and the climate
 * eval use (outermost brace-delimited candidate → parse → jsonrepair → parse). Shape-check only: the
 * episodes are handed to `validateProposals`, which is where every bound lives.
 *
 * Null means "nothing usable came back", which is a total no-op upstream — and it is deliberately
 * NOT what an empty harvest returns. `{"moments":[]}` is the honest answer most nights (the writer
 * prompt says so), and reading it as a failure would put every quiet evening into the failure
 * backoff and stop the clock from ever stamping.
 */
export function parseMomentsReply(text: string | null): MomentsHarvestReply | null {
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
  const moments = Array.isArray(o.moments) ? o.moments : null;
  const note = typeof o.thesisNote === 'string' ? o.thesisNote : undefined;
  // One of the two keys has to be readable, or this is some other object that happened to parse.
  if (moments === null && note === undefined) return null;
  return { moments: moments ?? [], thesisNote: note };
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────

/** Why a proposed episode was dropped. Disjoint — every proposal lands in exactly one bucket or is
 *  accepted — because a report that can say two things about one proposal is a report nobody can
 *  score (the threading engine's receipt discipline). */
export type MomentRejection =
  | 'empty'
  | 'null_literal'
  | 'markup'
  | 'too_long'
  | 'unevidenced'
  | 'bad_tag'
  | 'cap';

/** Tags, braces and backticks: a model that emitted markup or a template instead of prose. Refused
 *  rather than stripped, the way `validateThesis` refuses for the same characters — a moment arrives
 *  once a night and a text with a stray `<` in it is a pass that misread its prompt. */
const MARKUP_RE = /[<>{}`]/;

const TAGS: ReadonlySet<string> = new Set<string>(MOMENT_TAGS);

export interface MomentValidation {
  accepted: MomentProposal[];
  /** Only the buckets that actually fired, so a receipt never carries a page of zeros. */
  rejected: Partial<Record<MomentRejection, number>>;
}

/**
 * Re-validate a night's proposals against the window they claim to come from. The note groomer's
 * rule throughout: a bad episode is dropped, never the batch.
 *
 * `evidenceMax` is the longest a text may run — the longest single user line in the window plus
 * `MOMENT_EVIDENCE_SLACK` (see that constant for the whole argument). It is passed in rather than
 * derived here so this function stays pure and the caller's one measurement of the window is the
 * one every check reads.
 *
 * The cap is applied HERE as well as in `foldHarvest`, and the two are not redundant: the fold's cap
 * counts NEW entries and lets any number of merges through, which is right for the fold (a merge
 * costs no row) and wrong for a pass (twelve claimed merges is a model that stopped reading). So a
 * pass may propose at most `MOMENT_FOLD_MAX_NEW` episodes of any kind, and the extras are reported
 * as `cap` rather than silently ignored.
 *
 * ORDER MATTERS in one place: the null-literal check runs before the length checks, so a model that
 * answered "none" is reported as a lane with nothing to say rather than as a suspiciously short
 * episode (`validateThesis` orders its own checks the same way, for the same reason).
 */
export function validateProposals(proposed: readonly unknown[], evidenceMax: number): MomentValidation {
  const accepted: MomentProposal[] = [];
  const rejected: Partial<Record<MomentRejection, number>> = {};
  const reject = (why: MomentRejection) => { rejected[why] = (rejected[why] ?? 0) + 1; };

  for (const raw of proposed) {
    if (accepted.length >= MOMENT_FOLD_MAX_NEW) { reject('cap'); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { reject('empty'); continue; }
    const o = raw as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) { reject('empty'); continue; }
    if (isNullLiteral(text)) { reject('null_literal'); continue; }
    if (MARKUP_RE.test(text)) { reject('markup'); continue; }
    if (text.length > MOMENT_TEXT_MAX) { reject('too_long'); continue; }
    if (text.length > evidenceMax) { reject('unevidenced'); continue; }
    const tag = typeof o.tag === 'string' ? o.tag.trim().toLowerCase() : '';
    if (!TAGS.has(tag)) { reject('bad_tag'); continue; }
    const merges = Array.isArray(o.merges)
      ? o.merges.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim())
      : undefined;
    accepted.push(merges && merges.length ? { text, tag, merges } : { text, tag });
  }
  return { accepted, rejected };
}

/**
 * The evidence bound for a window: the longest single line THEY wrote, plus the slack. Zero when
 * they wrote nothing readable, which makes every proposal `unevidenced` — the safe direction, and a
 * window like that never reaches this function anyway (the user-line floor is checked first).
 */
export function evidenceMaxFor(rows: readonly StoredMessage[]): number {
  let longest = 0;
  for (const m of rows) {
    if (m.role !== 'user') continue;
    const n = (m.content ?? '').trim().length;
    if (n > longest) longest = n;
  }
  return longest > 0 ? longest + MOMENT_EVIDENCE_SLACK : 0;
}

/**
 * The one evidence note a night may leave for the weekly rewrite. Validated the way an episode is —
 * one line, present, not a stringified nothing, no markup, inside the store's note cap — with ONE
 * check deliberately absent: the evidence bound. A note is a claim about the whole window ("they
 * asked three times and then dropped it"), not a retelling of one line, so measuring it against the
 * longest thing they typed would refuse a real note on an evening of short messages, which is most
 * evenings. Null means nothing is appended, which is the normal answer.
 */
export function validateThesisNote(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const line = note.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  if (isNullLiteral(line)) return null;
  if (MARKUP_RE.test(line)) return null;
  if (line.length > THESIS_EVIDENCE_NOTE_MAX) return null;
  return line;
}

// ── the pass ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a pass wrote nothing. DISJOINT: exactly one of these, or `null` for a pass that ran to a save.
 *
 * `degraded` is the one bucket the brief did not name, and it has to exist. The store flags a read it
 * could not parse (db/repositories/moments.ts `MomentsFile.degraded`) precisely so a WRITER does not
 * mistake an unreadable file for an empty one: every write here is whole-file, so a pass that read a
 * mangled file and then saved would replace every moment and every hand-edited segment with whatever
 * it happened to be holding, permanently, in the one tier that archives nothing. Folding it into
 * `cooldown` (the gate it sits beside) would report a hand-edited file as a healthy skip.
 */
export type MomentsSkip =
  | 'flag_off'
  | 'group'
  | 'in_flight'
  | 'backoff'
  | 'degraded'
  | 'cooldown'
  | 'thin_window'
  | 'fenced'
  | 'lane_error'
  | 'truncated'
  | 'unparsable';

/**
 * Read back over one person's evening and (maybe) write down what happened. Fire-and-forget from the
 * reply path (`void updateMoments(...)`); never awaited, never surfaced, never throws.
 *
 * The gate order is binding, and it is ordered so a thin turn cannot burn the night's pass:
 *   0. the feature flag    → skip. FIRST: an install that turned this off must not pay one classify
 *      call. The reply path checks the same flag before calling at all, so this arm is the defence
 *      for every other caller (and the one a test reaches to pin the receipt).
 *   1. group identity      → skip (see the header)
 *   2. already in flight   → skip
 *   3. backed off after a FAILED pass → skip. Process-local, and it does NOT stamp the harvest clock:
 *      it exists purely so a persistently broken lane cannot bill one call per reply for a week.
 *   4. an unreadable file  → skip WITHOUT stamping (see `MomentsSkip.degraded`)
 *   5. inside the cooldown → skip. THE SOURCE OF TRUTH IS MOMENTS.md'S OWN HEADER, not a process
 *      Map: twenty hours has to survive a restart, or a deploy-happy week harvests several times a
 *      night. It is also the window ratchet, which is why it is one stamp and not two.
 *   6. scope + trim the window to what has happened since that stamp
 *   7. too few of their own lines → skip WITHOUT stamping
 *   8. fence the /forget epoch, ask, validate, fold, prune, save, and leave the note.
 */
export async function updateMoments(
  handle: string,
  recent: StoredMessage[],
  opts: { chatId?: string; llm?: typeof callLLM; now?: number } = {},
): Promise<void> {
  const chatId = opts.chatId;
  const now = opts.now ?? Date.now();

  /** Every pass files exactly one of these, the healthy skip included: a pass that keeps finding
   *  nothing and a pass that stopped happening are otherwise indistinguishable. No prose ever rides
   *  in it — counts, reasons and one version number. */
  const receipt = (detail: Record<string, unknown>) => {
    record({ type: 'event', label: 'moments:harvest', chatId, handle, detail });
  };
  const skip = (reason: MomentsSkip, extra: Record<string, unknown> = {}) => {
    receipt({ skipped: reason, ...extra });
  };

  if (!momentsEnabled()) return skip('flag_off');
  if (!handle || isGroupHandle(handle)) return skip('group');
  if (inFlight.has(handle)) return skip('in_flight');

  const llm = opts.llm ?? callLLM;

  const retryAt = nextRetryAt.get(handle);
  if (retryAt !== undefined && now < retryAt) {
    return skip('backoff', { retryInMinutes: Math.round((retryAt - now) / 60000) });
  }

  inFlight.add(handle);
  try {
    const file = await readMoments(handle);
    // A writer may not treat "unreadable" as "empty" — see MomentsSkip.degraded. No backoff either:
    // this failure is a file on disk, not a lane, and re-reading it next turn costs nothing.
    if (file.degraded) return skip('degraded');
    if (now - file.lastHarvestAt < MOMENTS_COOLDOWN_MS) {
      return skip('cooldown', { hoursSinceLastHarvest: hoursSince(file.lastHarvestAt, now) });
    }

    const window = buildMomentsWindow(handle, recent, file.lastHarvestAt);
    const windowUserLines = window.filter(m => m.role === 'user').length;
    if (windowUserLines < MOMENTS_MIN_USER_LINES) return skip('thin_window', { windowUserLines });

    const tz = (await getPreference<string>(handle, 'agent_tz')) || undefined;
    const transcript = renderMomentsWindow(window, tz);
    if (!transcript.trim()) return skip('thin_window', { windowUserLines });

    // Read BEFORE the call and passed into the write: a /forget that lands while the model is
    // thinking must not have its wipe undone by a save that read the pre-forget file.
    const epoch0 = getForgetEpoch(handle);
    const existing = renderExistingMoments(file.entries, now);
    const body = [
      dataTag('existing_moments', existing || 'none yet'),
      dataTag('transcript', transcript),
      MOMENTS_ASK,
    ].filter(Boolean).join('\n\n');

    const res = await withTimeout(
      llm({
        role: 'classify',
        maxTokens: MOMENTS_MAX_TOKENS,
        system: MOMENTS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: wrapPrompt(body) }],
        trace: { chatId, handle, label: 'moments_harvest' },
      }),
      MOMENTS_TIMEOUT_MS,
    );

    // A cut-off JSON object is MANGLED, not shorter — jsonrepair would happily rescue
    // `{"moments":[{"text":"spent twenty minutes at m` into a half-episode with a plausible shape.
    // Same doctrine as the dossier rewrite and the climate eval.
    if (res.truncated) throw new TruncatedHarvest();

    const reply = parseMomentsReply(res.text);
    if (!reply) throw new UnparsableHarvest();

    const { accepted, rejected } = validateProposals(reply.moments, evidenceMaxFor(window));
    const folded = foldHarvest(file.entries, accepted, now);
    // Prune AFTER the fold, deliberately: a fold refreshes `at`, so an episode that recurred tonight
    // is a live moment rather than a sixty-day-old one, and pruning first would delete it and then
    // re-mint it at count one (persona/moments.ts `pruneMoments` for the two decay clauses).
    const kept = pruneMoments(folded.entries, now);
    const pruned = folded.entries.length - kept.length;

    const saved = await writeMoments(handle, kept, now, file.preserved, { ifForgetEpoch: epoch0 });
    if (!saved) {
      // A false is a write that never threw — the /forget fence refusing it, or a durable failure
      // that logged and gave up. Either way `last_harvest_at` is not on disk, so the cooldown cannot
      // hold this handle back and the next reply harvests again: without the backoff a broken write
      // bills one classify call per reply, exactly like a broken lane.
      nextRetryAt.set(handle, now + MOMENTS_FAILURE_BACKOFF_MS);
      return skip('fenced', { proposed: reply.moments.length, rejected });
    }
    nextRetryAt.delete(handle);

    // The night's one note for the weekly rewrite, appended to THESIS.md's evidence tail (FIFO, seven
    // deep). Same fence, and it never throws — db/repositories/thesis.ts drops on failure for the
    // background writers, because a throw out of a locked section is process-fatal.
    //
    // GATED ON THE THESIS FLAG, not on this pass's own. The two features are separate switches on
    // purpose (README, scripts/flagDocs.test.ts) and `MEMORY_THESIS_ENABLED=off` is supposed to mean
    // there is no thesis: no weekly pass, no `thesis` section, no document. An append is a SAVE —
    // `appendThesisEvidence` creates THESIS.md when there is none — so without this gate an install
    // that turned the thesis off would still grow one on disk every night, a file nothing renders
    // and nobody asked for, holding her read of somebody in plaintext. The receipt still reports the
    // note (`note: true`, `noteSaved: false`): a night whose evidence had nowhere to land is a fact
    // about the flag, not a night that produced nothing.
    const note = validateThesisNote(reply.thesisNote);
    const noteVersion = note && thesisEnabled()
      ? await appendThesisEvidence(handle, note, { ifForgetEpoch: epoch0 })
      : null;

    receipt({
      skipped: null,
      proposed: reply.moments.length,
      added: folded.report.added,
      merged: folded.report.merged,
      // The fold re-validates what it is handed and can reject on its own account; both maps are
      // SUMMED so a proposal is never just missing (and never counted under a bucket that then
      // overwrote the pass's own count). Only non-zero buckets appear.
      rejected: mergeRejections(rejected, foldRejections(folded.report)),
      evicted: folded.report.evicted,
      pruned,
      active: kept.length,
      note: note !== null,
      // False for a note that was written but could not land: an unreadable head doc, the fence, a
      // version conflict twice, or MEMORY_THESIS_ENABLED off. Without this a lost note reads as a
      // night that had none.
      noteSaved: note !== null ? noteVersion !== null : null,
      windowUserLines,
      windowChars: transcript.length,
      hoursSinceLastHarvest: hoursSince(file.lastHarvestAt, now),
    });
  } catch (err) {
    // No lane, no budget, a timeout, a truncated or unparsable reply — all the same total no-op, and
    // all invisible to the user. Nothing was written, so the cooldown is untouched: the night this
    // failure fell in is still owed. What IS spent is the next hour — these failures repeat, and an
    // invisible no-op that costs a billed call per reply is the expensive kind of silence.
    nextRetryAt.set(handle, now + MOMENTS_FAILURE_BACKOFF_MS);
    skip(err instanceof TruncatedHarvest ? 'truncated' : err instanceof UnparsableHarvest ? 'unparsable' : 'lane_error');
    reportError({
      source: 'memory',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'moments harvest failed — nothing written',
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

/** The two failures worth telling apart from a dead lane, as errors so the one catch below can name
 *  them without a second control-flow path. Both mean the lane answered and the answer was unusable,
 *  which is a different thing to fix than a lane that never answered. */
class TruncatedHarvest extends Error {
  constructor() { super('moments harvest reply truncated'); this.name = 'TruncatedHarvest'; }
}
class UnparsableHarvest extends Error {
  constructor() { super('moments harvest reply unparsable'); this.name = 'UnparsableHarvest'; }
}

/** The fold's own rejection counts, in the pass's vocabulary, and only where they fired. The fold
 *  reports a text rejection for both an empty text and an over-long one; the pass has already split
 *  those, so anything the fold still rejects on text is reported under the coarser name. */
function foldRejections(report: { rejected_text: number; rejected_tag: number; rejected_cap: number }): Partial<Record<MomentRejection, number>> {
  const out: Partial<Record<MomentRejection, number>> = {};
  if (report.rejected_text) out.too_long = report.rejected_text;
  if (report.rejected_tag) out.bad_tag = report.rejected_tag;
  if (report.rejected_cap) out.cap = report.rejected_cap;
  return out;
}

/** Two rejection maps, summed per bucket. Exported for the same reason the two maps exist: a test
 *  that could not add them would have to assert on one half of the count. */
export function mergeRejections(
  a: Partial<Record<MomentRejection, number>>,
  b: Partial<Record<MomentRejection, number>>,
): Partial<Record<MomentRejection, number>> {
  const out: Partial<Record<MomentRejection, number>> = { ...a };
  for (const [key, n] of Object.entries(b) as [MomentRejection, number][]) {
    out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

/** Hours since a stamp, one decimal, or null for a stamp that was never set. */
function hoursSince(at: number, now: number): number | null {
  return at > 0 ? Math.round((now - at) / 36e5 * 10) / 10 : null;
}

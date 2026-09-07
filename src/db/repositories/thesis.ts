// The THESIS store: memories/<handle>/THESIS.md, one file per person, holding her ONE read on them
// plus the evidence notes the nightly moments pass leaves for the weekly rewrite.
//
// On disk (memories/<handle>/):
//   THESIS.md                  — head doc; first line is a machine header comment carrying the
//                                version, the writer, the update stamp and the REWRITE stamp, rest
//                                is the doc verbatim
//   revisions/THESIS.v0007.md  — one file per accepted version, same format
//
// TWO stamps, and the second one is the whole reason this file is not memoryLong.ts renamed. The
// document is written by two writers at two rhythms: the weekly rewrite changes the READ, the
// nightly pass appends a NOTE. `updated=` moves on every write, `rewritten=` only when the read
// itself was rewritten, and the weekly cooldown gates on `rewritten=`. Gating on `updated=` was the
// first version of this store and it was wrong in the worst available direction: one nightly note
// inside a six-and-a-half-day window would have reset the clock, and the steady state of a person
// she texts every day is a read written once and never again.
//
// A FORK of the long tier (memoryLong.ts), and a close one: the same header shape one field wider,
// the same optimistic version, the same revision-first write, the same fail-loud policy. What
// differs is who writes it and how often. The long doc is the user's own flexible prompt layer,
// rewritten whenever the dossier refresh runs; this is HER read, rewritten once every six and a half
// days by one classify call (memory/thesisRewrite.ts) and appended to nightly by the moments pass.
// Forking rather than parameterising memoryLong was the cheaper honesty: two stores with one grammar
// can each keep their own doc comment about what a lost write costs, and every attempt to share this
// grammar would have to share the header literal, which is the one thing that must NOT be shared —
// a THESIS.md that parsed as a LONG.md would let one store's stale version clobber the other's doc.
//
// The evidence tail lives in the SAME document (memory/thesisEngine.ts owns the grammar:
// `<read>\n\n## evidence\n- note`), so the read and the notes it will be rewritten from share one
// version, one lock and one wipe. Seven notes at most, oldest dropped first.
//
// Concurrency: optimistic, and it is real here rather than theoretical — the nightly pass appends
// evidence while the weekly pass may be rewriting the read. `saveThesis` carries the version the
// writer read; a stale version returns null and writes NOTHING, and the caller re-reads and retries
// once (`appendThesisEvidence` and `clearThesis` below do exactly that, so no caller has to
// remember). The VERSION CHECK — not the caller's re-read — is what happens under withHandleLock:
// the head is read and compared against `expectedVersion` inside the locked section, so a caller
// whose read went stale while it was thinking can only ever produce a null, never a clobber. The
// caller's retry then re-reads OUTSIDE the lock and calls again, which is safe for exactly that
// reason: whatever it read, the check inside decides.
//
// The /forget fence rides the same lock, and it is not the same problem as the version check. A
// version says "somebody else wrote"; the epoch says "the user asked to be forgotten". Both passes
// here read, think for fifteen seconds against a lane, and then write, and a `/forget` that lands
// inside that window must not have its wipe undone by a save that read the pre-forget document —
// `saveThesis(…, { ifForgetEpoch })` re-reads the epoch INSIDE the locked section, which is the only
// place the question has a definite answer (`clearDossier` bumps under the same queue), and the
// caller cannot supply the check itself because withHandleLock is not re-entrant. Same shape as
// `writeMoments`, `saveHookState` and `saveDossier`; `climateDrift.ts`'s caller is the pattern.
//
// Failure policy: REFUSE, don't guess. This is not the moments store, which degrades an unreadable
// file to empty because it renders on the reply path and is re-derivable from tonight's transcript:
// a read costs a week to earn back, so a write against a head file that exists and cannot be parsed
// is refused rather than clobbering it, and the caller is told by a `null` it has to handle. Reads
// still degrade to null on their own (a missing file is the normal state of a new person); a writer
// that must tell an absent doc from an unreadable one calls `readThesisHead` for the flag.
//
// ONE exception, and it is a crash-radius decision rather than a policy change: a throw out of a
// locked section is process-FATAL, not pass-fatal. withHandleLock keeps its queue with
// `void next.finally(...)`, which publishes a SECOND, unowned copy of the rejection beside the one
// the caller catches, and diagnostics/errorLog.ts exits on `unhandledRejection` — so a caller-side
// try/catch cannot contain a throw from in there, and the suppression has to happen inside the
// locked section itself. That is what `opts.onFailure` is for. Losing one night's note or one
// week's rewrite is a cost; taking the VM down over a hand-edited file or a full disk is a bug, and
// the memory note for this deployment records the VPS disk as near-full.
//
// So DROPPING IS THE DEFAULT and the throw is opt-in, which is the way round the crash radius asks
// for. The weekly rewrite was the last writer to hold out, on the argument that its loss is the one
// that actually costs a week; that argument is right about the COST and wrong about the remedy, and
// getting it wrong once was enough to make the safe answer the one nobody has to remember. A throw
// does not make the loss loud, it makes it fatal, and fatal here is a LOOP — the process dies inside
// the turn, the backoff map dies with it, `rewritten=` never moved, and the next non-group turn with
// a week's worth of lines in it does the whole thing again. Every writer this store has is a
// background one, so every writer either takes the default or asks for it by name — the weekly
// rewrite still spells `onFailure: 'drop'` out at its save (memory/thesisRewrite.ts `attemptSave`),
// which is the same answer stated rather than inherited, and its receipt reads the option back to
// tell a dropped write from a fenced one. `onFailure: 'throw'` exists for a foreground caller a
// person is waiting on, and there is no such caller today. Nothing on a REQUEST path should ever ask
// for it: the request would not survive to see the error either way.

import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';
import { withHandleLock, getForgetEpoch } from './memory.js';
import { splitThesisDoc, joinThesisDoc, THESIS_EVIDENCE_MAX } from '../../memory/thesisEngine.js';

export interface ThesisDoc {
  docMd: string;
  version: number;
  /** Which writer produced THIS version: `'weekly'` for a rewrite of the read, `'evidence'` for a
   *  nightly note, `'forget'` for a wipe. Surfaced because a caller that wants to know why the
   *  document last moved should not have to list revisions to find out. */
  writtenBy: string;
  /**
   * When THIS version was written (epoch ms), off the header's own `updated` stamp — the last write
   * by any of the three writers, which is not the same clock as `lastRewriteAt` below.
   *
   * Parsed either way (the header carries it and the version check needs the same line), so it is
   * free here; nothing on the reply path reads it. It exists for the operator surface
   * (`diagnostics/adminDashboard/api/affect.ts`), where "the read is four days old" and "a note was
   * appended last night" are two different answers to why the document says what it says, and the
   * alternative was deriving it from the newest revision's stamp — the same bytes, one directory
   * listing away, and a number that can silently disagree once a revision file goes missing.
   */
  updatedAt: number;
  /**
   * When the READ was last rewritten (epoch ms), off the header's own `rewritten` stamp — the
   * cooldown clock the weekly pass gates on, and the cut the weekly window ratchets from
   * (`buildThesisWindow`'s `lastRewriteAt`).
   *
   * Two fields more than the long tier's shape, deliberately: the plan puts the weekly cooldown "in
   * the THESIS.md header", and this is that stamp. The alternative was a pass that reads the head
   * doc for its content and then hunts the newest `written_by=weekly` revision for a date the head's
   * first line can carry.
   *
   * NOT the last write. A nightly note bumps the version and moves `updated=`, and it deliberately
   * does not move this — see the header comment above for what gating on the write stamp would have
   * cost. A WIPE does move it (see `saveThesis`). `0` means "never rewritten", which is also what an
   * unparseable or pre-`rewritten=` stamp reads as: an OPEN window, the safe direction for a
   * cooldown (one extra rewrite, never a year of skipped ones).
   */
  lastRewriteAt: number;
}

/**
 * What a caller may ask of a save beyond the version it read.
 *
 * `ifForgetEpoch` is the epoch the caller read BEFORE it started working (`getForgetEpoch`): when it
 * no longer matches at write time, a `/forget` landed mid-pass and this save would put back a read
 * the user asked to be forgotten, so it is refused. It shares the `null` return with a version
 * conflict, and unlike a conflict it must NOT be retried — the document the caller is holding is
 * exactly the thing the user erased. `appendThesisEvidence` short-circuits its own retry on it.
 *
 * `onFailure` picks what a failed write does, and it DEFAULTS TO `'drop'`: the two throwing branches
 * (an unreadable head doc, a durable write failure) log and return null instead. The reason is in
 * the header — a throw out of a locked section takes the PROCESS down rather than the pass, a
 * caller-side catch provably cannot contain it (`withHandleLock` publishes a second, unowned copy of
 * the rejection and diagnostics/errorLog.ts exits on `unhandledRejection`), and on a failure that
 * persists the exit repeats every turn. Every writer this store has is a background one, so every
 * writer takes the default.
 *
 * `onFailure: 'throw'` is therefore opt-in, for a foreground caller a person is actually waiting on,
 * where a lost write has to be an error somebody sees rather than a null somebody ignores. NOTHING
 * ON A REQUEST PATH SHOULD ASK FOR IT: the exit takes the request with it, so the throw cannot be
 * reported to the person who was waiting anyway. There is no such caller today, and the option
 * exists so the fail-loud policy is a choice on record rather than a branch that was deleted.
 *
 * A dropped write shares the `null` return with a version conflict and with the fence, and only the
 * conflict is worth retrying — `memory/thesisRewrite.ts`'s `attemptSave` tells the three apart by
 * re-reading the epoch and the version, which is the only information the null carries.
 */
export interface ThesisSaveOptions {
  ifForgetEpoch?: number;
  /** Default `'drop'`. See above: `'throw'` is process-fatal from inside the lock. */
  onFailure?: 'throw' | 'drop';
}

/** The one `writtenBy` word that advances the rewrite clock. Exported so the weekly pass and this
 *  store cannot disagree about it by a typo: a pass that saved as `'rewrite'` would write a read
 *  whose cooldown never closed, and every subsequent night would rewrite it again. */
export const THESIS_REWRITE_WRITER = 'weekly';

export interface ThesisRevision {
  version: number;
  docMd: string;
  writtenBy: string;
  createdAt: number; // epoch ms
}

/** Thrown when a durable thesis write fails. */
export class ThesisWriteError extends Error {
  constructor(scope: string, cause?: unknown) {
    super(`[memory-thesis] durable write failed: ${scope}`);
    this.name = 'ThesisWriteError';
    this.cause = cause;
  }
}

/** `rewritten=` is OPTIONAL in the pattern and required in everything this store writes: a file
 *  written before the stamp existed still parses, and reads as never-rewritten (an open cooldown).
 *  The alternative — refusing it — would fail-loud a write over a field that was added, not lost. */
const HEADER_RE =
  /^<!-- irises:thesis version=(\d+) written_by=(\S*) updated=(\S+?)(?: rewritten=(\S+))? -->(?:\r?\n)?/;

/** `never` rather than an epoch date for "no rewrite yet", so a human opening THESIS.md reads the
 *  answer instead of doing timezone arithmetic on 1970. It parses back to 0 through the same
 *  NaN guard an unparseable stamp takes. */
const NEVER = 'never';

function stamp(atMs: number): string {
  return atMs > 0 ? new Date(atMs).toISOString() : NEVER;
}

function parseStamp(raw: string | undefined): number {
  if (!raw) return 0;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? 0 : at;
}

function thesisPath(handle: string): string {
  return path.join(memoriesDir(handle), 'THESIS.md');
}

/** Revisions share the directory with the long tier's, which is why the prefix is in the FILENAME
 *  and every listing filters on it. Two stores, one folder, no collision: `LONG.v0003.md` and
 *  `THESIS.v0003.md` are different documents at the same version number. */
function revisionPath(handle: string, version: number): string {
  return path.join(memoriesDir(handle), 'revisions', `THESIS.v${String(version).padStart(4, '0')}.md`);
}

function renderDoc(
  version: number,
  writtenBy: string,
  atMs: number,
  rewrittenAtMs: number,
  docMd: string,
): string {
  return `<!-- irises:thesis version=${version} written_by=${encodeURIComponent(writtenBy)} updated=${new Date(atMs).toISOString()} rewritten=${stamp(rewrittenAtMs)} -->\n${docMd}`;
}

/** Parse a THESIS.md/revision file. Throws on a present-but-headerless file — the version is
 *  load-bearing for optimistic concurrency, so guessing would risk a clobber. */
function parseDoc(raw: string): {
  version: number; writtenBy: string; createdAt: number; rewrittenAt: number; docMd: string;
} {
  const m = raw.match(HEADER_RE);
  if (!m) throw new Error('missing/unparseable irises:thesis header');
  return {
    version: Number(m[1]),
    writtenBy: decodeURIComponent(m[2]),
    createdAt: parseStamp(m[3]),
    rewrittenAt: parseStamp(m[4]),
    docMd: raw.slice(m[0].length),
  };
}

/**
 * The ONE door to the head file, and the three answers it can give — because every caller here
 * needs a different one and the middle answer is the one a caller forgets exists.
 *
 * `absent` is the normal state of somebody she met this week. `unreadable` is a file that exists
 * and does not parse: a hand edit, a truncated write, a permission change. `parsed` is a document.
 * Nobody logs from in here — a read that degrades, a write that throws and a pass that drops a note
 * owe the log three different sentences, so each caller writes its own.
 *
 * Async with nothing awaited inside it, deliberately: the file read happens synchronously at CALL
 * time and the caller's `await` yields exactly one microtask, which is what keeps `withHandleLock`'s
 * queue FIFO by call time for the two racers (the nightly note and the weekly rewrite). See the
 * interleaving comment in thesis.test.ts's race test.
 */
type HeadRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'parsed'; doc: ThesisDoc };

async function readHead(handle: string): Promise<HeadRead> {
  try {
    const raw = readTextIfExists(thesisPath(handle));
    if (raw === null) return { kind: 'absent' };
    const parsed = parseDoc(raw);
    return {
      kind: 'parsed',
      doc: {
        docMd: parsed.docMd,
        version: parsed.version,
        writtenBy: parsed.writtenBy,
        updatedAt: parsed.createdAt,
        lastRewriteAt: parsed.rewrittenAt,
      },
    };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

/**
 * A head read plus the ONE thing `getThesis`'s `null` cannot say: whether the file is ABSENT or
 * present-and-unreadable. Same field and same name as `MomentsFile.degraded`, so the two stores
 * read as one from a caller's side.
 *
 * The distinction exists for WRITERS, exactly as it does in the moments store. A read that degrades
 * an unreadable head to `null` also degrades its `lastRewriteAt` to 0, which reads as "never
 * rewritten" — an OPEN cooldown, forever, on a file that will not parse tomorrow either. So the
 * weekly pass would spend one classify call per reply and then reach a save that must refuse: it
 * needs to see the unreadable file BEFORE it opens its own window (memory/thesisRewrite.ts's
 * `degraded` gate). The reply path wants the opposite and keeps `getThesis`.
 */
export interface ThesisRead {
  doc: ThesisDoc | null;
  degraded: boolean;
}

/** The head read with the degraded flag — see `ThesisRead` for who needs it and why. */
export async function readThesisHead(handle: string): Promise<ThesisRead> {
  const head = await readHead(handle);
  if (head.kind === 'unreadable') {
    logDbError('getThesis', head.error);
    return { doc: null, degraded: true };
  }
  return { doc: head.kind === 'parsed' ? head.doc : null, degraded: false };
}

/** The current read + its evidence tail, or null when this person has none yet. Reads degrade to
 *  null: a missing file is the normal state of somebody she met this week, and the reply path wants
 *  an empty section rather than a thrown turn. A WRITE against an unreadable file does not degrade
 *  (see `saveThesis`); a WRITER that needs to tell the two nulls apart reads `readThesisHead`. */
export async function getThesis(handle: string): Promise<ThesisDoc | null> {
  return (await readThesisHead(handle)).doc;
}

/**
 * Save a new version. `expectedVersion` is what the writer read (0 for "no doc yet"). Returns the
 * new version number, or null on a version conflict (the caller re-reads and retries once) or on the
 * `/forget` fence refusing the write (the caller must NOT retry — see `ThesisSaveOptions`).
 * A write that fails durably — including a head file that exists but cannot be read or parsed,
 * since clobbering it would lose a read that costs a week to earn back — is DROPPED: it logs and
 * returns null, which is the same null the conflict and the fence return. A caller that wants the
 * ThesisWriteError instead passes `onFailure: 'throw'`, which is process-fatal from inside the lock
 * and is for a foreground caller only (see `ThesisSaveOptions`).
 *
 * `writtenBy` is a short provenance word that lands in the header and in every revision: 'weekly'
 * (`THESIS_REWRITE_WRITER`) for the rewrite pass, 'evidence' for a nightly note, 'forget' for a
 * wipe.
 *
 * TWO writers advance the rewrite clock and everything else carries the previous stamp forward: a
 * 'weekly' save, and a save of an EMPTY document — a wipe, whoever wrote it. Keying the second on
 * the document rather than on the writer word is deliberate; the clock has to move for the wipe
 * whether or not the wipe came through `clearThesis`.
 *
 * The wipe stamps at the WIPE rather than carrying the pre-forget stamp forward, and this is the
 * same decision `clearMoments` records (db/repositories/moments.ts — the two stores read as one).
 * `lastRewriteAt` is not only the cooldown: it is the weekly window's CUT (`buildThesisWindow`), and
 * `/forget` does not clear the transcript — that is `/clear`. Carried forward, the first pass after
 * the cooldown reopened would read the pre-forget rows and re-mint substantially the read the user
 * asked to erase. Stamped at the wipe, the cooldown stays shut a full 6.5 days FROM the wipe (which
 * is strictly longer than "until the erased read would have been due anyway") and the next window
 * starts there. The rejected third option — clearing the stamp to 0 — is the worst of the three: an
 * open window over the whole pre-forget transcript, immediately.
 */
export async function saveThesis(
  handle: string,
  docMd: string,
  expectedVersion: number,
  writtenBy: string,
  opts?: ThesisSaveOptions,
): Promise<number | null> {
  return withHandleLock(handle, async () => {
    // The epoch is re-read INSIDE the lock: clearDossier's bump happens under the same queue, so
    // this is the point where "did a forget land while the pass was thinking?" has a definite
    // answer. Checked before the head read, so a fenced-out write cannot reach the refusal below.
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn(`[memory-thesis] save aborted for ${handle} — /forget landed mid-pass`);
      return null;
    }
    const head = await readHead(handle);
    if (head.kind === 'unreadable') {
      if (opts?.onFailure !== 'throw') {
        console.warn(`[memory-thesis] write dropped for ${handle} — head doc unreadable`, head.error);
        return null;
      }
      console.error(`[memory-thesis] WRITE REFUSED for ${handle} — head doc unreadable`, head.error);
      throw new ThesisWriteError('saveThesis (head read)', head.error);
    }
    const current = head.kind === 'parsed' ? head.doc : null;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) return null;
    const version = currentVersion + 1;
    const now = Date.now();
    const isWipe = !docMd.trim();
    const rewrittenAt = writtenBy === THESIS_REWRITE_WRITER || isWipe ? now : (current?.lastRewriteAt ?? 0);
    const file = renderDoc(version, writtenBy, now, rewrittenAt, docMd);
    try {
      // Revision first: a crash between the two writes leaves an orphan revision that a retry at
      // the same version harmlessly overwrites (the head stays the source of truth).
      atomicWriteText(revisionPath(handle, version), file);
      atomicWriteText(thesisPath(handle), file);
      return version;
    } catch (error) {
      if (opts?.onFailure !== 'throw') {
        console.warn(`[memory-thesis] write dropped for ${handle} — durable write failed`, error);
        return null;
      }
      console.error(`[memory-thesis] WRITE FAILED for ${handle} — thesis update lost`, error);
      throw new ThesisWriteError('saveThesis', error);
    }
  });
}

/** Recent revisions, newest first (a history/debug view and the dashboard's; nothing renders these
 *  into a prompt). Filtered on the THESIS prefix, because the long tier's revisions live in the
 *  same folder. One corrupt revision is skipped rather than sinking the listing.
 *
 *  NOT the way to find when the read was last rewritten — that is the head's own `rewritten=` stamp
 *  (`ThesisDoc.lastRewriteAt`), one file read with no window on it. A pass that hunted the
 *  newest `writtenBy === 'weekly'` revision instead would be defeated by its own default `limit` —
 *  ten nightly notes push the last rewrite off the page. */
export async function listThesisRevisions(handle: string, limit = 10): Promise<ThesisRevision[]> {
  try {
    const dir = path.join(memoriesDir(handle), 'revisions');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const versions = names
      .map(n => n.match(/^THESIS\.v(\d+)\.md$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => Number(m[1]))
      .sort((a, b) => b - a)
      .slice(0, limit);
    const out: ThesisRevision[] = [];
    for (const v of versions) {
      try {
        const raw = readTextIfExists(revisionPath(handle, v));
        if (raw === null) continue;
        const parsed = parseDoc(raw);
        out.push({ version: parsed.version, docMd: parsed.docMd, writtenBy: parsed.writtenBy, createdAt: parsed.createdAt });
      } catch { /* one corrupt revision must not sink the listing */ }
    }
    return out;
  } catch (error) {
    logDbError('listThesisRevisions', error);
    return [];
  }
}

/**
 * Append one evidence note — what the nightly moments pass writes when the day gave real evidence
 * for or against the standing read. FIFO: the newest `THESIS_EVIDENCE_MAX` survive, and the note
 * lands at the END so "oldest first" holds in the file the weekly pass reads.
 *
 * The read itself is untouched. A note is a save like any other, so it takes a version and bumps
 * one — an appended note IS a change to the document the weekly pass will be rewritten from, and a
 * store where one writer could mutate a document without moving its version is a store where the
 * other writer's optimistic check means nothing.
 *
 * `opts.ifForgetEpoch` is the epoch the nightly pass read before it started thinking (the moments
 * call is the same fifteen-second window `writeMoments` fences), passed straight through.
 *
 * Returns the new version, or null when nothing was written: an empty note (nothing to append), an
 * unreadable head doc, a durable write failure, the `/forget` fence, or a conflict that survived one
 * retry. The retry is the caller contract the long tier documents, done here so that neither pass
 * has to remember it — the nightly note and the weekly rewrite race by design, and one lost note is
 * worse than one extra read. It is NOT taken on the fence: a save the fence refused would be refused
 * again for the same reason, and the document this loop is holding is exactly what the user erased.
 *
 * NOTHING here may throw, and that asymmetry with the weekly rewrite is the point. This is one of the
 * two routes to the fail-loud branches that a BACKGROUND pass takes, and a throw out of a locked
 * section is process-fatal rather than pass-fatal (withHandleLock keeps its queue with
 * `void next.finally(...)`, so a second, unowned copy of the rejection is published beside the one a
 * caller catches, and diagnostics/errorLog.ts exits the process on `unhandledRejection` — which is
 * also why a try/catch around this call could never have contained it). One human who opened
 * THESIS.md and typed, or one full disk, would otherwise take the VM down on that night's pass. So
 * the head read is pre-checked here for its own warning, and `onFailure: 'drop'` suppresses BOTH
 * throwing branches inside the locked section, the write half included.
 */
export async function appendThesisEvidence(
  handle: string,
  note: string,
  opts?: { ifForgetEpoch?: number },
): Promise<number | null> {
  if (!(note ?? '').trim()) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await readHead(handle);
    if (head.kind === 'unreadable') {
      console.warn(`[memory-thesis] evidence note dropped for ${handle} — head doc unreadable`, head.error);
      return null;
    }
    const cur = head.kind === 'parsed' ? head.doc : null;
    const parts = splitThesisDoc(cur?.docMd ?? '');
    const evidence = [...parts.evidence, note].slice(-THESIS_EVIDENCE_MAX);
    const version = await saveThesis(
      handle,
      joinThesisDoc(parts.thesis, evidence),
      cur?.version ?? 0,
      'evidence',
      { ...opts, onFailure: 'drop' },
    );
    if (version !== null) return version;
    // A fenced-out save and a version conflict share the null, and only one of them is worth
    // retrying. The re-check here is outside the lock and therefore approximate, which is harmless:
    // the authoritative refusal already happened inside it, and the worst this costs is one extra
    // attempt that the fence refuses again.
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn(`[memory-thesis] evidence note dropped for ${handle} — /forget landed mid-pass`);
      return null;
    }
  }
  console.warn(`[memory-thesis] evidence note dropped for ${handle} — version conflict twice`);
  return null;
}

/** The highest version any revision FILE claims, read off the names rather than the contents — a
 *  corrupt newest revision must not make the next version number go backwards and overwrite a
 *  sibling. `0` for a handle with no revisions folder. Only the unversioned wipe below needs it;
 *  every other write gets its number from the head doc's own header. */
function highestRevisionVersion(handle: string): number {
  try {
    return fs.readdirSync(path.join(memoriesDir(handle), 'revisions'))
      .map(n => n.match(/^THESIS\.v(\d+)\.md$/))
      .reduce((max, m) => (m ? Math.max(max, Number(m[1])) : max), 0);
  } catch {
    return 0;
  }
}

/**
 * Wipe a head doc that cannot be READ — the one write in this store that ignores the version it is
 * replacing, because there is no version to be had.
 *
 * The fail-loud policy points the other way for every other writer and it is right to: a save must
 * not turn a file it cannot version into something else, because the read in there costs a week to
 * earn back. A WIPE is the exception, and it is the exception for the plainest possible reason —
 * losing that content is the request. `/forget` asked for her read of somebody to stop existing, and
 * a hand edit or a half-written head is the one shape where refusing would leave it sitting on disk
 * in plaintext instead. The sibling store gives the same answer (`clearMoments` overwrites
 * unconditionally, hand edits included).
 *
 * The version is `max(existing revision) + 1` rather than 1, so the revision this mints cannot
 * overwrite a real one, and a later save still moves forward. Failure logs and returns null: a wipe
 * has nothing left to protect by throwing, and this call is on the background side of the
 * crash-radius rule in the header.
 *
 * Null also means "the head healed under the lock" — a racing save parsed and versioned the file
 * between the caller's read and this one — in which case the caller's next attempt takes the normal
 * versioned path instead.
 */
async function wipeUnversioned(handle: string, why: unknown): Promise<number | null> {
  return withHandleLock(handle, async () => {
    const head = await readHead(handle);
    if (head.kind !== 'unreadable') return null;
    const version = highestRevisionVersion(handle) + 1;
    const now = Date.now();
    const file = renderDoc(version, 'forget', now, now, '');
    try {
      atomicWriteText(revisionPath(handle, version), file);
      atomicWriteText(thesisPath(handle), file);
      console.warn(`[memory-thesis] wiped an UNREADABLE head doc for ${handle} — /forget outranks a version nothing can read`, why);
      return version;
    } catch (error) {
      console.error(`[memory-thesis] WIPE FAILED for ${handle} — an unreadable read survives /forget`, error);
      return null;
    }
  });
}

/**
 * The /forget wipe: an empty document as a NEW version, read and evidence tail together. The
 * revision history stays (Stage 3's `forgetUser` is the one sanctioned hard-delete of revisions
 * themselves) — the same bargain the long tier makes, and nothing here is searchable, so nothing
 * comes back through `recall_memory`.
 *
 * A person with nothing written gets no file: `/forget` on a fresh handle must not create a THESIS.md
 * whose only content is the fact that somebody asked to be forgotten. This mirrors the long tier's
 * own call site in agents/convo/client.ts (`if (cur?.docMd) …`), lifted in here so the wipe list
 * stays one line per store.
 *
 * An unreadable head doc IS wiped — see `wipeUnversioned` for why this one write outranks the
 * version it cannot read.
 *
 * No `ifForgetEpoch`: this call is not a pass that might be overtaken by a `/forget`, it is what a
 * `/forget` does.
 *
 * Returns the new version, or null when there was nothing to clear, the write failed durably, or the
 * retry also conflicted. NOTHING here throws — `onFailure: 'drop'` keeps a full disk out of
 * `saveThesis`'s fail-loud branch, because a throw from inside a locked section is process-fatal and
 * the /forget path's own catch could not have contained it (see the header).
 */
export async function clearThesis(handle: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await readHead(handle);
    if (head.kind === 'unreadable') {
      const wiped = await wipeUnversioned(handle, head.error);
      if (wiped !== null) return wiped;
      continue; // the head healed under the lock, or the write failed — one more attempt either way
    }
    const cur = head.kind === 'parsed' ? head.doc : null;
    if (!cur || !cur.docMd.trim()) return null;
    const version = await saveThesis(handle, '', cur.version, 'forget', { onFailure: 'drop' });
    if (version !== null) return version;
  }
  console.warn(`[memory-thesis] wipe lost a race twice for ${handle} — thesis may survive /forget`);
  return null;
}

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
// remember). The re-read happens under withHandleLock, so in-process racers serialize.
//
// Failure policy: FAIL LOUD like memoryLong and memoryMedium. This is not the moments store, which
// degrades an unreadable file to empty because it renders on the reply path and is re-derivable
// from tonight's transcript: a read costs a week to earn back, and a write that quietly failed
// would leave the weekly pass re-proposing the same rewrite against a version that never moved.
// Reads still degrade to null (a missing file is the normal state of a new person), but a WRITE
// against a head file that exists and cannot be parsed is refused with a throw.
//
// ONE exception, and it is a crash-radius decision rather than a policy change: a throw out of a
// locked section is process-fatal (withHandleLock publishes an unowned rejection and
// diagnostics/errorLog.ts exits on `unhandledRejection`), so the two background writers that would
// otherwise meet a hand-edited file — the nightly note and the wipe — pre-read the head and DROP
// their write with a warning instead of entering `saveThesis` against a version they cannot know.
// The refusal still stands for the weekly rewrite, which is the write whose loss actually costs a
// week.

import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';
import { withHandleLock } from './memory.js';
import { splitThesisDoc, joinThesisDoc, THESIS_EVIDENCE_MAX } from '../../memory/thesisEngine.js';

export interface ThesisDoc {
  docMd: string;
  version: number;
  /** Which writer produced THIS version: `'weekly'` for a rewrite of the read, `'evidence'` for a
   *  nightly note, `'forget'` for a wipe. Surfaced because a caller that wants to know why the
   *  document last moved should not have to list revisions to find out. */
  writtenBy: string;
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
   * cost. `0` means "never rewritten", which is also what an unparseable or pre-`rewritten=` stamp
   * reads as: an OPEN window, the safe direction for a cooldown (one extra rewrite, never a year of
   * skipped ones).
   */
  lastRewriteAt: number;
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
        lastRewriteAt: parsed.rewrittenAt,
      },
    };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

/** The current read + its evidence tail, or null when this person has none yet. Reads degrade to
 *  null: a missing file is the normal state of somebody she met this week, and the reply path wants
 *  an empty section rather than a thrown turn. A WRITE against an unreadable file does not degrade
 *  (see `saveThesis`). */
export async function getThesis(handle: string): Promise<ThesisDoc | null> {
  const head = await readHead(handle);
  if (head.kind === 'unreadable') {
    logDbError('getThesis', head.error);
    return null;
  }
  return head.kind === 'parsed' ? head.doc : null;
}

/**
 * Save a new version. `expectedVersion` is what the writer read (0 for "no doc yet"). Returns the
 * new version number, or null on a version conflict — the caller re-reads and retries once.
 * Throws ThesisWriteError when the write itself fails durably (including a head file that exists
 * but cannot be read or parsed — clobbering it would lose a read that costs a week to earn back).
 *
 * `writtenBy` is a short provenance word that lands in the header and in every revision: 'weekly'
 * (`THESIS_REWRITE_WRITER`) for the rewrite pass, 'evidence' for a nightly note, 'forget' for a
 * wipe. It is also what decides the rewrite clock: ONLY a 'weekly' save stamps `rewritten=`, every
 * other writer carries the previous stamp forward untouched. A wipe carries it too rather than
 * clearing it — after a `/forget` the cooldown stays shut until the read it erased would have been
 * due anyway, which is the direction that does not re-mint a read minutes after somebody asked to
 * be forgotten.
 */
export async function saveThesis(
  handle: string,
  docMd: string,
  expectedVersion: number,
  writtenBy: string,
): Promise<number | null> {
  return withHandleLock(handle, async () => {
    const head = await readHead(handle);
    if (head.kind === 'unreadable') {
      console.error(`[memory-thesis] WRITE REFUSED for ${handle} — head doc unreadable`, head.error);
      throw new ThesisWriteError('saveThesis (head read)', head.error);
    }
    const current = head.kind === 'parsed' ? head.doc : null;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) return null;
    const version = currentVersion + 1;
    const now = Date.now();
    const rewrittenAt = writtenBy === THESIS_REWRITE_WRITER ? now : (current?.lastRewriteAt ?? 0);
    const file = renderDoc(version, writtenBy, now, rewrittenAt, docMd);
    try {
      // Revision first: a crash between the two writes leaves an orphan revision that a retry at
      // the same version harmlessly overwrites (the head stays the source of truth).
      atomicWriteText(revisionPath(handle, version), file);
      atomicWriteText(thesisPath(handle), file);
      return version;
    } catch (error) {
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
 * Returns the new version, or null when nothing was written: an empty note (nothing to append), an
 * unreadable head doc, or a conflict that survived one retry. The retry is the caller contract the
 * long tier documents, done here so that neither pass has to remember it — the nightly note and the
 * weekly rewrite race by design, and one lost note is worse than one extra read.
 *
 * The unreadable case is pre-checked HERE rather than left to `saveThesis`'s fail-loud throw, and
 * that asymmetry is the point. This is the one route to the throw that a BACKGROUND pass takes, and
 * a throw out of a locked section is process-fatal rather than pass-fatal (withHandleLock keeps its
 * queue with `void next.finally(...)`, so the rejection is also published unowned, and
 * diagnostics/errorLog.ts exits the process on `unhandledRejection`). One human who opened
 * THESIS.md and typed would take the VM down on that night's pass. So a note is DROPPED on an
 * unreadable head — the same answer `clearThesis` already gives to the same file — while the
 * fail-loud policy stands unchanged for the two writers a person is waiting on.
 */
export async function appendThesisEvidence(handle: string, note: string): Promise<number | null> {
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
    const version = await saveThesis(handle, joinThesisDoc(parts.thesis, evidence), cur?.version ?? 0, 'evidence');
    if (version !== null) return version;
  }
  console.warn(`[memory-thesis] evidence note dropped for ${handle} — version conflict twice`);
  return null;
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
 * An unreadable head doc is refused rather than wiped, on the same read: `/forget` must not turn a
 * file it cannot version into an empty one, and refusing here also keeps the wipe out of
 * `saveThesis`'s throwing branch.
 *
 * Returns the new version, or null when there was nothing to clear, the file was unreadable, or the
 * retry also conflicted. A durable write failure still throws ThesisWriteError like any other save
 * — the /forget path wraps every wipe in its own catch.
 */
export async function clearThesis(handle: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const head = await readHead(handle);
    if (head.kind === 'unreadable') {
      console.warn(`[memory-thesis] wipe refused for ${handle} — head doc unreadable`, head.error);
      return null;
    }
    const cur = head.kind === 'parsed' ? head.doc : null;
    if (!cur || !cur.docMd.trim()) return null;
    const version = await saveThesis(handle, '', cur.version, 'forget');
    if (version !== null) return version;
  }
  console.warn(`[memory-thesis] wipe lost a race twice for ${handle} — thesis may survive /forget`);
  return null;
}

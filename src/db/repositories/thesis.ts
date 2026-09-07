// The THESIS store: memories/<handle>/THESIS.md, one file per person, holding her ONE read on them
// plus the evidence notes the nightly moments pass leaves for the weekly rewrite.
//
// On disk (memories/<handle>/):
//   THESIS.md                  — head doc; first line is a machine header comment carrying the
//                                version, the writer and the update stamp, rest is the doc verbatim
//   revisions/THESIS.v0007.md  — one file per accepted version, same format
//
// A FORK of the long tier (memoryLong.ts), and a close one: the same header grammar, the same
// optimistic version, the same revision-first write, the same fail-loud policy. What differs is who
// writes it and how often. The long doc is the user's own flexible prompt layer, rewritten whenever
// the dossier refresh runs; this is HER read, rewritten once every six and a half days by one
// classify call (memory/thesisRewrite.ts) and appended to nightly by the moments pass. Forking
// rather than parameterising memoryLong was the cheaper honesty: two stores with one grammar can
// each keep their own doc comment about what a lost write costs, and every attempt to share this
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
  /**
   * When this version was written (epoch ms), off the header's own `updated` stamp.
   *
   * One field more than the long tier's shape, deliberately: the plan puts the weekly cooldown "in
   * the THESIS.md header", and this is that stamp. The alternative was a pass that reads the head
   * doc for its content and then reads the newest revision file for a date the head's first line
   * already carried. `0` when the stamp is unparseable — an open window, which is the safe
   * direction for a cooldown (one extra rewrite, never a week of skipped ones).
   */
  updatedAt: number;
}

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

const HEADER_RE = /^<!-- irises:thesis version=(\d+) written_by=(\S*) updated=(\S+) -->(?:\r?\n)?/;

function thesisPath(handle: string): string {
  return path.join(memoriesDir(handle), 'THESIS.md');
}

/** Revisions share the directory with the long tier's, which is why the prefix is in the FILENAME
 *  and every listing filters on it. Two stores, one folder, no collision: `LONG.v0003.md` and
 *  `THESIS.v0003.md` are different documents at the same version number. */
function revisionPath(handle: string, version: number): string {
  return path.join(memoriesDir(handle), 'revisions', `THESIS.v${String(version).padStart(4, '0')}.md`);
}

function renderDoc(version: number, writtenBy: string, atMs: number, docMd: string): string {
  return `<!-- irises:thesis version=${version} written_by=${encodeURIComponent(writtenBy)} updated=${new Date(atMs).toISOString()} -->\n${docMd}`;
}

/** Parse a THESIS.md/revision file. Throws on a present-but-headerless file — the version is
 *  load-bearing for optimistic concurrency, so guessing would risk a clobber. */
function parseDoc(raw: string): { version: number; writtenBy: string; createdAt: number; docMd: string } {
  const m = raw.match(HEADER_RE);
  if (!m) throw new Error('missing/unparseable irises:thesis header');
  const at = Date.parse(m[3]);
  return {
    version: Number(m[1]),
    writtenBy: decodeURIComponent(m[2]),
    createdAt: Number.isNaN(at) ? 0 : at,
    docMd: raw.slice(m[0].length),
  };
}

/** The current read + its evidence tail, or null when this person has none yet. Reads degrade to
 *  null: a missing file is the normal state of somebody she met this week, and the reply path wants
 *  an empty section rather than a thrown turn. A WRITE against an unreadable file does not degrade
 *  (see `saveThesis`). */
export async function getThesis(handle: string): Promise<ThesisDoc | null> {
  try {
    const raw = readTextIfExists(thesisPath(handle));
    if (raw === null) return null;
    const parsed = parseDoc(raw);
    return { docMd: parsed.docMd, version: parsed.version, updatedAt: parsed.createdAt };
  } catch (error) {
    logDbError('getThesis', error);
    return null;
  }
}

/**
 * Save a new version. `expectedVersion` is what the writer read (0 for "no doc yet"). Returns the
 * new version number, or null on a version conflict — the caller re-reads and retries once.
 * Throws ThesisWriteError when the write itself fails durably (including a head file that exists
 * but cannot be read or parsed — clobbering it would lose a read that costs a week to earn back).
 *
 * `writtenBy` is a short provenance word that lands in the header and in every revision: 'weekly'
 * for the rewrite pass, 'evidence' for a nightly note, 'forget' for a wipe.
 */
export async function saveThesis(
  handle: string,
  docMd: string,
  expectedVersion: number,
  writtenBy: string,
): Promise<number | null> {
  return withHandleLock(handle, async () => {
    let currentVersion: number;
    try {
      const raw = readTextIfExists(thesisPath(handle));
      currentVersion = raw === null ? 0 : parseDoc(raw).version;
    } catch (error) {
      console.error(`[memory-thesis] WRITE REFUSED for ${handle} — head doc unreadable`, error);
      throw new ThesisWriteError('saveThesis (head read)', error);
    }
    if (currentVersion !== expectedVersion) return null;
    const version = currentVersion + 1;
    const now = Date.now();
    try {
      // Revision first: a crash between the two writes leaves an orphan revision that a retry at
      // the same version harmlessly overwrites (the head stays the source of truth).
      atomicWriteText(revisionPath(handle, version), renderDoc(version, writtenBy, now, docMd));
      atomicWriteText(thesisPath(handle), renderDoc(version, writtenBy, now, docMd));
      return version;
    } catch (error) {
      console.error(`[memory-thesis] WRITE FAILED for ${handle} — thesis update lost`, error);
      throw new ThesisWriteError('saveThesis', error);
    }
  });
}

/** Recent revisions, newest first (a history/debug view and the dashboard's; nothing renders these
 *  into a prompt). Filtered on the THESIS prefix, because the long tier's revisions live in the
 *  same folder. One corrupt revision is skipped rather than sinking the listing. */
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
 * Returns the new version, or null when nothing was written: an empty note (nothing to append), or
 * a conflict that survived one retry. The retry is the caller contract the long tier documents,
 * done here so that neither pass has to remember it — the nightly note and the weekly rewrite race
 * by design, and one lost note is worse than one extra read.
 */
export async function appendThesisEvidence(handle: string, note: string): Promise<number | null> {
  if (!(note ?? '').trim()) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getThesis(handle);
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
 * Returns the new version, or null when there was nothing to clear or the retry also conflicted.
 * Throws ThesisWriteError like any other save — the /forget path wraps every wipe in its own catch.
 */
export async function clearThesis(handle: string): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getThesis(handle);
    if (!cur || !cur.docMd.trim()) return null;
    const version = await saveThesis(handle, '', cur.version, 'forget');
    if (version !== null) return version;
  }
  console.warn(`[memory-thesis] wipe lost a race twice for ${handle} — thesis may survive /forget`);
  return null;
}

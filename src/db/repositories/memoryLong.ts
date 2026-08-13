// TIER 3: long-term memory — ONE free-form markdown document per user (profile + how
// Irises should chat/behave: the "flexible prompt layer"), with every accepted version
// snapshotted as a file under revisions/. Nothing is ever lost: a save is a version bump
// plus a revision file, and "clearing" writes an empty doc as a NEW revision.
//
// On disk (memories/<handle>/):
//   LONG.md                  — head doc; first line is a machine header comment carrying
//                              the version, rest is the doc verbatim
//   revisions/LONG.v0007.md  — one file per accepted version, same format
//
// Concurrency: optimistic. saveLongDoc carries the version the writer read; a stale
// version returns null (no write) and the caller re-reads, re-merges, retries once.
// The re-read happens under withHandleLock, so in-process racers serialize.
// Writer today: the legacy dossier refresh (dual-write).
//
// Failure policy: FAIL LOUD like memoryMedium — a lost long-doc write is lost learning.

import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';
import { withHandleLock } from './memory.js';

export interface LongDoc {
  docMd: string;
  version: number;
}

export interface LongRevision {
  version: number;
  docMd: string;
  writtenBy: string;
  createdAt: number; // epoch ms
}

/** Thrown when a durable long-tier write fails. */
export class LongWriteError extends Error {
  constructor(scope: string, cause?: unknown) {
    super(`[memory-long] durable write failed: ${scope}`);
    this.name = 'LongWriteError';
    this.cause = cause;
  }
}

const HEADER_RE = /^<!-- irises:long version=(\d+) written_by=(\S*) updated=(\S+) -->(?:\r?\n)?/;

function longPath(handle: string): string {
  return path.join(memoriesDir(handle), 'LONG.md');
}

function revisionPath(handle: string, version: number): string {
  return path.join(memoriesDir(handle), 'revisions', `LONG.v${String(version).padStart(4, '0')}.md`);
}

function renderDoc(version: number, writtenBy: string, atMs: number, docMd: string): string {
  return `<!-- irises:long version=${version} written_by=${encodeURIComponent(writtenBy)} updated=${new Date(atMs).toISOString()} -->\n${docMd}`;
}

/** Parse a LONG.md/revision file. Throws on a present-but-headerless file — the version
 *  is load-bearing for optimistic concurrency, so guessing would risk a clobber. */
function parseDoc(raw: string): { version: number; writtenBy: string; createdAt: number; docMd: string } {
  const m = raw.match(HEADER_RE);
  if (!m) throw new Error('missing/unparseable irises:long header');
  return {
    version: Number(m[1]),
    writtenBy: decodeURIComponent(m[2]),
    createdAt: Date.parse(m[3]),
    docMd: raw.slice(m[0].length),
  };
}

/** The current doc, or null when the user has none yet. Reads degrade to null. */
export async function getLongDoc(handle: string): Promise<LongDoc | null> {
  try {
    const raw = readTextIfExists(longPath(handle));
    if (raw === null) return null;
    const parsed = parseDoc(raw);
    return { docMd: parsed.docMd, version: parsed.version };
  } catch (error) {
    logDbError('getLongDoc', error);
    return null;
  }
}

/**
 * Save a new doc version. `expectedVersion` is what the writer read (0 for "no doc yet").
 * Returns the new version number, or null on a version conflict — caller re-reads and
 * retries once. Throws LongWriteError when the write itself fails durably (including a
 * head file that exists but cannot be read/parsed — clobbering it would lose learning).
 */
export async function saveLongDoc(
  handle: string,
  docMd: string,
  expectedVersion: number,
  writtenBy: string,
): Promise<number | null> {
  return withHandleLock(handle, async () => {
    let currentVersion: number;
    try {
      const raw = readTextIfExists(longPath(handle));
      currentVersion = raw === null ? 0 : parseDoc(raw).version;
    } catch (error) {
      console.error(`[memory-long] WRITE REFUSED for ${handle} — head doc unreadable`, error);
      throw new LongWriteError('saveLongDoc (head read)', error);
    }
    if (currentVersion !== expectedVersion) return null;
    const version = currentVersion + 1;
    const now = Date.now();
    try {
      // Revision first: a crash between the two writes leaves an orphan revision that a
      // retry at the same version harmlessly overwrites (the head stays the source of truth).
      atomicWriteText(revisionPath(handle, version), renderDoc(version, writtenBy, now, docMd));
      atomicWriteText(longPath(handle), renderDoc(version, writtenBy, now, docMd));
      return version;
    } catch (error) {
      console.error(`[memory-long] WRITE FAILED for ${handle} — long-doc update lost`, error);
      throw new LongWriteError('saveLongDoc', error);
    }
  });
}

/** Recent revisions, newest first (a history/debug view; nothing renders these). */
export async function listLongRevisions(handle: string, limit = 10): Promise<LongRevision[]> {
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
      .map(n => n.match(/^LONG\.v(\d+)\.md$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => Number(m[1]))
      .sort((a, b) => b - a)
      .slice(0, limit);
    const out: LongRevision[] = [];
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
    logDbError('listLongRevisions', error);
    return [];
  }
}

// TIER 2: medium-term memory (weeks–years, operational). Conversationally-learned facts,
// directives, and important notes as first-class entries in a human-readable file:
//
//   memories/<handle>/MEDIUM.md         — ACTIVE entries only, §-delimited (Hermes style),
//                                         each carrying a trailing <!-- mm … --> annotation
//                                         (OpenClaw style) with id/kind/key/source/timestamps
//   memories/<handle>/MEDIUM.archive.md — superseded/retracted entries, append-only lineage
//
// Ledger discipline: entries are SUPERSEDED (edit/cap-eviction) or RETRACTED (user removal),
// NEVER deleted — retiring an entry moves it to the archive. The one sanctioned hard-delete
// is the /forget path (Stage 3's forgetUser).
//
// Dedupe and one-active-value-per-fact are enforced in code under withHandleLock — with a
// single serialized writer, a scan of ≤60 active entries IS the unique index the DB used
// to provide.
//
// Failure policy (per the tier table in the revamp plan): FAIL LOUD. This tier is the
// "no error margin" store — when a write fails after retries we THROW MediumWriteError so
// the caller voices "hit a snag" instead of confirming a save that didn't land. Reads still
// degrade to [] with a loud log: a render hiccup must never kill a turn.
//
// Hand edits: segments without a valid annotation are preserved verbatim at the top of
// every rewrite (warned once per handle) — never silently discarded.
//
// Directive/note TEXT validation stays where it lives today — validateDirective /
// sanitizeDirectives in src/memory/preferences.ts. This module only persists.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists, appendText } from '../files.js';
import { withHandleLock } from './memory.js';
import { archiveEntries, type ArchiveSource } from './memoryArchive.js';

export type MediumKind = 'fact' | 'directive' | 'important_note';
export type MediumStatus = 'active' | 'superseded' | 'retracted';

export interface MediumEntry {
  id: string;
  agentHandle: string;
  kind: MediumKind;
  key?: string; // fact slot name; undefined for directive/note
  body: string;
  status: MediumStatus;
  supersededBy?: string;
  source: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/** Thrown when a durable medium-tier write fails. Callers turn this into a user-visible
 *  "saving that hit a snag" — never a phantom confirmation. */
export class MediumWriteError extends Error {
  constructor(scope: string, cause?: unknown) {
    super(`[memory-medium] durable write failed: ${scope}`);
    this.name = 'MediumWriteError';
    this.cause = cause;
  }
}

// Active-entry caps, moved from the legacy prefs-array implementation (memory.ts). Enforced
// by superseding the oldest active entry after an insert lands — never by refusing the new one.
export const MAX_ACTIVE_DIRECTIVES = 40;
export const MAX_ACTIVE_NOTES = 20;

/** supersededBy sentinel for a cap eviction. The old code pointed the evicted row at whichever
 *  entry happened to trip the cap, which reads as "replaced by that" in the lineage — it wasn't;
 *  it aged out. A sentinel says why. */
export const CAP_EVICTED = 'cap-eviction';

/** MEDIUM.archive.md is append-only, so it grows forever. Rotated once it passes this size,
 *  keeping the newest MEDIUM_ARCHIVE_KEEP parsable entries — the deep lineage lives in the
 *  memory_archive table (searchable), and this file is the human-readable recent tail. */
export const MEDIUM_ARCHIVE_MAX_BYTES = 256 * 1024;
export const MEDIUM_ARCHIVE_KEEP = 200;

const WRITE_ATTEMPTS = 2;

const FILE_HEADER = '<!-- irises:medium format=1 — machine-managed by src/db/repositories/memoryMedium.ts; entries are §-delimited; the trailing mm annotation on each entry is load-bearing -->';
const DELIM = '\n§\n';
const ANNOTATION_RE = /^<!-- mm (.+) -->$/;
const KINDS: ReadonlySet<string> = new Set(['fact', 'directive', 'important_note']);
const STATUSES: ReadonlySet<string> = new Set(['active', 'superseded', 'retracted']);

function activePath(handle: string): string {
  return path.join(memoriesDir(handle), 'MEDIUM.md');
}

function archivePath(handle: string): string {
  return path.join(memoriesDir(handle), 'MEDIUM.archive.md');
}

const enc = encodeURIComponent;

function renderEntry(e: MediumEntry): string {
  const attrs = [`id=${enc(e.id)}`, `kind=${e.kind}`];
  if (e.key) attrs.push(`key=${enc(e.key)}`);
  attrs.push(`source=${enc(e.source)}`);
  attrs.push(`created=${new Date(e.createdAt).toISOString()}`, `updated=${new Date(e.updatedAt).toISOString()}`);
  if (e.status !== 'active') {
    attrs.push(`status=${e.status}`);
    if (e.supersededBy) attrs.push(`superseded_by=${enc(e.supersededBy)}`);
  }
  return `${e.body}\n<!-- mm ${attrs.join(' ')} -->`;
}

/** Parse one §-delimited segment. Null = not a valid entry (preserved verbatim). */
function parseSegment(segment: string, handle: string): MediumEntry | null {
  // Trailing newlines (e.g. before a hand-appended delimiter) must not unseat the
  // annotation from the last line.
  const lines = segment.replace(/[\r\n]+$/, '').split('\n');
  const last = lines[lines.length - 1]?.trim() ?? '';
  const m = last.match(ANNOTATION_RE);
  if (!m) return null;
  const attrs = new Map<string, string>();
  for (const token of m[1].split(' ')) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      try { attrs.set(token.slice(0, eq), decodeURIComponent(token.slice(eq + 1))); } catch { return null; }
    }
  }
  const id = attrs.get('id');
  const kind = attrs.get('kind');
  const created = Date.parse(attrs.get('created') ?? '');
  const updated = Date.parse(attrs.get('updated') ?? '');
  if (!id || !kind || !KINDS.has(kind) || Number.isNaN(created) || Number.isNaN(updated)) return null;
  const status = attrs.get('status') ?? 'active';
  if (!STATUSES.has(status)) return null;
  return {
    id,
    agentHandle: handle,
    kind: kind as MediumKind,
    key: attrs.get('key'),
    body: lines.slice(0, -1).join('\n'),
    status: status as MediumStatus,
    supersededBy: attrs.get('superseded_by'),
    source: attrs.get('source') ?? 'convo',
    createdAt: created,
    updatedAt: updated,
  };
}

const warnedPreserved = new Set<string>();

interface ActiveFile {
  entries: MediumEntry[];
  preserved: string[]; // unannotated segments (hand edits) — re-emitted verbatim on rewrite
}

/** Parse MEDIUM.md. Throws on an unreadable file (never "treat as empty and clobber"). */
function loadActive(handle: string): ActiveFile {
  const raw = readTextIfExists(activePath(handle));
  if (raw === null) return { entries: [], preserved: [] };
  let content = raw;
  if (content.startsWith('<!-- irises:medium')) {
    const nl = content.indexOf('\n');
    content = nl === -1 ? '' : content.slice(nl + 1);
  }
  content = content.replace(/\n$/, '');
  const entries: MediumEntry[] = [];
  const preserved: string[] = [];
  if (content.trim() !== '') {
    for (const segment of content.split(DELIM)) {
      if (segment.trim() === '') continue;
      const entry = parseSegment(segment, handle);
      if (entry) entries.push(entry);
      else preserved.push(segment);
    }
  }
  if (preserved.length && !warnedPreserved.has(handle)) {
    warnedPreserved.add(handle);
    console.warn(`[memory-medium] ${preserved.length} unannotated segment(s) in ${activePath(handle)} — preserved verbatim, not rendered`);
  }
  return { entries, preserved };
}

/** Rewrite MEDIUM.md atomically: header, preserved hand edits, then active entries. */
function writeActive(handle: string, file: ActiveFile): void {
  const parts = [...file.preserved, ...file.entries.map(renderEntry)];
  atomicWriteText(activePath(handle), parts.length ? `${FILE_HEADER}\n${parts.join(DELIM)}\n` : `${FILE_HEADER}\n`);
}

/** Why this entry left the active file, for the archive table's `source` column. */
function retireSource(e: MediumEntry): ArchiveSource {
  if (e.status === 'retracted') return 'medium_retracted';
  if (e.supersededBy === CAP_EVICTED) return 'medium_cap_evicted';
  return 'medium_superseded';
}

/**
 * The ONE choke point for retiring entries: every retire path (edit, retraction, cap eviction,
 * the /forget sweep) funnels through here, so the searchable archive table and the human-readable
 * ledger file can never disagree about what was retired.
 *
 * Each append ends with the delimiter, so a torn tail is skipped by the tolerant parser instead
 * of corrupting the next entry. Callers already hold the handle lock and run inside durably(),
 * so the rotation below is safe to do in place.
 */
function appendArchive(handle: string, retired: MediumEntry[]): void {
  if (!retired.length) return;
  // Table copy FIRST and fire-and-forget: archiveEntries never throws or rejects (it is the
  // lineage bonus, not the job), so a DB hiccup must not stop the ledger append below.
  void archiveEntries(retired.map(e => ({
    source: retireSource(e),
    agentHandle: handle,
    kind: e.kind,
    request: e.key,
    content: e.body,
    meta: { mediumId: e.id, status: e.status, source: e.source, supersededBy: e.supersededBy },
    createdAt: e.createdAt,
  })));
  appendText(archivePath(handle), retired.map(e => renderEntry(e) + DELIM).join(''));
  rotateArchiveIfLarge(handle);
}

/** Trim MEDIUM.archive.md back to its newest entries once it passes the size cap. Unparsable
 *  segments are dropped here (they were already invisible to loadArchive) — the entries
 *  themselves survive in memory_archive, which is what recall actually searches. */
function rotateArchiveIfLarge(handle: string): void {
  const p = archivePath(handle);
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return; // no file / unreadable — nothing to rotate
  }
  if (size <= MEDIUM_ARCHIVE_MAX_BYTES) return;
  try {
    const entries = loadArchive(handle);
    const keep = entries.slice(-MEDIUM_ARCHIVE_KEEP);
    atomicWriteText(p, keep.map(e => renderEntry(e) + DELIM).join(''));
    console.log(`[memory-medium] rotated ${path.basename(p)} for ${handle}: kept the newest ${keep.length} of ${entries.length} entries (deep lineage lives in memory_archive)`);
  } catch (error) {
    // A failed rotation is a big file, not a lost write — the append already landed.
    logDbError('memory-medium archive rotation', error);
  }
}

function loadArchive(handle: string): MediumEntry[] {
  const raw = readTextIfExists(archivePath(handle));
  if (raw === null) return [];
  const entries: MediumEntry[] = [];
  for (const segment of raw.split(DELIM)) {
    if (segment.trim() === '') continue;
    const entry = parseSegment(segment, handle);
    if (entry) entries.push(entry);
    // torn/foreign segments in the debug ledger are skipped silently
  }
  return entries;
}

/** Retry wrapper for durable writes. Throws MediumWriteError after the final attempt. */
function durably<T>(scope: string, fn: () => T): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastErr = error;
      if (attempt < WRITE_ATTEMPTS - 1) logDbError(`memory-medium ${scope} (attempt ${attempt + 1})`, error);
    }
  }
  console.error(`[memory-medium] WRITE FAILED after ${WRITE_ATTEMPTS} attempts: ${scope}`, lastErr);
  throw new MediumWriteError(scope, lastErr);
}

/** Active entries for a handle, oldest first (matches the legacy arrays' insertion order). */
export async function listMediumActive(handle: string, kinds?: MediumKind[]): Promise<MediumEntry[]> {
  try {
    return loadActive(handle).entries
      .filter(e => e.status === 'active')
      .filter(e => !kinds?.length || kinds.includes(e.kind))
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch (error) {
    logDbError('listMediumActive', error);
    return [];
  }
}

/**
 * Unannotated segments of MEDIUM.md — hand edits, or an entry whose annotation got mangled.
 * They are preserved verbatim on every rewrite but never RENDERED into a prompt, so without a
 * way to see them a corrupted entry is silently absent from Irises's memory. Surfaced in the
 * dashboard's memory inspector (mediumPreserved) alongside the once-per-handle warn.
 */
export async function listMediumPreserved(handle: string): Promise<string[]> {
  try {
    return loadActive(handle).preserved;
  } catch (error) {
    logDbError('listMediumPreserved', error);
    return [];
  }
}

/**
 * Every entry for a handle including superseded/retracted (a lineage/debug view). Bounded by
 * MEDIUM.archive.md's rotation — the DEEP lineage (and the only searchable copy) lives in the
 * memory_archive table (memoryArchive.ts), which every retire path feeds through appendArchive.
 */
export async function listMediumAll(handle: string): Promise<MediumEntry[]> {
  try {
    return [...loadActive(handle).entries, ...loadArchive(handle)].sort((a, b) => a.createdAt - b.createdAt);
  } catch (error) {
    logDbError('listMediumAll', error);
    return [];
  }
}

/** Move active entries beyond a kind's cap to the archive as superseded-by-newest. Runs
 *  inside the caller's read-modify-write (a brief over-cap was harmless before; now the
 *  cap simply lands in the same rewrite). */
function enforceCap(file: ActiveFile, kind: MediumKind, cap: number, retired: MediumEntry[]): void {
  const active = file.entries
    .filter(e => e.status === 'active' && e.kind === kind)
    .sort((a, b) => a.createdAt - b.createdAt);
  const excess = active.length - cap;
  if (excess <= 0) return;
  const now = Date.now();
  for (const old of active.slice(0, excess)) {
    old.status = 'superseded';
    old.supersededBy = CAP_EVICTED; // aged out, NOT replaced by the entry that tripped the cap
    old.updatedAt = now;
    file.entries = file.entries.filter(e => e.id !== old.id);
    retired.push(old);
  }
}

/** Append a directive entry. Returns the created entry, or null when it duplicates an
 *  active directive (case-insensitive, like the old lower(body) unique index). */
export async function addDirective(handle: string, text: string, source = 'convo'): Promise<MediumEntry | null> {
  const clean = text.trim();
  if (!clean) return null;
  return withHandleLock(handle, async () =>
    durably('addDirective', () => {
      const file = loadActive(handle);
      const dup = file.entries.find(
        e => e.status === 'active' && e.kind === 'directive' && e.body.trim().toLowerCase() === clean.toLowerCase(),
      );
      if (dup) return null;
      const now = Date.now();
      const entry: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: 'directive', body: clean,
        status: 'active', source, createdAt: now, updatedAt: now,
      };
      file.entries.push(entry);
      const retired: MediumEntry[] = [];
      enforceCap(file, 'directive', MAX_ACTIVE_DIRECTIVES, retired);
      appendArchive(handle, retired);
      writeActive(handle, file);
      return entry;
    }),
  );
}

/** Replace the text of an active directive/note by id (supersede + insert, one rewrite).
 *  Returns false when the id wasn't found active. */
export async function updateDirective(handle: string, id: string, text: string, source = 'convo'): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  return withHandleLock(handle, async () =>
    durably('updateDirective', () => {
      const file = loadActive(handle);
      const old = file.entries.find(e => e.id === id && e.status === 'active');
      if (!old) return false;
      const now = Date.now();
      const replacement: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: old.kind, body: clean,
        status: 'active', source, createdAt: now, updatedAt: now,
      };
      old.status = 'superseded';
      old.supersededBy = replacement.id;
      old.updatedAt = now;
      file.entries = file.entries.filter(e => e.id !== old.id);
      file.entries.push(replacement);
      appendArchive(handle, [old]);
      writeActive(handle, file);
      return true;
    }),
  );
}

/** Soft-remove an active entry by id (user asked to drop a preference/note). */
export async function retractEntry(handle: string, id: string): Promise<boolean> {
  return withHandleLock(handle, async () =>
    durably('retire:retracted', () => {
      const file = loadActive(handle);
      const row = file.entries.find(e => e.id === id && e.status === 'active');
      if (!row) return false;
      row.status = 'retracted';
      row.updatedAt = Date.now();
      file.entries = file.entries.filter(e => e.id !== row.id);
      appendArchive(handle, [row]);
      writeActive(handle, file);
      return true;
    }),
  );
}

/** Retract every active entry for a handle (the /forget path's medium-tier sweep). */
export async function retractAllForHandle(handle: string): Promise<void> {
  await withHandleLock(handle, async () =>
    durably('retractAllForHandle', () => {
      const file = loadActive(handle);
      const retired: MediumEntry[] = [];
      const now = Date.now();
      for (const row of file.entries) {
        if (row.status === 'active') {
          row.status = 'retracted';
          row.updatedAt = now;
          retired.push(row);
        }
      }
      if (!retired.length) return;
      file.entries = file.entries.filter(e => !retired.includes(e));
      appendArchive(handle, retired);
      writeActive(handle, file);
    }),
  );
}

/** Append an important note (deduped case-insensitively, FIFO-capped like the legacy
 *  ledger). Returns the stored text — including on dedupe, so the caller's confirmation
 *  stands either way. */
export async function addImportantNote(handle: string, note: string, source = 'convo'): Promise<string | null> {
  const clean = note.trim();
  if (!clean) return null;
  return withHandleLock(handle, async () =>
    durably('addImportantNote', () => {
      const file = loadActive(handle);
      const dup = file.entries.find(
        e => e.status === 'active' && e.kind === 'important_note' && e.body.trim().toLowerCase() === clean.toLowerCase(),
      );
      if (dup) return clean;
      const now = Date.now();
      const entry: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: 'important_note', body: clean,
        status: 'active', source, createdAt: now, updatedAt: now,
      };
      file.entries.push(entry);
      const retired: MediumEntry[] = [];
      enforceCap(file, 'important_note', MAX_ACTIVE_NOTES, retired);
      appendArchive(handle, retired);
      writeActive(handle, file);
      return clean;
    }),
  );
}

/** Set a structured fact slot (supersede-then-insert in one rewrite). No-op when the
 *  value is unchanged. */
export async function upsertFact(handle: string, key: string, body: string, source = 'convo'): Promise<void> {
  const clean = body.trim();
  if (!clean) return;
  return withHandleLock(handle, async () =>
    durably('upsertFact', () => {
      const file = loadActive(handle);
      const existing = file.entries.find(e => e.status === 'active' && e.kind === 'fact' && e.key === key);
      if (existing && existing.body === clean) return;
      const now = Date.now();
      const entry: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: 'fact', key, body: clean,
        status: 'active', source, createdAt: now, updatedAt: now,
      };
      const retired: MediumEntry[] = [];
      if (existing) {
        existing.status = 'superseded';
        existing.supersededBy = entry.id;
        existing.updatedAt = now;
        file.entries = file.entries.filter(e => e.id !== existing.id);
        retired.push(existing);
      }
      file.entries.push(entry);
      appendArchive(handle, retired);
      writeActive(handle, file);
    }),
  );
}

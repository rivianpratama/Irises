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
import { withHandleLock, getForgetEpoch } from './memory.js';
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
  /** The ids this entry was synthesized FROM (mergeNotes). The reverse edge of the sources'
   *  supersededBy, so the lineage reads both ways. Optional — only merge targets carry it. */
  mergedFrom?: string[];
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

/** Max chars for a synthesized merge. Notes render VERBATIM into every turn
 *  (renderMediumBlock has no render-time cap) — a merge must shrink the tier, never grow it. */
export const MERGED_NOTE_MAX_CHARS = 600;

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
  // Each id encoded, comma-joined. UUIDs carry no '%' or ',', so the parser's per-value decode
  // round-trips them exactly (see parseSegment).
  if (e.mergedFrom?.length) attrs.push(`merged_from=${e.mergedFrom.map(enc).join(',')}`);
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
  const mergedFromRaw = attrs.get('merged_from');
  // Decoded TWICE (once with every attr above, then once per member): exact for randomUUID() ids,
  // which carry no percent-escape — an id that did would drift on the next rewrite.
  const mergedFrom = mergedFromRaw
    ? mergedFromRaw.split(',').map(decodePart).filter(Boolean)
    : undefined;
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
    ...(mergedFrom?.length ? { mergedFrom } : {}),
  };
}

/** One comma-separated member of a list-valued attribute. A member that won't decode degrades to
 *  its raw text — a mangled lineage pointer must not unseat the whole entry. */
function decodePart(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
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
 *
 * RETURNS the table-copy promise rather than voiding it. durably()'s callback stays synchronous,
 * so every mutator captures this in a closure variable and awaits it once durably returns, still
 * inside the locked section — otherwise the insert lands a microtask AFTER the mutator resolves,
 * and a caller that retires rows and then purges the archive (the /forget path) purges BEFORE the
 * insert it was meant to remove. archiveEntries never rejects, so awaiting it cannot turn a
 * lineage hiccup into a mutator failure.
 *
 * `source` overrides the per-row retireSource() when the CALLER knows why the rows left (a merge
 * looks like a supersede from the row alone).
 */
function appendArchive(handle: string, retired: MediumEntry[], source?: ArchiveSource): Promise<void> {
  if (!retired.length) return Promise.resolve();
  // Table copy FIRST: archiveEntries never throws or rejects (it is the lineage bonus, not the
  // job), so a DB hiccup must not stop the ledger append below.
  const copied = archiveEntries(retired.map(e => {
    const src = source ?? retireSource(e);
    return {
      source: src,
      agentHandle: handle,
      kind: e.kind,
      request: e.key,
      content: e.body,
      meta: {
        mediumId: e.id, status: e.status, source: e.source, supersededBy: e.supersededBy,
        ...(src === 'medium_merged' ? { mergedInto: e.supersededBy } : {}),
      },
      createdAt: e.createdAt,
    };
  }));
  appendText(archivePath(handle), retired.map(e => renderEntry(e) + DELIM).join(''));
  rotateArchiveIfLarge(handle);
  return copied;
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
  return withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
    const entry = durably('addDirective', () => {
      const file = loadActive(handle);
      const dup = file.entries.find(
        e => e.status === 'active' && e.kind === 'directive' && e.body.trim().toLowerCase() === clean.toLowerCase(),
      );
      if (dup) return null;
      const now = Date.now();
      const created: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: 'directive', body: clean,
        status: 'active', source, createdAt: now, updatedAt: now,
      };
      file.entries.push(created);
      const retired: MediumEntry[] = [];
      enforceCap(file, 'directive', MAX_ACTIVE_DIRECTIVES, retired);
      archived = appendArchive(handle, retired);
      writeActive(handle, file);
      return created;
    });
    await archived; // still inside the lock — the lineage insert lands before this call resolves
    return entry;
  });
}

/** Replace the text of an active directive/note by id (supersede + insert, one rewrite).
 *  Returns false when the id wasn't found active. */
export async function updateDirective(handle: string, id: string, text: string, source = 'convo'): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  return withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
    const ok = durably('updateDirective', () => {
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
      archived = appendArchive(handle, [old]);
      writeActive(handle, file);
      return true;
    });
    await archived;
    return ok;
  });
}

/**
 * Fold N near-duplicate active notes into ONE synthesized replacement — updateDirective's
 * supersede-then-insert widened from 1:1 to N sources and one target. Each source retires
 * pointing FORWARD at the replacement (supersededBy); the replacement records the reverse edge
 * (mergedFrom), so the lineage reads in both directions from either end.
 *
 * All-or-nothing, and every rejection is a NULL rather than a throw (only durably's
 * MediumWriteError escapes): the caller is the background groomer (src/memory/noteGroomer.ts),
 * and a groom that can't merge safely must leave the tier byte-identical to how it found it.
 *
 * The /forget epoch fence lives HERE, inside the lock — NOT in the groomer. withHandleLock is not
 * re-entrant, so the groomer must read getForgetEpoch before it calls and pass the value in; it
 * can never take the lock itself to check.
 */
export async function mergeNotes(
  handle: string,
  ids: string[],
  mergedBody: string,
  source = 'groomer',
  opts?: { ifForgetEpoch?: number },
): Promise<MediumEntry | null> {
  const body = mergedBody.trim();
  return withHandleLock(handle, async () => {
    // FIRST, before any read: clearDossier's bump rides this same per-handle queue, so this is
    // the point where "did a /forget land while the model was synthesizing?" has a definite
    // answer. Writing past it would resurrect notes the user just wiped.
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn(`[memory-medium] note merge aborted for ${handle} — /forget landed mid-groom`);
      return null;
    }
    const unique = [...new Set(ids.map(i => i.trim()).filter(Boolean))];
    if (unique.length < 2 || unique.length > MAX_ACTIVE_NOTES) return null;
    // Rejected, never truncated: a clipped synthesis severs a fact mid-sentence, and these notes
    // render verbatim into every turn.
    if (!body || body.length > MERGED_NOTE_MAX_CHARS) return null;

    let archived: Promise<void> = Promise.resolve();
    const merged = durably('mergeNotes', () => {
      const file = loadActive(handle);
      const sources = unique
        .map(id => file.entries.find(e => e.id === id && e.status === 'active' && e.kind === 'important_note'))
        .filter((e): e is MediumEntry => !!e);
      if (sources.length !== unique.length) {
        console.warn(`[memory-medium] note merge skipped for ${handle}: only ${sources.length} of ${unique.length} ids are active notes`);
        return null;
      }
      const now = Date.now();
      const replacement: MediumEntry = {
        id: randomUUID(), agentHandle: handle, kind: 'important_note', body,
        // Fresh timestamps: cap-FIFO treats the merge as the NEWEST note, deliberately — it
        // carries the current version of the fact, so it should outlive its own sources' age.
        status: 'active', source, createdAt: now, updatedAt: now, mergedFrom: unique,
      };
      const mergedAway: MediumEntry[] = [];
      for (const row of sources) {
        row.status = 'superseded';
        row.supersededBy = replacement.id;
        row.updatedAt = now;
        file.entries = file.entries.filter(e => e.id !== row.id);
        mergedAway.push(row);
      }
      file.entries.push(replacement);
      // Kept for uniformity with the other inserts; a merge only ever shrinks the tier, so this
      // cannot actually trip — except on a hand-edited MEDIUM.md already over the cap. Its rows
      // get their OWN array: they aged out, they were not merged, and archiving them as
      // medium_merged would file a cap eviction under a merge with mergedInto pointing at the
      // CAP_EVICTED sentinel. The default retireSource() labels them honestly.
      const capEvicted: MediumEntry[] = [];
      enforceCap(file, 'important_note', MAX_ACTIVE_NOTES, capEvicted);
      archived = Promise.all([
        appendArchive(handle, mergedAway, 'medium_merged'),
        appendArchive(handle, capEvicted),
      ]).then(() => undefined);
      writeActive(handle, file);
      return replacement;
    });
    await archived;
    return merged;
  });
}

/** Soft-remove an active entry by id (user asked to drop a preference/note). */
export async function retractEntry(handle: string, id: string): Promise<boolean> {
  return withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
    const ok = durably('retire:retracted', () => {
      const file = loadActive(handle);
      const row = file.entries.find(e => e.id === id && e.status === 'active');
      if (!row) return false;
      row.status = 'retracted';
      row.updatedAt = Date.now();
      file.entries = file.entries.filter(e => e.id !== row.id);
      archived = appendArchive(handle, [row]);
      writeActive(handle, file);
      return true;
    });
    await archived;
    return ok;
  });
}

/** Retract every active entry for a handle (the /forget path's medium-tier sweep). */
export async function retractAllForHandle(handle: string): Promise<void> {
  await withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
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
      archived = appendArchive(handle, retired);
      writeActive(handle, file);
    });
    // Load-bearing for /forget: the caller purges the archive right after this resolves, and an
    // un-awaited insert would land after that purge (see convo/client.ts).
    await archived;
  });
}

/** Append an important note (deduped case-insensitively, FIFO-capped like the legacy
 *  ledger). Returns the stored text — including on dedupe, so the caller's confirmation
 *  stands either way. */
export async function addImportantNote(handle: string, note: string, source = 'convo'): Promise<string | null> {
  const clean = note.trim();
  if (!clean) return null;
  return withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
    const stored = durably('addImportantNote', () => {
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
      archived = appendArchive(handle, retired);
      writeActive(handle, file);
      return clean;
    });
    await archived;
    return stored;
  });
}

/** Set a structured fact slot (supersede-then-insert in one rewrite). No-op when the
 *  value is unchanged. */
export async function upsertFact(handle: string, key: string, body: string, source = 'convo'): Promise<void> {
  const clean = body.trim();
  if (!clean) return;
  return withHandleLock(handle, async () => {
    let archived: Promise<void> = Promise.resolve();
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
      archived = appendArchive(handle, retired);
      writeActive(handle, file);
    });
    await archived;
  });
}

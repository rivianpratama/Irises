// SELF.md: what she holds about HERSELF with one person — the sides she took, what she likes and
// hates, what she learned from them, where she changed her mind (memory/selfHarvest.ts writes it).
//
// Every other store under memories/<handle>/ is about THEM. This one is the exception on purpose:
// without it her stances live only in the transcript window, so a take she argued for on Monday is
// gone by Thursday and she can hold the opposite one with a straight face. The persona block is the
// constitution and stays static; this file is the diary that lets her be the same person twice.
//
// One entry per line, the annotation riding at the end of the same line:
//   stance: pineapple belongs on pizza, sweet and salt is the point <!-- se id=a1b2c3 at=2026-09-25T… -->
// A line that does not parse (a hand edit, a mangled annotation) is PRESERVED verbatim and never
// rendered, the moments store's rule, so a human can edit the file without the next pass eating it.
// Reads degrade to empty and FLAG it (`degraded`), because every write is whole-file and a writer
// that mistook "unreadable" for "empty" would replace her whole self with one night's harvest.

import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';
import { withHandleLock, getForgetEpoch } from './memory.js';

export const SELF_KINDS = ['stance', 'taste', 'learned', 'changed'] as const;
export type SelfKind = typeof SELF_KINDS[number];

export interface SelfEntry {
  id: string;
  kind: SelfKind;
  text: string;
  at: number;
}

export interface SelfFile {
  entries: SelfEntry[];
  lastHarvestAt: number;
  preserved: string[];
  degraded: boolean;
}

const HEADER_PREFIX = '<!-- irises:self';
const LAST_HARVEST_RE = /\blast_harvest_at=(\S*)/;
const ENTRY_RE = /^(stance|taste|learned|changed): (.+?) <!-- se id=(\S+) at=(\S+) -->$/;
const NEVER = 'never';

function selfPath(handle: string): string {
  return path.join(memoriesDir(handle), 'SELF.md');
}

function parseStamp(raw: string | undefined): number {
  const t = Date.parse((raw ?? '').trim());
  return Number.isNaN(t) ? 0 : t;
}

export function selfHeader(lastHarvestAt: number): string {
  const stamp = lastHarvestAt > 0 ? new Date(lastHarvestAt).toISOString() : NEVER;
  return `<!-- irises:self format=1 last_harvest_at=${stamp} · machine-managed by src/db/repositories/self.ts; one entry per line; the trailing se annotation is load-bearing -->`;
}

function renderEntry(e: SelfEntry): string {
  return `${e.kind}: ${e.text} <!-- se id=${encodeURIComponent(e.id)} at=${new Date(e.at).toISOString()} -->`;
}

function parseLine(line: string): SelfEntry | null {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  const at = Date.parse(m[4]);
  if (Number.isNaN(at)) return null;
  let id: string;
  try { id = decodeURIComponent(m[3]); } catch { return null; }
  return { id, kind: m[1] as SelfKind, text: m[2], at };
}

/** Read SELF.md. Missing is empty and healthy; unreadable is empty and `degraded`. */
export async function readSelf(handle: string): Promise<SelfFile> {
  try {
    const raw = readTextIfExists(selfPath(handle));
    if (raw === null) return { entries: [], lastHarvestAt: 0, preserved: [], degraded: false };
    const lines = raw.split('\n');
    let lastHarvestAt = 0;
    if (lines[0]?.startsWith(HEADER_PREFIX)) {
      lastHarvestAt = parseStamp(lines[0].match(LAST_HARVEST_RE)?.[1]);
      lines.shift();
    }
    const entries: SelfEntry[] = [];
    const preserved: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry) entries.push(entry);
      else preserved.push(line);
    }
    return { entries, lastHarvestAt, preserved, degraded: false };
  } catch (error) {
    logDbError('readSelf', error);
    return { entries: [], lastHarvestAt: 0, preserved: [], degraded: true };
  }
}

/**
 * Rewrite SELF.md whole. `preserved` is required for the moments store's reason: a caller that
 * forgot it would silently delete a human's hand edits. `ifForgetEpoch` refuses a save that raced a
 * /forget. Returns whether the file was written, so a pass never stamps a harvest it did not save.
 */
export async function writeSelf(
  handle: string,
  entries: readonly SelfEntry[],
  lastHarvestAt: number,
  preserved: readonly string[],
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  return withHandleLock(handle, async () => {
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn('[self] write aborted: /forget landed mid-pass');
      return false;
    }
    const body = [...preserved, ...entries.map(renderEntry)];
    try {
      atomicWriteText(selfPath(handle), `${[selfHeader(lastHarvestAt), ...body].join('\n')}\n`);
      return true;
    } catch (error) {
      logDbError('writeSelf', error);
      return false;
    }
  });
}

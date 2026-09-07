// The MOMENTS store: memories/<handle>/MOMENTS.md, one file per person, holding the episodes the
// nightly pass wrote down and the counters the sampler bills.
//
//   memories/<handle>/MOMENTS.md — ACTIVE moments only, §-delimited (Hermes style), each carrying a
//                                  trailing <!-- mo … --> annotation (OpenClaw style) with
//                                  id/tag/at and the three counters. NO archive file. Ever.
//
// A FORK of the medium tier's grammar, not a reuse of it. memoryMedium.ts's parser and renderer are
// module-private and validate `kind` against a closed set that has nothing to do with moment tags,
// and its whole ledger discipline is the OPPOSITE of this store's: the medium tier supersedes and
// archives because a retracted directive's lineage is evidence, while a decayed moment must leave
// no trace anywhere (see persona/moments.ts's header — a roast diary that resurfaced through
// `recall_memory` months later is the worst failure this feature can have). Two files that share a
// grammar and disagree about deletion are better than one file that tries to do both. What IS
// shared is real: the §-delimiter, the trailing-annotation shape, per-value percent-encoding, and
// the hand-edit rule — a segment without a valid annotation is preserved verbatim at the top of
// every rewrite and warned about once, never silently discarded.
//
// The file header comment carries `last_harvest_at`. It lives in the FILE rather than in a prefs
// key because it is the nightly pass's own cooldown and window ratchet, and a cooldown that can
// disagree with the file it guards would let one bad night either re-harvest the same window
// forever or skip a week of texts. One artifact, one clock.
//
// Failure policy, and it differs from every other tier here on purpose: READS DEGRADE TO EMPTY.
// memoryMedium.ts throws on an unreadable-but-present file, because clobbering a directive the user
// dictated is unacceptable. Moments are not that: they are re-derivable (the next pass reads the
// same transcript), they are deleted rather than archived by design, and they render into a prompt
// on the reply path where a throw would cost a turn. So an unreadable file degrades to empty here,
// and a later write starts a fresh one. Losing a diary is a cost; losing a reply is a bug.
// The degrade is FLAGGED, not silent (`MomentsFile.degraded`): a reader may ignore an unreadable
// file, but a writer must not mistake one for an empty file and rewrite it from nothing.
//
// Writes are atomic (db/files.ts), serialized on the shared per-handle queue, and carry the /forget
// fence: the nightly pass reads → thinks for fifteen seconds → writes, and a /forget that lands
// inside that window must not have its wipe undone by a save that read the pre-forget file.

import path from 'node:path';
import { logDbError } from '../client.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';
import { withHandleLock, getForgetEpoch } from './memory.js';
import { MOMENT_TAGS, type MomentEntry, type MomentTag } from '../../persona/moments.js';

/** What one read of the file yields. `lastHarvestAt` is `0` for "never harvested" — the nightly
 *  pass reads that as an open window rather than as a cooldown that already expired. */
export interface MomentsFile {
  entries: MomentEntry[];
  lastHarvestAt: number;
  /** Unannotated segments (hand edits, mangled annotations) — re-emitted verbatim on rewrite. */
  preserved: string[];
  /**
   * The read FAILED and this shape is a fallback, not the file. `false` for a genuinely absent file
   * and for every successful parse; `true` only when something was there and could not be read.
   *
   * The reply path may ignore this — an empty read is exactly what it wants, and a turn must not die
   * over a diary. A WRITER may not. Every write here is whole-file, so a pass that read a degraded
   * file and then saved would replace every moment AND every hand-edited segment with whatever it
   * happened to be holding, permanently, in the one tier that archives nothing (db/files.ts's
   * `readTextIfExists` names this hazard in its own doc comment). A pass that sees `degraded` must
   * SKIP WITHOUT STAMPING the harvest clock, exactly as the failure-backoff rule does, and try again
   * on the next tick.
   */
  degraded: boolean;
}

const DELIM = '\n§\n';
const HEADER_PREFIX = '<!-- irises:moments';
const ANNOTATION_RE = /^<!-- mo (.+) -->$/;
const LAST_HARVEST_RE = /\blast_harvest_at=(\S*)/;
/** The stamp written when there is no harvest yet. A word rather than an empty value, so a human
 *  reading the header learns the state instead of wondering whether the attribute is broken. */
const NEVER = 'never';
const TAGS: ReadonlySet<string> = new Set<string>(MOMENT_TAGS);

const enc = encodeURIComponent;

function momentsPath(handle: string): string {
  return path.join(memoriesDir(handle), 'MOMENTS.md');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A stamp attribute → epoch ms. `never`, a blank, or anything unparseable is 0 — "no stamp" is the
 *  safe direction for every clock in this feature (an open harvest window, a moment that has never
 *  been offered), and a NaN written back into the file would poison the next read too. */
function parseStamp(raw: string | undefined): number {
  const t = Date.parse((raw ?? '').trim());
  return Number.isNaN(t) ? 0 : t;
}

/** A counter attribute → a non-negative integer. A hand-edited negative count would make the
 *  sampler's weights and the fold's arithmetic quietly wrong rather than loudly broken. */
function parseCount(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : dflt;
}

/** The header line, carrying the harvest clock and saying what the file is. Written on EVERY
 *  rewrite, so the stamp and the entries can never come apart. */
export function momentsHeader(lastHarvestAt: number): string {
  const stamp = lastHarvestAt > 0 ? iso(lastHarvestAt) : NEVER;
  return `<!-- irises:moments format=1 last_harvest_at=${stamp} — machine-managed by src/db/repositories/moments.ts; entries are §-delimited; the trailing mo annotation on each entry is load-bearing; a decayed moment is DELETED, never archived -->`;
}

/** One entry: her text, then the annotation on its OWN last line. The text is written verbatim —
 *  a moment is one collapsed line by the time it gets here (persona/moments.ts collapses whitespace
 *  in the fold, which is what keeps a model-authored newline out of a line-oriented grammar), and a
 *  store that re-edited her prose on every rewrite would be a store nobody could hand-edit. */
function renderEntry(e: MomentEntry): string {
  const attrs = [
    `id=${enc(e.id)}`,
    `tag=${e.tag}`,
    `at=${iso(e.at)}`,
    `count=${Math.max(1, Math.trunc(e.count))}`,
    `offered=${Math.max(0, Math.trunc(e.offered))}`,
    `last_offered=${e.lastOfferedAt > 0 ? iso(e.lastOfferedAt) : NEVER}`,
  ];
  return `${e.text}\n<!-- mo ${attrs.join(' ')} -->`;
}

/**
 * Parse one §-delimited segment. Null = not a valid moment, and the segment is preserved verbatim
 * instead. Only THREE attributes can fail an entry — id, tag and at — because those three are its
 * identity, its vocabulary and its clock, and no safe default exists for any of them. Every counter
 * degrades: a mangled `offered` costs a spacing decision, and dropping the whole moment over it
 * would lose her writing to protect an integer.
 */
function parseSegment(segment: string): MomentEntry | null {
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
  const tag = attrs.get('tag');
  const at = Date.parse(attrs.get('at') ?? '');
  if (!id || !tag || !TAGS.has(tag) || Number.isNaN(at)) return null;
  return {
    id,
    text: lines.slice(0, -1).join('\n'),
    tag: tag as MomentTag,
    at,
    count: parseCount(attrs.get('count'), 1),
    offered: parseCount(attrs.get('offered'), 0),
    lastOfferedAt: parseStamp(attrs.get('last_offered')),
  };
}

const warnedPreserved = new Set<string>();

/**
 * Read MOMENTS.md. Degrades to an empty file on ANY failure (missing, unreadable, half-written by a
 * hand edit) — see the header for why this tier degrades where the medium tier throws. The read is
 * lock-free: writes are whole-file and atomic, so a reader either sees the old file or the new one.
 *
 * A degraded read is FLAGGED rather than silent (`degraded`), because the two callers want opposite
 * things from it: the reply path wants an empty sample and a turn that survives, and a writer must
 * not treat "unreadable" as "empty" and rewrite the file from nothing. See `MomentsFile.degraded`.
 */
export async function readMoments(handle: string): Promise<MomentsFile> {
  try {
    const raw = readTextIfExists(momentsPath(handle));
    if (raw === null) return { entries: [], lastHarvestAt: 0, preserved: [], degraded: false };
    let content = raw;
    let lastHarvestAt = 0;
    if (content.startsWith(HEADER_PREFIX)) {
      const nl = content.indexOf('\n');
      const header = nl === -1 ? content : content.slice(0, nl);
      lastHarvestAt = parseStamp(header.match(LAST_HARVEST_RE)?.[1]);
      content = nl === -1 ? '' : content.slice(nl + 1);
    }
    content = content.replace(/\n$/, '');
    const entries: MomentEntry[] = [];
    const preserved: string[] = [];
    if (content.trim() !== '') {
      for (const segment of content.split(DELIM)) {
        if (segment.trim() === '') continue;
        const entry = parseSegment(segment);
        if (entry) entries.push(entry);
        else preserved.push(segment);
      }
    }
    if (preserved.length && !warnedPreserved.has(handle)) {
      warnedPreserved.add(handle);
      console.warn(`[moments] ${preserved.length} unannotated segment(s) in ${momentsPath(handle)} — preserved verbatim, not rendered`);
    }
    return { entries, lastHarvestAt, preserved, degraded: false };
  } catch (error) {
    logDbError('readMoments', error);
    return { entries: [], lastHarvestAt: 0, preserved: [], degraded: true };
  }
}

/**
 * Rewrite MOMENTS.md whole: header, preserved hand edits, then the entries in the order given. The
 * caller owns the list — folding, pruning and billing all happen in persona/moments.ts and arrive
 * here as one finished array, which is what keeps this file a store rather than a second engine.
 *
 * `preserved` is REQUIRED and has no default, deliberately: every rewrite is whole-file, so a
 * caller that forgot it would delete a human's hand edits silently and with no type error. Pass the
 * array `readMoments` handed back — `[]` only when the caller genuinely means "there were none".
 *
 * `opts.ifForgetEpoch` is the epoch the CALLER read before it started working: when it no longer
 * matches, a /forget landed mid-pass and this write would put back moments the user asked to be
 * forgotten, so the save is refused. Returns whether the file was written — a fenced-out or failed
 * write must never be reported upstream as applied, because the pass would then stamp a harvest
 * clock for a harvest that is not on disk.
 */
export async function writeMoments(
  handle: string,
  entries: readonly MomentEntry[],
  lastHarvestAt: number,
  preserved: readonly string[],
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  return withHandleLock(handle, async () => {
    // Re-read the epoch INSIDE the lock: clearDossier's bump happens under the same queue, so this
    // is the point where "did a forget land while the pass was thinking?" has a definite answer.
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn('[moments] write aborted — /forget landed mid-pass');
      return false;
    }
    const parts = [...preserved, ...entries.map(renderEntry)];
    const header = momentsHeader(lastHarvestAt);
    try {
      atomicWriteText(momentsPath(handle), parts.length ? `${header}\n${parts.join(DELIM)}\n` : `${header}\n`);
      return true;
    } catch (error) {
      logDbError('writeMoments', error);
      return false;
    }
  });
}

/**
 * The /forget wipe: an empty file with a fresh header, hand edits included. Nothing is archived,
 * which is the whole reason this tier exists as its own store — there is no lineage row to sequence
 * a purge against and nothing left for `recall_memory` to find.
 *
 * The fresh header stamps `last_harvest_at` at the wipe rather than resetting it to `never`, so the
 * next nightly window starts HERE. A reset would hand the first pass after a /forget the entire
 * transcript that the user just asked to be forgotten, and it would re-mint the same moments before
 * morning. `now` is injected for the same reason it is everywhere else in this feature.
 */
export async function clearMoments(handle: string, now: number = Date.now()): Promise<void> {
  await withHandleLock(handle, async () => {
    try {
      atomicWriteText(momentsPath(handle), `${momentsHeader(now)}\n`);
    } catch (error) {
      logDbError('clearMoments', error);
    }
  });
}

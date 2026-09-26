// The persisted familiarity row: how well she knows ONE memory identity, as the stored level and the
// two lived-exchange counters (persona/familiarity.ts owns what they mean).
//
// Keyed by the MEMORY handle, like the climate row beside it. A room's pseudo-handle could key a row
// too, and nothing writes one: the pass skips a room, and the turn reads a room as a stranger without
// asking this table.
//
// Read doctrine is relationshipClimate.ts's: reads DEGRADE, never throw. A missing row or a failed
// read is `null` (a stranger to every caller), and a row with a field that will not parse keeps its
// other fields: a rotted day stamp costs the day guard one extra day, never the earned level.
//
// Writes carry the /forget fence: the pass reads the stores and then saves, and a /forget that lands
// between the two must not have its wipe undone by a level computed from what it wiped.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';
import { FAMILIARITY_START, clampLevel, type FamiliarityCounters } from '../../persona/familiarity.js';

/** The row as read: the stored level, the counters, and when it was last written (epoch ms). */
export interface FamiliarityRow extends FamiliarityCounters {
  level: number;
  updatedAt: number;
}

type Row = {
  handle: string;
  level: unknown;
  turns: unknown;
  active_days: unknown;
  last_day: unknown;
  updated_at: unknown;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A stored counter: a finite non-negative integer, or zero. */
function counter(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** A stored day stamp: `YYYY-MM-DD`, or '' (which the tick reads as "no day counted yet"). */
function dayStamp(v: unknown): string {
  return typeof v === 'string' && DAY_RE.test(v) ? v : '';
}

/** The stored row for a handle, or null for no row or a failed read. Never throws: this sits on the
 *  reply path, where a failed read must cost the mask and nothing else. */
export async function getFamiliarity(handle: string): Promise<FamiliarityRow | null> {
  try {
    const r = stmt(
      'SELECT handle, level, turns, active_days, last_day, updated_at FROM familiarity WHERE handle = ?'
    ).get(handle) as Row | undefined;
    if (!r) return null;
    return {
      level: typeof r.level === 'number' ? clampLevel(r.level) : FAMILIARITY_START,
      turns: counter(r.turns),
      activeDays: counter(r.active_days),
      lastDay: dayStamp(r.last_day),
      updatedAt: counter(r.updated_at),
    };
  } catch (error) {
    logDbError('getFamiliarity', error);
    return null;
  }
}

/**
 * Upsert the whole row. `opts.ifForgetEpoch` is the epoch the CALLER read before it started: when it
 * no longer matches, a /forget landed mid-pass and the save is refused. Returns whether it was
 * written, so the caller never reports a band change that is not on disk.
 */
export async function saveFamiliarity(
  handle: string,
  next: Omit<FamiliarityRow, 'updatedAt'>,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
    console.warn('[memory] familiarity save aborted: /forget landed mid-pass');
    return false;
  }
  try {
    stmt(
      `INSERT INTO familiarity (handle, level, turns, active_days, last_day, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         level = excluded.level,
         turns = excluded.turns,
         active_days = excluded.active_days,
         last_day = excluded.last_day,
         updated_at = excluded.updated_at`
    ).run(
      handle,
      clampLevel(next.level),
      counter(next.turns),
      counter(next.activeDays),
      dayStamp(next.lastDay),
      Date.now(),
    );
    return true;
  } catch (error) {
    logDbError('saveFamiliarity', error);
    return false;
  }
}

/** Drop the row, so the next read is a stranger again. The /forget and test seam. */
export async function clearFamiliarity(handle: string): Promise<void> {
  try {
    stmt('DELETE FROM familiarity WHERE handle = ?').run(handle);
  } catch (error) {
    logDbError('clearFamiliarity', error);
  }
}

// The persisted relationship climate: the weeks-scale standing register for ONE memory identity.
//
// Keyed by the MEMORY handle, not chat_id. affect_state's chat keying is the historical outlier —
// mood is felt per conversation, but the register you've settled into is a property of the person
// (and of a group's shared identity), so it follows the same key every other memory tier uses.
//
// Read doctrine is affectState.ts's: reads DEGRADE, never throw. A missing row, a corrupt dials
// blob, an unreadable ledger — each falls back to the safest thing that still lets the turn
// proceed, which is the DEFAULT register (the one that renders nothing at all). The dials and the
// ledger degrade INDEPENDENTLY: a mangled moves_json costs the rolling-window budget's history, not
// the earned register itself, so the dials survive with an empty ledger.
//
// Writes carry the /forget fence (getForgetEpoch, see memory.ts): the drift eval is a long
// read→LLM→write, and a /forget that lands inside that window must not have its wipe undone by a
// save that read the pre-forget climate.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';
import {
  defaultClimate, coerceDials, CLIMATE_MOVES_CAP,
  type ClimateMove, type DialKey, type RelationshipClimate,
} from '../../persona/climate.js';

type Row = {
  handle: string;
  dials_json: string;
  moves_json: string;
  last_eval_at: number;
  eval_count: number;
  updated_at: number;
};

const VALID_KEYS: ReadonlySet<string> = new Set<DialKey>(['ease', 'candor', 'playfulness']);

/** The feature gate (env: RELATIONSHIP_CLIMATE_ENABLED). Default ON, read at CALL time so flipping
 *  it needs no restart — the same parse shape as the sibling memory flags (semanticRecallEnabled,
 *  recallExpansionEnabled, noteGroomEnabled).
 *
 *  It gates BOTH ends, and it has to. Off at the EVAL (climateDrift.ts) stops the daily classify
 *  call; off at the READS (agents/convo/client.ts, agents/composerCore.ts, which fall back to
 *  defaultClimate()) is what actually turns the feature off in her voice — otherwise an already
 *  drifted register would stay frozen in every prompt, still colouring the reply, with nothing left
 *  running to move it back. Nothing is deleted: the row survives, so flipping the flag on again
 *  restores exactly the register that was earned. */
export function relationshipClimateEnabled(): boolean {
  const v = (process.env.RELATIONSHIP_CLIMATE_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Stored ledger → moves. Row-by-row: one malformed entry is dropped, not the whole ledger.
 *  Anything that isn't an array at all yields [] (an empty budget history, never a throw). */
function coerceMoves(raw: unknown): ClimateMove[] {
  if (!Array.isArray(raw)) return [];
  const out: ClimateMove[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const m = item as { at?: unknown; k?: unknown; d?: unknown };
    if (typeof m.at !== 'number' || !Number.isFinite(m.at)) continue;
    if (typeof m.k !== 'string' || !VALID_KEYS.has(m.k)) continue;
    if (typeof m.d !== 'number' || !Number.isFinite(m.d) || m.d === 0) continue;
    out.push({ at: m.at, k: m.k as DialKey, d: Math.trunc(m.d) });
  }
  return out.length > CLIMATE_MOVES_CAP ? out.slice(out.length - CLIMATE_MOVES_CAP) : out;
}

function intOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt;
}

/** The stored climate for a handle — DEFAULTS for an unknown handle, a corrupt row, or a read
 *  error. Never throws: this sits on the reply path, where a climate read failing must cost the
 *  register and nothing else. */
export async function getRelationshipClimate(handle: string): Promise<RelationshipClimate> {
  const fallback = defaultClimate();
  try {
    const r = stmt(
      'SELECT handle, dials_json, moves_json, last_eval_at, eval_count, updated_at FROM relationship_climate WHERE handle = ?'
    ).get(handle) as Row | undefined;
    if (!r) return fallback;

    // Independent parses: a mangled ledger must not cost the earned dials, and vice versa.
    let dialsRaw: unknown;
    try { dialsRaw = JSON.parse(r.dials_json); } catch { dialsRaw = null; }
    let movesRaw: unknown;
    try { movesRaw = JSON.parse(r.moves_json); } catch { movesRaw = null; }

    return {
      dials: coerceDials(dialsRaw),
      moves: coerceMoves(movesRaw),
      lastEvalAt: Math.max(0, intOr(r.last_eval_at, 0)),
      evalCount: Math.max(0, intOr(r.eval_count, 0)),
    };
  } catch (error) {
    logDbError('getRelationshipClimate', error);
    return fallback;
  }
}

/**
 * Upsert the whole climate. `opts.ifForgetEpoch` is the epoch the CALLER read before it started
 * evaluating: when it no longer matches, a /forget landed mid-eval and this write would resurrect
 * a register the user asked to be forgotten, so the save is refused. Returns whether it was written.
 */
export async function saveRelationshipClimate(
  handle: string,
  next: RelationshipClimate,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
    console.warn('[memory] climate save aborted — /forget landed mid-eval');
    return false;
  }
  try {
    stmt(
      `INSERT INTO relationship_climate (handle, dials_json, moves_json, last_eval_at, eval_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         dials_json = excluded.dials_json,
         moves_json = excluded.moves_json,
         last_eval_at = excluded.last_eval_at,
         eval_count = excluded.eval_count,
         updated_at = excluded.updated_at`
    ).run(
      handle,
      JSON.stringify(coerceDials(next.dials)),
      JSON.stringify(coerceMoves(next.moves)),
      Math.max(0, intOr(next.lastEvalAt, 0)),
      Math.max(0, intOr(next.evalCount, 0)),
      Date.now(),
    );
    return true;
  } catch (error) {
    logDbError('saveRelationshipClimate', error);
    return false;
  }
}

/** Drop the row, so the next read returns defaults. The /forget and test seam. */
export async function clearRelationshipClimate(handle: string): Promise<void> {
  try {
    stmt('DELETE FROM relationship_climate WHERE handle = ?').run(handle);
  } catch (error) {
    logDbError('clearRelationshipClimate', error);
  }
}

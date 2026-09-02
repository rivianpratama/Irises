// The persisted thread inventory: the themes and open loops held for ONE memory identity.
//
// Keyed by the MEMORY handle, exactly like relationship_climate beside it. What a person keeps
// circling back to, and what they left hanging, are properties of the PERSON — not of a chat
// window — so this follows the same key every memory tier uses, and a group's shared identity gets
// its own row for free. (affect_state's chat keying is the historical outlier; not copied here.)
//
// Read doctrine is relationshipClimate.ts's, which is affectState.ts's: reads DEGRADE, never throw.
// A missing row, a mangled blob, an entry hand-edited into nonsense — each falls back to the safest
// thing that still lets the turn proceed, which is the DEFAULT inventory (the one that renders
// nothing at all). This sits on the reply path: a read failing here must cost a callback and
// nothing else.
//
// The four json columns degrade INDEPENDENTLY, and that independence is the point. Themes are
// months of slowly earned evidence; loops are days of pending questions; the offer ledger is a
// rolling week of budget history; the pending slot is one turn wide. They rot at completely
// different rates and are worth completely different amounts, so a mangled loops_json costs loops,
// not themes, and a rotted offers_json costs a week of budget history rather than a season of
// patterns.
//
// Writes carry the /forget fence (getForgetEpoch, see memory.ts): a harvest is a read-modify-write
// around an in-flight turn, and a /forget that lands inside that window must not have its wipe
// undone by a save that read the pre-forget inventory.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';
import {
  defaultThreadInventory, THEME_KINDS,
  type LoopStatus, type OpenLoop, type PendingOffer, type ThemeKind, type ThemeStatus,
  type ThreadInventory, type ThreadMaterial, type ThreadOffer, type ThreadOutcome,
  type ThreadTheme,
} from '../../persona/threads.js';

type Row = {
  handle: string;
  themes_json: string;
  loops_json: string;
  offers_json: string;
  pending_json: string;
  turns_since_offer: number;
  last_harvest_at: number;
  harvest_count: number;
  last_ping_at: number;
  updated_at: number;
};

// The unions, as runtime sets. Held here rather than exported from persona/threads.ts for the same
// reason relationshipClimate.ts holds its own VALID_KEYS: validating stored data is the STORE's
// job, and the type module stays a pure description of the shape.
//
// The ONE exception is THEME_KINDS, which the engine's note grammar builds its `value|tension|goal|
// phrase` prefix alternation out of. Two copies of that list would let a sixth kind be a kind the
// model may emit and the store may accept while the grammar silently routed it to `pattern`, so it
// is imported from where the type is declared rather than re-typed here.
const THEME_KIND_SET: ReadonlySet<string> = new Set<string>(THEME_KINDS);
const THEME_STATUSES: ReadonlySet<string> = new Set<ThemeStatus>(['open', 'taggable', 'shorthand', 'sore', 'retired']);
const LOOP_STATUSES: ReadonlySet<string> = new Set<LoopStatus>(['open', 'asked', 'resolved', 'expired']);
const MATERIALS: ReadonlySet<string> = new Set<ThreadMaterial>(['loop', 'theme']);
const PENDING_PHASES: ReadonlySet<string> = new Set<PendingOffer['phase']>(['offered', 'awaiting']);
const OUTCOMES: ReadonlySet<string> = new Set<ThreadOutcome>(['took', 'passed', 'pushed_back']);

/** The feature gate (env: CONVO_THREADING_ENABLED). Default ON, read at CALL time so flipping it
 *  needs no restart — the same parse shape as every sibling memory flag (relationshipClimateEnabled,
 *  semanticRecallEnabled, recallExpansionEnabled, noteGroomEnabled).
 *
 *  It gates BOTH ends, and it has to. Off at the HARVEST (memory/threadHarvest.ts) stops anything
 *  new being written; off at the PRE-TURN READ is what actually turns the feature off in her voice,
 *  because that read falling back to nothing is what makes the prompt byte-identical to no feature
 *  at all — otherwise an already-earned theme would keep being offered every few turns with nothing
 *  left running to age it, resolve it, or retire it. Nothing is deleted: the row survives, so
 *  flipping the flag back on restores exactly the inventory that was earned. */
export function threadingEnabled(): boolean {
  const v = (process.env.CONVO_THREADING_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The theme TOPIC GATE (env: CONVO_THEME_TOPIC_GATE). Default ON, read at call time, the same parse
 *  shape as its sibling above — and subordinate to it, since it only means anything while threading
 *  is on at all.
 *
 *  A narrower switch inside the feature: threading keeps running and keeps earning themes, but the
 *  theme stage stops requiring a candidate to touch the message in hand (persona/threads.ts's
 *  `selectThreadCandidate`, which takes this as an injected boolean rather than reading env — it is
 *  a pure module, and it is the module THIS file imports its types from). Off is byte-identical to
 *  the engine before the gate existed, down to the `off_topic` bucket staying 0. Loops are not
 *  affected either way: their own present-topic check points the opposite direction and predates
 *  this flag. */
export function themeTopicGateEnabled(): boolean {
  const v = (process.env.CONVO_THEME_TOPIC_GATE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

function intOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt;
}

/** A stored epoch-ms/day stamp → a non-negative integer. Anything unreadable becomes 0, which every
 *  clock in the engine reads as "never" — the safe direction for a stamp, since "never offered"
 *  only ever makes something MORE eligible for the plain, cheap question. */
function stampOr(v: unknown, dflt = 0): number {
  return Math.max(0, intOr(v, dflt));
}

/** Counters can only be non-negative. A negative `passes` hand-edited into a row would let a loop
 *  that was waved off twice come back for a third ask. */
function countOr(v: unknown, dflt = 0): number {
  return Math.max(0, intOr(v, dflt));
}

/** Confidence is CLAMPED, never rejected: a value that drifted outside 0-100 in some earlier shape
 *  should come back INSIDE the range keeping the direction it had earned, exactly as coerceDials
 *  treats a stray dial. */
function clampConfidence(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Stored JSON → themes. Row-by-row: ONE malformed theme is dropped, not the whole inventory — a
 *  single rotted entry must not cost a person a season of earned patterns. An entry is dropped only
 *  when it has lost its IDENTITY (no id, no label, an unknown kind or status): everything else is
 *  coerced back into range, because a theme with a garbled counter is still the right theme. */
function coerceThemes(raw: unknown): ThreadTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadTheme[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const id = str(t.id).trim();
    const label = str(t.label).trim();
    if (!id || !label) continue;
    // A duplicated id would let the engine's own "find it and update it" read one row and its
    // caps evict the other — two lives for one theme.
    if (seen.has(id)) continue;
    if (typeof t.kind !== 'string' || !THEME_KIND_SET.has(t.kind)) continue;
    if (typeof t.status !== 'string' || !THEME_STATUSES.has(t.status)) continue;
    seen.add(id);
    const days = Array.isArray(t.evidenceDays)
      ? t.evidenceDays.filter((d): d is number => typeof d === 'number' && Number.isFinite(d)).map(d => Math.trunc(d))
      : [];
    out.push({
      id,
      label,
      kind: t.kind as ThemeKind,
      note: str(t.note),
      evidenceDays: days,
      // Never below the number of distinct days actually on file: the second-mention rule reads the
      // days, and a count that disagreed with them would be the one number a reader trusts wrongly.
      evidenceCount: Math.max(countOr(t.evidenceCount, days.length), days.length),
      status: t.status as ThemeStatus,
      confidence: clampConfidence(t.confidence),
      firstSeenAt: stampOr(t.firstSeenAt),
      lastSeenAt: stampOr(t.lastSeenAt),
      lastOfferedAt: stampOr(t.lastOfferedAt),
      lastTaggedAt: stampOr(t.lastTaggedAt),
      lastOutcome: typeof t.lastOutcome === 'string' && OUTCOMES.has(t.lastOutcome)
        ? t.lastOutcome as ThreadOutcome
        : null,
      soreAt: stampOr(t.soreAt),
      uptakes: countOr(t.uptakes),
      passes: countOr(t.passes),
      pushbacks: countOr(t.pushbacks),
      mintedDistressed: t.mintedDistressed === true,
    });
  }
  return out;
}

/** Stored JSON → loops. Same row-by-row tolerance as themes; a loop without an id, a label, or a
 *  known status is not a question anyone could ask, so it goes. */
function coerceLoops(raw: unknown): OpenLoop[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenLoop[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const l = item as Record<string, unknown>;
    const id = str(l.id).trim();
    const label = str(l.label).trim();
    if (!id || !label || seen.has(id)) continue;
    if (typeof l.status !== 'string' || !LOOP_STATUSES.has(l.status)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      note: str(l.note),
      status: l.status as LoopStatus,
      capturedAt: stampOr(l.capturedAt),
      lastSeenAt: stampOr(l.lastSeenAt),
      offeredAt: stampOr(l.offeredAt),
      askedAt: stampOr(l.askedAt),
      resolvedAt: stampOr(l.resolvedAt),
      passes: countOr(l.passes),
    });
  }
  return out;
}

/** Stored JSON → the offer ledger. Kept only to enforce the rolling day caps, so an entry missing
 *  its timestamp or its material is worthless: it can neither be aged out nor billed to the right
 *  budget, and keeping it would silently shrink whichever cap it landed in. */
function coerceOffers(raw: unknown): ThreadOffer[] {
  if (!Array.isArray(raw)) return [];
  const out: ThreadOffer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) continue;
    const themeId = str(o.themeId).trim();
    if (!themeId) continue;
    if (typeof o.material !== 'string' || !MATERIALS.has(o.material)) continue;
    out.push({ at: Math.trunc(o.at), themeId, material: o.material as ThreadMaterial });
  }
  return out;
}

/** Stored JSON → the one in-flight offer, or null. Nothing is salvaged from a half-readable pending
 *  slot: this is the record of a promise made to the model on the PREVIOUS turn, and a pending
 *  offer with a guessed phase would either consume an outcome that was never asked for or swallow
 *  one that was. Null is the correct degrade — the machine simply idles for a turn. */
function coercePending(raw: unknown): PendingOffer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const themeId = str(p.themeId).trim();
  if (!themeId) return null;
  if (typeof p.at !== 'number' || !Number.isFinite(p.at)) return null;
  if (typeof p.phase !== 'string' || !PENDING_PHASES.has(p.phase)) return null;
  if (typeof p.material !== 'string' || !MATERIALS.has(p.material)) return null;
  return {
    themeId,
    at: Math.trunc(p.at),
    phase: p.phase as PendingOffer['phase'],
    material: p.material as ThreadMaterial,
  };
}

/**
 * The stored inventory for a handle — DEFAULTS for an unknown handle, a corrupt row, or a read
 * error. Never throws: this sits on the reply path, where an inventory read failing must cost the
 * callback and nothing else.
 *
 * Note what is deliberately NOT done here: MAX_THEMES/MAX_LOOPS are not applied. The caps belong to
 * the engine, whose eviction order is load-bearing (never a shorthand, never a sore theme — the
 * tombstone is what stops the same bad guess twice). A blind slice at the boundary would drop
 * exactly the rows the engine is required to keep.
 */
export async function getThreadInventory(handle: string): Promise<ThreadInventory> {
  const fallback = defaultThreadInventory();
  try {
    const r = stmt(
      `SELECT handle, themes_json, loops_json, offers_json, pending_json,
              turns_since_offer, last_harvest_at, harvest_count, last_ping_at, updated_at
         FROM thread_inventory WHERE handle = ?`
    ).get(handle) as Row | undefined;
    if (!r) return fallback;

    // Four independent parses. A mangled loops_json costs LOOPS — the pending questions of the last
    // few days — and leaves the months of theme evidence beside it untouched, and vice versa. One
    // try/catch around all four would throw away three good columns to punish one bad one.
    let themesRaw: unknown;
    try { themesRaw = JSON.parse(r.themes_json); } catch { themesRaw = null; }
    let loopsRaw: unknown;
    try { loopsRaw = JSON.parse(r.loops_json); } catch { loopsRaw = null; }
    let offersRaw: unknown;
    try { offersRaw = JSON.parse(r.offers_json); } catch { offersRaw = null; }
    let pendingRaw: unknown;
    try { pendingRaw = JSON.parse(r.pending_json); } catch { pendingRaw = null; }

    return {
      themes: coerceThemes(themesRaw),
      loops: coerceLoops(loopsRaw),
      offers: coerceOffers(offersRaw),
      pending: coercePending(pendingRaw),
      turnsSinceOffer: Math.max(0, intOr(r.turns_since_offer, 0)),
      lastHarvestAt: Math.max(0, intOr(r.last_harvest_at, 0)),
      harvestCount: Math.max(0, intOr(r.harvest_count, 0)),
      lastPingAt: Math.max(0, intOr(r.last_ping_at, 0)),
    };
  } catch (error) {
    logDbError('getThreadInventory', error);
    return fallback;
  }
}

/**
 * Upsert the whole inventory. `opts.ifForgetEpoch` is the epoch the CALLER read before it started
 * working: when it no longer matches, a /forget landed mid-turn and this write would resurrect
 * themes and loops the user asked to be forgotten, so the save is refused. Returns whether it was
 * written — a fenced-out write must never be reported upstream as applied.
 */
export async function saveThreadInventory(
  handle: string,
  next: ThreadInventory,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
    console.warn('[memory] thread inventory save aborted — /forget landed mid-turn');
    return false;
  }
  try {
    stmt(
      `INSERT INTO thread_inventory (handle, themes_json, loops_json, offers_json, pending_json,
                                     turns_since_offer, last_harvest_at, harvest_count, last_ping_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         themes_json = excluded.themes_json,
         loops_json = excluded.loops_json,
         offers_json = excluded.offers_json,
         pending_json = excluded.pending_json,
         turns_since_offer = excluded.turns_since_offer,
         last_harvest_at = excluded.last_harvest_at,
         harvest_count = excluded.harvest_count,
         last_ping_at = excluded.last_ping_at,
         updated_at = excluded.updated_at`
    ).run(
      handle,
      // Coerced on the way IN as well as out, so a caller that built an entry by hand can never put
      // an unknown status or an out-of-range confidence into the store for a later read to trust.
      JSON.stringify(coerceThemes(next.themes)),
      JSON.stringify(coerceLoops(next.loops)),
      JSON.stringify(coerceOffers(next.offers)),
      JSON.stringify(coercePending(next.pending)),
      Math.max(0, intOr(next.turnsSinceOffer, 0)),
      Math.max(0, intOr(next.lastHarvestAt, 0)),
      Math.max(0, intOr(next.harvestCount, 0)),
      Math.max(0, intOr(next.lastPingAt, 0)),
      Date.now(),
    );
    return true;
  } catch (error) {
    logDbError('saveThreadInventory', error);
    return false;
  }
}

/** Drop the row, so the next read returns defaults. The /forget and test seam. */
export async function clearThreadInventory(handle: string): Promise<void> {
  try {
    stmt('DELETE FROM thread_inventory WHERE handle = ?').run(handle);
  } catch (error) {
    logDbError('clearThreadInventory', error);
  }
}

/** Every handle holding an inventory. The sweep seam for the thread-revisit ping (phase F), which
 *  has no conversation to hang off and so has to start from the store. Degrades to an empty list:
 *  a sweep that can't read is a sweep that pings nobody, which is the safe direction for something
 *  that texts a phone unprompted. */
export async function listThreadInventoryHandles(): Promise<string[]> {
  try {
    const rows = stmt('SELECT handle FROM thread_inventory ORDER BY updated_at DESC')
      .all() as unknown as Array<{ handle: string }>;
    return rows.map(r => r.handle);
  } catch (error) {
    logDbError('listThreadInventoryHandles', error);
    return [];
  }
}

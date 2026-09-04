// The durable half of the ops registry. Its live half — state/opsCoordination.ts — is a pair of
// process-local maps, deliberately: the "is research running for this chat?" flag has to be readable
// on the VERY NEXT turn, and it must die with the VM, because a crashed run never resumes.
//
// What dies with it, though, is the ONLY record that a run existed. A user who was told "give me a
// minute" while the process was killed gets silence forever. This table is that record and nothing
// more:
//
//   • RECOVERY — a row still `running` long past its own leg budget is crash debris. The sweep marks
//     it `lost` and owns up to it once, honestly. It is NOT a queue: nothing re-runs off these rows.
//     A re-run costs a real engine leg and can repeat a side effect, so the follow-up asks instead.
//   • CONTINUITY — hasRunningTask() lets the delegate path suppress a re-ask that the in-memory maps
//     forgot across a restart.
//   • APPROVAL — a side-effecting delegation parks here as `pending_approval` until the user says yes
//     (promoteToRunning) or no (settleOpsTask 'declined'), or the ask goes stale ('expired').
//
// Failure policy mirrors proactive.ts: BEST-EFFORT with one retry, then a loud log. Writes return a
// boolean so the caller can leave a receipt for a lost write; reads degrade to []/false/null. A
// durable-state write must never take down a reply.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

export type OpsTaskStatus =
  | 'pending_approval' | 'running' | 'retrying'
  | 'delivered' | 'failed' | 'cancelled' | 'lost' | 'declined' | 'expired';

/** Statuses a row can still move out of. Everything else is terminal — and terminal is FOREVER:
 *  it is what stops a late markOpsDone overwriting a `cancelled` or `lost` row. */
const OPEN_STATUSES = "('pending_approval','running','retrying')";
/** The two statuses that mean "a leg is on the clock right now". */
const LIVE_STATUSES = "('running','retrying')";

/** Settled rows are deleted this long after they settled (the daily retention sweep). */
export const OPS_TASKS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OpsTaskRow {
  id: string;
  chatId: string;
  kind: string;
  request: string;
  status: OpsTaskStatus;
  /** When the run started. For a row still parked for approval this is when we ASKED — promotion
   *  overwrites it with the real start, because from then on it is a leg clock like any other. */
  startedAt: number;
  /** The CURRENT leg's clock (reset by markRetrying). What the stranded horizon is measured from. */
  legStartedAt: number;
  budgetMs: number | null;
  retryOf: string | null;
  meta: Record<string, unknown>;
  updatedAt: number;
  settledAt: number | null;
}

/** What a caller has to know at insert time. `meta` is free-form and must be JSON-safe. */
export interface OpsTaskInsert {
  id: string;
  chatId: string;
  kind: string;
  request: string;
  /** The staleness horizon this run was started under — recorded so a later reader can tell how long
   *  this particular leg was ever entitled to run, whatever the flag says today. */
  budgetMs?: number | null;
  /** Reserved: our retry is IN-PLACE on the same task id (markRetrying), so nothing writes this
   *  today. It exists for the day a retry gets its own id, and reads as NULL until then. */
  retryOf?: string | null;
  meta?: Record<string, unknown>;
}

interface Row {
  id: string;
  chat_id: string;
  kind: string;
  request: string;
  status: string;
  started_at: number;
  leg_started_at: number;
  budget_ms: number | null;
  retry_of: string | null;
  meta_json: string;
  updated_at: number;
  settled_at: number | null;
}

function fromRow(r: Row): OpsTaskRow {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(r.meta_json) as Record<string, unknown>; } catch { /* unparseable → {} */ }
  return {
    id: r.id,
    chatId: r.chat_id,
    kind: r.kind,
    request: r.request,
    status: r.status as OpsTaskStatus,
    startedAt: r.started_at,
    legStartedAt: r.leg_started_at,
    budgetMs: r.budget_ms,
    retryOf: r.retry_of,
    meta,
    updatedAt: r.updated_at,
    settledAt: r.settled_at,
  };
}

/** The same normalization opsCoordination's hasInFlightRequest uses, so the durable answer and the
 *  in-memory one agree about what "the same ask" means. */
function normalize(request: string): string {
  return request.trim().toLowerCase().replace(/\s+/g, ' ');
}

const INSERT_SQL =
  `INSERT INTO ops_tasks
     (id, chat_id, kind, request, status, started_at, leg_started_at, budget_ms, retry_of, meta_json, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insert(e: OpsTaskInsert, status: 'running' | 'pending_approval', clockMs: number): boolean {
  const meta = JSON.stringify(e.meta ?? {});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      stmt(INSERT_SQL).run(
        e.id, e.chatId, e.kind, e.request, status,
        clockMs, clockMs, e.budgetMs ?? null, e.retryOf ?? null, meta, clockMs,
      );
      return true;
    } catch (error) {
      if (attempt === 0) logDbError('ops_tasks insert failed, retrying once', error);
      else console.error(`[opsTasks] DURABLE WRITE LOST for ${e.chatId}/${e.kind} — a restart mid-run will go unowned`, error);
    }
  }
  return false;
}

/** Claim a run as live. Synchronous, because the caller is the synchronous registry write that INV-1
 *  depends on. Returns false when both attempts were lost — the caller leaves a receipt for that. */
export function insertRunning(e: OpsTaskInsert): boolean {
  return insert(e, 'running', Date.now());
}

/** Park a side-effecting delegation until the user answers. Nothing has started: `askedAt` is the
 *  row's clock, and the stranded sweep ignores this status entirely (an unanswered ask is not debris,
 *  it is a question waiting — its own TTL retires it). */
export function insertPendingApproval(e: OpsTaskInsert, askedAt: number): boolean {
  return insert(e, 'pending_approval', askedAt);
}

function update(sql: string, params: Array<string | number | null>, what: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return Number(stmt(sql).run(...params).changes) > 0;
    } catch (error) {
      if (attempt === 0) logDbError(`ops_tasks ${what} failed, retrying once`, error);
      else console.error(`[opsTasks] could not ${what} — this row may be swept as stranded`, error);
    }
  }
  return false;
}

/** A cheap retry leg starts: the status says so and the LEG clock restarts, so a retry that lands
 *  late is not immediately read as crash debris. Refuses a row that has already settled. */
export function markRetrying(id: string): boolean {
  const now = Date.now();
  return update(
    `UPDATE ops_tasks SET status = 'retrying', leg_started_at = ?, updated_at = ? WHERE id = ? AND status IN ${LIVE_STATUSES}`,
    [now, now, id], 'mark retrying',
  );
}

/** Move a parked action to running once the user has approved it. Only ever from pending_approval —
 *  a declined or expired ask can never be started by a late yes. */
export function promoteToRunning(id: string, startedAt: number = Date.now()): boolean {
  return update(
    `UPDATE ops_tasks SET status = 'running', started_at = ?, leg_started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'`,
    [startedAt, startedAt, startedAt, id], 'promote to running',
  );
}

/** Close a row out. The open-statuses WHERE is load-bearing: `lost` and `cancelled` are TERMINAL, so
 *  a handoff that finishes after the sweep already owned up to the run cannot rewrite history. */
export function settleOpsTask(id: string, status: Exclude<OpsTaskStatus, 'pending_approval' | 'running' | 'retrying'>): boolean {
  const now = Date.now();
  return update(
    `UPDATE ops_tasks SET status = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status IN ${OPEN_STATUSES}`,
    [status, now, now, id], `settle ${status}`,
  );
}

/** The sweep's verdict on crash debris. Terminal — nothing re-runs off it. */
export function markLost(id: string): boolean {
  return settleOpsTask(id, 'lost');
}

/** Live rows whose CURRENT leg has been on the clock longer than the horizon: runs no process is
 *  driving any more. Oldest first. `pending_approval` is excluded by the status filter — an
 *  unanswered question is not a stranded run. Reads degrade to []. */
export function listStranded(nowMs: number, horizonMs: number, limit = 20): OpsTaskRow[] {
  try {
    const rows = stmt(
      `SELECT * FROM ops_tasks
       WHERE status IN ${LIVE_STATUSES} AND leg_started_at <= ?
       ORDER BY leg_started_at ASC
       LIMIT ?`
    ).all(nowMs - horizonMs, limit) as unknown as Row[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listStranded', error);
    return [];
  }
}

/** Actions still waiting on this chat's yes, oldest first. Reads degrade to []. */
export function listPendingApprovals(chatId: string): OpsTaskRow[] {
  try {
    const rows = stmt(
      `SELECT * FROM ops_tasks WHERE chat_id = ? AND status = 'pending_approval' ORDER BY started_at ASC`
    ).all(chatId) as unknown as Row[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listPendingApprovals', error);
    return [];
  }
}

/**
 * Is a live run recorded for this chat since `sinceMs` — and, when `request` is given, THAT ask
 * specifically? Synchronous, because the reader is the synchronous duplicate-delegation check.
 *
 * The optional request is what keeps the durable answer honest: without it, one stranded row would
 * make every unrelated ask in that chat read as "already running" until the horizon passed. Reads
 * degrade to false — a missed suppression costs one duplicate run, a thrown read costs the turn.
 */
export function hasRunningTask(chatId: string, sinceMs: number, request?: string): boolean {
  try {
    const rows = stmt(
      `SELECT request FROM ops_tasks WHERE chat_id = ? AND status IN ${LIVE_STATUSES} AND started_at > ?`
    ).all(chatId, sinceMs) as unknown as Array<{ request: string }>;
    if (request === undefined) return rows.length > 0;
    const norm = normalize(request);
    return rows.some(r => normalize(r.request) === norm);
  } catch (error) {
    logDbError('hasRunningTask', error);
    return false;
  }
}

/** One row by id — diagnostics and tests. Degrades to null. */
export function getOpsTask(id: string): OpsTaskRow | null {
  try {
    const row = stmt('SELECT * FROM ops_tasks WHERE id = ?').get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : null;
  } catch (error) {
    logDbError('getOpsTask', error);
    return null;
  }
}

/** Hard-delete SETTLED rows past `maxAgeMs` (the daily retention sweep). Open rows are never swept:
 *  the horizon sweep is what retires a stranded run, and a pending approval retires on its own TTL. */
export async function sweepOldOpsTasks(maxAgeMs: number = OPS_TASKS_MAX_AGE_MS): Promise<number> {
  try {
    const res = stmt(
      `DELETE FROM ops_tasks WHERE status NOT IN ${OPEN_STATUSES} AND updated_at <= ?`
    ).run(Date.now() - maxAgeMs);
    return Number(res.changes);
  } catch (error) {
    logDbError('sweepOldOpsTasks', error);
    return 0;
  }
}

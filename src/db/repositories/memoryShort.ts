// TIER 1: short-term memory (24h chat coherence). Multi-entry, full-fidelity records of
// what Irises did today — every Ops research answer, MM media analysis, and Judge email
// flag — so a same-day follow-up never re-digs and she never sounds like she forgot the
// morning. Replaces the latest-only prefs.recent_research / pending_email_contexts stashes.
//
// Failure policy (per the tier table in the revamp plan): BEST-EFFORT. One retry, then a
// loud log — a lost row degrades to "Irises re-delegates", which is annoying but never
// corrupting. Contrast memoryMedium.ts, which fails loudly.

import { randomUUID } from 'node:crypto';
import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

export type ShortKind = 'ops_research' | 'media_analysis' | 'email_flag';

export interface ShortTermEntry {
  id: string;
  agentHandle: string;
  chatId?: string;
  kind: ShortKind;
  request?: string;
  content: string;
  meta: Record<string, unknown>;
  taskId?: string;
  createdAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export const SHORT_TTL_MS = 24 * 60 * 60 * 1000;
/** Full-fidelity, not unbounded: renderers slice much smaller; this caps storage growth. */
export const SHORT_CONTENT_MAX_CHARS = 8000;
/** Swept rows are deleted this long PAST expiry, so a daily review always finds
 *  a full ≥24h of context even if a run slips (~72h physical retention). */
export const SHORT_SWEEP_GRACE_MS = Number(process.env.MEMORY_SHORT_SWEEP_GRACE_MS || 48 * 60 * 60 * 1000);

interface ShortRow {
  id: string;
  agent_handle: string;
  chat_id: string | null;
  kind: string;
  request: string | null;
  content: string;
  meta_json: string;
  task_id: string | null;
  created_at: number;
  expires_at: number;
}

function fromRow(r: ShortRow): ShortTermEntry {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(r.meta_json) as Record<string, unknown>; } catch { /* unparseable → {} */ }
  return {
    id: r.id,
    agentHandle: r.agent_handle,
    chatId: r.chat_id ?? undefined,
    kind: r.kind as ShortKind,
    request: r.request ?? undefined,
    content: r.content,
    meta,
    taskId: r.task_id ?? undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Append one short-term entry. Duplicate (handle, kind, taskId) inserts are no-ops —
 *  INSERT OR IGNORE + the partial-unique index make a retrying pipeline (Judge batch,
 *  orchestrator retry) safe. */
export async function addShortTerm(e: {
  agentHandle: string;
  chatId?: string;
  kind: ShortKind;
  request?: string;
  content: string;
  meta?: Record<string, unknown>;
  taskId?: string;
  ttlMs?: number;
}): Promise<void> {
  const now = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      stmt(
        `INSERT OR IGNORE INTO memory_short
           (id, agent_handle, chat_id, kind, request, content, meta_json, task_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        e.agentHandle,
        e.chatId ?? null,
        e.kind,
        e.request ?? null,
        e.content.slice(0, SHORT_CONTENT_MAX_CHARS),
        JSON.stringify(e.meta ?? {}),
        e.taskId ?? null,
        now,
        now + (e.ttlMs ?? SHORT_TTL_MS),
      );
      return;
    } catch (error) {
      if (attempt === 0) logDbError('memory-short write failed, retrying once', error);
      else console.error(`[memory-short] DURABLE WRITE LOST for ${e.agentHandle}/${e.kind} — entry did not persist`, error);
    }
  }
}

/** Non-expired entries for a handle, newest first. Reads degrade to [] — a hiccup here
 *  must never kill a turn (Convo just re-delegates). */
export async function listShortTerm(
  handle: string,
  opts: { kinds?: ShortKind[]; chatId?: string; sinceMs?: number; limit?: number } = {},
): Promise<ShortTermEntry[]> {
  const limit = opts.limit ?? 30;
  try {
    const where = ['agent_handle = ?', 'expires_at > ?'];
    const params: Array<string | number> = [handle, Date.now()];
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    if (opts.chatId) {
      where.push('chat_id = ?');
      params.push(opts.chatId);
    }
    if (opts.sinceMs) {
      where.push('created_at > ?');
      params.push(opts.sinceMs);
    }
    // rowid breaks same-millisecond ties so entries still come back newest-first —
    // two inserts can land in one ms under load.
    const rows = stmt(
      `SELECT * FROM memory_short WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(...params, limit) as unknown as ShortRow[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listShortTerm', error);
    return [];
  }
}

/** The single most-recent non-expired entry across the given kinds (routing-gate freshness). */
export async function latestShortTerm(handle: string, kinds: ShortKind[]): Promise<ShortTermEntry | null> {
  const list = await listShortTerm(handle, { kinds, limit: 1 });
  return list[0] ?? null;
}

/** Force-expire entries now (/forget drops everything; `kinds` allows a scoped expiry).
 *  Expiry, not deletion — rows still age out through the swept path like everything else. */
export async function expireShortTermNow(handle: string, kinds?: ShortKind[]): Promise<void> {
  try {
    const params: Array<string | number> = [Date.now(), handle];
    let sql = 'UPDATE memory_short SET expires_at = ? WHERE agent_handle = ?';
    if (kinds?.length) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
      params.push(...kinds);
    }
    stmt(sql).run(...params);
  } catch (error) {
    logDbError('expireShortTermNow', error);
  }
}

/** Hard-delete rows well past expiry (grace default 48h). Called hourly by the retention
 *  timers (src/db/retention.ts). Returns the number of rows deleted. */
export async function sweepExpiredShortTerm(graceMs: number = SHORT_SWEEP_GRACE_MS): Promise<number> {
  try {
    const res = stmt('DELETE FROM memory_short WHERE expires_at < ?').run(Date.now() - graceMs);
    return Number(res.changes);
  } catch (error) {
    logDbError('sweepExpiredShortTerm', error);
    return 0;
  }
}

// TIER 1: short-term memory (24h chat coherence). Multi-entry, full-fidelity records of
// what Irises did today — every Ops research answer, MM media analysis, and Judge email
// flag — so a same-day follow-up never re-digs and she never sounds like she forgot the
// morning. Replaces the latest-only prefs.recent_research / pending_email_contexts stashes.
//
// Failure policy (per the tier table in the revamp plan): BEST-EFFORT. One retry, then
// mirror to the in-memory map + loud log — a lost row degrades to "Irises re-delegates",
// which is annoying but never corrupting. Contrast memoryMedium.ts, which fails loudly.

import { randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';

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
/** Swept rows are deleted this long PAST expiry, so Reflexion's daily pass always finds
 *  a full ≥24h of context even if a run slips (~72h physical retention). */
export const SHORT_SWEEP_GRACE_MS = Number(process.env.MEMORY_SHORT_SWEEP_GRACE_MS || 48 * 60 * 60 * 1000);

interface ShortRow {
  id: string;
  agent_handle: string;
  chat_id: string | null;
  kind: string;
  request: string | null;
  content: string;
  meta: Record<string, unknown> | null;
  task_id: string | null;
  created_at: string;
  expires_at: string;
}

function fromRow(r: ShortRow): ShortTermEntry {
  return {
    id: r.id,
    agentHandle: r.agent_handle,
    chatId: r.chat_id ?? undefined,
    kind: r.kind as ShortKind,
    request: r.request ?? undefined,
    content: r.content,
    meta: r.meta ?? {},
    taskId: r.task_id ?? undefined,
    createdAt: Date.parse(r.created_at),
    expiresAt: Date.parse(r.expires_at),
  };
}

function memList(handle: string): ShortTermEntry[] {
  return mem.memoryShort.get(handle) ?? [];
}

/** Append one short-term entry. Duplicate (handle, kind, taskId) inserts are no-ops —
 *  the unique index makes a retrying pipeline (Judge batch, orchestrator retry) safe. */
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
  const entry: ShortTermEntry = {
    id: randomUUID(),
    agentHandle: e.agentHandle,
    chatId: e.chatId,
    kind: e.kind,
    request: e.request,
    content: e.content.slice(0, SHORT_CONTENT_MAX_CHARS),
    meta: e.meta ?? {},
    taskId: e.taskId,
    createdAt: now,
    expiresAt: now + (e.ttlMs ?? SHORT_TTL_MS),
  };

  const supabase = getSupabase();
  if (supabase) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { error } = await supabase.from('memory_short').insert({
          id: entry.id,
          agent_handle: entry.agentHandle,
          chat_id: entry.chatId ?? null,
          kind: entry.kind,
          request: entry.request ?? null,
          content: entry.content,
          meta: entry.meta,
          task_id: entry.taskId ?? null,
          created_at: new Date(entry.createdAt).toISOString(),
          expires_at: new Date(entry.expiresAt).toISOString(),
        });
        if (error) {
          // 23505 = the partial-unique (handle, kind, task_id) fired: already recorded.
          if ((error as { code?: string }).code === '23505') return;
          throw error;
        }
        return;
      } catch (error) {
        if (attempt === 0) {
          logDbError('memory-short write failed, retrying once', error);
          await new Promise(r => setTimeout(r, 250));
        } else {
          console.error(`[memory-short] DURABLE WRITE LOST for ${entry.agentHandle}/${entry.kind} — entry survives this session only`, error);
        }
      }
    }
  }
  // Memory backend, or durable write lost: mirror so the session stays coherent.
  const list = memList(entry.agentHandle);
  if (entry.taskId && list.some(x => x.kind === entry.kind && x.taskId === entry.taskId)) return;
  mem.memoryShort.set(entry.agentHandle, [...list, entry]);
}

/** Non-expired entries for a handle, newest first. Reads degrade to [] — a hiccup here
 *  must never kill a turn (Convo just re-delegates). */
export async function listShortTerm(
  handle: string,
  opts: { kinds?: ShortKind[]; chatId?: string; sinceMs?: number; limit?: number } = {},
): Promise<ShortTermEntry[]> {
  const limit = opts.limit ?? 30;
  const nowIso = new Date().toISOString();
  const supabase = getSupabase();
  if (supabase) {
    try {
      let q = supabase
        .from('memory_short')
        .select('*')
        .eq('agent_handle', handle)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (opts.kinds?.length) q = q.in('kind', opts.kinds);
      if (opts.chatId) q = q.eq('chat_id', opts.chatId);
      if (opts.sinceMs) q = q.gt('created_at', new Date(opts.sinceMs).toISOString());
      const { data, error } = await q;
      if (error) throw error;
      return (data as ShortRow[]).map(fromRow);
    } catch (error) {
      logDbError('listShortTerm', error);
      return [];
    }
  }
  const now = Date.now();
  return memList(handle)
    .filter(e => e.expiresAt > now)
    .filter(e => !opts.kinds?.length || opts.kinds.includes(e.kind))
    .filter(e => !opts.chatId || e.chatId === opts.chatId)
    .filter(e => !opts.sinceMs || e.createdAt > opts.sinceMs)
    // Reverse (newest insertion first) BEFORE the stable sort so same-millisecond entries
    // still come back newest-first — two inserts can land in one ms under load.
    .reverse()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** The single most-recent non-expired entry across the given kinds (routing-gate freshness). */
export async function latestShortTerm(handle: string, kinds: ShortKind[]): Promise<ShortTermEntry | null> {
  const list = await listShortTerm(handle, { kinds, limit: 1 });
  return list[0] ?? null;
}

/** Force-expire entries now (Gmail disconnect drops email_flags; /forget drops everything).
 *  Expiry, not deletion — rows still age out through the swept path like everything else. */
export async function expireShortTermNow(handle: string, kinds?: ShortKind[]): Promise<void> {
  const nowIso = new Date().toISOString();
  const supabase = getSupabase();
  if (supabase) {
    try {
      let q = supabase.from('memory_short').update({ expires_at: nowIso }).eq('agent_handle', handle);
      if (kinds?.length) q = q.in('kind', kinds);
      const { error } = await q;
      if (error) throw error;
    } catch (error) {
      logDbError('expireShortTermNow', error);
    }
  }
  const now = Date.now();
  mem.memoryShort.set(
    handle,
    memList(handle).map(e => (!kinds?.length || kinds.includes(e.kind) ? { ...e, expiresAt: now } : e)),
  );
}

/** Hard-delete rows well past expiry (grace default 48h). Called hourly off the Autonome
 *  tick. Returns the number of rows deleted (supabase) or pruned (memory). */
export async function sweepExpiredShortTerm(graceMs: number = SHORT_SWEEP_GRACE_MS): Promise<number> {
  const cutoffIso = new Date(Date.now() - graceMs).toISOString();
  let removed = 0;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('memory_short')
        .delete()
        .lt('expires_at', cutoffIso)
        .select('id');
      if (error) throw error;
      removed = data?.length ?? 0;
    } catch (error) {
      logDbError('sweepExpiredShortTerm', error);
    }
  }
  const cutoff = Date.now() - graceMs;
  for (const [handle, list] of mem.memoryShort) {
    const kept = list.filter(e => e.expiresAt >= cutoff);
    removed += list.length - kept.length;
    if (kept.length) mem.memoryShort.set(handle, kept);
    else mem.memoryShort.delete(handle);
  }
  return removed;
}

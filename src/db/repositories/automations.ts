import { createHash, randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import { nextRunAt as cronNextRunAt } from '../../pipeline/cron.js';
import { dateTimeInZone } from '../../pipeline/zonedTime.js';
import type { Automation, NewAutomation } from '../types.js';

const LEASE_MS = 10 * 60 * 1000; // matches claim_due_automations' stuck-claim recovery window

/** Stable dedupe key from what + when, so the same reminder requested twice (a double-tap,
 *  a burst re-fire, a model retry) creates ONE row. A genuinely different time or wording
 *  makes a different key, so re-asking for a similar reminder later still works. */
export function deriveDedupeKey(source: string, instruction: string, when: string): string {
  const digest = createHash('sha1').update(`${instruction.trim().toLowerCase()}|${when}`).digest('hex').slice(0, 16);
  return `${source}:${digest}`;
}

function rowToAutomation(r: any): Automation {
  return {
    id: r.id,
    agentHandle: r.agent_handle,
    chatId: r.chat_id,
    source: r.source ?? 'convo',
    title: r.title ?? null,
    instruction: r.instruction,
    needsOps: r.needs_ops ?? false,
    opsKind: r.ops_kind ?? null,
    dealId: r.deal_id ?? null,
    deadlineId: r.deadline_id ?? null,
    scheduleKind: r.schedule_kind,
    nextRunAt: r.next_run_at,
    cron: r.cron ?? null,
    timezone: r.timezone ?? 'America/Chicago',
    respectQuietHours: r.respect_quiet_hours ?? false,
    status: r.status,
    lastRunAt: r.last_run_at ?? null,
    runCount: r.run_count ?? 0,
    attempts: r.attempts ?? 0,
    lastError: r.last_error ?? null,
    claimedAt: r.claimed_at ?? null,
    dedupeKey: r.dedupe_key ?? null,
  };
}

/**
 * Resolve the first fire time. For 'once' the caller supplies an absolute ISO
 * instant; for 'cron' we compute it from the cron expression + timezone so the
 * model never has to guess the first occurrence.
 */
function resolveFirstRun(a: NewAutomation, timezone: string): string {
  if (a.scheduleKind === 'cron') {
    if (!a.cron) throw new Error('cron automation requires a cron expression');
    return cronNextRunAt(a.cron, timezone, new Date());
  }
  if (!a.nextRunAt) throw new Error('one-time automation requires nextRunAt');
  return a.nextRunAt;
}

/** Create an automation unless one with the same dedupeKey already exists. */
export async function createAutomation(a: NewAutomation): Promise<Automation | null> {
  const timezone = a.timezone ?? 'America/Chicago';
  const firstRun = resolveFirstRun(a, timezone);
  const supabase = getSupabase();
  if (supabase) {
    // Supabase is the source of truth the runner reads. If a write fails we return
    // null (an honest failure the caller can surface) rather than falling through to
    // an in-memory row the runner would never claim.
    try {
      if (a.dedupeKey) {
        // Scope dedupe by agent — keys can collide across agents (e.g. two agents
        // with a deal at the same address producing "412-maple|closing"). A row the
        // user CANCELLED (or that failed out) doesn't block deliberate re-creation;
        // active/paused/done rows do (done = already fired once, don't re-nag).
        const { data: existing } = await supabase.from('automations').select('*')
          .eq('agent_handle', a.agentHandle).eq('dedupe_key', a.dedupeKey)
          .in('status', ['active', 'paused', 'done'])
          .limit(1).maybeSingle();
        if (existing) return rowToAutomation(existing);
      }
      const { data, error } = await supabase.from('automations').insert({
        agent_handle: a.agentHandle,
        chat_id: a.chatId,
        source: a.source ?? 'convo',
        title: a.title ?? null,
        instruction: a.instruction,
        needs_ops: a.needsOps ?? false,
        ops_kind: a.opsKind ?? null,
        deal_id: a.dealId ?? null,
        deadline_id: a.deadlineId ?? null,
        schedule_kind: a.scheduleKind,
        next_run_at: firstRun,
        cron: a.cron ?? null,
        timezone,
        respect_quiet_hours: a.respectQuietHours ?? false,
        dedupe_key: a.dedupeKey ?? null,
      }).select().single();
      if (error) throw error;
      return rowToAutomation(data);
    } catch (error) {
      logDbError('createAutomation', error);
      return null;
    }
  }
  // In-memory mode (no Supabase configured).
  if (a.dedupeKey) {
    const dup = [...mem.automations.values()].find(x =>
      x.dedupeKey === a.dedupeKey && x.agentHandle === a.agentHandle
      && (x.status === 'active' || x.status === 'paused' || x.status === 'done'));
    if (dup) return dup;
  }
  const automation: Automation = {
    id: randomUUID(),
    agentHandle: a.agentHandle,
    chatId: a.chatId,
    source: a.source ?? 'convo',
    title: a.title ?? null,
    instruction: a.instruction,
    needsOps: a.needsOps ?? false,
    opsKind: a.opsKind ?? null,
    dealId: a.dealId ?? null,
    deadlineId: a.deadlineId ?? null,
    scheduleKind: a.scheduleKind,
    nextRunAt: firstRun,
    cron: a.cron ?? null,
    timezone,
    respectQuietHours: a.respectQuietHours ?? false,
    status: 'active',
    lastRunAt: null,
    runCount: 0,
    attempts: 0,
    lastError: null,
    claimedAt: null,
    dedupeKey: a.dedupeKey ?? null,
  };
  mem.automations.set(automation.id, automation);
  noteMemCreated(automation.id); // the mem row has no created_at; countWakesToday needs one
  return automation;
}

/**
 * Atomically claim due automations (status active, next_run_at <= now, not under
 * an active lease). On Supabase this uses the claim_due_automations RPC
 * (FOR UPDATE SKIP LOCKED) which sets claimed_at = now(). Status is unchanged —
 * the runner reschedules (cron) or completes (once) after the send.
 */
export async function claimDueAutomations(limit: number): Promise<Automation[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('claim_due_automations', { p_limit: limit });
      if (error) throw error;
      return (data ?? []).map(rowToAutomation);
    } catch (error) {
      logDbError('claimDueAutomations', error);
    }
  }
  const now = Date.now();
  const due = [...mem.automations.values()]
    .filter(a => a.status === 'active'
      && Date.parse(a.nextRunAt) <= now
      && (!a.claimedAt || Date.parse(a.claimedAt) < now - LEASE_MS))
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
    .slice(0, limit);
  const claimedAt = new Date(now).toISOString();
  // Mirror claim_due_automations: retire one-time rows atomically at claim so they
  // fire at most once; recurring rows just take the lease and advance after the send.
  const claim = (a: Automation): Automation => a.scheduleKind === 'once'
    ? { ...a, claimedAt, status: 'done', lastRunAt: claimedAt, runCount: a.runCount + 1 }
    : { ...a, claimedAt };
  return due.map(a => {
    const claimed = claim(a);
    mem.automations.set(a.id, claimed);
    return claimed;
  });
}

/** Cron job fired successfully: advance to the next occurrence and release the lease. */
export async function rescheduleAutomation(a: Automation, next: string): Promise<void> {
  const patch = {
    next_run_at: next,
    last_run_at: new Date().toISOString(),
    run_count: a.runCount + 1,
    attempts: 0,
    last_error: null,
    claimed_at: null,
  };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch).eq('id', a.id);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('rescheduleAutomation', error);
    }
  }
  const cur = mem.automations.get(a.id);
  if (cur) mem.automations.set(a.id, {
    ...cur, nextRunAt: next, lastRunAt: patch.last_run_at, runCount: cur.runCount + 1,
    attempts: 0, lastError: null, claimedAt: null,
  });
}

/** One-time job fired successfully: mark done and release the lease. */
export async function completeAutomation(a: Automation): Promise<void> {
  // With migration 0006 the claim already retired this row ('done'); skip the redundant
  // write. Without 0006 (or in-memory before this code), the claim left it 'active' and
  // this is what retires it. Either way, a one-time row ends up done exactly once.
  if (a.status === 'done') return;
  const patch = {
    status: 'done' as const,
    last_run_at: new Date().toISOString(),
    run_count: a.runCount + 1,
    claimed_at: null,
  };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch).eq('id', a.id);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('completeAutomation', error);
    }
  }
  const cur = mem.automations.get(a.id);
  if (cur) mem.automations.set(a.id, {
    ...cur, status: 'done', lastRunAt: patch.last_run_at, runCount: cur.runCount + 1, claimedAt: null,
  });
}

/**
 * Re-point a deadline's 48h reminder at a NEW fire time and re-arm it. Called by promoteDeadlines
 * ONLY when the deadline's date actually moved (an amended contract), so the reminder tracks the
 * corrected date instead of firing at — or having already fired at — the stale one. This is the one
 * path that deliberately mutates an existing reminder; the normal re-promotion path relies on
 * createAutomation's dedupe to be a no-op, so an unchanged re-index never reaches here and never
 * re-fires a reminder the user already got. Re-activates a row that had already fired ('done') so
 * the new date gets a fresh reminder, and clears the lease + backoff. Matched by the stable
 * (agent_handle, dedupe_key) — the same unique key createAutomation dedupes on. A 'cancelled' or
 * 'failed' row is left alone: a moved date must not resurrect a reminder the user opted out of
 * (mirrors createAutomation, which won't recreate a cancelled row).
 */
const REARMABLE = ['active', 'paused', 'done'] as const;
export async function rearmDeadlineReminder(agentHandle: string, dedupeKey: string, nextRunAt: string, instruction: string): Promise<void> {
  const patch = {
    next_run_at: nextRunAt, instruction, status: 'active' as const,
    claimed_at: null, attempts: 0, last_error: null,
  };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch)
        .eq('agent_handle', agentHandle).eq('dedupe_key', dedupeKey)
        .in('status', REARMABLE as unknown as string[]);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('rearmDeadlineReminder', error);
    }
  }
  for (const [id, a] of mem.automations) {
    if (a.agentHandle === agentHandle && a.dedupeKey === dedupeKey
      && (REARMABLE as readonly string[]).includes(a.status)) {
      mem.automations.set(id, {
        ...a, nextRunAt, instruction, status: 'active', claimedAt: null, attempts: 0, lastError: null,
      });
    }
  }
}

/**
 * Reflexion wake budget: how many self-scheduled wake rows this handle CREATED since local
 * midnight in their timezone. Counts created rows of any status — a cancelled or failed wake
 * still consumed budget (the conservative reading the ≤N/day cap wants).
 */
export async function countWakesToday(agentHandle: string, timeZone: string): Promise<number> {
  // Today's Y-M-D on the user's wall clock → the UTC instant of their local midnight.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const midnightMs = dateTimeInZone(ymd, { hour: 0 }, timeZone);
  const sinceIso = new Date(Number.isFinite(midnightMs) ? midnightMs : Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const supabase = getSupabase();
  if (supabase) {
    try {
      const { count, error } = await supabase.from('automations')
        .select('id', { count: 'exact', head: true })
        .eq('agent_handle', agentHandle)
        .eq('source', 'reflexion')
        .eq('schedule_kind', 'once')
        .gte('created_at', sinceIso);
      if (error) throw error;
      return count ?? 0;
    } catch (error) {
      logDbError('countWakesToday', error);
      // Fail CLOSED for a budget check: an unreadable count must not grant unlimited wakes.
      return Number.MAX_SAFE_INTEGER;
    }
  }
  const since = Date.parse(sinceIso);
  let n = 0;
  for (const a of mem.automations.values()) {
    if (a.agentHandle === agentHandle && a.source === 'reflexion' && a.scheduleKind === 'once'
      && (memCreatedAt.get(a.id) ?? 0) >= since) n++;
  }
  return n;
}

// The mem fallback has no created_at column; track it locally for the wake-budget window.
const memCreatedAt = new Map<string, number>();
export function noteMemCreated(id: string): void {
  memCreatedAt.set(id, Date.now());
}

/**
 * Update an existing row's timezone/chat (and recompute its next cron fire) in place —
 * the tz-change reconciliation for Reflexion's daily row. Modeled on rearmDeadlineReminder.
 * No-op when no matching active row exists.
 */
export async function retimeAutomation(agentHandle: string, dedupeKey: string, timezone: string, chatId: string): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('automations').select('*')
        .eq('agent_handle', agentHandle).eq('dedupe_key', dedupeKey)
        .eq('status', 'active').maybeSingle();
      if (error) throw error;
      if (!data) return;
      const row = rowToAutomation(data);
      if (row.timezone === timezone && row.chatId === chatId) return;
      const patch: Record<string, unknown> = { timezone, chat_id: chatId };
      if (row.scheduleKind === 'cron' && row.cron) patch.next_run_at = cronNextRunAt(row.cron, timezone, new Date());
      const { error: upErr } = await supabase.from('automations').update(patch).eq('id', row.id);
      if (upErr) throw upErr;
      return;
    } catch (error) {
      logDbError('retimeAutomation', error);
      return;
    }
  }
  for (const [id, a] of mem.automations) {
    if (a.agentHandle === agentHandle && a.dedupeKey === dedupeKey && a.status === 'active') {
      if (a.timezone === timezone && a.chatId === chatId) return;
      mem.automations.set(id, {
        ...a, timezone, chatId,
        nextRunAt: a.scheduleKind === 'cron' && a.cron ? cronNextRunAt(a.cron, timezone, new Date()) : a.nextRunAt,
      });
    }
  }
}

/**
 * Retire a deadline's still-pending 48h reminder without firing it. Called by promoteDeadlines
 * when an amended contract moved a deadline's date such that the new 48h mark is ALREADY PAST —
 * the armed reminder now carries a stale date and firing it would tell the user wrong information.
 * Only 'active'/'paused' rows are touched: a fired ('done') or user-cancelled row needs nothing.
 */
export async function retireDeadlineReminder(agentHandle: string, dedupeKey: string): Promise<void> {
  const patch = { status: 'done' as const, claimed_at: null };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch)
        .eq('agent_handle', agentHandle).eq('dedupe_key', dedupeKey)
        .in('status', ['active', 'paused']);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('retireDeadlineReminder', error);
    }
  }
  for (const [id, a] of mem.automations) {
    if (a.agentHandle === agentHandle && a.dedupeKey === dedupeKey
      && (a.status === 'active' || a.status === 'paused')) {
      mem.automations.set(id, { ...a, status: 'done', claimedAt: null });
    }
  }
}

/**
 * Record a failed run. With nextRetryAt the row is re-armed (status stays active);
 * without it (a one-time job out of attempts) the row is parked as 'failed'. Pass
 * resetAttempts=true when re-arming a recurring job at its NEXT occurrence so a bad
 * day doesn't carry its failure count into tomorrow. Either way the lease is released.
 */
export async function failAutomation(a: Automation, errMsg: string, nextRetryAt?: string, resetAttempts = false): Promise<void> {
  const attempts = resetAttempts ? 0 : a.attempts + 1;
  const base = { attempts, last_error: errMsg.slice(0, 500), claimed_at: null };
  const patch = nextRetryAt
    ? { ...base, next_run_at: nextRetryAt }
    : { ...base, status: 'failed' as const };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch).eq('id', a.id);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('failAutomation', error);
    }
  }
  const cur = mem.automations.get(a.id);
  if (cur) mem.automations.set(a.id, {
    ...cur, attempts, lastError: errMsg.slice(0, 500), claimedAt: null,
    ...(nextRetryAt ? { nextRunAt: nextRetryAt } : { status: 'failed' as const }),
  });
}

/**
 * Defer a claimed row to a later time and release the lease, WITHOUT counting it as
 * a run or a failure. Used for quiet-hours: a row claimed during 9pm-8am is pushed to
 * the next 8am so it isn't held under a stale lease for the whole window.
 *
 * MUST re-arm status: the atomic claim (migration 0006) already retired a one-time row
 * to 'done', so a defer that only moved next_run_at would leave it permanently
 * unclaimable — the reminder would silently vanish instead of firing at 8am. Re-activating
 * is safe for cron rows too (their status was still 'active'). The claim's one-time
 * run_count bump is rolled back so the row doesn't double-count when it really fires.
 */
export async function deferAutomation(a: Automation, next: string): Promise<void> {
  const rearmOnce = a.scheduleKind === 'once' && a.status === 'done';
  const patch = {
    next_run_at: next,
    claimed_at: null,
    status: 'active' as const,
    ...(rearmOnce ? { run_count: Math.max(0, a.runCount - 1) } : {}),
  };
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('automations').update(patch).eq('id', a.id);
      if (error) throw error;
      return;
    } catch (error) {
      logDbError('deferAutomation', error);
    }
  }
  const cur = mem.automations.get(a.id);
  if (cur) mem.automations.set(a.id, {
    ...cur, nextRunAt: next, claimedAt: null, status: 'active',
    ...(rearmOnce ? { runCount: Math.max(0, cur.runCount - 1) } : {}),
  });
}

/** Active + paused automations for one agent, soonest first (for list/cancel UX). */
export async function listAutomations(handle: string): Promise<Automation[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('automations').select('*')
        .eq('agent_handle', handle).in('status', ['active', 'paused'])
        .order('next_run_at', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(rowToAutomation);
    } catch (error) {
      logDbError('listAutomations', error);
    }
  }
  return [...mem.automations.values()]
    .filter(a => a.agentHandle === handle && (a.status === 'active' || a.status === 'paused'))
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

/**
 * Failed or stuck-retrying automations for one agent — the reliability board that listAutomations
 * (active + paused only) structurally hides. Surfaces status='failed' (gave up) PLUS any row still
 * carrying failures (attempts > 0, i.e. mid-retry: a run errored and attempts hasn't been reset by a
 * success). Excludes 'reflexion' rows: those are the internal memory curator, not user-facing outreach
 * the agent needs to know silently failed. Newest last-attempt first.
 */
export async function listFailedAutomations(handle: string): Promise<Automation[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('automations').select('*')
        .eq('agent_handle', handle)
        .neq('source', 'reflexion')
        .or('status.eq.failed,attempts.gt.0')
        .order('last_run_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []).map(rowToAutomation);
    } catch (error) {
      logDbError('listFailedAutomations', error);
    }
  }
  return [...mem.automations.values()]
    .filter(a => a.agentHandle === handle && a.source !== 'reflexion'
      && (a.status === 'failed' || a.attempts > 0))
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));
}

/** Cancel one automation, guarded by agent_handle so users can't cancel others'. */
export async function cancelAutomation(id: string, handle: string): Promise<boolean> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from('automations')
        .update({ status: 'cancelled', claimed_at: null })
        .eq('id', id).eq('agent_handle', handle).select('id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    } catch (error) {
      logDbError('cancelAutomation', error);
    }
  }
  const cur = mem.automations.get(id);
  if (cur && cur.agentHandle === handle) {
    mem.automations.set(id, { ...cur, status: 'cancelled', claimedAt: null });
    return true;
  }
  return false;
}

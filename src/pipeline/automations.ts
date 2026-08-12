// Autonome runner — the single in-process scheduler for ALL proactive outreach.
// Replaces the old deadline sweeper. Every minute it claims due automations
// (user-asked, email-triaged, or Ops-scheduled follow-ups), voices each through
// the Autonome agent (Irises's proactive persona, optionally running Ops first),
// and sends it via the same paced sender used for live replies. Self-healing
// across restarts: claims are leased, cron jobs reschedule, one-time jobs complete.
import {
  claimDueAutomations, rescheduleAutomation, completeAutomation, failAutomation, deferAutomation,
} from '../db/repositories/automations.js';
import { randomUUID } from 'node:crypto';
import { nextRunAt } from './cron.js';
import { inQuietHours } from './zonedTime.js';
import { sweepExpiredShortTerm } from '../db/repositories/memoryShort.js';
import { hasInFlightRequest } from '../state/opsCoordination.js';
import { prepareAutonomeJob } from '../agents/autonome/client.js';
import { runReflexionQueued, reflexionEnabled } from '../agents/reflexion/client.js';
import { runDailyJudgePass } from './emailJudge.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { Automation } from '../db/types.js';

/** Build + queue the silent Reflexion run for a claimed reflexion row. The row's schedule was
 *  already advanced by the caller (at-most-once); the per-handle queue inside runReflexionQueued
 *  serializes against any concurrent delegated run. */
function runReflexionForAutomation(a: Automation): Promise<void> {
  if (!reflexionEnabled()) return Promise.resolve();
  return runReflexionQueued({
    id: randomUUID(),
    chatId: a.chatId,
    agentHandle: a.agentHandle,
    kind: 'memory_update',
    trigger: a.scheduleKind === 'cron' ? 'daily' : 'self_wake',
    request: a.instruction,
    focus: a.scheduleKind === 'cron' ? undefined : a.instruction,
    attempt: 1,
    createdAt: Date.now(),
  });
}

// The mouth contract (state/mouth.ts): content may be a voicer thunk run under the per-chat lock.
type SendFollowUp = (chatId: string, content: string | (() => Promise<string | null>), opts?: { record?: boolean }) => Promise<unknown>;

const INTERVAL_MS = Number(process.env.AUTONOME_INTERVAL_MS || 60_000);
const BATCH = Number(process.env.AUTONOME_BATCH || 10);
// How far to push a needsOps row whose exact research is already running live. 5 min > the 4-min
// scheduled-Ops timeout, so on re-fire the live run has settled and its 90s "recent" dedupe window
// has expired — the deferred row then runs fresh instead of being suppressed.
const DUP_DEFER_MS = Number(process.env.AUTONOME_DUP_DEFER_MS || 5 * 60_000);
const MAX_ATTEMPTS = 4;

// Quiet hours (9pm–8am, shared definition in zonedTime.ts) apply ONLY to rows with
// respect_quiet_hours=true (system-generated email reminders). User-set reminders fire
// at the exact time they chose.
function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 60_000 * 2 ** attempts); // 1m, 2m, 4m, 8m … capped at 15m
}

export async function runAutonomeOnce(sendFollowUp: SendFollowUp): Promise<void> {
  const due = await claimDueAutomations(BATCH);
  for (const a of due) {
    // Quiet hours: push the row to the next 8am (local) and release the claim, so it
    // isn't held under a stale lease (or re-claimed every cycle) all night and fires
    // promptly once quiet hours end. Only respect_quiet_hours rows are gated.
    // deferAutomation re-arms status too — the atomic claim already retired a one-time
    // row to 'done', and a deferred row must be claimable again at 8am.
    if (a.respectQuietHours && inQuietHours(a.timezone)) {
      await deferAutomation(a, nextRunAt('0 8 * * *', a.timezone, new Date()));
      continue;
    }

    // SILENT lane: reflexion rows (the daily memory pass + self-wakes) never voice, never touch
    // the mouth. Advance the schedule FIRST — a deliberate at-most-once flip vs. the reminders'
    // at-least-once below: a missed curation pass is cheap (the next daily covers it), while a
    // lease-lapse re-claim mid-5-minute-Opus-run would double an expensive, already-running job.
    // Then run DETACHED so a long pass never blocks the user reminders behind it in this batch.
    if (a.source === 'reflexion') {
      if (a.scheduleKind === 'cron' && a.cron) await rescheduleAutomation(a, nextRunAt(a.cron, a.timezone, new Date()));
      else await completeAutomation(a);
      void runReflexionForAutomation(a).catch(e => console.error('[reflexion] scheduled run failed', e));
      continue;
    }

    // EMAIL DIGEST lane: the once-daily Judge pass. It voices its own digest (unread-important only)
    // via sendFollowUp, so unlike reflexion it isn't silent — but like reflexion it's at-most-once (a
    // missed digest is cheap; tomorrow covers it): advance the schedule FIRST, then run DETACHED so a
    // slow inbox scan never blocks the user reminders behind it in this batch.
    if (a.source === 'judge_daily') {
      if (a.scheduleKind === 'cron' && a.cron) await rescheduleAutomation(a, nextRunAt(a.cron, a.timezone, new Date()));
      else await completeAutomation(a);
      void runDailyJudgePass(a.agentHandle, sendFollowUp).catch(e => console.error('[judge-daily] scheduled run failed', e));
      continue;
    }

    // A live Convo delegation of this EXACT ask is running right now (the user just asked, or a
    // prior lease-lapse re-claim is mid-flight) — don't double-spend Ops on the identical research.
    // Kind-agnostic on purpose: the row's opsKind and the kind Convo chose for the same wording
    // routinely differ. deferAutomation (not reschedule/complete) releases the lease, re-arms a
    // claim-retired row, and rolls back run_count — a skipped occurrence never counts as a run.
    if (a.needsOps && hasInFlightRequest(a.chatId, a.instruction)) {
      if (a.scheduleKind === 'cron' && a.cron) {
        // Skip this occurrence: the user is already getting the identical answer live.
        await deferAutomation(a, nextRunAt(a.cron, a.timezone, new Date()));
      } else {
        // A one-time reminder is at-least-once — defer past the live run, never skip it.
        await deferAutomation(a, new Date(Date.now() + DUP_DEFER_MS).toISOString());
      }
      console.log(`[autonome] deferred automation ${a.id} — identical research already in flight`);
      continue;
    }

    try {
      // At-least-once: we mark the row done/rescheduled only AFTER the send. A crash
      // in the gap re-fires it after the lease lapses. That's the deliberate choice —
      // for reminders an occasional duplicate beats a silent miss.
      // Two-phase through the mouth: the (possibly minutes-long) Ops leg runs HERE, outside any
      // lock; the history-reading VOICE runs inside the per-chat lock via the thunk, so the
      // reach-out blends into the thread exactly as it is when it actually speaks — it can never
      // barge in voiced against a moment that a queued reply has already moved past.
      const { voice } = await prepareAutonomeJob(a);
      await sendFollowUp(a.chatId, voice, { record: true });

      if (a.scheduleKind === 'cron' && a.cron) {
        await rescheduleAutomation(a, nextRunAt(a.cron, a.timezone, new Date()));
      } else {
        await completeAutomation(a);
      }
      console.log(`[autonome] fired automation ${a.id} (${a.scheduleKind}, source=${a.source})`);
    } catch (err) {
      const msg = (err as Error)?.message ?? 'job failed';
      console.error(`[autonome] automation ${a.id} failed`, err);
      // One report covers all three bookkeeping branches below. last_error is per-row and
      // latest-only, so a pattern ACROSS rows (every needsOps reach-out timing out, one chat's
      // sends all failing) is invisible there — the durable log is where it shows up.
      // trace:false: the failing leg already recorded its own ERROR event (autonome:voicing_failed,
      // an LLM error row, a mouth drop), so counting this again would double the turn's errors.
      reportError({
        source: 'pipeline',
        category: 'automation_failure',
        message: msg,
        err,
        chatId: a.chatId,
        handle: a.agentHandle,
        detail: { automationId: a.id, attempts: a.attempts, scheduleKind: a.scheduleKind, source: a.source, needsOps: a.needsOps },
        trace: false,
      });
      if (a.scheduleKind === 'cron' && a.cron) {
        if (a.attempts + 1 < MAX_ATTEMPTS) {
          // Transient failure — back off and retry this occurrence.
          await failAutomation(a, msg, new Date(Date.now() + backoffMs(a.attempts)).toISOString());
        } else {
          // Out of retries: skip this occurrence, reset the counter, keep the series alive.
          await failAutomation(a, msg, nextRunAt(a.cron, a.timezone, new Date()), true);
        }
      } else {
        // One-time rows were already retired ('done') by the atomic claim, so a failed send is NOT
        // retried — they fire at most once, and a rare miss beats the repeat loop. Flipping them to
        // 'failed' (no nextRetryAt ⇒ status='failed' + last_error) is what makes the miss DURABLE
        // instead of a line in the logs: listFailedAutomations and the outreach_failures Ops tool
        // read exactly that, so Irises can own the gap when the user asks. 'failed' rows are never
        // re-claimable, so this can't resurrect the send.
        await failAutomation(a, msg);
      }
    }
  }
}

// Hourly janitor piggybacked on the runner tick: hard-delete short-term memory rows well
// past expiry (the 48h grace keeps ≥24h of context available for Reflexion's daily pass).
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

function maybeSweepShortTerm(): void {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = Date.now();
  void sweepExpiredShortTerm()
    .then(n => { if (n > 0) console.log(`[memory-short] swept ${n} expired row(s)`); })
    .catch(e => console.error('[memory-short] sweep failed', e));
}

export function startAutonome(sendFollowUp: SendFollowUp): void {
  if (process.env.AUTONOME_ENABLED === 'false') {
    console.log('[autonome] disabled (AUTONOME_ENABLED=false)');
    return;
  }
  console.log(`[autonome] starting — every ${Math.round(INTERVAL_MS / 1000)}s`);
  // First pass shortly after boot, then on the interval.
  setTimeout(() => {
    void runAutonomeOnce(sendFollowUp).catch(e => console.error('[autonome] tick failed', e));
    maybeSweepShortTerm();
  }, 10_000);
  setInterval(() => {
    void runAutonomeOnce(sendFollowUp).catch(e => console.error('[autonome] tick failed', e));
    maybeSweepShortTerm();
  }, INTERVAL_MS);
}

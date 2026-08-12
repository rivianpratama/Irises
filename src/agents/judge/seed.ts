// Seeds the per-user DAILY email-digest row (source='judge_daily', cron at JUDGE_DIGEST_HOUR local,
// default 08:00). Modeled on ensureReflexionDaily: called fire-and-forget from the Convo turn path,
// idempotent (stable dedupe key + hourly throttle), retimed in place when tz or primary chat drifts.
// A user who never texts never gets a row; the runtime pass (runDailyJudgePass) layers a 3-day
// inactivity gate on top. Reflexion stays at local midnight — this row is independent.
import { createAutomation, retimeAutomation } from '../../db/repositories/automations.js';
import { getPreference } from '../../db/repositories/memory.js';
import { DEFAULT_TZ } from '../../pipeline/zonedTime.js';
import { dailyJitterMinute } from '../reflexion/seed.js';

export const JUDGE_DAILY_KEY = 'judge:daily';

// Boot-cheap: at most one real pass per handle per hour; every other call is a Map lookup.
const THROTTLE_MS = 60 * 60 * 1000;
const lastEnsured = new Map<string, number>();

function isValidIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Global kill switch for the whole daily-digest feature. */
export function judgeDailyEnabled(): boolean {
  return process.env.JUDGE_DAILY_ENABLED !== 'false';
}

/**
 * Ensure this user's daily email-digest automation exists and matches their current timezone and
 * primary chat. Idempotent (stable dedupe key + hourly throttle); fire-and-forget at the call site —
 * a scheduling hiccup must never touch the live turn.
 */
export async function ensureJudgeDaily(handle: string, chatId: string): Promise<void> {
  if (!judgeDailyEnabled()) return;
  const now = Date.now();
  if (now - (lastEnsured.get(handle) ?? 0) < THROTTLE_MS) return;
  lastEnsured.set(handle, now);

  try {
    // Timezone: an explicit agent_tz wins; else the default. (Same resolution as ensureReflexionDaily —
    // no location inference, and DEFAULT_TZ is the honest fallback.)
    let tz = await getPreference<string>(handle, 'agent_tz');
    if (!tz || !isValidIana(tz)) tz = DEFAULT_TZ;

    const hour = Number(process.env.JUDGE_DIGEST_HOUR || 8);
    const cron = `${dailyJitterMinute(handle)} ${hour} * * *`;
    const created = await createAutomation({
      agentHandle: handle,
      chatId,
      source: 'judge_daily',
      title: 'daily email digest',
      instruction: 'daily email digest pass',
      needsOps: false,
      scheduleKind: 'cron',
      cron,
      timezone: tz,
      // false so the row fires at the chosen morning hour rather than being deferred by quiet hours.
      respectQuietHours: false,
      dedupeKey: JUDGE_DAILY_KEY,
    });
    // createAutomation returns the EXISTING row on dedupe — reconcile tz/chat drift in place.
    if (created && (created.timezone !== tz || created.chatId !== chatId)) {
      await retimeAutomation(handle, JUDGE_DAILY_KEY, tz, chatId);
    }
  } catch (err) {
    console.error(`[judge-daily] ensureJudgeDaily failed for ${handle}`, err);
  }
}

// Seeding + retiming the per-user DAILY reflection row (source='reflexion', cron at local
// midnight). Called fire-and-forget from the Convo turn path (beside ensureChatId) — the one
// place a real chatId is guaranteed, so a user who never texts simply never gets a row.
//
// Timezone: prefs.agent_tz (IANA) with DEFAULT_TZ fallback; the row is retimed in place when
// the tz (or primary chat) changes. The fire minute is a stable per-user jitter in 00:00–00:29
// local — still "midnight local" for the review-the-day semantics, but N same-tz users don't
// all claim in one 60s runner tick and stack Opus runs.

import { createHash } from 'node:crypto';
import { createAutomation, retimeAutomation } from '../../db/repositories/automations.js';
import { getPreference } from '../../db/repositories/memory.js';
import { DEFAULT_TZ } from '../../pipeline/zonedTime.js';
import { reflexionEnabled } from './client.js';

export const REFLEXION_DAILY_KEY = 'reflexion:daily';

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

/** Stable per-user minute in 0–29 (sha1 of the handle), so the daily cron is '<m> 0 * * *'. */
export function dailyJitterMinute(handle: string): number {
  const digest = createHash('sha1').update(handle).digest();
  return digest[0] % 30;
}

/**
 * Ensure this user's daily reflection automation exists and matches their current timezone and
 * primary chat. Idempotent (stable dedupe key + hourly throttle); fire-and-forget at the call
 * site — a scheduling hiccup must never touch the live turn.
 */
export async function ensureReflexionDaily(handle: string, chatId: string): Promise<void> {
  if (!reflexionEnabled()) return;
  const now = Date.now();
  if (now - (lastEnsured.get(handle) ?? 0) < THROTTLE_MS) return;
  lastEnsured.set(handle, now);

  try {
    // Timezone: an explicit agent_tz wins; else the default. (No location inference — an explicit
    // agent_tz preference is the one signal, and DEFAULT_TZ is the honest fallback.)
    let tz = await getPreference<string>(handle, 'agent_tz');
    if (!tz || !isValidIana(tz)) tz = DEFAULT_TZ;

    const cron = `${dailyJitterMinute(handle)} 0 * * *`;
    const created = await createAutomation({
      agentHandle: handle,
      chatId,
      source: 'reflexion',
      title: 'daily memory reflection',
      instruction: 'daily reflection pass',
      needsOps: false,
      scheduleKind: 'cron',
      cron,
      timezone: tz,
      // MUST be false: the quiet-hours gate would defer a 00:00 fire to 8am (automations.ts).
      respectQuietHours: false,
      dedupeKey: REFLEXION_DAILY_KEY,
    });
    // createAutomation returns the EXISTING row on dedupe — reconcile tz/chat drift in place
    // (recomputes next_run_at for the new zone; no-op when nothing changed).
    if (created && (created.timezone !== tz || created.chatId !== chatId)) {
      await retimeAutomation(handle, REFLEXION_DAILY_KEY, tz, chatId);
    }
  } catch (err) {
    console.error(`[reflexion] ensureReflexionDaily failed for ${handle}`, err);
  }
}

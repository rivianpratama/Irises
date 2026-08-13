// Retention timers for the local store — the sweeps that keep a small VM's disk
// bounded. The error-log and turn-history prunes live with their own modules
// (startErrorLogPruneTimer / startHistoryPruneTimer); this covers everything else:
//
//   hourly : memory_short hard-delete past expiry+grace (the sweep that lost its
//            runner when the Autonome tick was removed — restored here)
//   daily  : messages / sent_messages / inbound_messages past their 7d windows
//            (reads already filter; this reclaims the rows), token_usage past
//            TOKEN_USAGE_MAX_AGE_DAYS (default 90 — the ledger was unbounded),
//            and LONG revision files beyond the newest 50 per handle
//
// All timers are unref'd and idempotent to arm; every sweep is best-effort and
// must never take the process down.

import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from './client.js';
import { stmt } from './sqlite.js';
import { irisesHome } from './stateDir.js';
import { sweepExpiredShortTerm } from './repositories/memoryShort.js';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const TOKEN_USAGE_MAX_AGE_DAYS = Number(process.env.TOKEN_USAGE_MAX_AGE_DAYS || 90);
export const LONG_REVISIONS_KEEP = 50;

function sweepDaily(): void {
  const now = Date.now();
  try {
    const messages = Number(stmt('DELETE FROM messages WHERE created_at <= ?').run(now - SEVEN_DAYS_MS).changes);
    const sent = Number(stmt('DELETE FROM sent_messages WHERE created_at <= ?').run(now - SEVEN_DAYS_MS).changes);
    const inbound = Number(stmt('DELETE FROM inbound_messages WHERE created_at <= ?').run(now - SEVEN_DAYS_MS).changes);
    const usage = Number(stmt('DELETE FROM token_usage WHERE created_at <= ?').run(now - TOKEN_USAGE_MAX_AGE_DAYS * DAY_MS).changes);
    const revisions = sweepLongRevisions();
    const total = messages + sent + inbound + usage + revisions;
    if (total > 0) {
      console.log(`[retention] daily sweep: ${messages} messages, ${sent} sent, ${inbound} inbound, ${usage} usage rows, ${revisions} long revisions`);
    }
  } catch (error) {
    logDbError('retention daily sweep', error);
  }
}

/** Cap LONG revision files at the newest N per handle (the tier itself never deletes). */
function sweepLongRevisions(): number {
  let removed = 0;
  const memories = path.join(irisesHome(), 'memories');
  let handles: string[];
  try {
    handles = fs.readdirSync(memories);
  } catch {
    return 0; // no memories dir yet
  }
  for (const dir of handles) {
    const revDir = path.join(memories, dir, 'revisions');
    let names: string[];
    try {
      names = fs.readdirSync(revDir);
    } catch {
      continue;
    }
    const versions = names
      .map(n => n.match(/^LONG\.v(\d+)\.md$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ name: m[0], v: Number(m[1]) }))
      .sort((a, b) => b.v - a.v);
    for (const { name } of versions.slice(LONG_REVISIONS_KEEP)) {
      try {
        fs.rmSync(path.join(revDir, name));
        removed++;
      } catch { /* best-effort */ }
    }
  }
  return removed;
}

let armed = false;

/** Called once from src/index.ts at boot. */
export function startRetentionTimers(): void {
  if (armed) return;
  armed = true;
  const boot = setTimeout(() => {
    void sweepExpiredShortTerm().then(n => {
      if (n > 0) console.log(`[retention] short-term sweep: ${n} expired rows`);
    });
    sweepDaily();
  }, 60_000);
  (boot as { unref?: () => void }).unref?.();

  const hourly = setInterval(() => {
    void sweepExpiredShortTerm().then(n => {
      if (n > 0) console.log(`[retention] short-term sweep: ${n} expired rows`);
    });
  }, HOUR_MS);
  (hourly as { unref?: () => void }).unref?.();

  const daily = setInterval(sweepDaily, DAY_MS);
  (daily as { unref?: () => void }).unref?.();
}

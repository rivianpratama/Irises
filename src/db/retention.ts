// Retention timers for the local store — the sweeps that keep a small VM's disk
// bounded. The error-log and turn-history prunes live with their own modules
// (startErrorLogPruneTimer / startHistoryPruneTimer); this covers everything else:
//
//   hourly : memory_short hard-delete past expiry+grace (the sweep that lost its
//            runner when the Autonome tick was removed — restored here)
//   daily  : messages / sent_messages / inbound_messages past their 7d windows
//            (reads already filter; this reclaims the rows), token_usage past
//            TOKEN_USAGE_MAX_AGE_DAYS (default 90 — the ledger was unbounded),
//            LONG revision files beyond the newest 50 per handle, and the
//            per-handle memory_archive cap
//
// Messages are pruned through the repository (pruneMessagesBefore) so they land in
// memory_archive on the way out; short-term rows archive themselves in their sweep.
//
// All timers are unref'd and idempotent to arm; every sweep is best-effort and
// must never take the process down.

import fs from 'node:fs';
import path from 'node:path';
import { logDbError } from './client.js';
import { stmt } from './sqlite.js';
import { irisesHome } from './stateDir.js';
import { sweepExpiredShortTerm } from './repositories/memoryShort.js';
import { sweepOldProactive } from './repositories/proactive.js';
import { sweepOldOpsTasks } from './repositories/opsTasks.js';
import { sweepArchiveCaps } from './repositories/memoryArchive.js';
import { pruneMessagesBefore } from './repositories/conversations.js';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const TOKEN_USAGE_MAX_AGE_DAYS = Number(process.env.TOKEN_USAGE_MAX_AGE_DAYS || 90);
export const LONG_REVISIONS_KEEP = 50;

function sweepDaily(): void {
  const now = Date.now();
  // Messages go through the repository so they are ARCHIVED on the way out (the same path
  // addMessage's inline prune uses). sent/inbound are threading indexes whose content
  // duplicates the messages rows, so they are plain deletes.
  void pruneMessagesBefore(now - SEVEN_DAYS_MS).then(n => {
    if (n > 0) console.log(`[retention] daily sweep: ${n} messages (archived first)`);
  });
  try {
    const sent = Number(stmt('DELETE FROM sent_messages WHERE created_at <= ?').run(now - SEVEN_DAYS_MS).changes);
    const inbound = Number(stmt('DELETE FROM inbound_messages WHERE created_at <= ?').run(now - SEVEN_DAYS_MS).changes);
    const usage = Number(stmt('DELETE FROM token_usage WHERE created_at <= ?').run(now - TOKEN_USAGE_MAX_AGE_DAYS * DAY_MS).changes);
    const revisions = sweepLongRevisions();
    const total = sent + inbound + usage + revisions;
    if (total > 0) {
      console.log(`[retention] daily sweep: ${sent} sent, ${inbound} inbound, ${usage} usage rows, ${revisions} long revisions`);
    }
  } catch (error) {
    logDbError('retention daily sweep', error);
  }
  // Per-handle archive cap (the repository owns its own error handling). The per-insert
  // enforcement only sees handles still being written to; this catches the ones that went quiet.
  void sweepArchiveCaps().then(n => {
    if (n > 0) console.log(`[retention] archive sweep: ${n} over-cap rows`);
  });
  // Settled proactive-delivery rows past 7d (the repository owns its own error handling). Pending
  // rows are never swept — a quiet-hours deferral must survive until its morning arrives.
  void sweepOldProactive().then(n => {
    if (n > 0) console.log(`[retention] proactive sweep: ${n} settled delivery rows`);
  });
  // Settled ops-task rows past 7d. Open rows (running, retrying, waiting on an approval) are never
  // swept here — the stranded-run horizon and the approval TTL are what retire those, and a row
  // deleted before either got to it would take the only record of a cut-off run with it.
  void sweepOldOpsTasks().then(n => {
    if (n > 0) console.log(`[retention] ops-task sweep: ${n} settled task rows`);
  });
}

/** Cap LONG revision files at the newest N per handle (the tier itself never deletes). Deliberately
 *  NOT archived: the HEAD doc is never lost, and revisions are near-duplicates of each other — cold
 *  copies of 50 overlapping drafts would swamp every recall search with the same paragraphs. */
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

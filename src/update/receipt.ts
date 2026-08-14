// The update receipt — scripts/update.sh writes $IRISES_HOME/update-receipt.json after a successful
// apply; the server consumes it on the next boot to voice a "got my upgrades" confirmation.
//
// consumeUpdateReceipt() renames the file BEFORE returning it (into $IRISES_HOME/updates/, which
// doubles as an update history). Rename-first makes the read at-most-once: a crash mid-voicing loses
// one confirmation rather than ever repeating it on the following boot.

import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { readTextIfExists } from '../db/files.js';
import { irisesHome, ensureDir } from '../db/stateDir.js';
import { reportError } from '../diagnostics/errorLog.js';

export interface UpdateReceipt {
  oldSha: string;
  newSha: string;
  branch?: string;
  appliedAt: string;
  /** `git log --oneline old..new` subjects — DEV copy, so only ever voiced (never relayed verbatim). */
  changes: string[];
}

function receiptPath(): string {
  return join(irisesHome(), 'update-receipt.json');
}

/**
 * Read + archive the pending receipt, or null if there is none. Malformed JSON is archived as
 * `update-receipt.bad.json` and reported. Never throws.
 */
export function consumeUpdateReceipt(): UpdateReceipt | null {
  const p = receiptPath();
  let raw: string | null;
  try {
    raw = readTextIfExists(p);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: UpdateReceipt | null = null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o && typeof o.oldSha === 'string' && typeof o.newSha === 'string') {
      parsed = {
        oldSha: o.oldSha,
        newSha: o.newSha,
        branch: typeof o.branch === 'string' ? o.branch : undefined,
        appliedAt: typeof o.appliedAt === 'string' ? o.appliedAt : new Date().toISOString(),
        changes: Array.isArray(o.changes) ? o.changes.filter((c): c is string => typeof c === 'string').slice(0, 50) : [],
      };
    }
  } catch {
    parsed = null;
  }

  try {
    if (parsed) {
      const dir = ensureDir(join(irisesHome(), 'updates'));
      renameSync(p, join(dir, `applied-${parsed.newSha.slice(0, 7)}-${Date.now()}.json`));
    } else {
      renameSync(p, join(irisesHome(), 'update-receipt.bad.json'));
    }
  } catch { /* best-effort; a failed rename may re-read next boot, acceptable */ }

  if (!parsed) {
    reportError({ source: 'process', category: 'update_receipt', severity: 'warn', message: 'malformed update-receipt.json — archived as .bad', trace: false });
  }
  return parsed;
}

/**
 * Announce the upgrade only when the running build actually IS the receipt's target. A mismatch
 * (build failed, wrong process relaunched) means the upgrade didn't take — voicing "got my upgrades"
 * would be a lie. `null` running sha (unknown build) gets the benefit of the doubt. Pure.
 */
export function shouldAnnounceReceipt(r: UpdateReceipt, runningSha: string | null): boolean {
  if (!runningSha) return true;
  return runningSha.toLowerCase() === r.newSha.toLowerCase();
}

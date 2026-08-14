// The update checker — a boot-armed periodic poll of the GitHub remote for new commits on this
// clone's branch. It reads refs only (`git ls-remote`); it never touches the worktree, never pulls,
// never restarts. Applying an update stays the operator's explicit `scripts/update.sh`.
//
// `git ls-remote` (not the GitHub API) because: zero new deps, no tokens or rate limits, it checks
// the ACTUAL remote the operator will pull from (forks and private mirrors included), and it degrades
// to a plain network error when offline instead of a 4xx to interpret.
//
// The checker must never crash the server and never spam errors when offline — a laptop that closes
// its lid should produce at most one folded warn row per outage, not one per tick.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { reportError } from '../diagnostics/errorLog.js';
import { getVersion, repoRoot, type VersionInfo } from './version.js';
import { recordCheck } from './state.js';

const execFileAsync = promisify(execFile);

export interface UpdateStatus {
  current: VersionInfo;
  remoteSha: string | null;
  updateAvailable: boolean;
  lastCheckAt: number | null;
  lastCheckOk: boolean;
}

const DEFAULT_INTERVAL_MS = 6 * 3600_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_DELAY_MS = 60_000;
const LS_REMOTE_TIMEOUT_MS = 15_000;
const IS_ANCESTOR_TIMEOUT_MS = 5_000;
const WARN_AFTER_CONSECUTIVE = 3;

let liveStatus: Omit<UpdateStatus, 'current'> = {
  remoteSha: null,
  updateAvailable: false,
  lastCheckAt: null,
  lastCheckOk: false,
};
let consecutiveFailures = 0;
let armed = false;
let onDetected: ((sha: string) => void) | null = null;

/** In-memory snapshot for /health, the dashboard, and the weave gate. Cheap; no disk read. */
export function getUpdateStatus(): UpdateStatus {
  return { current: getVersion(), ...liveStatus };
}

function branchTarget(): string {
  const env = (process.env.UPDATE_CHECK_BRANCH ?? '').trim();
  return env || getVersion().branch || 'main';
}

export interface CheckerSeams {
  current?: VersionInfo;
  lsRemote?: (branch: string) => Promise<string | null>;
  isAncestorOfRunning?: (remoteSha: string, runningSha: string) => Promise<boolean | null>;
  onDetected?: (sha: string) => void;
}

async function defaultLsRemote(branch: string): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--quiet', 'origin', `refs/heads/${branch}`], {
    cwd: repoRoot(),
    timeout: LS_REMOTE_TIMEOUT_MS,
  });
  const line = stdout.split('\n').find(l => l.trim().length > 0);
  if (!line) return null;
  const sha = line.split(/\s+/)[0]?.trim().toLowerCase();
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// Ancestry is checked against the RUNNING BUILD's sha, NOT the worktree HEAD. After `git pull` but
// before a restart, HEAD has already advanced to the new commit while the process still runs the old
// build — checking against HEAD would then report "already have it" and wrongly clear updateAvailable
// for the whole pulled-but-not-restarted window. Comparing against the running build keeps the
// "update pending" signal true until the new build is actually live, and still handles the
// local-dev-ahead case (the running build contains the older remote sha → not an update).
async function defaultIsAncestorOfRunning(remoteSha: string, runningSha: string): Promise<boolean | null> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', remoteSha, runningSha], { cwd: repoRoot(), timeout: IS_ANCESTOR_TIMEOUT_MS });
    return true; // exit 0 → remote sha is already contained in the running build → not an update
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return false; // exit 1 → remote has commits the running build lacks → genuine update
    return null; // exit 128 (object not present locally) or anything else → inconclusive
  }
}

/**
 * Run one check. Exported for tests, which inject the git/network seams. Never throws: a failure is
 * caught, marked (lastCheckOk=false), and reported only once it has failed WARN_AFTER_CONSECUTIVE
 * times in a row (then stays quiet until a success resets the counter).
 */
export async function checkOnce(deps: CheckerSeams = {}): Promise<void> {
  const current = deps.current ?? getVersion();
  const lsRemote = deps.lsRemote ?? defaultLsRemote;
  const isAncestor = deps.isAncestorOfRunning ?? defaultIsAncestorOfRunning;
  const fire = deps.onDetected ?? onDetected;
  try {
    const remoteSha = await lsRemote(branchTarget());
    let updateAvailable = false;
    if (remoteSha && current.sha && remoteSha !== current.sha.toLowerCase()) {
      const anc = await isAncestor(remoteSha, current.sha.toLowerCase());
      // true  → remote sha already contained in the RUNNING build (we're ahead / local dev) → NOT an update
      // false → remote has commits the running build lacks → update
      // null  → object not present locally → treat as an update
      updateAvailable = anc !== true;
    }
    const prevRemote = liveStatus.remoteSha;
    recordCheck(remoteSha, true);
    liveStatus = { remoteSha, updateAvailable, lastCheckAt: Date.now(), lastCheckOk: true };
    consecutiveFailures = 0;
    if (updateAvailable && remoteSha && remoteSha !== prevRemote && fire) {
      try { void Promise.resolve(fire(remoteSha)).catch(() => { /* announcer owns its own errors */ }); }
      catch { /* a throwing sync callback must not fail the check */ }
    }
  } catch (err) {
    consecutiveFailures++;
    recordCheck(null, false);
    liveStatus = { ...liveStatus, lastCheckAt: Date.now(), lastCheckOk: false };
    if (consecutiveFailures === WARN_AFTER_CONSECUTIVE) {
      reportError({
        source: 'process',
        category: 'update_check',
        severity: 'warn',
        err,
        message: `update check failed ${WARN_AFTER_CONSECUTIVE}x consecutively (offline, or no reachable remote?)`,
        trace: false,
      });
    } else {
      console.log(`[update] check failed (${consecutiveFailures}x): ${(err as Error)?.message ?? err}`);
    }
  }
}

/** Arm the periodic checker once, at boot. Idempotent. Silently disables itself when there is
 *  nothing to check (opted out, no .git, or own build unknown). */
export function startUpdateChecker(deps: { onUpdateDetected: (remoteSha: string) => void }): void {
  if (armed) return;
  if ((process.env.UPDATE_CHECK_ENABLED ?? 'true') === 'false') {
    console.log('[update] checker disabled (UPDATE_CHECK_ENABLED=false)');
    return;
  }
  if (!existsSync(join(repoRoot(), '.git'))) {
    console.log('[update] no .git at the repo root — update checker disabled (non-git install, e.g. Docker)');
    return;
  }
  if (!getVersion().sha) {
    console.log('[update] own build sha unknown — update checker disabled');
    return;
  }
  armed = true;
  onDetected = deps.onUpdateDetected;
  // Number('6h') / Number('21_600_000') → NaN, and Math.max(MIN, NaN) → NaN → setInterval(NaN) fires
  // every ~1ms. Only accept a finite positive number; anything else falls back to the default.
  const parsed = Number(process.env.UPDATE_CHECK_INTERVAL_MS);
  const interval = Math.max(MIN_INTERVAL_MS, Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS);
  const boot = setTimeout(() => { void checkOnce(); }, FIRST_CHECK_DELAY_MS);
  (boot as { unref?: () => void }).unref?.();
  const timer = setInterval(() => { void checkOnce(); }, interval);
  (timer as { unref?: () => void }).unref?.();
  console.log(`[update] checker armed — first check in ${Math.round(FIRST_CHECK_DELAY_MS / 1000)}s, then every ${Math.round(interval / 60000)}min (branch ${branchTarget()})`);
}

export function _resetCheckerForTests(): void {
  liveStatus = { remoteSha: null, updateAvailable: false, lastCheckAt: null, lastCheckOk: false };
  consecutiveFailures = 0;
  armed = false;
  onDetected = null;
}

/** Test seam: drive the in-memory status the weave/health/dashboard read from. */
export function _setUpdateStatusForTests(partial: Partial<Omit<UpdateStatus, 'current'>>): void {
  liveStatus = { ...liveStatus, ...partial };
}

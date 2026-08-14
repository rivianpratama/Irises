// Chat-triggered self-update — the user tells Irises (in chat) to update itself, and Irises runs the
// whole flow with no terminal: it spawns scripts/update.sh --yes --restart DETACHED (so the updater
// outlives Irises restarting itself), acks immediately, and the boot-time receipt voices the
// "got my upgrades" confirmation once the new build is live.
//
// Authorization: single-user by design (one person owns one engine instance), so ANY chat may
// trigger it — gated only by UPDATE_SELF_ENABLED (default on). If bridge mode is ever used to front
// OTHER people's chats, set UPDATE_SELF_ENABLED=false, or a fronted contact could trigger a rebuild.
//
// Feedback: the immediate ack is Convo's own bubble (or the returned Outcome as a fallback). The
// success confirmation rides the existing receipt announce after the restart. For the paths that do
// NOT restart — "already current" (noop) or a build/preflight failure — update.sh writes
// $IRISES_HOME/update-status.json, and a bounded watcher on this (still-alive) process voices it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './version.js';
import { irisesHome, ensureDir } from '../db/stateDir.js';
import { driver } from '../db/client.js';
import { reportError } from '../diagnostics/errorLog.js';
import { voiceOutcome } from '../agents/fallfirm/client.js';
import type { Outcome } from '../agents/fallfirm/floor.js';
import type { SendFollowUp } from '../agents/orchestrator.js';

const WATCH_TIMEOUT_MS = 20 * 60_000;   // covers a slow cold `npm ci` + build + web build before giving up
const WATCH_INTERVAL_MS = 3_000;

let sendFollowUpRef: SendFollowUp | null = null;

/** Wire the outbound follow-up path (called once at boot) so the status watcher can voice back. */
export function initSelfUpdate(deps: { sendFollowUp: SendFollowUp }): void {
  sendFollowUpRef = deps.sendFollowUp;
}

export function selfUpdateEnabled(): boolean {
  return (process.env.UPDATE_SELF_ENABLED ?? 'true') !== 'false';
}

function statusFilePath(): string {
  return join(irisesHome(), 'update-status.json');
}

export interface SelfUpdateSeams {
  /** Test seam: replaces the real detached spawn. */
  spawnUpdater?: () => void;
}

/**
 * Handle an "update yourself" chat request. Gates, spawns the detached updater, arms the status
 * watcher, and returns the Outcome to voice right now (an "on it" ack, or a reason it can't).
 * Never throws.
 */
export async function requestSelfUpdate(chatId: string, handle?: string, seams: SelfUpdateSeams = {}): Promise<Outcome> {
  if (!selfUpdateEnabled()) {
    return { kind: 'failed', summary: 'updating yourself from chat is switched off right now', nextStep: 'it can be turned back on in the config, or you can update from the machine directly' };
  }
  // Environment guards (skipped when a test injects the spawn, which is explicitly driving the flow).
  if (!seams.spawnUpdater) {
    if (driver === 'memory') {
      return { kind: 'failed', summary: "this is an ephemeral run, so there's no install here to update" };
    }
    if (!fs.existsSync(join(repoRoot(), '.git'))) {
      return { kind: 'failed', summary: "you're not running from a git install, so you can't self-update this way", nextStep: 'an image/Docker install updates by rebuilding the image instead' };
    }
  }

  const spawnedAt = Date.now();
  try { fs.rmSync(statusFilePath(), { force: true }); } catch { /* best-effort — clear any stale status */ }
  try {
    if (seams.spawnUpdater) seams.spawnUpdater();
    else defaultSpawn();
  } catch (err) {
    reportError({ source: 'process', category: 'self_update', severity: 'error', err, chatId, message: 'failed to spawn the self-updater', trace: false });
    return { kind: 'failed', summary: "couldn't kick off the update just now", nextStep: 'try again in a bit, or update from the machine directly' };
  }
  armStatusWatcher(chatId, handle, spawnedAt);
  return {
    kind: 'confirmed',
    summary: "you're checking for a new version and will pull + restart yourself if there is one — say you're on it, brief and warm, and that you'll be back in a moment if you do restart",
  };
}

function defaultSpawn(): void {
  const logDir = ensureDir(join(irisesHome(), 'logs'));
  const out = fs.openSync(join(logDir, 'self-update.log'), 'a');
  try {
    const child = spawn('bash', [join(repoRoot(), 'scripts', 'update.sh'), '--yes', '--restart'], {
      cwd: repoRoot(),
      detached: true,           // own session, so killing this server (during the restart) won't kill it
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
  } finally {
    // The child inherited its OWN dup of the fd during spawn; close the parent's copy so a noop/failure
    // (non-restart) invocation doesn't leak an fd in the long-lived server on every "update yourself".
    fs.closeSync(out);
  }
}

interface UpdateStatus { ok?: boolean; phase?: string; at?: number }

/** Bounded poll for update-status.json. Voices the terminal state for the non-restart paths (noop /
 *  failure). On a successful apply the process is replaced, so this watcher dies and the boot-time
 *  receipt announce voices the success instead. */
function armStatusWatcher(chatId: string, handle: string | undefined, spawnedAt: number): void {
  const deadline = spawnedAt + WATCH_TIMEOUT_MS;
  const tick = (): void => {
    if (Date.now() > deadline) return; // give up quietly — an apply success is covered by the receipt
    let status: UpdateStatus | null = null;
    try { status = JSON.parse(fs.readFileSync(statusFilePath(), 'utf8')) as UpdateStatus; } catch { /* not written yet */ }
    if (status && typeof status.at === 'number' && status.at >= spawnedAt) {
      try { fs.rmSync(statusFilePath(), { force: true }); } catch { /* best-effort */ }
      void voiceStatus(chatId, handle, status);
      return;
    }
    const t = setTimeout(tick, WATCH_INTERVAL_MS);
    (t as { unref?: () => void }).unref?.();
  };
  const t = setTimeout(tick, WATCH_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
}

function failureSummary(phase?: string): string {
  const byPhase: Record<string, string> = {
    preflight: "there are uncommitted changes on your machine, so a clean update can't run right now",
    pull: 'your code has drifted from the source, so this one needs a look on the machine directly',
    build: "the new version didn't build cleanly, so you stayed on the current one — nothing broke",
    web: "the new version built but the web client didn't, so you stayed on the current one",
  };
  return byPhase[phase ?? ''] ?? 'the update hit a snag, so you stayed on the current version';
}

/** Map an update-status.json record to the Outcome Fallfirm voices. Pure. */
export function statusToOutcome(status: UpdateStatus): Outcome {
  if (status.ok && status.phase === 'restart') {
    // Pulled + built, but couldn't restart itself (no owned pidfile, or a hands-on run mode).
    return { kind: 'confirmed', summary: 'you grabbed the new version but it needs a restart on the machine to actually run — say so warmly, brief, that you\'ve got the update ready and just need a restart to finish', nextStep: 'a restart on the machine (stop + start) and you\'ll be on the new build' };
  }
  return status.ok
    ? { kind: 'nothing_found', summary: 'there was no new version to pull — say you checked and you\'re already on the latest' }
    : { kind: 'failed', summary: failureSummary(status.phase), nextStep: 'it can be sorted from the machine directly; nothing was lost' };
}

async function voiceStatus(chatId: string, handle: string | undefined, status: UpdateStatus): Promise<void> {
  if (!sendFollowUpRef) return;
  const outcome = statusToOutcome(status);
  try {
    await sendFollowUpRef(chatId, () => voiceOutcome(outcome, chatId, handle ?? ''), {});
  } catch (err) {
    reportError({ source: 'process', category: 'self_update', severity: 'warn', err, chatId, message: 'self-update status voice failed', trace: false });
  }
}

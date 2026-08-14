// Update detection + announcement state — one JSON file under $IRISES_HOME, chosen over a SQLite
// table because scripts/update.sh must write the receipt half as a plain file anyway, so all
// update state stays one file-shaped, operator-inspectable, schema-free concern.
//
//   $IRISES_HOME/update-state.json
//   { remoteSha, remoteSeenAt, lastCheckAt, lastCheckOk, announced: { <sha>: { <chatId>: ts } } }
//
// `announced` is the double-announce guard: claimAnnouncement() is a synchronous test-and-set that
// returns true exactly once per (sha, chatId), so the weave path and the proactive push path both
// claim through it and "weave OR push, never both" is structural, not a timing accident. The map is
// pruned to the current remoteSha on every write, so it never grows without bound.

import { join } from 'node:path';
import { atomicWriteText, readTextIfExists } from '../db/files.js';
import { irisesHome } from '../db/stateDir.js';

export interface UpdateState {
  remoteSha: string | null;
  remoteSeenAt: number | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean;
  /** sha → chatId → epoch ms it was announced. Pruned to the current remoteSha on save. */
  announced: Record<string, Record<string, number>>;
}

// In-process short-circuit so a chat already claimed this run costs no disk read on later turns
// (the weave gate runs on every convo turn while an update sits unapplied). The disk file stays the
// durable record; this is a pure fast-path for repeat negatives within one process.
const claimedThisProcess = new Set<string>();

function statePath(): string {
  return join(irisesHome(), 'update-state.json');
}

function fresh(): UpdateState {
  return { remoteSha: null, remoteSeenAt: null, lastCheckAt: null, lastCheckOk: false, announced: {} };
}

/** Lenient load — a missing or corrupt file yields a fresh state, never a throw. */
export function loadUpdateState(): UpdateState {
  try {
    const raw = readTextIfExists(statePath());
    if (!raw) return fresh();
    const o = JSON.parse(raw) as Partial<UpdateState>;
    return {
      remoteSha: typeof o.remoteSha === 'string' ? o.remoteSha : null,
      remoteSeenAt: typeof o.remoteSeenAt === 'number' ? o.remoteSeenAt : null,
      lastCheckAt: typeof o.lastCheckAt === 'number' ? o.lastCheckAt : null,
      lastCheckOk: o.lastCheckOk === true,
      announced: o.announced && typeof o.announced === 'object' ? (o.announced as Record<string, Record<string, number>>) : {},
    };
  } catch {
    return fresh();
  }
}

/** Persist, pruning `announced` to the current remoteSha only. Best-effort — never throws. */
export function saveUpdateState(s: UpdateState): void {
  try {
    const pruned: UpdateState = {
      ...s,
      announced: s.remoteSha && s.announced[s.remoteSha] ? { [s.remoteSha]: s.announced[s.remoteSha] } : {},
    };
    atomicWriteText(statePath(), JSON.stringify(pruned, null, 2) + '\n');
  } catch (err) {
    console.warn('[update] could not persist update-state.json:', (err as Error)?.message ?? err);
  }
}

/**
 * Record the outcome of one remote check. A newly-seen remoteSha resets remoteSeenAt (and, via the
 * save prune, clears the previous sha's announced map so the new version re-announces).
 */
export function recordCheck(remoteSha: string | null, ok: boolean): void {
  const s = loadUpdateState();
  s.lastCheckAt = Date.now();
  s.lastCheckOk = ok;
  if (ok && remoteSha && s.remoteSha !== remoteSha) {
    s.remoteSha = remoteSha;
    s.remoteSeenAt = Date.now();
  }
  saveUpdateState(s);
}

/**
 * Synchronous test-and-set: true exactly once per (sha, chatId), false forever after. The single
 * gate the weave and push paths share. Callers pass the CURRENT remote sha so the save-time prune
 * (which keeps only remoteSha's map) retains the claim.
 */
export function claimAnnouncement(sha: string, chatId: string): boolean {
  const key = `${sha}:${chatId}`;
  if (claimedThisProcess.has(key)) return false;
  const s = loadUpdateState();
  const forSha = s.announced[sha] ?? {};
  if (forSha[chatId]) {
    claimedThisProcess.add(key);
    return false;
  }
  forSha[chatId] = Date.now();
  s.announced[sha] = forSha;
  // Keep remoteSha aligned with the sha being claimed so the prune retains this map (callers always
  // claim for the live remote, so this is normally a no-op).
  if (s.remoteSha !== sha) s.remoteSha = sha;
  saveUpdateState(s);
  claimedThisProcess.add(key);
  return true;
}

/**
 * Release a claim (the push path calls this when delivery threw, so a dropped note can still recover
 * via the weave on the chat's next turn). Safe to call when nothing was claimed.
 */
export function unclaimAnnouncement(sha: string, chatId: string): void {
  claimedThisProcess.delete(`${sha}:${chatId}`);
  const s = loadUpdateState();
  if (s.announced[sha]?.[chatId]) {
    delete s.announced[sha][chatId];
    saveUpdateState(s);
  }
}

export function _resetStateForTests(): void {
  claimedThisProcess.clear();
  try {
    atomicWriteText(statePath(), JSON.stringify(fresh(), null, 2) + '\n');
  } catch { /* best-effort */ }
}

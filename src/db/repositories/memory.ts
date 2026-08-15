import path from 'node:path';
import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { memoriesDir } from '../stateDir.js';
import { atomicWriteText, readTextIfExists } from '../files.js';

// The legacy memory pair, split by shape: operational prefs (chat_id, agent_tz,
// pending_clarification, recent_media, …) live in the agent_prefs table; the
// LLM-merged dossier prose lives as memories/<handle>/DOSSIER.md — stored
// verbatim (no header line) because it round-trips into prompts as-is.

export interface AgentMemory {
  handle: string;
  dossierMd: string;
  prefs: Record<string, unknown>;
}

/**
 * A free-form, conversationally-learned user preference ("directive") that shapes how
 * Irises behaves across all user-facing agents. The legacy copy lives in prefs.directives
 * (soak-window fallback for buildPreferenceBlock); the first-class rows are the medium
 * tier's kind='directive' entries. Directives govern voice/behavior only; they can never
 * override safety, fidelity, scope, or identity (charter §5.2).
 */
export interface Directive {
  id: string;
  text: string;
  createdAt: number;
}

/**
 * A fact the user explicitly asked Irises to remember (the "forgot → re-ask → flag" loop).
 * Legacy shape for prefs.important_notes; the first-class rows are the medium tier's
 * kind='important_note' entries.
 */
export interface ImportantNote {
  note: string;
  at: number;
}

// Serialize read-modify-write merges per handle WITHIN this process, so concurrent writers
// (a Convo turn, the orchestrator's result handoff, a Judge batch) can't interleave their
// read→merge→upsert and clobber each other's keys. Single-VM, single-process deployment makes
// an in-process lock sufficient; if a second process ever shares IRISES_HOME, this must become
// an flock-style sidecar lock on the memory files. The same single-writer assumption covers the
// SQLite-side merge paths that ride this queue (user_profiles, forget_epochs, memory_archive
// evictions). The one place two Irises processes can genuinely overlap today is a restart, and
// that window is held shut by the updater's pidfile handshake (src/update/pidfile.ts) rather
// than by a lock file here.
//
// NOT re-entrant, by construction: it is a promise-chain queue, so calling withHandleLock for
// the SAME handle from inside a locked section deadlocks (the inner call waits on the outer,
// which waits on the inner). Every function here follows the same shape — private unlocked
// helpers, wrapped ONCE at the export boundary.
const writeLocks = new Map<string, Promise<unknown>>();
// Exported so the tier repositories (memoryMedium/memoryLong) share the SAME per-handle
// queue — a prefs merge and a medium-entry cap eviction for one user never interleave.
export function withHandleLock<T>(handle: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(handle) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(handle, next);
  void next.finally(() => { if (writeLocks.get(handle) === next) writeLocks.delete(handle); });
  return next;
}

function dossierPath(handle: string): string {
  return path.join(memoriesDir(handle), 'DOSSIER.md');
}

/** Prefs row, or null when absent. Throws on read/parse failure — see getMemoryStrict. */
function readPrefsStrict(handle: string): Record<string, unknown> | null {
  const row = stmt('SELECT prefs_json FROM agent_prefs WHERE handle = ?').get(handle) as
    { prefs_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.prefs_json) as Record<string, unknown>;
}

/** Upsert the prefs row with one retry. A false means the write is LOST — logged loudly
 *  because lost learning is silent otherwise. */
function upsertPrefs(handle: string, prefs: Record<string, unknown>): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      stmt(
        `INSERT INTO agent_prefs (handle, prefs_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`
      ).run(handle, JSON.stringify(prefs), Date.now());
      return true;
    } catch (error) {
      if (attempt === 0) logDbError('prefs write failed, retrying once', error);
      else console.error(`[memory] DURABLE WRITE LOST for ${handle} after retry — learned state did not persist`, error);
    }
  }
  return false;
}

export async function getMemory(handle: string): Promise<AgentMemory | null> {
  try {
    return getMemoryStrict(handle);
  } catch (error) {
    logDbError('getMemory', error);
    return null;
  }
}

/**
 * Like getMemory, but a READ FAILURE throws instead of degrading to null. Read-modify-write
 * callers use this: treating a transient read error as "no row" would rebuild the user's
 * prefs from scratch on the next upsert and silently wipe them. Returns null only for a
 * genuinely-absent row (no prefs row AND no dossier file).
 */
function getMemoryStrict(handle: string): AgentMemory | null {
  const prefs = readPrefsStrict(handle);                       // throws on read/parse failure
  const dossierMd = readTextIfExists(dossierPath(handle));     // throws on non-ENOENT
  if (prefs === null && dossierMd === null) return null;
  return { handle, dossierMd: dossierMd ?? '', prefs: prefs ?? {} };
}

// ── /forget epochs (the mid-merge race) ─────────────────────────────────────────────
// The dossier refresh is a long read→LLM→write. A /forget that lands INSIDE that window used
// to be undone seconds later: the merge had already read the pre-forget doc and happily wrote
// it back over the wipe. The epoch is the fence — clearDossier bumps it, and a merge that
// carries a stale epoch aborts instead of resurrecting what the user asked to be forgotten.

/** The handle's forget generation (0 when they've never been forgotten). Sync + fail-soft:
 *  a read error returns 0, which makes the epoch check pass — the wipe-protection is a guard,
 *  never a reason to lose a legitimate write. */
export function getForgetEpoch(handle: string): number {
  try {
    const row = stmt('SELECT epoch FROM forget_epochs WHERE agent_handle = ?').get(handle) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  } catch (error) {
    logDbError('getForgetEpoch', error);
    return 0;
  }
}

/** Advance the handle's forget generation. Sync and lock-FREE on purpose: it is called from
 *  inside clearDossier's locked section (withHandleLock is not re-entrant). */
export function bumpForgetEpoch(handle: string): number {
  try {
    const next = getForgetEpoch(handle) + 1;
    stmt(
      `INSERT INTO forget_epochs (agent_handle, epoch, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_handle) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at`
    ).run(handle, next, Date.now());
    return next;
  } catch (error) {
    logDbError('bumpForgetEpoch', error);
    return 0;
  }
}

/**
 * Write the dossier. `opts.ifForgetEpoch` is the epoch the CALLER read before it started
 * merging: when it no longer matches, a /forget landed mid-merge and this write would undo it,
 * so the save is refused. Returns whether the doc was written.
 */
export async function saveDossier(
  handle: string,
  dossierMd: string,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  return withHandleLock(handle, async () => {
    // Re-read inside the lock: clearDossier's bump also happens under it, so this is the point
    // where "did a forget land while I was thinking?" has a definite answer.
    if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
      console.warn('[memory] dossier save aborted — /forget landed mid-merge');
      return false;
    }
    try {
      atomicWriteText(dossierPath(handle), dossierMd);
      return true;
    } catch (error) {
      console.error(`[memory] DURABLE WRITE LOST for ${handle} — dossier write failed`, error);
      return false;
    }
  });
}

/** Wipe the agent's learned dossier (e.g. on /forget me, or to clear a poisoned scope section).
 *  Preserves operational prefs like chat_id so background jobs can still reach them. */
export async function clearDossier(handle: string): Promise<void> {
  return withHandleLock(handle, async () => {
    // Fence any dossier merge already in flight for this handle (see getForgetEpoch above).
    bumpForgetEpoch(handle);
    let existing: Record<string, unknown> | null;
    try {
      existing = readPrefsStrict(handle);
    } catch (error) {
      console.error(`[memory] read failed — skipping dossier clear for ${handle} to avoid dropping prefs (retry the clear)`, error);
      return;
    }
    const chatId = existing?.chat_id;
    const prefs = chatId ? { chat_id: chatId } : {};
    try {
      upsertPrefs(handle, prefs);
      atomicWriteText(dossierPath(handle), '');
    } catch (error) {
      console.error(`[memory] dossier clear failed for ${handle}`, error);
    }
  });
}

export async function getPreference<T = unknown>(handle: string, key: string): Promise<T | undefined> {
  const m = await getMemory(handle);
  return m?.prefs[key] as T | undefined;
}

/** Record the agent's primary chat so background engine-push deliveries can reach them. */
export async function ensureChatId(handle: string, chatId: string): Promise<void> {
  const m = await getMemory(handle);
  if (m?.prefs?.chat_id === chatId) return;
  await setPreference(handle, 'chat_id', chatId);
}

export async function setPreference(handle: string, key: string, value: unknown): Promise<void> {
  return setPreferences(handle, { [key]: value });
}

/** Merge preference keys in ONE serialized read-modify-write (per-handle lock, retried upsert). */
export async function setPreferences(handle: string, updates: Record<string, unknown>): Promise<void> {
  return withHandleLock(handle, async () => {
    let existing: Record<string, unknown> | null;
    try {
      existing = readPrefsStrict(handle);
    } catch (error) {
      // A failed read must NOT be treated as an empty row: merging onto {} and upserting
      // would wipe every other pref. One lost write beats a wiped row.
      console.error(`[memory] read failed — skipping preference write for ${handle} to avoid wiping prefs`, error);
      return;
    }
    upsertPrefs(handle, { ...(existing ?? {}), ...updates });
  });
}

// NOTE on confidence_level: it is deliberately NOT stored here. It's a per-turn, fast-fluctuating
// self-signal (it can swing 20→90 between two texts), so persisting it to any memory tier would be
// stale the moment it's read. It flows IN-FLIGHT only: Convo's turn score rides on the delegated
// OpsTask (originConfidence) into the Composer's prompt, then evaporates.

// --- Directives (legacy prefs.directives list) ------------------------------------
// Read-only soak-window fallback for buildPreferenceBlock (src/memory/preferences.ts).
// Writes go to the medium tier (memoryMedium.ts addDirective) — the legacy mutators
// were removed with the Supabase backend.

export async function listDirectives(handle: string): Promise<Directive[]> {
  const m = await getMemory(handle);
  const raw = m?.prefs?.directives;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is Directive =>
    !!d && typeof (d as Directive).id === 'string' && typeof (d as Directive).text === 'string');
}

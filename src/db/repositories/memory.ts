import { randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';

export interface AgentMemory {
  handle: string;
  dossierMd: string;
  prefs: Record<string, unknown>;
}

/**
 * A free-form, conversationally-learned user preference ("directive") that shapes how
 * Irises behaves across all user-facing agents. Stored in agent_memory.prefs.directives
 * (JSONB) — see buildPreferenceBlock/sanitizeDirectives in src/memory/preferences.ts for
 * how these are rendered into a prompt and guarded. Directives govern voice/behavior only;
 * they can never override safety, fidelity, scope, or identity (charter §5.2).
 */
export interface Directive {
  id: string;
  text: string;
  createdAt: number;
}

const MAX_DIRECTIVES = 40; // a sane cap so the injected block can't grow unbounded

/**
 * A fact the user explicitly asked Irises to remember (the "forgot → re-ask → flag" loop).
 * Rendered verbatim into every user-facing prompt and never summarized away by the dossier
 * merge — this is the focused, always-on slice of long-term memory.
 */
export interface ImportantNote {
  note: string;
  at: number;
}

const MAX_IMPORTANT_NOTES = 20; // FIFO — old notes age out only when the ledger is full

// Serialize read-modify-write merges per handle WITHIN this process, so concurrent writers
// (a Convo turn, the orchestrator's result handoff, a Judge batch) can't interleave their
// read→merge→upsert and clobber each other's keys. Single-VM deployment makes an in-process
// lock sufficient (same reasoning as emailJudge's runLocks); a second instance would need a
// DB-side merge instead.
const writeLocks = new Map<string, Promise<unknown>>();
// Exported so the tier repositories (memoryMedium/memoryLong) share the SAME per-handle
// queue — a prefs merge and a medium-row cap eviction for one user never interleave.
export function withHandleLock<T>(handle: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(handle) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeLocks.set(handle, next);
  void next.finally(() => { if (writeLocks.get(handle) === next) writeLocks.delete(handle); });
  return next;
}

/**
 * Upsert the memory row with one retry. Returns true on durable success. A false with
 * Supabase configured means the write is LOST on restart (the caller mirrors it in-memory
 * so the session stays coherent) — logged loudly because lost learning is silent otherwise.
 */
async function upsertMemoryRow(row: { handle: string; dossier_md?: string; prefs?: Record<string, unknown> }): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.from('agent_memory').upsert(row, { onConflict: 'handle' });
      if (error) throw error;
      return true;
    } catch (error) {
      if (attempt === 0) {
        logDbError('memory write failed, retrying once', error);
        await new Promise(r => setTimeout(r, 250));
      } else {
        console.error(`[memory] DURABLE WRITE LOST for ${row.handle} after retry — learned state survives this session only`, error);
      }
    }
  }
  return false;
}

export async function getMemory(handle: string): Promise<AgentMemory | null> {
  try {
    return await getMemoryStrict(handle);
  } catch (error) {
    logDbError('getMemory', error);
    return mem.agentMemory.get(handle) ?? null;
  }
}

/**
 * Like getMemory, but a Supabase READ FAILURE throws instead of falling back to the in-process
 * mirror (which is normally EMPTY in supabase mode). Read-modify-write callers use this: treating
 * a transient read error as "no row" would rebuild the user's row from scratch on the next upsert
 * and silently wipe their prefs. Returns null only for a genuinely-absent row.
 */
async function getMemoryStrict(handle: string): Promise<AgentMemory | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from('agent_memory')
      .select('handle, dossier_md, prefs')
      .eq('handle', handle)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { handle: data.handle, dossierMd: data.dossier_md ?? '', prefs: data.prefs ?? {} };
  }
  return mem.agentMemory.get(handle) ?? null;
}

/** Bulk prefs read for the dashboard roster (one .in() query instead of N getMemory calls). */
export async function getPrefsBulk(handles: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!handles.length) return out;
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('agent_memory')
        .select('handle, prefs')
        .in('handle', handles);
      if (error) throw error;
      for (const row of data ?? []) out.set(row.handle as string, (row.prefs as Record<string, unknown>) ?? {});
      return out;
    } catch (error) {
      logDbError('getPrefsBulk', error);
    }
  }
  for (const h of handles) {
    const m = mem.agentMemory.get(h);
    if (m) out.set(h, m.prefs);
  }
  return out;
}

export async function saveDossier(handle: string, dossierMd: string): Promise<void> {
  return withHandleLock(handle, async () => {
    if (await upsertMemoryRow({ handle, dossier_md: dossierMd })) return;
    const existing = mem.agentMemory.get(handle);
    mem.agentMemory.set(handle, { handle, dossierMd, prefs: existing?.prefs ?? {} });
  });
}

/** Wipe the agent's learned dossier (e.g. on /forget me, or to clear a poisoned scope section).
 *  Preserves operational prefs like chat_id so background jobs can still reach them. */
export async function clearDossier(handle: string): Promise<void> {
  return withHandleLock(handle, async () => {
    let existing: AgentMemory | null;
    try {
      existing = await getMemoryStrict(handle);
    } catch (error) {
      console.error(`[memory] read failed — skipping dossier clear for ${handle} to avoid dropping prefs (retry the clear)`, error);
      return;
    }
    const chatId = existing?.prefs?.chat_id;
    const prefs = chatId ? { chat_id: chatId } : {};
    if (await upsertMemoryRow({ handle, dossier_md: '', prefs })) return;
    mem.agentMemory.set(handle, { handle, dossierMd: '', prefs });
  });
}

export async function getPreference<T = unknown>(handle: string, key: string): Promise<T | undefined> {
  const m = await getMemory(handle);
  return m?.prefs[key] as T | undefined;
}

/** Record the agent's primary chat so background jobs (sweeper/poller) can reach them. */
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
    let read: AgentMemory | null;
    try {
      read = await getMemoryStrict(handle);
    } catch (error) {
      // A failed read must NOT be treated as an empty row: merging onto {} and upserting
      // would wipe every other pref. One lost write beats a wiped row.
      console.error(`[memory] read failed — skipping preference write for ${handle} to avoid wiping prefs`, error);
      return;
    }
    const existing = read ?? { handle, dossierMd: '', prefs: {} };
    const prefs = { ...existing.prefs, ...updates };
    if (await upsertMemoryRow({ handle, dossier_md: existing.dossierMd, prefs })) return;
    mem.agentMemory.set(handle, { handle, dossierMd: existing.dossierMd, prefs });
  });
}

// --- Important notes ("remember this" ledger) ------------------------------------
// Facts the user explicitly asked to keep. Rendered verbatim in every user-facing prompt
// (userContext.ts) — never folded into the dossier where a merge could drop them.

export async function listImportantNotes(handle: string): Promise<ImportantNote[]> {
  const m = await getMemory(handle);
  const raw = m?.prefs?.important_notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is ImportantNote => !!n && typeof (n as ImportantNote).note === 'string');
}

/** Append a note (deduped case-insensitively, FIFO-capped). Returns the stored note text. */
export async function addImportantNote(handle: string, note: string): Promise<string | null> {
  const clean = note.trim();
  if (!clean) return null;
  const existing = await listImportantNotes(handle);
  if (existing.some(n => n.note.trim().toLowerCase() === clean.toLowerCase())) return clean;
  const next = [...existing, { note: clean, at: Date.now() }].slice(-MAX_IMPORTANT_NOTES);
  await setPreference(handle, 'important_notes', next);
  return clean;
}

// NOTE on confidence_level: it is deliberately NOT stored here. It's a per-turn, fast-fluctuating
// self-signal (it can swing 20→90 between two texts), so persisting it to any memory tier would be
// stale the moment it's read. It flows IN-FLIGHT only: Convo's turn score rides on the delegated
// OpsTask (originConfidence) into the Composer's prompt, then evaporates.

// --- Directives (free-form learned preferences) ---------------------------------
// Thin wrappers over setPreference that maintain prefs.directives as an ordered list.
// Validation/sanitization of directive TEXT lives in src/memory/preferences.ts; these
// functions only persist what they're given.

export async function listDirectives(handle: string): Promise<Directive[]> {
  const m = await getMemory(handle);
  const raw = m?.prefs?.directives;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is Directive =>
    !!d && typeof (d as Directive).id === 'string' && typeof (d as Directive).text === 'string');
}

/** Append a directive. Returns the created row, or null if it duplicates existing text. */
export async function addDirective(handle: string, text: string): Promise<Directive | null> {
  const clean = text.trim();
  if (!clean) return null;
  const existing = await listDirectives(handle);
  if (existing.some(d => d.text.trim().toLowerCase() === clean.toLowerCase())) return null;
  const directive: Directive = { id: randomUUID(), text: clean, createdAt: Date.now() };
  const next = [...existing, directive].slice(-MAX_DIRECTIVES);
  await setPreference(handle, 'directives', next);
  return directive;
}

/** Replace the text of an existing directive by id. Returns false if not found. */
export async function updateDirective(handle: string, id: string, text: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  const existing = await listDirectives(handle);
  const idx = existing.findIndex(d => d.id === id);
  if (idx === -1) return false;
  existing[idx] = { ...existing[idx], text: clean };
  await setPreference(handle, 'directives', existing);
  return true;
}

/** Remove a directive by id. Returns false if not found. */
export async function removeDirective(handle: string, id: string): Promise<boolean> {
  const existing = await listDirectives(handle);
  const next = existing.filter(d => d.id !== id);
  if (next.length === existing.length) return false;
  await setPreference(handle, 'directives', next);
  return true;
}

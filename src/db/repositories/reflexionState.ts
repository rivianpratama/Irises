// Reflexion agent state — the memory curator's own per-user awareness. The self-prompt is
// the READ-WRITE half of Reflexion's rigid/flexible split (its Context.md values are the
// read-only half); revisions are capped-inline history so a bad self-edit is recoverable.
// Scheduling lives in `automations` (source='reflexion'), not here.

import { getSupabase, logDbError } from '../client.js';
import { withHandleLock } from './memory.js';

export interface SelfPromptRevision {
  md: string;
  note: string;
  at: number; // epoch ms
}

export interface ReflexionState {
  handle: string;
  selfPromptMd: string;
  selfPromptRevs: SelfPromptRevision[];
  lastDailyAt: number | null;
  lastRunAt: number | null;
  migratedAt: number | null;
}

export const SELF_PROMPT_MAX_CHARS = 4000; // a ballooned self-prompt taxes every future run
const MAX_REVISIONS = 10;

// In-memory fallback (dev / degraded), same per-process caveat as every other repo.
const memState = new Map<string, ReflexionState>();

function parseTs(v: string | null | undefined): number | null {
  return v ? Date.parse(v) : null;
}

export async function getReflexionState(handle: string): Promise<ReflexionState | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('reflexion_state')
        .select('*')
        .eq('handle', handle)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        handle: data.handle,
        selfPromptMd: data.self_prompt_md ?? '',
        selfPromptRevs: Array.isArray(data.self_prompt_revs) ? data.self_prompt_revs : [],
        lastDailyAt: parseTs(data.last_daily_at),
        lastRunAt: parseTs(data.last_run_at),
        migratedAt: parseTs(data.migrated_at),
      };
    } catch (error) {
      logDbError('getReflexionState', error);
    }
  }
  return memState.get(handle) ?? null;
}

async function upsertState(handle: string, patch: Record<string, unknown>): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.from('reflexion_state').upsert({ handle, ...patch }, { onConflict: 'handle' });
      if (error) throw error;
      return true;
    } catch (error) {
      if (attempt === 0) {
        logDbError('reflexion-state write failed, retrying once', error);
        await new Promise(r => setTimeout(r, 250));
      } else {
        console.error(`[reflexion-state] DURABLE WRITE LOST for ${handle}`, error);
      }
    }
  }
  return false;
}

function memBase(handle: string): ReflexionState {
  return memState.get(handle) ?? {
    handle, selfPromptMd: '', selfPromptRevs: [], lastDailyAt: null, lastRunAt: null, migratedAt: null,
  };
}

/** Replace the self-prompt, pushing the previous version into the capped revision list. */
export async function saveSelfPrompt(handle: string, md: string, note: string): Promise<void> {
  const clean = md.trim().slice(0, SELF_PROMPT_MAX_CHARS);
  return withHandleLock(handle, async () => {
    const existing = await getReflexionState(handle);
    const revs: SelfPromptRevision[] = existing?.selfPromptMd
      ? [...(existing.selfPromptRevs ?? []), { md: existing.selfPromptMd, note, at: Date.now() }].slice(-MAX_REVISIONS)
      : existing?.selfPromptRevs ?? [];
    if (await upsertState(handle, { self_prompt_md: clean, self_prompt_revs: revs })) return;
    memState.set(handle, { ...memBase(handle), selfPromptMd: clean, selfPromptRevs: revs });
  });
}

/** Stamp a completed run. Daily runs also advance last_daily_at (the skip-if-quiet anchor). */
export async function markRunComplete(handle: string, trigger: 'daily' | 'delegated' | 'self_wake'): Promise<void> {
  return withHandleLock(handle, async () => {
    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = { last_run_at: nowIso };
    if (trigger === 'daily') patch.last_daily_at = nowIso;
    if (await upsertState(handle, patch)) return;
    const base = memBase(handle);
    memState.set(handle, {
      ...base,
      lastRunAt: Date.now(),
      lastDailyAt: trigger === 'daily' ? Date.now() : base.lastDailyAt,
    });
  });
}

/** Set once, after a migration run that actually wrote ≥1 tier entry (the caller checks). */
export async function markMigrated(handle: string): Promise<void> {
  return withHandleLock(handle, async () => {
    if (await upsertState(handle, { migrated_at: new Date().toISOString() })) return;
    memState.set(handle, { ...memBase(handle), migratedAt: Date.now() });
  });
}

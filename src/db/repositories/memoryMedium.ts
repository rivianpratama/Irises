// TIER 2: medium-term memory (weeks–years, operational). Conversationally-learned facts,
// directives, and important notes as first-class rows — replacing the prefs.directives /
// prefs.important_notes JSONB arrays whose read-rebuild-write pattern could silently drop
// a concurrent append. Dedupe and one-active-value-per-fact are DB unique indexes now:
// a racing duplicate INSERT fails with 23505 (treated as "already saved") instead of
// clobbering a sibling.
//
// Ledger discipline: rows are SUPERSEDED (edit/cap-eviction) or RETRACTED (user removal),
// NEVER deleted. The one sanctioned hard-delete is the /forget path (Stage 3's forgetUser).
//
// Failure policy (per the tier table in the revamp plan): FAIL LOUD. This tier is the
// "no error margin" store — when Supabase is configured and a write fails after retries,
// we THROW MediumWriteError so the caller voices "hit a snag" instead of confirming a
// save that only reached a process-local mirror. (When the driver is the in-memory
// backend, the Map IS the store — dev mode, not degradation.) Reads still degrade to []
// with a loud log: a render hiccup must never kill a turn.
//
// Directive/note TEXT validation stays where it lives today — validateDirective /
// sanitizeDirectives in src/memory/preferences.ts. This module only persists.

import { randomUUID } from 'node:crypto';
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import { withHandleLock } from './memory.js';

export type MediumKind = 'fact' | 'directive' | 'important_note';
export type MediumStatus = 'active' | 'superseded' | 'retracted';

export interface MediumEntry {
  id: string;
  agentHandle: string;
  kind: MediumKind;
  key?: string; // fact slot name; undefined for directive/note
  body: string;
  status: MediumStatus;
  supersededBy?: string;
  source: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/** Thrown when a durable medium-tier write fails with Supabase configured. Callers turn
 *  this into a user-visible "saving that hit a snag" — never a phantom confirmation. */
export class MediumWriteError extends Error {
  constructor(scope: string, cause?: unknown) {
    super(`[memory-medium] durable write failed: ${scope}`);
    this.name = 'MediumWriteError';
    this.cause = cause;
  }
}

// Active-row caps, moved from the legacy prefs-array implementation (memory.ts). Enforced
// by superseding the oldest active row after an insert lands — never by refusing the new one.
export const MAX_ACTIVE_DIRECTIVES = 40;
export const MAX_ACTIVE_NOTES = 20;

const WRITE_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1000];

interface MediumRow {
  id: string;
  agent_handle: string;
  kind: MediumKind;
  key: string | null;
  body: string;
  status: MediumStatus;
  superseded_by: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

function fromRow(r: MediumRow): MediumEntry {
  return {
    id: r.id,
    agentHandle: r.agent_handle,
    kind: r.kind,
    key: r.key ?? undefined,
    body: r.body,
    status: r.status,
    supersededBy: r.superseded_by ?? undefined,
    source: r.source,
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
  };
}

function memList(handle: string): MediumEntry[] {
  return mem.memoryMedium.get(handle) ?? [];
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

/** Retry wrapper for durable writes. Throws MediumWriteError after the final attempt. */
async function durably<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw error; // not transient — surface to the caller's dedupe handling
      lastErr = error;
      if (attempt < WRITE_ATTEMPTS - 1) {
        logDbError(`memory-medium ${scope} (attempt ${attempt + 1})`, error);
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] ?? 1000));
      }
    }
  }
  console.error(`[memory-medium] WRITE FAILED after ${WRITE_ATTEMPTS} attempts: ${scope}`, lastErr);
  throw new MediumWriteError(scope, lastErr);
}

/** Active rows for a handle, oldest first (matches the legacy arrays' insertion order). */
export async function listMediumActive(handle: string, kinds?: MediumKind[]): Promise<MediumEntry[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      let q = supabase
        .from('memory_medium')
        .select('*')
        .eq('agent_handle', handle)
        .eq('status', 'active')
        .order('created_at', { ascending: true });
      if (kinds?.length) q = q.in('kind', kinds);
      const { data, error } = await q;
      if (error) throw error;
      return (data as MediumRow[]).map(fromRow);
    } catch (error) {
      logDbError('listMediumActive', error);
      return [];
    }
  }
  return memList(handle)
    .filter(e => e.status === 'active')
    .filter(e => !kinds?.length || kinds.includes(e.kind))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Every row for a handle including superseded/retracted (a lineage/debug view). */
export async function listMediumAll(handle: string): Promise<MediumEntry[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('memory_medium')
        .select('*')
        .eq('agent_handle', handle)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data as MediumRow[]).map(fromRow);
    } catch (error) {
      logDbError('listMediumAll', error);
      return [];
    }
  }
  return [...memList(handle)].sort((a, b) => a.createdAt - b.createdAt);
}

function memInsert(entry: MediumEntry): MediumEntry | null {
  const list = memList(entry.agentHandle);
  // Emulate the partial unique indexes.
  if (entry.kind === 'fact') {
    const existing = list.find(e => e.status === 'active' && e.kind === 'fact' && e.key === entry.key);
    if (existing) {
      if (existing.body === entry.body) return existing;
      existing.status = 'superseded';
      existing.supersededBy = entry.id;
      existing.updatedAt = Date.now();
    }
  } else {
    const dup = list.find(
      e => e.status === 'active' && e.kind === entry.kind && e.body.trim().toLowerCase() === entry.body.trim().toLowerCase(),
    );
    if (dup) return null;
  }
  mem.memoryMedium.set(entry.agentHandle, [...list, entry]);
  return entry;
}

async function insertRow(entry: MediumEntry, scope: string): Promise<MediumEntry | null> {
  const supabase = getSupabase();
  if (!supabase) return memInsert(entry);
  try {
    return await durably(scope, async () => {
      const { data, error } = await supabase
        .from('memory_medium')
        .insert({
          id: entry.id,
          agent_handle: entry.agentHandle,
          kind: entry.kind,
          key: entry.key ?? null,
          body: entry.body,
          source: entry.source,
        })
        .select()
        .single();
      if (error) throw error;
      return fromRow(data as MediumRow);
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null; // active duplicate — already saved
    throw error;
  }
}

/** Supersede the oldest active rows of a kind beyond its cap. Best-effort (a brief
 *  over-cap is harmless — renderers slice too); runs under the caller's handle lock. */
async function enforceCap(handle: string, kind: MediumKind, cap: number, newestId: string): Promise<void> {
  try {
    const active = await listMediumActive(handle, [kind]);
    const excess = active.length - cap;
    if (excess <= 0) return;
    for (const old of active.slice(0, excess)) {
      await retireRow(handle, old.id, 'superseded', newestId);
    }
  } catch (error) {
    console.warn(`[memory-medium] cap enforcement failed for ${handle}/${kind} (over-cap is harmless)`, error);
  }
}

async function retireRow(handle: string, id: string, status: MediumStatus, supersededBy?: string): Promise<boolean> {
  const supabase = getSupabase();
  if (supabase) {
    return durably(`retire:${status}`, async () => {
      const { data, error } = await supabase
        .from('memory_medium')
        .update({ status, superseded_by: supersededBy ?? null })
        .eq('agent_handle', handle)
        .eq('id', id)
        .eq('status', 'active')
        .select('id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    });
  }
  const row = memList(handle).find(e => e.id === id && e.status === 'active');
  if (!row) return false;
  row.status = status;
  row.supersededBy = supersededBy;
  row.updatedAt = Date.now();
  return true;
}

/** Append a directive row. Returns the created row, or null when it duplicates an
 *  active directive (case-insensitive — the DB index is on lower(body)). */
export async function addDirective(handle: string, text: string, source = 'convo'): Promise<MediumEntry | null> {
  const clean = text.trim();
  if (!clean) return null;
  return withHandleLock(handle, async () => {
    const now = Date.now();
    const created = await insertRow(
      { id: randomUUID(), agentHandle: handle, kind: 'directive', body: clean, status: 'active', source, createdAt: now, updatedAt: now },
      'addDirective',
    );
    if (created) await enforceCap(handle, 'directive', MAX_ACTIVE_DIRECTIVES, created.id);
    return created;
  });
}

/** Replace the text of an active directive by id (supersede + insert, one transaction on
 *  Supabase via the RPC). Returns false when the id wasn't found active. */
export async function updateDirective(handle: string, id: string, text: string, source = 'convo'): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  return withHandleLock(handle, async () => {
    const supabase = getSupabase();
    if (supabase) {
      const data = await durably('updateDirective', async () => {
        const { data, error } = await supabase.rpc('memory_medium_supersede', {
          p_handle: handle,
          p_old_id: id,
          p_new_body: clean,
          p_source: source,
        });
        if (error) throw error;
        return data;
      });
      return data != null;
    }
    const old = memList(handle).find(e => e.id === id && e.status === 'active');
    if (!old) return false;
    const now = Date.now();
    const replacement: MediumEntry = {
      id: randomUUID(), agentHandle: handle, kind: old.kind, body: clean, status: 'active', source, createdAt: now, updatedAt: now,
    };
    old.status = 'superseded';
    old.supersededBy = replacement.id;
    old.updatedAt = now;
    mem.memoryMedium.set(handle, [...memList(handle), replacement]);
    return true;
  });
}

/** Soft-remove an active row by id (user asked to drop a preference/note). */
export async function retractEntry(handle: string, id: string): Promise<boolean> {
  return withHandleLock(handle, () => retireRow(handle, id, 'retracted'));
}

/** Retract every active row for a handle (the /forget path's medium-tier sweep). */
export async function retractAllForHandle(handle: string): Promise<void> {
  await withHandleLock(handle, async () => {
    const supabase = getSupabase();
    if (supabase) {
      await durably('retractAllForHandle', async () => {
        const { error } = await supabase
          .from('memory_medium')
          .update({ status: 'retracted' })
          .eq('agent_handle', handle)
          .eq('status', 'active');
        if (error) throw error;
      });
    }
    for (const row of memList(handle)) {
      if (row.status === 'active') {
        row.status = 'retracted';
        row.updatedAt = Date.now();
      }
    }
  });
}

/** Append an important note (deduped case-insensitively, FIFO-capped like the legacy
 *  ledger). Returns the stored text — including on dedupe, so the caller's confirmation
 *  stands either way. */
export async function addImportantNote(handle: string, note: string, source = 'convo'): Promise<string | null> {
  const clean = note.trim();
  if (!clean) return null;
  return withHandleLock(handle, async () => {
    const now = Date.now();
    const created = await insertRow(
      { id: randomUUID(), agentHandle: handle, kind: 'important_note', body: clean, status: 'active', source, createdAt: now, updatedAt: now },
      'addImportantNote',
    );
    if (created) await enforceCap(handle, 'important_note', MAX_ACTIVE_NOTES, created.id);
    return clean;
  });
}

/** Set a structured fact slot (supersede-then-insert atomically on Supabase). No-op when
 *  the value is unchanged. */
export async function upsertFact(handle: string, key: string, body: string, source = 'convo'): Promise<void> {
  const clean = body.trim();
  if (!clean) return;
  return withHandleLock(handle, async () => {
    const supabase = getSupabase();
    if (supabase) {
      await durably('upsertFact', async () => {
        const { error } = await supabase.rpc('memory_medium_upsert_fact', {
          p_handle: handle,
          p_key: key,
          p_body: clean,
          p_source: source,
        });
        if (error) throw error;
      });
      return;
    }
    const now = Date.now();
    memInsert({ id: randomUUID(), agentHandle: handle, kind: 'fact', key, body: clean, status: 'active', source, createdAt: now, updatedAt: now });
  });
}

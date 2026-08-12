// TIER 3: long-term memory — ONE free-form markdown document per user (profile + how
// Irises should chat/behave: the "flexible prompt layer"), with every accepted version
// snapshotted into memory_long_revisions. Nothing is ever lost: a save is a version bump
// plus a revision row, and "clearing" writes an empty doc as a NEW revision.
//
// Concurrency: optimistic. saveLongDoc carries the version the writer read; a stale
// version returns null (no write) and the caller re-reads, re-merges, retries once.
// Writers today: the legacy dossier refresh (dual-write, Stage 1) and Reflexion (Stage 3).
//
// Failure policy: FAIL LOUD like memoryMedium — a lost long-doc write is lost learning.

import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import { withHandleLock } from './memory.js';

export interface LongDoc {
  docMd: string;
  version: number;
}

export interface LongRevision {
  version: number;
  docMd: string;
  writtenBy: string;
  createdAt: number; // epoch ms
}

/** Thrown when a durable long-tier write fails with Supabase configured. */
export class LongWriteError extends Error {
  constructor(scope: string, cause?: unknown) {
    super(`[memory-long] durable write failed: ${scope}`);
    this.name = 'LongWriteError';
    this.cause = cause;
  }
}

function memDoc(handle: string) {
  return mem.memoryLong.get(handle) ?? null;
}

/** The current doc, or null when the user has none yet. Reads degrade to null. */
export async function getLongDoc(handle: string): Promise<LongDoc | null> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('memory_long')
        .select('doc_md, version')
        .eq('agent_handle', handle)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { docMd: data.doc_md ?? '', version: data.version ?? 0 };
    } catch (error) {
      logDbError('getLongDoc', error);
      return null;
    }
  }
  const doc = memDoc(handle);
  return doc ? { docMd: doc.docMd, version: doc.version } : null;
}

/**
 * Save a new doc version. `expectedVersion` is what the writer read (0 for "no doc yet").
 * Returns the new version number, or null on a version conflict — caller re-reads and
 * retries once. Throws LongWriteError when the write itself fails durably.
 */
export async function saveLongDoc(
  handle: string,
  docMd: string,
  expectedVersion: number,
  writtenBy: string,
): Promise<number | null> {
  return withHandleLock(handle, async () => {
    const supabase = getSupabase();
    if (supabase) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data, error } = await supabase.rpc('memory_long_save', {
            p_handle: handle,
            p_doc: docMd,
            p_expected_version: expectedVersion,
            p_written_by: writtenBy,
          });
          if (error) throw error;
          return (data as number | null) ?? null; // null = version conflict, NOT an error
        } catch (error) {
          lastErr = error;
          if (attempt === 0) {
            logDbError('saveLongDoc (attempt 1)', error);
            await new Promise(r => setTimeout(r, 250));
          }
        }
      }
      console.error(`[memory-long] WRITE FAILED for ${handle} — long-doc update lost`, lastErr);
      throw new LongWriteError('saveLongDoc', lastErr);
    }
    const existing = memDoc(handle);
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== expectedVersion) return null;
    const version = currentVersion + 1;
    const revision: LongRevision = { version, docMd, writtenBy, createdAt: Date.now() };
    mem.memoryLong.set(handle, {
      docMd,
      version,
      revisions: [...(existing?.revisions ?? []), revision],
    });
    return version;
  });
}

/** Recent revisions, newest first (Reflexion's history view; nothing renders these). */
export async function listLongRevisions(handle: string, limit = 10): Promise<LongRevision[]> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('memory_long_revisions')
        .select('version, doc_md, written_by, created_at')
        .eq('agent_handle', handle)
        .order('version', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data as Array<{ version: number; doc_md: string; written_by: string; created_at: string }>).map(r => ({
        version: r.version,
        docMd: r.doc_md,
        writtenBy: r.written_by,
        createdAt: Date.parse(r.created_at),
      }));
    } catch (error) {
      logDbError('listLongRevisions', error);
      return [];
    }
  }
  return [...(memDoc(handle)?.revisions ?? [])].sort((a, b) => b.version - a.version).slice(0, limit);
}

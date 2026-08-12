// Local mail search index (the `emails` table). Every message the pipeline fetches — push,
// backstop, sent sweep, backfill — is upserted here, so Ops can search the mailbox with
// substring matching, deterministic ordering, and zero Gmail quota. Gmail's own q search
// stays available as the live escape hatch; this index is what makes "find the email"
// reliable for anything already synced.
import { getSupabase, logDbError } from '../client.js';
import { mem } from '../memory.js';
import type { DealEmail, AttachmentRef } from '../../services/gmail.js';

/** One indexed message. Body capped on write; haystack drives substring search. */
export interface IndexedEmail {
  handle: string;
  id: string;
  threadId: string;
  from: string;
  to: string;             // comma-joined
  subject: string;
  snippet: string;
  bodyText: string;
  haystack: string;       // lower(subject + from + to + body)
  labels: string[];
  attachments: Pick<AttachmentRef, 'filename' | 'mimeType' | 'attachmentId' | 'sizeBytes'>[];
  hasAttachments: boolean;
  internalDate: number;   // epoch ms
}

export interface EmailIndexQuery {
  text?: string;          // free text: every whitespace-separated term must appear (substring, any field)
  from?: string;          // substring of the From header
  to?: string;            // substring of the To list
  subject?: string;       // substring of the subject
  afterMs?: number;       // internalDate > afterMs
  beforeMs?: number;      // internalDate < beforeMs
  hasAttachment?: boolean;
  limit?: number;         // default 20, cap 50
}

export interface EmailIndexStats {
  count: number;
  oldestMs: number | null;
  newestMs: number | null;
}

const BODY_CAP = 20000;

function toIndexed(handle: string, e: DealEmail): IndexedEmail {
  const body = (e.bodyText ?? '').slice(0, BODY_CAP);
  const to = e.to.join(', ');
  return {
    handle,
    id: e.id,
    threadId: e.threadId,
    from: e.from,
    to,
    subject: e.subject,
    snippet: e.snippet,
    bodyText: body,
    haystack: `${e.subject}\n${e.from}\n${to}\n${body}`.toLowerCase(),
    labels: e.labelIds ?? [],
    attachments: e.attachments.map(a => ({
      filename: a.filename, mimeType: a.mimeType, attachmentId: a.attachmentId, sizeBytes: a.sizeBytes,
    })),
    hasAttachments: e.attachments.length > 0,
    internalDate: e.internalDate,
  };
}

function rowToIndexed(r: Record<string, unknown>): IndexedEmail {
  return {
    handle: String(r.handle ?? ''),
    id: String(r.id ?? ''),
    threadId: String(r.thread_id ?? ''),
    from: String(r.from_addr ?? ''),
    to: String(r.to_addrs ?? ''),
    subject: String(r.subject ?? ''),
    snippet: String(r.snippet ?? ''),
    bodyText: String(r.body_text ?? ''),
    haystack: String(r.haystack ?? ''),
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    attachments: Array.isArray(r.attachments) ? (r.attachments as IndexedEmail['attachments']) : [],
    hasAttachments: r.has_attachments === true,
    internalDate: Number(r.internal_date ?? 0),
  };
}

/**
 * Upsert a batch of fetched messages into the index. Fire-and-forget safe: never throws
 * (an index write failure must never drop a Judge flag or fail an Ops search).
 */
export async function upsertEmails(handle: string, emails: DealEmail[]): Promise<void> {
  const rows = emails.filter(e => e.id).map(e => toIndexed(handle, e));
  if (!rows.length) return;
  const supabase = getSupabase();
  if (supabase) {
    try {
      // Chunked upserts keep payloads reasonable on big backfills.
      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50).map(r => ({
          handle: r.handle,
          id: r.id,
          thread_id: r.threadId,
          from_addr: r.from,
          to_addrs: r.to,
          subject: r.subject,
          snippet: r.snippet,
          body_text: r.bodyText,
          haystack: r.haystack,
          labels: r.labels,
          attachments: r.attachments,
          has_attachments: r.hasAttachments,
          internal_date: r.internalDate,
          indexed_at: new Date().toISOString(),
        }));
        const { error } = await supabase.from('emails').upsert(chunk, { onConflict: 'handle,id' });
        if (error) throw error;
      }
      return;
    } catch (error) {
      logDbError('upsertEmails', error);
    }
  }
  const box = mem.emails.get(handle) ?? new Map<string, IndexedEmail>();
  for (const r of rows) box.set(r.id, r);
  mem.emails.set(handle, box);
}

/** Escape ILIKE wildcards in user-supplied terms. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

function textTerms(text?: string): string[] {
  return (text ?? '').toLowerCase().split(/\s+/).map(t => t.trim()).filter(Boolean).slice(0, 8);
}

/**
 * Search the index. All filters AND together; `text` splits into terms that must each appear
 * somewhere in subject/from/to/body (substring — the matching Gmail's q cannot do). Results
 * newest first.
 */
export async function searchEmailIndex(handle: string, q: EmailIndexQuery): Promise<IndexedEmail[]> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  const terms = textTerms(q.text);
  const supabase = getSupabase();
  if (supabase) {
    try {
      let query = supabase.from('emails').select('*').eq('handle', handle);
      for (const t of terms) query = query.ilike('haystack', `%${escapeLike(t)}%`);
      if (q.from) query = query.ilike('from_addr', `%${escapeLike(q.from)}%`);
      if (q.to) query = query.ilike('to_addrs', `%${escapeLike(q.to)}%`);
      if (q.subject) query = query.ilike('subject', `%${escapeLike(q.subject)}%`);
      if (q.afterMs) query = query.gt('internal_date', q.afterMs);
      if (q.beforeMs) query = query.lt('internal_date', q.beforeMs);
      if (q.hasAttachment) query = query.eq('has_attachments', true);
      const { data, error } = await query.order('internal_date', { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []).map(rowToIndexed);
    } catch (error) {
      logDbError('searchEmailIndex', error);
    }
  }
  const box = mem.emails.get(handle);
  if (!box) return [];
  const fromL = q.from?.toLowerCase();
  const toL = q.to?.toLowerCase();
  const subjL = q.subject?.toLowerCase();
  return [...box.values()]
    .filter(e =>
      terms.every(t => e.haystack.includes(t))
      && (!fromL || e.from.toLowerCase().includes(fromL))
      && (!toL || e.to.toLowerCase().includes(toL))
      && (!subjL || e.subject.toLowerCase().includes(subjL))
      && (!q.afterMs || e.internalDate > q.afterMs)
      && (!q.beforeMs || e.internalDate < q.beforeMs)
      && (!q.hasAttachment || e.hasAttachments))
    .sort((a, b) => b.internalDate - a.internalDate)
    .slice(0, limit);
}

/** Coverage stats so the model (and diagnostics) can see what the index actually holds. */
export async function emailIndexStats(handle: string): Promise<EmailIndexStats> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { count, error } = await supabase.from('emails')
        .select('id', { count: 'exact', head: true }).eq('handle', handle);
      if (error) throw error;
      if (!count) return { count: 0, oldestMs: null, newestMs: null };
      const [{ data: oldest }, { data: newest }] = await Promise.all([
        supabase.from('emails').select('internal_date').eq('handle', handle).order('internal_date', { ascending: true }).limit(1),
        supabase.from('emails').select('internal_date').eq('handle', handle).order('internal_date', { ascending: false }).limit(1),
      ]);
      return {
        count,
        oldestMs: oldest?.[0]?.internal_date != null ? Number(oldest[0].internal_date) : null,
        newestMs: newest?.[0]?.internal_date != null ? Number(newest[0].internal_date) : null,
      };
    } catch (error) {
      logDbError('emailIndexStats', error);
    }
  }
  const box = mem.emails.get(handle);
  if (!box || !box.size) return { count: 0, oldestMs: null, newestMs: null };
  const dates = [...box.values()].map(e => e.internalDate);
  return { count: box.size, oldestMs: Math.min(...dates), newestMs: Math.max(...dates) };
}

/** Remove a handle's indexed mail (Gmail disconnect teardown). */
export async function clearEmailIndex(handle: string): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { error } = await supabase.from('emails').delete().eq('handle', handle);
      if (error) throw error;
    } catch (error) {
      logDbError('clearEmailIndex', error);
    }
  }
  mem.emails.delete(handle);
}

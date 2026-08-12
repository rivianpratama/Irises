// Mail SEARCH index maintenance — the `emails` table that Ops queries via search_inbox_local.
// Every message that flows through the Judge/backfill is persisted (text + headers) so retrieval
// is substring-capable, deterministic, and quota-free. No LLM extraction, no domain-specific
// parsing — just a faithful local mirror of the user's mailbox for fast, private search.

import { upsertEmails, emailIndexStats } from '../db/repositories/emails.js';

/** Search-index backfill: broad fetch (inbox + sent + archive), paced, upserted. */
export async function backfillEmailSearchIndex(
  handle: string,
  opts: { newerThanDays?: number; maxResults?: number } = {},
): Promise<{ indexed: number }> {
  const { fetchAllMailForIndex } = await import('../services/gmail.js');
  const emails = await fetchAllMailForIndex(handle, opts);
  await upsertEmails(handle, emails);
  console.log(`[index] search-index backfill for ${handle}: ${emails.length} messages indexed`);
  return { indexed: emails.length };
}

/**
 * Ensure the search index exists for a handle: backfill only when it's empty (one cheap count
 * on every other call). Runs at boot for every connected handle and after a fresh connect.
 */
export async function ensureEmailSearchIndex(handle: string): Promise<void> {
  if ((process.env.EMAIL_SEARCH_INDEX || '').toLowerCase() === 'off') return;
  try {
    const stats = await emailIndexStats(handle);
    if (stats.count > 0) return;
    await backfillEmailSearchIndex(handle);
  } catch (err) {
    console.error(`[index] search-index ensure failed for ${handle}`, err);
  }
}

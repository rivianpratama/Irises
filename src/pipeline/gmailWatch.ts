// Gmail push subscription management. We register a users.watch on each connected agent's
// INBOX, pointing at a Cloud Pub/Sub topic; Google then POSTs a notification to /webhook/gmail
// whenever new mail arrives, which fires the Judge in real time. A watch lapses in <=7 days,
// so we renew daily. Requires GMAIL_PUBSUB_TOPIC (the fully-qualified topic name) to be set;
// without it, push is simply off and the backstop poll carries discovery.
import { watchMailbox, stopWatch } from '../services/gmail.js';
import { getMemory, setPreference, setPreferences } from '../db/repositories/memory.js';
import { expireShortTermNow } from '../db/repositories/memoryShort.js';
import { listConnectedHandles, getGmailToken, revokeGmailToken } from '../db/repositories/tokens.js';
import { clearEmailIndex } from '../db/repositories/emails.js';
import { GmailReauthRequired, revokeGoogleGrant } from '../oauth/google.js';

const RENEWAL_INTERVAL_MS = Number(process.env.GMAIL_WATCH_RENEWAL_MS || 24 * 60 * 60 * 1000);

function topicName(): string | undefined {
  return process.env.GMAIL_PUBSUB_TOPIC || undefined;
}

/**
 * Register/refresh the push watch for one handle and persist what we learned. Returns the mailbox's
 * current historyId (null if push is disabled or registration failed). The historyId is persisted as
 * our sync cursor only the FIRST time (renewals leave the advancing cursor alone). Pass
 * { persistCursor: false } to register + return the historyId WITHOUT writing the cursor — the
 * stale-cursor recovery path (emailJudge) uses this to commit the cursor itself, but only after a
 * clean run, so a mid-run failure can't strand the backlog behind a prematurely-advanced cursor.
 */
export async function startWatchForHandle(handle: string, opts: { persistCursor?: boolean } = {}): Promise<string | null> {
  const topic = topicName();
  if (!topic) return null;
  try {
    const { emailAddress, historyId, expiration } = await watchMailbox(handle, topic);
    if (emailAddress) await setPreference(handle, 'gmail_address', emailAddress);
    if (expiration) await setPreference(handle, 'gmail_watch_expiration', expiration);
    if (opts.persistCursor !== false) {
      const memory = await getMemory(handle);
      if (historyId && !memory?.prefs?.gmail_watch_history_id) {
        await setPreference(handle, 'gmail_watch_history_id', historyId);
      }
    }
    console.log(`[watch] registered Gmail push for ${handle} (expires ${expiration ?? '?'})`);
    return historyId ?? null;
  } catch (err) {
    if (err instanceof GmailReauthRequired) { console.log(`[watch] ${handle} needs re-auth; skipping watch`); return null; }
    console.error(`[watch] failed to register watch for ${handle}`, err);
    return null;
  }
}

export interface DisconnectResult { wasConnected: boolean }

/**
 * Teardown counterpart to the connect flow: stop the Gmail push watch, revoke the grant at Google
 * (best-effort), flip the local token to revoked, and clear cached email state so a logout leaves
 * nothing behind. `chat_id` is preserved so background jobs can still reach the user (same invariant
 * clearDossier holds). Order matters: stop/revoke at Google while the token is still live, THEN flip
 * the local token (getGmailToken returns null once revoked), THEN clear prefs. Effectively never
 * throws — steps 1-2 are best-effort and revokeGmailToken swallows its own DB errors — so the local
 * disconnect always completes even if Google is unreachable.
 */
export async function disconnectGmail(handle: string): Promise<DisconnectResult> {
  const token = await getGmailToken(handle);
  if (!token) return { wasConnected: false }; // idempotent no-op

  // 1. Stop Gmail push while credentials are still valid (best-effort).
  try {
    await stopWatch(handle);
  } catch (err) {
    if (!(err instanceof GmailReauthRequired)) console.warn(`[watch] stopWatch failed on disconnect for ${handle}`, err);
  }
  // 2. Revoke the grant at Google (best-effort; never throws).
  await revokeGoogleGrant(handle);
  // 3. Flip the local token to revoked (authoritative — gates getGmailToken/listConnectedHandles).
  await revokeGmailToken(handle);
  // 4. Clear cached email state. chat_id is intentionally left intact.
  await setPreferences(handle, {
    gmail_address: null,
    gmail_watch_history_id: null,
    gmail_watch_expiration: null,
    email_watermark: null,
    email_ingested: null,
    surfaced_email_ids: null,
    pending_email_contexts: null,
    gmail_last_push_at: null,
    gmail_watch_reset_at: null,
  });
  // 5. Drop the local mail search index — a logout must leave no mail content behind.
  await clearEmailIndex(handle);
  // 6. Expire the short-term email flags too — same "no mail residue" rule as the index.
  await expireShortTermNow(handle, ['email_flag']);
  console.log(`[watch] disconnected Gmail for ${handle}`);
  return { wasConnected: true };
}

/** Daily renewal sweep (also re-establishes every watch after a restart). */
export function startWatchRenewal(): void {
  if (!topicName()) {
    console.log('[watch] GMAIL_PUBSUB_TOPIC not set — Gmail push disabled (backstop poll only)');
    return;
  }
  // The webhook fails closed (403) in production without the shared secret — a topic with no
  // token means Google delivers pushes that we silently reject. Shout about it at boot.
  if (!process.env.GMAIL_PUSH_VERIFY_TOKEN && process.env.NODE_ENV === 'production') {
    console.error('[watch] GMAIL_PUBSUB_TOPIC is set but GMAIL_PUSH_VERIFY_TOKEN is empty — /webhook/gmail will 403 every push; set it in /opt/irises/.env');
  }
  console.log(`[watch] renewal sweep starting — every ${Math.round(RENEWAL_INTERVAL_MS / 3_600_000)}h`);
  const tick = async () => {
    try {
      const handles = await listConnectedHandles();
      for (const handle of handles) await startWatchForHandle(handle);
    } catch (err) {
      console.error('[watch] renewal tick failed', err);
    }
  };
  setTimeout(() => void tick(), 20_000);
  setInterval(() => void tick(), RENEWAL_INTERVAL_MS);
}

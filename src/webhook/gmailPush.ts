// Gmail push receiver. Google Cloud Pub/Sub POSTs here whenever a watched mailbox changes.
// We verify the request, map the notified Gmail address back to an agent handle, and fire the
// Judge for that handle — then ack fast (Pub/Sub retries on a slow/failed ack). The body shape:
//   { message: { data: base64(JSON{ emailAddress, historyId }), messageId, publishTime }, subscription }
// The historyId in the payload is just a "something changed" ping; judgeNewEmailsForHandle uses
// the agent's STORED history cursor to fetch exactly what's new, so we don't trust it directly.
import { Router } from 'express';
import { findHandleByGoogleEmail } from '../db/repositories/tokens.js';
import { listConnectedHandles } from '../db/repositories/tokens.js';
import { getMemory, setPreference } from '../db/repositories/memory.js';
import { judgeNewEmailsForHandle } from '../pipeline/emailJudge.js';
import { reportError } from '../diagnostics/errorLog.js';

export interface GmailPushDeps {
  // Return widened to unknown: the sender is the mouth (state/mouth.ts), which reports 'sent'/'dropped'.
  sendFollowUp: (chatId: string, text: string, opts?: { record?: boolean }) => Promise<unknown>;
}

/**
 * Shared-secret check via ?token=. If GMAIL_PUSH_VERIFY_TOKEN is unset we allow in dev (with a
 * warning) but REJECT in production — a misconfigured prod deploy must fail closed, not accept
 * spoofed pushes that would drive Judge runs for arbitrary attacker-supplied addresses.
 */
function verify(query: Record<string, unknown>): boolean {
  const expected = process.env.GMAIL_PUSH_VERIFY_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[gmail-push] GMAIL_PUSH_VERIFY_TOKEN is unset in production — rejecting push (set it to enable)');
      return false;
    }
    console.warn('[gmail-push] GMAIL_PUSH_VERIFY_TOKEN not set — accepting unauthenticated push (dev only)');
    return true;
  }
  return query.token === expected;
}

/**
 * Map a notified Gmail address to a handle. Primary: the token row's google_email. Fallback:
 * the prefs.gmail_address that watchMailbox stores from users.getProfile — reliable even when
 * OAuth's best-effort google_email capture failed or a re-consent skipped the token write.
 */
async function resolveHandle(emailAddress: string): Promise<string | null> {
  const byToken = await findHandleByGoogleEmail(emailAddress);
  if (byToken) return byToken;
  for (const handle of await listConnectedHandles()) {
    const m = await getMemory(handle);
    if (m?.prefs?.gmail_address === emailAddress) return handle;
  }
  return null;
}

export function createGmailPushRouter(deps: GmailPushDeps): Router {
  const router = Router();

  router.post('/webhook/gmail', async (req, res) => {
    if (!verify(req.query as Record<string, unknown>)) { res.status(403).end(); return; }

    let emailAddress: string | undefined;
    try {
      const data = req.body?.message?.data;
      if (data) {
        const decoded = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'));
        emailAddress = decoded?.emailAddress;
      }
    } catch (err) {
      console.error('[gmail-push] failed to parse notification', err);
    }

    // Ack immediately so Pub/Sub doesn't retry; do the work out-of-band.
    res.status(204).end();
    if (!emailAddress) return;

    void (async () => {
      // Hoisted so the catch can attribute the drop to a handle (the resolve may itself be what failed).
      let handle: string | null = null;
      try {
        handle = await resolveHandle(emailAddress!);
        if (!handle) { console.warn(`[gmail-push] no connected handle for ${emailAddress}`); return; }
        // Liveness stamp for the watch-staleness watchdog (backstop compares against this).
        void setPreference(handle, 'gmail_last_push_at', Date.now()).catch(() => {});
        await judgeNewEmailsForHandle(handle, deps.sendFollowUp, { trigger: 'push' });
      } catch (err) {
        console.error('[gmail-push] judging notification failed', err);
        // We already acked 204, so Pub/Sub considers this notification delivered and will NEVER
        // redeliver it: whatever it carried is now only recoverable by the hourly backstop poll.
        // That makes this the one webhook failure that has to be durable on its own.
        reportError({
          source: 'webhook',
          category: 'push_dropped',
          err,
          handle: handle ?? undefined,
          detail: { emailAddress, acked: true },
        });
      }
    })();
  });

  return router;
}

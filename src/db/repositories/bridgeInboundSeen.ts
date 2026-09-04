// Inbound claims for the bridge door (src/channels/bridge/inboundRouter.ts).
//
// The plugins claim the turn from their engine BEFORE Irises acknowledges — they have to, the
// engine consumes the suppression decision synchronously — and the Hermes one retries a forward
// three times. So a 202 that never lands is up to three identical turns: Irises answers the same
// question twice, or worse, runs the same delegation twice. One row per
// (platform, chat_id, message_id) is what makes the retry a no-op instead.
//
// Failure policy is hasRecentDelivery's, pointed the same way: every error degrades to 'fresh'.
// A lost claim means a duplicate turn (annoying, visible, recoverable); a claim that wrongly
// reported 'duplicate' would silently eat a real message the user typed, which is not.
import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';

// A retry window, not a history: the plugins give up long before this, and inbound_messages
// already keeps the 7-day record used for reply resolution.
const TTL_MS = 24 * 60 * 60 * 1000;
// Soft cap, pruned on write — a flood must not grow the table unbounded between retention sweeps.
const CAP = 5000;

function pruneOnWrite(now: number): void {
  stmt('DELETE FROM bridge_inbound_seen WHERE created_at <= ?').run(now - TTL_MS);
  stmt(
    `DELETE FROM bridge_inbound_seen WHERE seen_key IN (
       SELECT seen_key FROM bridge_inbound_seen ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`
  ).run(CAP);
}

/** The dedup gate (env: BRIDGE_INBOUND_DEDUP). Default ON, read at CALL time so flipping it needs
 *  no restart — the same parse shape as every sibling flag. Off means the door never claims and
 *  never touches this table: a retry is a second turn, exactly as it was. */
export function bridgeInboundDedupEnabled(): boolean {
  const v = (process.env.BRIDGE_INBOUND_DEDUP || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * Claim an inbound message. `'fresh'` means this door has not seen it and the caller owns the
 * turn; `'duplicate'` means someone already does. Synchronous — the router answers on this.
 *
 * The claim IS the insert: ON CONFLICT DO NOTHING makes the primary key the arbiter, so two
 * near-simultaneous retries can never both read "not there" and both proceed.
 */
export function claimBridgeInbound(platform: string, chatId: string, messageId: string): 'fresh' | 'duplicate' {
  const seenKey = `${platform}|${chatId}|${messageId}`;
  try {
    const now = Date.now();
    const res = stmt(
      `INSERT INTO bridge_inbound_seen (seen_key, chat_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(seen_key) DO NOTHING`
    ).run(seenKey, chatId, now);
    if (Number(res.changes) === 0) return 'duplicate';
    pruneOnWrite(now);
    return 'fresh';
  } catch (error) {
    logDbError('claimBridgeInbound', error);
    return 'fresh';
  }
}

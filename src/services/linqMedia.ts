import { fetchMediaDetailed, type FetchedMedia } from '../llm/inlineMedia.js';
import { getFreshAttachmentUrl } from '../linq/client.js';
import type { ExtractedMedia } from '../webhook/types.js';

// Verified inbound-chat media fetch — shared by the MM agent's native read and Ops'
// read_chat_attachment tool. CHANNEL SCOPE: this is the Linq (iMessage) lane specifically — the
// re-sign path calls Linq's attachment endpoint. Inbound files only arrive over Linq today; when the
// web/telegram channels start carrying attachments they need their own verified fetch (TODO), and
// this module stays the Linq one rather than growing per-channel branches.
//
// The URL the webhook delivered may already be stale (Linq's ephemeral-tier signed URLs last
// ~15 min), so on an HTTP/network failure — if we know the file's Linq attachmentId — we re-sign
// ONCE (GET /v3/attachments/{id}) and try the fresh URL before giving up. Nothing is ever silently
// dropped: a failure returns a typed reason the caller turns into an honest "resend it" (naming why:
// expired vs too large vs didn't come through).

export type LostReason = 'expired' | 'unfetchable' | 'oversize';
// User-facing nouns for a lost file (mirrors describeMedia in mediaRecall.ts).
export type MediaKind = 'photo' | 'video' | 'voice memo' | 'document';

export interface LostFile { kind: MediaKind; filename?: string; reason: LostReason }
export type VerifiedFetch =
  | { ok: true; media: FetchedMedia }
  | { ok: false; reason: LostReason };

export interface FetchDeps {
  fetchMedia: typeof fetchMediaDetailed;
  getFreshUrl: typeof getFreshAttachmentUrl;
}

// HTTP statuses that mean "this signed link is dead" (expired signature / purged object), vs a
// transient server/network hiccup. A fresh signature won't fix a purged file, but we still surface
// it honestly as 'expired' — from the user's side the fix is identical: resend it.
const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);

function reasonFromHttp(status: number): LostReason {
  return EXPIRED_STATUSES.has(status) ? 'expired' : 'unfetchable';
}

/**
 * Fetch one attachment to base64. On an HTTP/network failure, if we have its Linq attachmentId,
 * re-sign ONCE and retry the fresh URL. Oversize never retries (a new signature doesn't shrink the
 * file). Returns the bytes, or a typed reason for the loss. Dependency-injected for tests.
 */
export async function fetchVerified(m: ExtractedMedia, deps: Partial<FetchDeps> = {}): Promise<VerifiedFetch> {
  const fetchMedia = deps.fetchMedia ?? fetchMediaDetailed;
  const getFreshUrl = deps.getFreshUrl ?? getFreshAttachmentUrl;

  const first = await fetchMedia(m.url, m.mimeType);
  if (first.ok) return { ok: true, media: first.media };
  if (first.failure === 'oversize') return { ok: false, reason: 'oversize' };

  // HTTP or network failure — one re-sign retry if we can identify the attachment.
  if (m.attachmentId) {
    const fresh = await getFreshUrl(m.attachmentId);
    if (fresh && fresh !== m.url) {
      const second = await fetchMedia(fresh, m.mimeType);
      if (second.ok) {
        console.log(`[linqMedia] re-signed URL recovered attachment ${m.attachmentId}`);
        return { ok: true, media: second.media };
      }
      if (second.failure === 'oversize') return { ok: false, reason: 'oversize' };
      // Fall through: classify from the LAST attempt.
      return { ok: false, reason: second.failure === 'http' ? reasonFromHttp(second.status) : 'unfetchable' };
    }
  }

  return { ok: false, reason: first.failure === 'http' ? reasonFromHttp(first.status) : 'unfetchable' };
}

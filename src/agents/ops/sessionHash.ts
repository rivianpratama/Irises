// The one content hash both engine adapters key on — the long-id fallback in a session key and the
// onboarding doctrine's version. Shared so the two engines can never drift on what a given string
// hashes to (a drift here would silently re-key live sessions).
import { createHash } from 'node:crypto';

/** 8 hex of sha256 over the RAW string. For a chat id that's enough to separate ids sharing a
 *  truncated head, and taking it BEFORE sanitizing keeps two ids differing only in punctuation
 *  distinct too. */
export function hash8(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

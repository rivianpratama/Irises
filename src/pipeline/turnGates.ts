// Two small gates the per-turn pipeline opens before it has any output to show. They live here, not
// inline in index.ts, because both were wrong in ways only a table of cases makes obvious: one
// introduced Irises to people it had been talking to for weeks, the other showed typing dots in a
// group chat before knowing whether Irises would speak at all.

export interface ContactCardPromo {
  /** CONTACT_CARD_PROMO — the every-N-messages re-share, off by default (it reads as self-promo). */
  enabled: boolean;
  /** CONTACT_CARD_INTERVAL. */
  interval: number;
}

/**
 * Share Irises's own contact card (name + photo instead of a bare number) on this turn?
 *
 * `count` is the in-process turn counter, which resets on every restart — so on its own it says
 * "first message since the last deploy", not "first message ever". `hasHistory` is the durable half
 * of the question: a chat with stored messages has already met Irises, and re-introducing itself
 * mid-relationship is the tell of a bot that just restarted.
 */
export function shouldShareContactCard(count: number, hasHistory: boolean, promo: ContactCardPromo): boolean {
  if (count === 1 && !hasHistory) return true;
  return promo.enabled && promo.interval > 0 && count % promo.interval === 0;
}

/**
 * Start the typing indicator BEFORE the turn knows what it will do?
 *
 * Only when a reply is already certain: a 1:1 message always gets one, and any media does too (the
 * group classifier is skipped for media). A group TEXT message is not certain — the classifier may
 * say ignore or react — and dots that appear and then evaporate read as Irises starting to answer
 * and thinking better of it, in front of everyone. That path starts typing after the classifier says
 * 'respond'; the cost is the classifier's latency, which is the honest price of not lying.
 */
export function shouldStartTypingEarly(isGroup: boolean, hasMedia: boolean): boolean {
  return !isGroup || hasMedia;
}

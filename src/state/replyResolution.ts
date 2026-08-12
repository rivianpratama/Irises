import { lookupSentBubble, listSentBubblesByReplyRoot } from '../db/repositories/sentMessages.js';
import { lookupInboundMessage } from '../db/repositories/inboundMessages.js';
import { getChannel, parseChannelKind } from '../channels/registry.js';
import { record, noteTurnReply } from '../diagnostics/trace.js';

// Thread-aware resolution of a tapped reply's target. The transport reports a tapped reply by the
// message's THREAD ROOT id; since Irises's Ops answers are themselves sent threaded to the user's
// originating question, that root is often the USER'S OWN message rather than the bubble they
// actually tapped. The bare "is this one of Irises's bubbles?" lookup nulls out on those and the turn
// used to fall back to answering the latest sends. This resolver names all three outcomes explicitly.

export const THREAD_BUBBLE_CAP = 6;

export type ResolvedReply =
  // The tapped id is one of Irises's own bubbles — the exact bubble they replied to. `sentAtMs`/
  // `viaLiveFetch` are set only when recovered from the channel live (an old message past the local
  // index), which is also how the prompt decides the exchange is beyond Irises's visible recall window.
  | { kind: 'assistant'; text: string; sentAtMs?: number; viaLiveFetch?: boolean }
  // The tapped id is the user's own earlier message — the root of a thread. What they tapped is
  // almost always one of Irises's answer bubbles IN that thread (assistantBubbles), send-ordered.
  | { kind: 'own-thread'; rootText: string; rootSenderHandle?: string; assistantBubbles: string[]; sentAtMs?: number; viaLiveFetch?: boolean }
  // The tapped id resolves to nothing — not local, and the channel couldn't return it (deleted,
  // network failure, a cross-chat/forged id, or a transport with no live message fetch at all).
  // Honest unknown: acknowledge and ask, never guess.
  | { kind: 'unresolved' };

/**
 * Resolve an inbound reply_to.message_id, thread-aware. Never throws; never returns null —
 * 'unresolved' IS the honest answer. Emits the dashboard turn:reply note itself (and, on an
 * unresolved target, a convo:reply_unresolved tripwire + a console warn), so every call site in
 * index.ts stays a one-liner.
 */
export async function resolveTappedReply(messageId: string, chatId: string): Promise<ResolvedReply> {
  // Parallel: the two point-reads add no wall time over a single lookup on the common paths.
  const [own, inbound] = await Promise.all([
    lookupSentBubble(messageId, chatId),
    lookupInboundMessage(messageId, chatId),
  ]);

  let resolved: ResolvedReply;
  if (own != null) {
    // One of Irises's bubbles wins on any collision — it's the most specific, least ambiguous target.
    resolved = { kind: 'assistant', text: own };
  } else if (inbound != null) {
    const assistantBubbles = await listSentBubblesByReplyRoot(messageId, chatId, THREAD_BUBBLE_CAP);
    resolved = { kind: 'own-thread', rootText: inbound.content, rootSenderHandle: inbound.senderHandle, assistantBubbles };
  } else {
    // Local index aged out (older than ~7 days, or from before this feature shipped). On a transport
    // that can serve a message by id the message still lives on its servers — pull it directly so an
    // old tapped reply is still recoverable.
    resolved = await resolveViaLiveFetch(messageId, chatId);
  }

  noteTurnReply(chatId, {
    targetId: messageId,
    kind: resolved.kind,
    snippet: resolved.kind === 'assistant' ? resolved.text.slice(0, 80)
      : resolved.kind === 'own-thread' ? resolved.rootText.slice(0, 80)
      : undefined,
  });
  return resolved;
}

/**
 * Live fallback: fetch the tapped message straight from the channel when neither local index knows
 * it. Only reached on a double-miss (old thread), so the one HTTP call it costs is rare. Chat-scoped
 * like the local lookups — a message from another chat (id collision, forged webhook body) must never
 * leak in. A channel with no `getMessage` (web/telegram) skips straight to the honest 'unresolved',
 * as does a true miss here (deleted / network failure / cross-chat) — both raise the tripwire.
 */
async function resolveViaLiveFetch(messageId: string, chatId: string): Promise<ResolvedReply> {
  // getChannel (not resolveChannel) so an unregistered transport degrades to 'unresolved' rather
  // than throwing — this resolver sits on the reply path and must never break a turn.
  const kind = parseChannelKind(chatId);
  const channel = getChannel(kind);
  const fetched = await channel?.getMessage?.(chatId, messageId).catch(() => null) ?? null;
  if (!fetched || fetched.chatId !== chatId) {
    console.warn(`[reply] tapped-reply target could not be resolved (chat ${chatId}, id ${messageId})`);
    record({
      type: 'event', label: 'convo:reply_unresolved', chatId,
      detail: { messageId, liveFetchMiss: true, ...(channel?.getMessage ? {} : { channel: kind, noLiveFetch: true }) },
    });
    return { kind: 'unresolved' };
  }
  const sentAtMs = fetched.sentAtMs || undefined;
  if (fetched.isFromMe) {
    return { kind: 'assistant', text: fetched.text, sentAtMs, viaLiveFetch: true };
  }
  // Their own message: still try to attach Irises's recorded answer bubbles in that thread (usually
  // empty for a pre-feature thread — the prompt section handles that honestly).
  const assistantBubbles = await listSentBubblesByReplyRoot(messageId, chatId, THREAD_BUBBLE_CAP);
  return { kind: 'own-thread', rootText: fetched.text, rootSenderHandle: fetched.senderHandle, assistantBubbles, sentAtMs, viaLiveFetch: true };
}

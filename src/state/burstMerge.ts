// Pure merge of a queued burst of user messages into ONE agent turn, kept side-effect-free so the
// id-preservation is unit-testable (mirrors batchTiming.ts). This is the fix for the old inline merge
// that collapsed a burst to `lastMsg.messageId` and DISCARDED every other message id — which made
// per-bubble reply threading impossible.
//
// `combinedText` is byte-identical to the old behavior for a single message, so non-burst prompts are
// unchanged. `manifest` + `incomingMessageIds` are the ordered, text-bearing subset the model is shown
// (numbered [msg 1], [msg 2] …) and that the send path maps `[[re:N]]` tags back onto.

import type { IncomingMedia, ReplyTo } from '../webhook/types.js';

export interface BurstInputMessage {
  from: string;
  text: string;
  messageId: string;
  media: IncomingMedia;
  incomingReplyTo?: ReplyTo;
  receivedAt?: number; // epoch ms this message was enqueued (for gap detection on the reply)
}

export interface MergedBurst {
  combinedText: string;
  // The text-bearing messages, in order, as the model is shown them ([msg 1], [msg 2] …). `handle` is
  // carried so a group chat can label who sent which; the prompt decides whether to render it.
  // `receivedAt` is that message's own arrival time (0 when unstamped) so the turn can tell, per
  // message, how many of Irises's sends landed AFTER it was typed (a message queued behind the chat
  // lock while a follow-up delivered predates bubbles it never saw). See state/outboundLog.ts.
  manifest: { text: string; handle: string; receivedAt: number }[];
  // Message ids of the same text-bearing messages, in the same order — index i ↔ manifest[i] ↔ tag N=i+1.
  incomingMessageIds: string[];
  incomingReplyTo?: ReplyTo;
  lastMessageId: string;
  from: string;
  media: IncomingMedia;
  // Earliest arrival time in the batch — used to tell whether the reply is "gapped" (Irises sent other
  // bubbles after these messages arrived, so the reply needs a quote to stay connected to them).
  earliestReceivedAt: number;
}

/**
 * Split a queued batch into maximal runs of CONSECUTIVE same-sender messages, order preserved.
 * A turn has exactly ONE identity (`from` picks whose memory loads, whose data the engine reads,
 * whose profile the reply addresses), so a multi-sender group batch must become one turn per
 * sender-run — mergeBurst's `from: last?.from` is then correct by construction. 1:1 chats and
 * single-sender bursts yield one run: behavior identical to the unsplit path.
 */
export function splitBurstBySender<T extends { from: string }>(messages: T[]): T[][] {
  const runs: T[][] = [];
  for (const m of messages) {
    const current = runs[runs.length - 1];
    if (current && current[current.length - 1].from === m.from) current.push(m);
    else runs.push([m]);
  }
  return runs;
}

export function mergeBurst(messages: BurstInputMessage[]): MergedBurst {
  const withText = messages.filter(m => m.text && m.text.trim());
  const last = messages[messages.length - 1];
  const receivedTimes = messages.map(m => m.receivedAt).filter((t): t is number => typeof t === 'number');
  return {
    combinedText: messages.map(m => m.text).filter(Boolean).join('\n\n'),
    manifest: withText.map(m => ({ text: m.text.trim(), handle: m.from, receivedAt: m.receivedAt ?? 0 })),
    incomingMessageIds: withText.map(m => m.messageId),
    // Only ONE reply-target can survive a combined burst — take the EARLIEST non-null so a
    // thread-reply on the FIRST burst message isn't silently lost (unchanged behavior).
    incomingReplyTo: messages.find(m => m.incomingReplyTo)?.incomingReplyTo,
    lastMessageId: last?.messageId,
    from: last?.from,
    media: {
      images: messages.flatMap(m => m.media.images),
      audio: messages.flatMap(m => m.media.audio),
      video: messages.flatMap(m => m.media.video),
      docs: messages.flatMap(m => m.media.docs),
    },
    earliestReceivedAt: receivedTimes.length ? Math.min(...receivedTimes) : 0,
  };
}

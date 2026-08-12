// Per-bubble native reply threading. Pure, side-effect-free logic so the WHEN-rule and all the
// fallbacks are unit-testable without the network (mirrors batchTiming.ts / interveningMessages.ts).
//
// The model prefixes a bubble with a hidden routing tag `[[re:N]]` (N = 1-based index of the incoming
// message that bubble answers). It is stripped before sending, never shown, and never counts toward
// the word limit. The tag survives splitIntoBubbles/cleanResponse (those touch only ---, newlines,
// spaced dashes, markdown, and number ranges — none touch `[[re:N]]`).
//
// See src/agents/convo/Context.md ("Which incoming message each bubble answers") for the model side.

import type { ReplyTo } from '../webhook/types.js';

// A well-formed tag at the very START of a bubble → the message index it answers.
export const REPLY_TAG_HEAD = /^\s*\[\[re:(\d{1,2})\]\]\s*/;
// Backstop: ANY `[[re:...]]` shape anywhere (even malformed like `[[re:none]]` or a mid-bubble slip),
// scrubbed defensively so a routing tag can never reach the user — mirrors redactInternalTools.
export const STRAY_TAG = /\[\[re:[^\]]*\]\]/gi;

/**
 * Remove any reply-routing tag from a single bubble. Idempotent and safe on already-clean text:
 * returns the input untouched when there's no tag, so it never mangles normal bubbles.
 */
export function stripReplyTag(text: string | null | undefined): string {
  if (!text) return text ?? '';
  const out = text.replace(STRAY_TAG, '');
  if (out === text) return text;                       // fast path: nothing removed, don't touch spacing
  return out.replace(/[ \t]{2,}/g, ' ').trim();        // tidy the gap the removed tag left; keep newlines
}

/**
 * Parse a leading `[[re:N]]` off a bubble. Returns the 1-based index (or null if untagged) and the
 * tag-stripped text (also scrubbed of any stray tags further in).
 */
export function parseReplyTag(segment: string): { index: number | null; text: string } {
  const m = segment.match(REPLY_TAG_HEAD);
  if (!m) return { index: null, text: stripReplyTag(segment) };
  const index = parseInt(m[1], 10);
  return { index: Number.isNaN(index) ? null : index, text: stripReplyTag(segment.slice(m[0].length)) };
}

/**
 * Resolve a send_reaction `re` target (1-based [msg N] index within this turn's burst) to the
 * channel message id to tapback. Mirrors resolveOutboundBubbles' `idFor`: an absent, non-positive, or
 * out-of-range index falls back to `fallbackId` (the latest message) — so a model slip degrades to
 * exactly today's behavior (react to the latest message) rather than misfiring or throwing.
 */
export function resolveReactionTarget(re: number | undefined | null, incomingMessageIds: string[], fallbackId: string): string {
  if (re != null && Number.isInteger(re) && re >= 1) {
    const id = incomingMessageIds[re - 1];
    if (id) return id;
  }
  return fallbackId;
}

export interface ResolveOpts {
  // True when the user sent 2+ text messages this turn (per-bubble [[re:N]] tags drive the quoting).
  isBurst: boolean;
  // Single-message turns: quote this on the FIRST bubble to anchor context, then flow. Set when the
  // user tapped reply on an earlier bubble, OR when the reply is "gapped" — Irises already sent other
  // bubbles between the user's message and this reply (e.g. a late/leftover message answered only
  // after a prior burst reply went out), so a bare reply would look detached from the message it answers.
  anchorFirstTo?: ReplyTo;
}

/**
 * Turn the raw split segments of a reply into the bubbles we actually send plus their per-bubble
 * native-reply targets. Quoting is SPARSE and natural: a person quotes the one message they're
 * picking up, then just keeps typing — they don't quote every bubble.
 *
 * - Tags are stripped; a segment that is ONLY a tag (e.g. the model put `[[re:1]]` on its own line)
 *   carries its index onto the NEXT content bubble and is itself dropped — so an accidental newline
 *   between the tag and its text still threads correctly instead of silently misfiring.
 * - Burst: ONLY the bubbles the model actually tagged carry a native quote (to the tagged message).
 *   Untagged bubbles — and tags that don't resolve to a real message — send clean, unthreaded. The
 *   model is instructed to tag only where a quote genuinely clarifies which message it's answering.
 * - Single message: tags are ignored; when `anchorFirstTo` is set (tapped reply, or a gapped reply),
 *   only the FIRST bubble anchors to that message, the rest flow naturally. Otherwise all clean.
 * - An index that maps to no real incoming id never produces a bogus/empty message_id.
 */
export function resolveOutboundBubbles(
  segments: string[],
  incomingMessageIds: string[],
  opts: ResolveOpts,
): { bubbles: string[]; targets: (ReplyTo | undefined)[] } {
  const bubbles: string[] = [];
  const targets: (ReplyTo | undefined)[] = [];
  let pendingIndex: number | null = null; // from a tag-only segment, applied to the next content bubble
  let firstAnchored = false;              // single-message: anchor only the FIRST bubble, then flow

  const idFor = (index: number | null): ReplyTo | undefined => {
    if (index == null) return undefined;
    const id = incomingMessageIds[index - 1]; // 1-based
    return id ? { message_id: id } : undefined;
  };

  for (const seg of segments) {
    const { index, text } = parseReplyTag(seg);
    if (!text) {
      if (index != null) pendingIndex = index; // carry the tag forward; drop this empty segment
      continue;
    }
    const effIndex = index ?? pendingIndex;
    pendingIndex = null;

    let target: ReplyTo | undefined;
    if (opts.isBurst) {
      // Only quote the bubbles the model deliberately tagged; untagged ones keep typing, unthreaded.
      target = idFor(effIndex);
    } else if (opts.anchorFirstTo && !firstAnchored) {
      // Single message: quote it once on the first bubble to anchor context, then flow naturally.
      target = opts.anchorFirstTo;
      firstAnchored = true;
    }

    bubbles.push(text);
    targets.push(target);
  }

  return { bubbles, targets };
}

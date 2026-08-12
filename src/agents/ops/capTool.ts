import type { LlmMessage } from '../../llm/types.js';

// Bounds on what the Ops loop re-sends to the model every step. The loop's messages array grows by
// one tool-result message per step and is re-sent WHOLE each time — one unbounded tool result (a
// full email thread, a raw JSON dump) compounds quadratically across a 12-step run. These caps bound
// the model-visible context only; the grounding corpus and escalation debrief keep the full text
// (they have their own independent caps — fidelity.ts slices, triage.ts buildCorpusDigest).

/** Max chars of a single tool result forwarded to the model. */
export const OPS_TOOL_RESULT_CAP = Number(process.env.OPS_TOOL_RESULT_CAP || 20_000);
/** Max total chars of the loop's messages array; past it, oldest tool results are evicted. */
export const OPS_MESSAGES_CHAR_CAP = Number(process.env.OPS_MESSAGES_CHAR_CAP || 300_000);

/** Keep the head (query framing + the bulk of the content) and tail (the conclusion) of an
 *  oversized tool result — same shape as the escalation digest's capEntry, scaled up. */
export function capToolEntry(entry: string, max = OPS_TOOL_RESULT_CAP): string {
  if (entry.length <= max) return entry;
  const tailKeep = Math.floor(max * 0.2);
  const headKeep = max - tailKeep;
  return `${entry.slice(0, headKeep)}\n…[trimmed ${entry.length - headKeep - tailKeep} chars]…\n${entry.slice(-tailKeep)}`;
}

function contentChars(m: LlmMessage): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

const EVICTED_MARKER = (chars: number) =>
  `[an older tool result (${chars} chars) was evicted to keep context bounded — re-run the tool if you still need it]`;

/**
 * Evict oldest tool-result messages (in place) until the array fits the cap. Never touches the
 * task prompt (index 0) or the latest exchange (the last two messages — the model needs the
 * results it JUST asked for). Returns how many messages were evicted, for tracing.
 */
export function capMessagesChars(messages: LlmMessage[], totalCap = OPS_MESSAGES_CHAR_CAP): number {
  let evicted = 0;
  const total = () => messages.reduce((n, m) => n + contentChars(m), 0);
  for (let i = 1; i < messages.length - 2 && total() > totalCap; i++) {
    const m = messages[i];
    if (m.role !== 'user' || typeof m.content !== 'string' || !m.content.startsWith('TOOL ')) continue;
    m.content = EVICTED_MARKER(m.content.length);
    evicted++;
  }
  return evicted;
}

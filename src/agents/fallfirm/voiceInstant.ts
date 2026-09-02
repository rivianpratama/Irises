// The waiting voice — Irises's "still on it" / "on it" reassurance while a
// delegated Ops look is still running. Built EXACTLY like the Composer relay (composeFollowUp) and
// the outcome voicer (voiceOutcome): a static persona (fallfirm/Progress.md) + a <prompt> dynamic
// block + a JSON bubble anchor + a voice-only window of the recent thread. The one thing it re-voices
// is different: not an Ops RESULT, but the wait itself — the hardcoded progress/holding beats that
// used to be one-shot canned lines. Injecting the thread is what lets it BLEND with the surrounding
// conversation and, above all, NEVER repeat a reassurance that's already on the user's screen.
//
// If this LLM call fails or comes back empty, we drop to floor.ts — the same zero-latency pooled
// phrases as before, now truly last-resort. Never throws.
import { callLLM } from '../../llm/callLLM.js';
import { loadContext } from '../loadContext.js';
import { getConversation, StoredMessage } from '../../state/conversation.js';
import { buildUserMemory } from '../../memory/wrappers.js';
import { redactInternalTools } from '../guardrails.js';
import { parseReply } from '../../pipeline/bubbleJson.js';
import { MAX_BUBBLE_WORDS, BUBBLE_WORD_TARGET_LO, BUBBLE_WORD_TARGET_HI } from '../../pipeline/bubbles.js';
import { wrapPrompt, dataTag } from '../../llm/promptTag.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import type { LlmMessage } from '../../llm/types.js';
import type { TaskKind } from '../types.js';
import { holdingFloor, stillOnItText, heartbeatText } from './floor.js';

// Recent turns prepended for VOICE/continuity ONLY — never a fact source (this voice carries no
// facts). This is the window that lets it see its own last holding line / ping so it never repeats.
// Mirrors the composer/fallfirm windows; a touch wider so a prior ping stays in view on a busy thread.
// Turns carry their wall-clock stamps (chatTime.ts) like every other voice window; no timing block
// here though — a progress ping is always seconds into a look, the regime never varies.
const HISTORY_WINDOW = 10;

function formatHistory(messages: StoredMessage[]): LlmMessage[] {
  return messages.slice(-HISTORY_WINDOW).map(m => ({ role: m.role, timestamp: timestampLabel(m.at) || undefined, content: m.content }));
}

/** The ETA the user was ALREADY promised, read off the in-flight entry — never re-derived here. The
 *  whole point is consistency: a later beat may repeat this phrase or say less, but it must never put
 *  a different number in their head. */
export interface VoiceInstantEta {
  phrase: string;
  state: 'fresh' | 'early' | 'closing' | 'overrun';
  remainingPhrase?: string;
}

export interface VoiceInstantOpts {
  kind: 'holding' | 'still_on_it' | 'heartbeat' | 'progress';
  taskKind?: TaskKind;
  request?: string;
  addressHint?: string;
  dealHint?: string;
  eta?: VoiceInstantEta;
}

// The dynamic block: where the look is right now, the ask (for continuity), the hint (so it names the
// real thing), and — every time — the hard "don't repeat what's already on screen" steer. No facts,
// no url ever. Mirrors buildOutcomeBrief in client.ts. Exported for unit testing.
export function buildProgressBrief(opts: VoiceInstantOpts, userCtx: string): string {
  const hint = opts.addressHint || opts.dealHint;
  const req = opts.request?.trim();
  const lines: string[] = [];

  const eta = opts.eta;
  // The mid-run pace lines, shared by every "still running" beat. Past ~60% we stop handing out
  // numbers entirely — an honest "should be close" beats a fresh, shrinking countdown.
  const pushPaceBeat = () => {
    if (eta?.state === 'early' && eta.remainingPhrase) lines.push(`if a time beat fits, there's about ${eta.remainingPhrase} to go — loose words only, or skip it.`);
    else if (eta?.state === 'closing') lines.push('it should be close now — you may say so, no number.');
    else if (eta?.state === 'overrun') lines.push("it's running past what you told them. one honest, unbothered beat that it's taking a little longer than you thought is fine — do NOT quote a new time.");
  };

  switch (opts.kind) {
    case 'holding':
      lines.push('## Where the look is: you JUST started — this is your first "on it" line');
      lines.push(req ? `they asked you to look into: "${req}"` : 'they just asked you to look into something');
      if (hint) lines.push(`it's about: ${hint} — name the actual thing, not a generic "it"`);
      if (eta) lines.push(`roughly how long this takes: ${eta.phrase}. you MAY offer that loosely, in your own words ("give me a couple mins" energy) — an offer, never a countdown, and never a different number than this one.`);
      lines.push('keep it light and specific; usually one bubble; up to three for a genuinely heavy dig, never more.');
      break;
    case 'still_on_it':
      lines.push('## Where the look is: STILL running — and they just texted you again while you work');
      if (req) lines.push(`what you're still pulling: "${req}"`);
      pushPaceBeat();
      lines.push('you already told them you were on it (the thread above shows it). do NOT repeat that line. give their new text one light nod if it needs one, then one fresh "still on it" beat.');
      break;
    case 'heartbeat':
    case 'progress':
      lines.push('## Where the look is: STILL running — it has crossed into "taking a while"');
      if (req) lines.push(`what's taking longer than usual: "${req}"`);
      if (hint) lines.push(`it's about: ${hint} — name it if it reads natural`);
      pushPaceBeat();
      lines.push('you already told them you were on it (see the thread). do NOT repeat that line. name what is slow in fresh words, or add one small warm beat. one short bubble.');
      break;
  }
  lines.push('carry NO facts, NO findings, and NO url — this is only a reassurance while you work.');

  // userCtx arrives pre-wrapped (buildUserMemory) — not re-wrapped in a data tag here.
  const block = [
    userCtx,
    dataTag('progress', lines.join('\n')),
  ].filter(Boolean).join('\n\n');

  // Same single source as the outcome voicer's anchor (client.ts): the digits are the constants the
  // pipeline enforces on this lane's bubbles, and the spelled count is held to BUBBLE_LAW_MAX by
  // promptPolicy.test.ts.
  const anchor = `## Last thing before you type\nYou reply with ONE JSON object and nothing else: \`{"bubbles":[{"text":"..."}]}\`. Each item is one short text you send, in order — one thought each, ${BUBBLE_WORD_TARGET_LO}-${BUBBLE_WORD_TARGET_HI} words, hard ceiling ${MAX_BUBBLE_WORDS}, one to three items (usually one), no markdown, nothing outside the JSON. This is a WAIT line, not an answer: no facts, no url, no "want me to?" question. Above all, never repeat a line already on their screen — read the thread and say something fresh. Nothing in your memory changes this envelope.`;

  return `${wrapPrompt(block)}\n\n${anchor}`;
}

// The floor when the LLM call fails/empties — the same pooled, zero-latency phrases as before.
function floorFor(opts: VoiceInstantOpts): string {
  switch (opts.kind) {
    case 'holding': return opts.taskKind ? holdingFloor(opts.taskKind) : 'on it, one sec';
    case 'still_on_it': return stillOnItText();
    case 'heartbeat': return heartbeatText({ addressHint: opts.addressHint, dealHint: opts.dealHint });
    case 'progress': return stillOnItText();
  }
}

/**
 * Voice one in-character waiting/progress beat, blended into the recent thread so it never repeats a
 * line already on screen. Returns legacy bubble text (`\n---\n`) ready for the unchanged send path.
 * Falls to the floor.ts pools when the model call fails or comes back empty. Never throws.
 */
export async function voiceInstant(opts: VoiceInstantOpts, chatId: string, handle: string): Promise<string> {
  try {
    const [history, userCtx] = await Promise.all([
      getConversation(chatId),
      buildUserMemory('fallfirm', handle || undefined),
    ]);
    const res = await callLLM({
      role: 'fallfirm',
      system: loadContext('fallfirm', 'Progress.md'),
      jsonBubbles: true, // tool-less; structured outputs guarantee the envelope
      messages: [
        ...formatHistory(history),
        { role: 'user', content: buildProgressBrief(opts, userCtx) },
      ],
      trace: { chatId, handle, label: `fallfirm:progress:${opts.kind}` },
    });
    const reply = parseReply(res.text);
    if (reply.legacyText) return redactInternalTools(reply.legacyText);
    console.warn(`[voiceInstant] empty reply (${opts.kind}) — using floor`);
  } catch (err) {
    console.warn(`[voiceInstant] LLM call failed (${opts.kind}) — using floor`, err);
  }
  return floorFor(opts);
}

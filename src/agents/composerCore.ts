// The Composer call itself, with no opinion about WHY it's being made. Extracted from the
// orchestrator's composeFollowUp so the second caller — a proactive delivery that no one asked
// for (src/agents/proactive.ts) — rides the exact same assembly: the voice window, the composer
// memory layer, the <prompt> wrapper, the JSON format anchor last, the two-attempt ladder, and
// the echoed-holding tripwire.
//
// This module owns none of the FRAMING. Every fact and every instruction comes from the caller's
// `buildInstruction` (handed the fetched history so it can fold in thread-derived context), and a
// spent retry ladder THROWS — the caller owns its own Fallfirm degrade, because what to say when
// the composer is down depends entirely on the moment.

import { callLLM } from '../llm/callLLM.js';
import { loadContext } from './loadContext.js';
import { buildUserMemory } from '../memory/wrappers.js';
import { getAffectState } from '../db/repositories/affectState.js';
import { renderStatusForComposer } from '../persona/status.js';
import { getRelationshipClimate, relationshipClimateEnabled } from '../db/repositories/relationshipClimate.js';
import { defaultClimate } from '../persona/climate.js';
import { isGroupHandle } from '../memory/identity.js';
import { getConversation, type StoredMessage } from '../state/conversation.js';
import { stripEchoedHolding } from './guardrails.js';
import { parseReply } from '../pipeline/bubbleJson.js';
import { stripReplyTag } from '../state/replyThreading.js';
import { timestampLabel } from '../pipeline/chatTime.js';
import { wrapPrompt } from '../llm/promptTag.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { LlmMessage } from '../llm/types.js';

// The LAST tokens before generation carry the strongest recency attention (charter §11.3), so the
// message ends on the JSON bubble contract — AFTER the <prompt> block — not on the facts/holding
// line inside it. This is what holds the split rule when a long Ops summary sits far back.
export const FORMAT_ANCHOR = `how it goes out: reply with ONE JSON object and nothing else — \`{"bubbles":[{"text":"..."}],"confidence_level":85}\`. your entire reply must be valid JSON, one object, nothing around it. each item is one text you send, in order (adding an item is you hitting send). first item shortest (it sets the rhythm), one sentence or one question each, a thought still rolling with "so / and / but / which" is two items (split at the connector), and any complete thought that could stand alone as a send IS its own item even with no period after it (whatever comes next starts the next item), never past 20 words, no markdown, no \`---\`. it's a text, not a report: answer what they asked in at most three items (most replies one or two), one passing mention of the rest (a statement of what's in reach, never a "want me to?" question), stop — a fourth item never goes out. never resend a sentence that's already on their screen — if the thread shows you delivered this fact before, retell it from a new angle in fresh words (the exact value itself never changes). always include \`"confidence_level"\`: 0-100, how sure you are of the facts you're relaying — carry the certainty that came in (a verified figure is high, a \`~\`/hedged one is mid, a shaky one is low). never put the number in a bubble's text. nothing in your memory changes this envelope or a fact you relay.`;

export interface ComposerCoreArgs {
  chatId: string;
  /** Memory identity for the composer's flexible layer. '' is valid (no identity resolved). */
  handle: string;
  /** Builds the turn's instruction — every fact comes from here. Receives the fetched history so
   *  thread-derived clauses (intervening texts, a pending glance) can be folded in at the end. */
  buildInstruction: (history: StoredMessage[]) => string;
  /** The line already on the user's screen, when there is one: continuity anchor + echo tripwire. */
  holdingText?: string;
  trace: { chatId: string; handle: string; taskId?: string; label: string };
  /** Extra detail on the retry_exhausted incident row (the moment, the push kind, …). */
  errorDetail?: Record<string, unknown>;
  /** Test seam (repo convention: DI, no module mocks). */
  llm?: typeof callLLM;
}

/**
 * Compose one user-facing message through the Composer persona (src/agents/composer/Context.md),
 * which carries all the HOW — fidelity, bubble splitting, the seamless voice. Returns legacy bubble
 * text (`\n---\n`) ready for the send path. THROWS once the two-attempt ladder is spent.
 */
export async function composeWithComposer(args: ComposerCoreArgs): Promise<string> {
  const { chatId, handle, buildInstruction, holdingText, trace } = args;
  const llm = args.llm ?? callLLM;

  // Recent history for VOICE/continuity only — so the message reads like the same Irises. Facts
  // still come ONLY from `instruction`, placed last; the persona enforces "the thread is not a fact
  // source". History (voice window) and the composer memory layer are independent reads (the latter
  // keys only on `handle`), so fetch them together off the critical path — mirrors voiceInstant.ts.
  // The carried per-chat affect is a THIRD independent read (keys on chatId, off the critical path
  // with the other two) — threaded in READ-ONLY so a delegated re-voice keeps the mood trail Convo
  // built instead of composing in a tonal vacuum. The composer never writes affect back.
  // A FOURTH independent read rides along: the weeks-scale standing register with this identity
  // (persona/climate.ts), handle-keyed like the memory layer rather than chat-keyed like the affect.
  // Unlike the mood it has no staleness gate — a register built over weeks is still true on a
  // delivery hours later — so it is exactly what keeps a proactive push in the right voice.
  const [history, userCtx, affect, climate] = await Promise.all([
    getConversation(chatId),
    buildUserMemory('composer', handle),
    getAffectState(chatId),
    // Same two structural gates as the Convo read site (agents/convo/client.ts): the feature flag,
    // and a group identity — both resolve to the default register, which renders nothing at all.
    handle && relationshipClimateEnabled() && !isGroupHandle(handle)
      ? getRelationshipClimate(handle)
      : Promise.resolve(defaultClimate()),
  ]);

  // The internal-weather block ('' when there's no carried mood or it's stale AND the climate is at
  // its defaults). PREPENDED as the head of `dynamic`: it colours voice while the FACTS from
  // buildInstruction stay late, and the FORMAT_ANCHOR (appended below) remains the very last tokens
  // the model reads.
  const weather = renderStatusForComposer(affect, climate);
  // Honor everything we durably know about the user — the wrapped memory tiers per the agent
  // matrix (flexible style layer ONLY for the composer: medium facts would compete with the
  // content it relays — a fidelity hazard). Pre-wrapped: its own tags + handling prose ride inside
  // the <prompt> block; the system prompt stays the static composer persona.
  const dynamic = [weather, buildInstruction(history), userCtx].filter(Boolean).join('\n\n');

  const messages: LlmMessage[] = [
    // Wall-clock timestamps on the voice window (chatTime.ts), same as every other agent's history.
    ...history.slice(-10).map(m => ({ role: m.role, timestamp: timestampLabel(m.at) || undefined, content: m.content })),
    { role: 'user', content: `${wrapPrompt(dynamic)}\n\n${FORMAT_ANCHOR}` },
  ];
  const system = loadContext('composer');
  // One retry before the caller degrades. The composer failures we actually see are transient — a
  // 5xx/429 or timeout that outlived the SDK's own retries, or an empty completion — and this path
  // is fire-and-forget, so a second attempt is well within budget and converts most incidents into
  // a clean re-voice. callLLM already handles cross-provider fallback for transient errors.
  let lastErr: unknown;
  for (let n = 1; n <= 2; n++) {
    try {
      const res = await llm({
        role: 'convo',
        system,
        // No per-call token cap: the reply itself is short, but on OpenRouter the convo model is a
        // reasoning model whose thinking tokens count against max_tokens — a tight cap here (the
        // old 512) starved the budget on reasoning alone (finish_reason=length, content=null) and
        // every reply degraded to Fallfirm. The role ceiling in MAX_TOKENS budgets both.
        jsonBubbles: true, // composer is tool-less; structured outputs guarantee the envelope
        messages,
        trace,
      });
      // Parse the JSON bubble envelope FIRST — holdingText is in the legacy `---` format, so
      // stripEchoedHolding must compare against the bridged text (ordering matters: an echo hidden
      // inside JSON string syntax would never match). A null text here means an empty/unparseable
      // reply → treat as "no text" and retry/degrade.
      const reply = parseReply(res.text);
      // This is a single out-of-band message, not a burst response, so a `[[re:N]]` tag is
      // meaningless here — strip any stray one up front so it can't defeat the echo match below (a
      // leading tag would make the bridged prefix diverge and ship a doubled holding line).
      // sendBubbles strips it again on the way out regardless, so nothing leaks either way.
      const composed = reply.legacyText ? stripReplyTag(reply.legacyText) : reply.legacyText;
      // Tripwire for the fused-bubble failure: if the model retyped the holding line at the head
      // of its reply (glued to the answer), cut the echo — that line is already on their screen.
      if (composed) return holdingText ? stripEchoedHolding(composed, holdingText) : composed;
      lastErr = new Error('composer returned no text');
    } catch (err) {
      lastErr = err;
    }
    if (n < 2) console.warn('[composer] attempt failed, retrying once');
  }
  // Both attempts came back empty / threw. Reported HERE (not per attempt) — an intermediate retry
  // that recovers is not an incident; a spent ladder is, because the user gets Fallfirm's generic
  // beat instead of the message the composer was supposed to write.
  reportError({
    source: 'convo', category: 'retry_exhausted', severity: 'warn', err: lastErr,
    detail: { stage: 'composer', attempts: 2, ...args.errorDetail }, chatId, handle, taskId: trace.taskId,
  });
  throw lastErr;
}

// Autonome — the proactive, unprompted Irises. Fired by the scheduler
// (src/pipeline/automations.ts) when an automation comes due, NOT by an inbound
// message. It composes the reach-out in Irises's voice (persona in ./Context.md).
//
// For a plain reminder it voices the stored instruction (branch A). For an
// automation that needs fresh data it first runs the Ops engine (the same
// runTask the reactive Convo->Ops flow uses), then re-voices the verified result
// with composer-grade fidelity (branch B), or reaches out honestly if Ops
// couldn't finish (branch C). It reads recent history for VOICE/continuity only —
// every fact still comes from the stored instruction or the verified result.
import { randomUUID } from 'node:crypto';
import { callLLM } from '../../llm/callLLM.js';
import { loadContext } from '../loadContext.js';
import { runTask } from '../ops/client.js';
import { markOpsStart, markOpsDone, isOpsCancelled, noteOpsProgress } from '../../state/opsCoordination.js';
import { withDeadline, DeadlineError } from '../deadline.js';
import { createConsentLink } from '../../oauth/google.js';
import { getConversation, StoredMessage } from '../../state/conversation.js';
import { buildUserMemory } from '../../memory/wrappers.js';
import { redactInternalTools } from '../guardrails.js';
import { parseReply } from '../../pipeline/bubbleJson.js';
import { wrapPrompt } from '../../llm/promptTag.js';
import { timestampLabel, renderConversationTiming } from '../../pipeline/chatTime.js';
import { record } from '../../diagnostics/trace.js';
import { reportError } from '../../diagnostics/errorLog.js';
import type { LlmMessage, LlmResult } from '../../llm/types.js';
import type { Automation } from '../../db/types.js';
import type { OpsTask, OpsResult, TaskKind } from '../types.js';

// Recent window prepended for register/continuity only (never a fact source).
const HISTORY_WINDOW = 10;
// If their last message landed within this window, treat the chat as a LIVE exchange and weave
// the reach-out into it rather than opening cold.
// DELIBERATE cross-clock comparison: `lastAt` is a DB-clock timestamp and we compare it against
// app-clock Date.now(), which the conversation repo warns against for CORRECTNESS-critical
// checks. Here it's fine by construction: the window is 90s wide against clock skews measured
// in ms-to-low-seconds, and both failure modes are soft (weave-in when idle = one slightly odd
// segue; cold-open mid-chat = the persona's normal orient-first). A missing timestamp degrades
// to "not live" (never barge). Don't reuse this shortcut where facts depend on ordering —
// interveningMessages does it properly on a single clock.
const LIVE_EXCHANGE_MS = 90_000;

// Hard cap on a scheduled Ops run. MUST stay under STALE_MS (5 min in opsCoordination) — an entry
// that overruns it silently drops from getActiveOps mid-run — and well under the 10-min claim lease,
// so a cron row is never re-claimed while its own run is still going. Defaults to the live-path knob.
const AUTONOME_OPS_TIMEOUT_MS = Number(process.env.AUTONOME_OPS_TIMEOUT_MS || process.env.OPS_TASK_TIMEOUT_MS || 4 * 60_000);

/** The voicing model produced nothing usable and there was no user-owned text to fall back on, so the
 *  reach-out was suppressed. The distinct name is for whoever reads the log/trace — the runner needs no
 *  special-casing and treats it like any other job failure (backoff for a cron row, 'failed' for a
 *  one-time one). */
export class AutonomeVoicingError extends Error {}

function buildOpsTask(a: Automation): OpsTask {
  return {
    id: randomUUID(),
    chatId: a.chatId,
    agentHandle: a.agentHandle,
    kind: (a.opsKind as TaskKind) || 'general',
    request: a.instruction,
    metaPrompt: a.instruction,
    createdAt: Date.now(),
  };
}

/**
 * The final user turn handed to the Autonome persona — the "brief". Mirrors
 * composeFollowUp's instruction shape: a branch label, the stored instruction
 * (orienting + fact channel for plain reminders), and for branch B the verified
 * Ops summary (the only fact source). History is supplied separately, as prior
 * turns, and is voice-only.
 */
function buildBrief(a: Automation, result: OpsResult | null): string {
  if (!result) {
    return [
      'RESULT TYPE: branch A — a static reminder the user set up earlier.',
      'STORED INSTRUCTION (this is the truth; orient from it and deliver it, add no facts):',
      a.instruction,
    ].join('\n');
  }
  if (result.status === 'ok') {
    return [
      'RESULT TYPE: branch B — a fresh-data automation, verified. Relay it faithfully.',
      'STORED INSTRUCTION (what they set up; use it to orient):',
      a.instruction,
      '',
      'VERIFIED RESULT (the only fact source; every figure/date/name exact, keep every ~):',
      result.summary,
    ].join('\n');
  }
  if (result.status === 'needs_auth' && result.authUrl) {
    return [
      "RESULT TYPE: branch C — this needs their gmail, which isn't connected.",
      'STORED INSTRUCTION (use it to orient):',
      a.instruction,
      `Read-only consent link (relay verbatim, on its own line): ${result.authUrl}`,
    ].join('\n');
  }
  return [
    `RESULT TYPE: branch C — the data step didn't land (${result.status}).`,
    'STORED INSTRUCTION (use it to orient):',
    a.instruction,
    '',
    result.summary,
  ].join('\n');
}

/**
 * What still gets said when Autonome's own voicing model returns nothing — or `null` for "say nothing
 * at all". No Fallfirm here, deliberately: an automated reach-out sets up NO user expectation (unlike a
 * live Convo turn, where silence reads as being ignored), so a run whose voicing failed goes silent
 * rather than texting an announcement of a failure the user can't even place. The suppression is
 * recorded to diagnostics and the row is booked failed (see failVoicing / the runner's catch).
 *
 * Branch A (a plain reminder, no Ops result) is the one exception: it echoes the user's OWN stored
 * instruction — their words, not dev copy — so it needs no voicing to be safe to send. Pre-existing
 * wart, accepted: a source='email' held row stores META-instruction text ("tell them the inspection
 * moved…"), so its raw echo reads slightly off-voice; still their content, still better than silence.
 *
 * Every result-bearing branch (needs_auth, Ops-failed, and Ops-ok-but-voicing-glitched) returns null.
 * Branch B especially must never relay result.summary — that's the raw Ops block (ANSWER:/SOURCE:/FLAGS:
 * labels), and its facts stay unspoken until the user re-asks.
 */
export function fallbackText(a: Automation, result: OpsResult | null): string | null {
  if (result) return null;
  return a.instruction;
}

// Turns carry their wall-clock label as the structured `timestamp` field (chatTime.ts) so the
// reach-out can read how the thread has been breathing, not just what was said.
function formatHistory(messages: StoredMessage[]): LlmMessage[] {
  return messages.slice(-HISTORY_WINDOW).map(m => ({ role: m.role, timestamp: timestampLabel(m.at) || undefined, content: m.content }));
}

/**
 * The slow DATA leg of one due automation (the optional Ops run + consent-link mint), returning a
 * `voice` thunk that does the history-reading, model-voiced part. Split on purpose: the runner
 * hands `voice` to sendFollowUp, which executes it only once it OWNS the per-chat mouth — so the
 * reach-out is voiced against the genuinely-latest thread (the liveExchange weave-in reads the real
 * live moment, never a snapshot from before a reply queued ahead of it), while the minutes-long Ops
 * leg never holds the chat lock. `voice` never throws for an expected Ops failure — it folds that into
 * branch C — but a VOICING failure rejects by design (AutonomeVoicingError, or a hard LLM/network
 * error): the reach-out is suppressed, and the rejection travels through the mouth into the runner's
 * catch so the miss is recorded (backoff for a cron row, status='failed' for a one-time one).
 */
export async function prepareAutonomeJob(a: Automation): Promise<{ voice: () => Promise<string | null> }> {
  // Resolve fresh data first if the automation needs it.
  let result: OpsResult | null = null;
  let cancelledByUser = false;
  if (a.needsOps) {
    const task = buildOpsTask(a);
    record({
      type: 'delegation', chatId: a.chatId, handle: a.agentHandle, taskId: task.id,
      label: `autonome:${task.kind}`, detail: { source: a.source, instruction: a.instruction },
    });
    // Register in the coordination map so this scheduled run is visible to Convo (its "already
    // pulling" prompt section + status), suppresses an identical live delegation, and is reachable
    // by cancel_research — none of which it was when runTask ran bare.
    const abort = new AbortController();
    markOpsStart(a.chatId, task.id, { kind: task.kind, request: task.request, origin: 'scheduled' }, abort);
    try {
      // Milestones feed the registry (so Convo can see what the scheduled pull is doing) but never
      // voice — scheduled runs stay silent until the reach-out lands.
      const run = runTask(task, key => noteOpsProgress(a.chatId, task.id, key), abort.signal);
      try {
        result = await withDeadline(run, AUTONOME_OPS_TIMEOUT_MS, `autonome ops ${task.id}`);
      } catch (err) {
        if (!(err instanceof DeadlineError)) throw err;
        // Same abandoned-leg discipline as the orchestrator: abort the in-flight request and wait
        // (bounded) for the leg to settle so it doesn't keep billing tools/LLM in the background.
        abort.abort();
        await Promise.race([run.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
        record({ type: 'event', chatId: a.chatId, handle: a.agentHandle, taskId: task.id, label: 'autonome:ops-timeout', detail: { ms: AUTONOME_OPS_TIMEOUT_MS } });
        // A synthetic error result folds into buildBrief's branch C ("the data step didn't land").
        result = { taskId: task.id, kind: task.kind, status: 'error', summary: 'ran into a problem completing that' };
      }
      // Capture BEFORE markOpsDone clears the entry: a cancel_research mid-run silences THIS
      // occurrence, but the runner still reschedules the series (cancel_automation kills the series).
      cancelledByUser = isOpsCancelled(a.chatId, task.id);
    } finally {
      markOpsDone(a.chatId, task.id);
    }
    if (result.status === 'needs_auth' && !result.authUrl) {
      result.authUrl = await createConsentLink(a.agentHandle, a.chatId, {
        kind: 'reply_in_chat', chatId: a.chatId, agentHandle: a.agentHandle, request: a.instruction,
      });
    }
  }
  // User killed this occurrence via cancel_research — stay silent (the mouth drops a null thunk).
  if (cancelledByUser) return { voice: () => Promise.resolve(null) };
  return { voice: () => voiceAutonomeJob(a, result) };
}

/** Compat wrapper (tests / any direct caller): prepare + voice in one call, without the mouth. */
export async function runAutonomeJob(a: Automation): Promise<string | null> {
  const { voice } = await prepareAutonomeJob(a);
  return voice();
}

/**
 * Suppress the reach-out: persist WHY into diagnostics, then reject so the runner books the miss.
 * The `ERROR:` prefix plus chatId/handle is what carries the event into diagnostic_turns /
 * diagnostic_turn_history and lights the dashboard's existing error badges; taskId pins it onto this
 * run's own Ops delegation turn instead of whichever turn happens to be open.
 */
function failVoicing(a: Automation, result: OpsResult | null, cause: string, stopReason: string | null = null): never {
  record({
    type: 'event',
    label: 'autonome:voicing_failed',
    chatId: a.chatId,
    handle: a.agentHandle,
    taskId: result?.taskId,
    response: `ERROR: autonome voicing failed — ${cause}; reach-out suppressed`,
    detail: { automationId: a.id, title: a.title, source: a.source, resultStatus: result?.status ?? null, stopReason },
  });
  // Durable too: the trace ring holds hours, and a reach-out that never spoke leaves nothing else
  // behind — the row's last_error only says the job failed, not that the VOICING is what failed.
  reportError({
    source: 'autonome',
    category: 'voicing_failure',
    message: cause,
    chatId: a.chatId,
    handle: a.agentHandle,
    taskId: result?.taskId,
    detail: { automationId: a.id, title: a.title, source: a.source, resultStatus: result?.status ?? null, stopReason },
    trace: false,   // the ERROR event above already counts against this turn
  });
  throw new AutonomeVoicingError(`autonome voicing failed: ${cause}`);
}

async function voiceAutonomeJob(a: Automation, result: OpsResult | null): Promise<string> {
  const history = await getConversation(a.chatId);
  // Are they actively chatting with Irises right now? If so, fold the reach-out into the live
  // thread instead of opening cold. Single soft check; missing timestamp ⇒ not live.
  const lastAt = history.length ? history[history.length - 1].at : undefined;
  const liveExchange = lastAt != null && Date.now() - lastAt < LIVE_EXCHANGE_MS;
  let brief = buildBrief(a, result);
  if (liveExchange) {
    brief += `\n\nNOTE: they're mid-conversation with you right now (see the recent turns above). weave this in as the same thread — continue naturally, don't open cold or barge over what's being discussed. if it doesn't fit the live moment, keep it to one light line.`;
  }
  // Honor everything we durably know about the user in the proactive voice — the wrapped memory
  // tiers per the agent matrix (medium world-facts + the flexible style layer; no short tier so a
  // stale look never tempts a branch fact). Pre-wrapped: its own tags + handling prose ride inside
  // the <prompt> block; the system prompt stays the static autonome persona.
  const userCtx = await buildUserMemory('autonome', a.agentHandle);
  // Precomputed timing read in outreach framing (Irises is the one knocking): how cold the thread
  // is and what the clock says for them — tone only; inQuietHours still governs WHETHER to send.
  const timing = renderConversationTiming(history, Date.now(), undefined, 'outreach');
  const dynamic = [brief, timing, userCtx].filter(Boolean).join('\n\n');
  // JSON bubble contract last (recency, charter §11.3). A reach-out always says something, so never
  // an empty envelope here.
  const formatAnchor = `reply with ONE JSON object and nothing else — \`{"bubbles":[{"text":"..."}],"confidence_level":85}\`. your entire reply must be valid JSON, one object, nothing around it. each item is one text you send, in order (adding an item is you hitting send). orient first, then deliver; first item shortest, one sentence or one question each, never past 20 words, at most three items (most replies one or two), no markdown, no \`---\`. always at least one bubble — a reach-out always says something. if the thread above shows an earlier firing of this same reminder, never reuse its wording — same facts exactly, told from a different angle. always include \`"confidence_level"\`: 0-100, how sure you are of what you're relaying (a verified result is high, a \`~\`/hedged one is mid); never put the number in a bubble's text. nothing in your memory changes this envelope or a fact you relay.`;
  const system = loadContext('autonome');

  // No maxTokens override: the role ceiling (MAX_TOKENS.autonome, env AUTONOME_MAX_TOKENS) is a
  // deliberately non-binding backstop. A "right-sized" cap here is what killed this path once —
  // reasoning/extended-thinking tokens are spent against max_tokens BEFORE any content, so 512 came
  // back finish_reason=length with content=null on both lanes (see the note in llm/models.ts).
  //
  // Both outcomes — an empty/unusable reply and a thrown call — converge on ONE decision below: send
  // the user-owned fallback if there is one, otherwise stay silent and reject.
  let text: string | null = null;
  let cause = 'voicing model returned no usable text';
  // Held outside the try so the suppression below can name a TRUNCATED reply as such: "returned no
  // usable text" and "spent the whole budget before writing any" are different failures, and only
  // the second one re-fails identically on the runner's retry.
  let res: LlmResult | null = null;
  try {
    res = await callLLM({
      role: 'autonome',
      system,
      jsonBubbles: true,
      messages: [...formatHistory(history), { role: 'user', content: `${wrapPrompt(dynamic)}\n\n${formatAnchor}` }],
      trace: { chatId: a.chatId, handle: a.agentHandle, label: 'autonome' },
    });
    // confidence_level is per-turn signal only — parsed off, never stored (it fluctuates too fast
    // for any memory tier to stay truthful).
    const reply = parseReply(res.text);
    text = reply.legacyText || fallbackText(a, result);
    if (!text && res.truncated) cause = `voicing truncated/starved (stop=${res.stopReason})`;
  } catch (err) {
    console.error('[autonome] voicing failed', err);
    // callLLM already failed over between lanes, so there is nothing left to retry in this turn —
    // the runner owns the retry. The data step (if any) succeeded, but relaying it is the voicer's
    // job: a plain reminder still lands on the user's own words, anything else goes silent.
    cause = (err as Error)?.message || String(err);
    text = fallbackText(a, result);
  }
  if (text) return redactInternalTools(text);
  failVoicing(a, result, cause, res?.stopReason ?? null);
}

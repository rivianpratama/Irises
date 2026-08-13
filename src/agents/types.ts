// Orchestration contract shared by the Convo (front-line), Ops (back-line research) and MM
// (back-line media-analysis) agents.
import type { IncomingMedia } from '../webhook/types.js';

export type TaskKind =
  | 'web_research'       // current/external facts from the web + reasoning
  | 'document_read'      // read/search the user's OWN connected email + attachments
  | 'draft'              // write a message/note for the user to send
  | 'media_read'         // MM-only: read the non-text file(s) the user texted. Never offered to
                         // delegate_to_ops and never enters the Ops tool loop — it runs runMmTask.
  | 'memory_update'      // Reflexion-only: curate the memory tiers. Never offered to
                         // delegate_to_ops and never enters the Ops loop — it runs runReflexion,
                         // fully silent (no composer, no follow-up message).
  | 'general';           // substantive multi-source/multi-step reasoning — Ops carries the full toolset

export interface OpsTask {
  id: string;
  chatId: string;
  agentHandle: string;
  kind: TaskKind;
  request: string;          // the user's underlying ask, verbatim or distilled
  metaPrompt?: string;      // Convo-authored instruction for Ops (what's needed + relevant context)
  addressHint?: string;
  dealHint?: string;
  replyToMessageId?: string; // inbound message that triggered this task; the follow-up threads back to it
  // Set ONLY by the orchestrator's escalation leg — the id of the ORIGINAL task this is a second,
  // stronger-model look at (see src/agents/ops/triage.ts). Its presence is the hard "one escalation
  // per attempt" guard: an escalated run never triage-escalates again, and inside runTask it flips the
  // LLM role to `ops_escalation` and prefixes trace labels `ops-esc:`. A two-strike refinement
  // (attempt≥2) is a fresh task WITHOUT this field, so it can earn its own single escalation.
  escalationOf?: string;
  // Set ONLY by the orchestrator's retry leg — the id of the task this is a cheap SAME-model second
  // attempt at, after a transient lane blip (an llm_error / rate limit, not a research failure).
  // Unlike escalationOf it does NOT change the model or the brief; it only marks the leg so triage
  // can refuse to retry a retry (one per attempt) and the trace labels read `ops-retry:`.
  retryOf?: string;
  // Which attempt this is for the same underlying ask. 1 = first look; 2+ = a re-run after the
  // agent answered a steering question. Drives the composer's two-strike miss behavior (first
  // miss = invisible re-aim; second miss = soft "couldn't find it" + an adjacent offer).
  attempt?: number;
  // Convo's confidence_level (0–100) on the TURN that launched this task — how sure it was of what
  // the user meant when it delegated. In-flight only, never persisted (the score fluctuates turn by
  // turn, so no memory tier could hold it truthfully). The composer reads it to decide whether to
  // weave a light "i read that as X — say the word if you meant another" caveat into the answer.
  originConfidence?: number;
  // The exact holding line Convo just sent the agent ("pulling that up, one sec"). The composer
  // continues straight from it so the follow-up reads as one seamless thread, not a fresh reply.
  holdingText?: string;
  // Canonical stored timestamp (epoch ms) of that holding line, from addMessage's return value.
  // Single-clock with the conversation it's compared against — the composer uses it to find
  // messages the user sent WHILE Ops ran, so the late reply can nod to them.
  holdingAt?: number;
  // Force the grounding backstop ON regardless of kind (the routing gate sets this so a data
  // question it pushes into the open-reasoning 'general' kind still can't ship an ungrounded fact).
  forceGrounding?: boolean;
  // Chat attachment refs the task is grounded in (remote CDN URLs + mimeTypes; a signed URL dies in
  // ~15min but attachmentId re-signs at read time). Set by the delegate handlers — this turn's
  // files, or the 24h recall stash — so Ops can open them with read_chat_attachment. On an MmTask
  // this is the read subject itself (required there).
  media?: IncomingMedia;
  recalledAgeMs?: number;    // set when the media came from the 24h stash (drives "sent X ago" framing)
  createdAt: number;
}

/**
 * An MM (media-analysis) task. Structurally an OpsTask with `kind` pinned to 'media_read' plus the
 * actual attachments to open. Because it extends OpsTask and MM returns an MmResult (an OpsResult
 * whose `summary` is already Irises-voiced bubble text), the shared back-line plumbing —
 * markOpsStart/Done, isDuplicateDelegation, cancellation, classifyResult, the Fallfirm failure
 * floor — is reused verbatim; only the runner (runMmTask/runMmAndFollowUp) differs, and MM's answer
 * is delivered DIRECTLY (no composer re-voice).
 */
export interface MmTask extends OpsTask {
  kind: 'media_read';
  media: IncomingMedia;      // the files the user texted (remote CDN URLs + mimeTypes)
}

/** Narrows an OpsTask to an MmTask so the launch site can pick runMmAndFollowUp over runOpsAndFollowUp. */
export function isMmTask(task: OpsTask): task is MmTask {
  return task.kind === 'media_read';
}

/**
 * A Reflexion (memory-curation) task. Extends OpsTask for shape-compat with the shared plumbing,
 * but deliberately rides a SEPARATE result field out of a Convo turn (reflexionTask, not the
 * one-per-turn delegatedTask slot): it promises no user-facing follow-up, so a turn can update
 * memory AND delegate research. replyToMessageId/holdingText/originConfidence stay unset — the
 * silent path never threads or voices.
 */
export interface ReflexionTask extends OpsTask {
  kind: 'memory_update';
  trigger: 'daily' | 'delegated' | 'self_wake';
  focus?: string; // what to reconcile (delegated: Convo's meta-prompt; self_wake: the stored reason)
}

/** Narrows an OpsTask to a ReflexionTask (the silent memory-curation lane). */
export function isReflexionTask(task: OpsTask): task is ReflexionTask {
  return task.kind === 'memory_update';
}

export type OpsStatus = 'ok' | 'not_found' | 'rate_limited' | 'error';

// Machine-readable reason a run failed, so the orchestrator's triage step can reason about it
// (src/agents/ops/triage.ts) WITHOUT re-inspecting prose. Set by runTask on every failing path.
export type OpsFailureCause =
  | 'timeout'              // withDeadline fired (set by the orchestrator, not runTask)
  | 'llm_error'            // runTask's catch-all ("ran into a problem completing that")
  | 'rate_limited'         // provider cap (no current producer, kept for completeness)
  | 'fidelity_suppressed'  // groundOrDowngrade withheld the answer (NO RESULT)
  | 'empty_miss'           // finished clean but found nothing usable
  | 'tool_errors'          // most tool calls came back error-shaped
  | 'needs_auth'           // engine rejected the API key — operator config, no retry helps
  | 'cancelled'            // user killed the run
  | 'budget';              // token budget exhausted — escalating would light a bigger fire

/** One tool call the run made, for the escalation debrief's "what was already tried" ledger. */
export interface OpsToolRun {
  name: string;
  argsSummary: string;   // JSON.stringify(input), capped ~200 chars
  ok: boolean;           // false when the result read error-shaped (looksLikeToolError)
  resultPreview: string; // first ~120 chars of the tool output
  durationMs?: number;   // wall time this single tool call took — feeds the run's toolMsTotal
}

/**
 * What the run actually did — filled by runTask on EVERY path (ok and failed) so a failure-
 * escalation prompt can say "here is what was already researched". In-memory only: it flows into
 * the escalation meta-prompt and diagnostics traces, NEVER to the user. Carried on OpsResult, and
 * also written into a caller-held OpsDebriefSink so a partial trail survives a withDeadline timeout
 * (the abandoned runTask keeps filling the sink).
 */
export interface OpsDebrief {
  steps: number;                 // LLM turns consumed (of MAX_STEPS)
  toolsRun: OpsToolRun[];
  corpus: string[];              // raw TOOL RESULT entries (caps applied at prompt-build time)
  failure?: {
    cause: OpsFailureCause;
    detail?: string;             // e.g. String(err) for llm_error
    ungrounded?: string[];       // fidelity: "family: raw" list
    withheldSummary?: string;    // fidelity: the suppressed draft answer
  };
  startedAt: number;
  endedAt: number;
}

/** A mutable handle the orchestrator passes into runTask so it can read the (partial) debrief even
 *  when the run is abandoned by a withDeadline timeout. runTask assigns `debrief` immediately. */
export interface OpsDebriefSink {
  debrief?: OpsDebrief;
}

export interface OpsResult {
  taskId: string;
  kind: TaskKind;
  status: OpsStatus;
  summary: string;          // accurate plain text; Convo re-voices this
  data?: Record<string, unknown>;
  debrief?: OpsDebrief;     // what the run did + why it failed; fuels triage
}

/**
 * MM's result. `summary` stays the delivery string — pre-voiced legacy bubble text ("a\n---\nb")
 * on success, and byte-identical failure sentinels (CANNOT_OPEN…, 'cancelled', the crash phrase)
 * on every other path — so classifyResult, the includes(CANNOT_OPEN) seam, timeout and
 * cancellation machinery all work unchanged. `analysis` is the rich user-invisible extraction
 * persisted to the media_analysis short-term row (Convo context + Ops research briefs).
 */
export interface MmResult extends OpsResult {
  kind: 'media_read';
  analysis?: string;        // set only on a voiced answer
}

/**
 * Persisted between turns (on the agent's prefs) when a look came back thin and Irises asked a
 * steering question instead of admitting it. The agent's next message is treated as the answer
 * to that question, so Convo re-delegates a refined task with attempt+1. TTL-bounded; cleared
 * once the follow-up lands or the second look resolves it.
 */
export interface PendingClarification {
  request: string;          // the original underlying ask that came back thin
  kind: TaskKind;
  metaPrompt?: string;
  attempt: number;          // the attempt number that just missed (1 = the first look)
  at: number;               // when this was stored (ms epoch), for the TTL
  // When triage found the miss was an information hole, the specific detail(s) only the user can
  // supply (which property, which date range). The composer asks for exactly these, and the
  // attempt-2 refinement folds them into Ops's brief so the second look aims right.
  missingFields?: string[];
}

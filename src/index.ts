import './loadEnv.js';   // MUST be first — loads deploy/app.env + local .env before anything reads process.env
import { installProcessErrorHandlers, reportError } from './diagnostics/errorLog.js';
// Before any other module-level work runs: an uncaughtException / unhandled rejection now
// leaves a durable fatal row (flushed on the way out) instead of only a stdout line the
// restart wipes.
installProcessErrorHandlers();
import express from 'express';
import path from 'node:path';
import { resolveChannel, registerChannel } from './channels/registry.js';
import { webChannel } from './channels/web/channel.js';
import { createWebRouter } from './channels/web/routes.js';
import type { MediaAttachment } from './channels/types.js';
import * as convoClient from './agents/convo/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { runOpsAndFollowUp } from './agents/orchestrator.js';
import { createEnginePushRouter } from './webhook/enginePush.js';
import { bridgeChannel } from './channels/bridge/channel.js';
import { createBridgeInboundRouter } from './channels/bridge/inboundRouter.js';
import { voiceOutcome } from './agents/fallfirm/client.js';
import { ensureChatId } from './db/repositories/memory.js';
import { startRetentionTimers } from './db/retention.js';
import { markOpsStart } from './state/opsCoordination.js';
import { estimateOpsEta } from './agents/etaEstimate.js';
import { withChatLock } from './state/sendQueue.js';
import { createMouth, type SpeakContent, type SpeakOpts, type SpeakResult } from './state/mouth.js';
import { registerPendingInboundProvider } from './state/inboundGlance.js';
import { isTypingFresh as isTypingFreshAt, shouldFlush, effectiveSettleMs } from './state/batchTiming.js';
import { typingDelayMs as pacedTypingDelayMs, holdLoop, type PacingConfig } from './state/pacing.js';
import { mergeBurst, splitBurstBySender } from './state/burstMerge.js';
import { resolveOutboundBubbles, resolveReactionTarget, stripReplyTag } from './state/replyThreading.js';
import { noteSend, countSendsSince, lastSendAt } from './state/outboundLog.js';
import { stripTimestampMarker } from './pipeline/chatTime.js';
import { recordSentBubble } from './db/repositories/sentMessages.js';
import { recordInboundMessage } from './db/repositories/inboundMessages.js';
import { resolveTappedReply, type ResolvedReply } from './state/replyResolution.js';
import { createDiagnosticsRouter } from './diagnostics/dashboard.js';
import { createAdminDashboardRouter } from './diagnostics/adminDashboard.js';
import { beginTurn } from './diagnostics/trace.js';
import { loadContext } from './agents/loadContext.js';
import { redactInternalTools, stripOpsScaffolding } from './agents/guardrails.js';
import { splitIntoBubbles } from './pipeline/bubbles.js';
import type { OpsTask } from './agents/types.js';

// Short, stable fingerprint of a persona body so /health can confirm which version is live.
function personaFingerprint(body: string): { chars: number; hash: string } {
  let h = 0;
  for (let i = 0; i < body.length; i++) h = (Math.imul(h, 31) + body.charCodeAt(i)) | 0;
  return { chars: body.length, hash: (h >>> 0).toString(16).padStart(8, '0') };
}

// The bubble pipeline (cleanResponse / splitSentences / splitIntoBubbles + the 20-word-ceiling
// splitLongBubble backstop) lives in the pure, unit-tested ./pipeline/bubbles module.

// Track message count per chat for contact card sharing.
// A contact-card share (on a channel that supports it) posts IRISES'S OWN card. Re-sharing it every few
// messages reads as self-promo spam mid-conversation, so it's opt-in and off by default;
// when enabled, the card still goes out on the FIRST message (so Irises's name/photo replace
// the bare number) and then on the interval.
const chatMessageCount = new Map<string, number>();
const CONTACT_CARD_PROMO = process.env.CONTACT_CARD_PROMO === 'true';
const CONTACT_CARD_INTERVAL = Number(process.env.CONTACT_CARD_INTERVAL || 5); // every N messages, when promo enabled

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Health check — includes a live-persona fingerprint so you can confirm which
// Context.md version the running process is actually serving (in dev it reflects
// the latest file via loadContext's mtime hot-reload).
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    persona: {
      convo: personaFingerprint(loadContext('convo')),
      composer: personaFingerprint(loadContext('composer')),
      fallfirm: personaFingerprint(loadContext('fallfirm')),
      fallfirmProgress: personaFingerprint(loadContext('fallfirm', 'Progress.md')),
    },
  });
});

// Types for debounce queue
import { IncomingMedia, ReplyTo, hasMedia, emptyMedia } from './webhook/types.js';

interface PendingMessage {
  from: string;
  text: string;
  messageId: string;
  media: IncomingMedia;
  incomingReplyTo?: ReplyTo;
  receivedAt: number;   // epoch ms this message was enqueued — used for reply-gap detection
}

// Reaction shape used by the channel sendReaction call. `re` (optional) is the 1-based [msg N] index
// of a burst message to tapback instead of the latest — resolved to an id via resolveReactionTarget.
type Reaction = { type: 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question'; re?: number } | { type: 'custom'; emoji: string; re?: number };

// Result returned by an agent's chat(). New orchestration fields (delegatedTask,
// optional so the legacy Deepseek agent still satisfies it.
interface AgentChatResult {
  text: string | null;
  reaction: Reaction | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
  generatedImage: { url: string; prompt: string } | null;
  groupChatIcon: { prompt: string } | null;
  removeMember: string | null;
  delegatedTask?: OpsTask | null;
}

export interface AgentClient {
  chat: (chatId: string, userMessage: string, media: IncomingMedia, chatContext?: unknown) => Promise<AgentChatResult>;
  getGroupChatAction: (message: string, sender: string, chatId: string) => Promise<{ action: 'respond' | 'react' | 'ignore'; reaction?: Reaction }>;
  generateImage: (prompt: string) => Promise<string | null>;
}

// ── Channel-routed outbound wrappers ─────────────────────────────────────────
// Every outbound call resolves its transport from the chatId prefix (channels/registry.ts), so the
// SAME send path below speaks over the web/CLI debug channel (SSE) or the engine bridge with no
// change. Optional ops (reactions, group ops, contact card) are guarded by the channel's caps, so
// a channel that can't do one simply skips it instead of throwing.
const sendMessage = (chatId: string, text: string, replyTo?: ReplyTo, media?: MediaAttachment[]) =>
  resolveChannel(chatId).sendMessage(chatId, text, replyTo, media);
const startTyping = (chatId: string) => resolveChannel(chatId).startTyping(chatId);
const stopTyping = (chatId: string) => resolveChannel(chatId).stopTyping(chatId);
const markAsRead = (chatId: string) => resolveChannel(chatId).markAsRead(chatId);
const getChat = (chatId: string) => resolveChannel(chatId).getChat(chatId);
const sendReaction = (chatId: string, messageId: string, reaction: Reaction, operation?: 'add' | 'remove') => {
  const ch = resolveChannel(chatId);
  return ch.caps.reactions ? ch.sendReaction(chatId, messageId, reaction, operation) : Promise.resolve();
};
const shareContactCard = (chatId: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.contactCard && ch.shareContactCard ? ch.shareContactCard(chatId) : Promise.resolve();
};
const renameGroupChat = (chatId: string, displayName: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.renameGroupChat ? ch.renameGroupChat(chatId, displayName) : Promise.resolve();
};
const setGroupChatIcon = (chatId: string, iconUrl: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.setGroupChatIcon ? ch.setGroupChatIcon(chatId, iconUrl) : Promise.resolve();
};
const removeParticipant = (chatId: string, handle: string) => {
  const ch = resolveChannel(chatId);
  return ch.caps.groupOps && ch.removeParticipant ? ch.removeParticipant(chatId, handle) : Promise.resolve();
};

interface PendingChat {
  chatId: string;
  messages: PendingMessage[];
  timer: NodeJS.Timeout | null;
  lastActivityAt: number;         // time of the last message — the rolling-settle anchor
  isProcessing: boolean;
  // The batch currently being processed (spliced out of `messages`, its turn not yet recorded to
  // history). Held here ONLY so the pending-inbound glance below can see it — an out-of-band voicer
  // must know these texts exist even though neither the queue nor history contains them yet.
  inFlightBatch: PendingMessage[] | null;
  agentClient: AgentClient;
}

const pendingChats = new Map<string, PendingChat>();

// Let out-of-band voicers (the Composer's late Ops reply) glance at texts that have ARRIVED but not
// yet entered history — the settle queue plus the batch mid-processing. Without this, a follow-up
// composed while the user is mid-burst reads as if their newest texts don't exist ("jumping the
// convo"). Read-only; raw texts only.
registerPendingInboundProvider(chatId => {
  const p = pendingChats.get(chatId);
  if (!p) return [];
  return [...(p.inFlightBatch ?? []), ...p.messages].map(m => m.text?.trim() ?? '').filter(Boolean);
});
// When Irises last sent a bubble to each chat, and how many she's sent since a given instant, both live
// in state/outboundLog.ts now (noteSend / lastSendAt / countSendsSince). A reply is "gapped" — and so
// needs a native quote to stay connected to the message it answers — when Irises has sent bubbles since
// that message arrived (they now sit between them in the UI); the same log tells the prompt, per
// message, how many sends landed after it was typed so a stale queued message isn't re-answered blind.
// SINGLE source of truth for "is the user typing", with the time it was last set so a stale
// 'started' (no matching 'stopped' — common on some transports) self-expires. Lives outside PendingChat
// so it also survives between batches (waitForUserQuiet reads it during sends).
const typingState = new Map<string, { isTyping: boolean; at: number }>();

// Reply pacing / latency. All env-overridable. Before every bubble we hold a LIVE typing
// indicator for a simulated-typing beat (based on character count), refreshed so it never
// lapses into dead air. "Fast but human": the FIRST bubble gets only a short beat (the user
// already waited through batching + the LLM call with dots showing); later bubbles pace at a
// fast-texter speed with a floor, a cap, and slight jitter. Pure math in state/pacing.ts.
// Pacing is channel-agnostic — the web SSE channel gets the same beats, so a debug session
// reads at the same cadence as a phone thread.
// Burst batching: a ROLLING window (message-driven; the user typing indicator is unreliable so we
// don't use it). We wait for quiet after the LAST message, and every new message RESETS that window
// — so a whole burst is compiled and answered once. The window GROWS with the burst: the base is
// BATCH_SETTLE_MS and each additional message adds BATCH_SETTLE_INCREMENT_MS (someone firing off a
// lot is clearly mid-thought), capped at BATCH_MAX_SETTLE_MS. E.g. 5s, 6s, 7s, … up to 20s.
const BATCH_SETTLE_MS = Number(process.env.BATCH_SETTLE_MS || 5000);                    // base quiet window (1st message)
const BATCH_SETTLE_INCREMENT_MS = Number(process.env.BATCH_SETTLE_INCREMENT_MS || 1000); // added per extra message in the burst
const BATCH_MAX_SETTLE_MS = Number(process.env.BATCH_MAX_SETTLE_MS || 20000);            // ceiling on the (grown) window
const PAUSE_WHILE_TYPING = process.env.PAUSE_WHILE_TYPING === 'true';          // pause our send while the user is mid-typing (default OFF)

// The rolling window for the current burst, grown by how many messages are already queued.
function burstSettleMs(pending: PendingChat): number {
  return effectiveSettleMs(pending.messages.length, BATCH_SETTLE_MS, BATCH_SETTLE_INCREMENT_MS, BATCH_MAX_SETTLE_MS);
}
const USER_QUIET_WAIT_MS = Number(process.env.USER_QUIET_WAIT_MS || 600);      // quiet required after the user stops typing before we send (only when PAUSE_WHILE_TYPING)
const TYPING_CPM = Number(process.env.TYPING_CPM || 800);                      // chars/min; ≈160 WPM "fast texter" (190 ≈ avg two-thumb speed proved way too slow: every bubble hit the cap)
const TYPING_DELAY_MAX_MS = Number(process.env.TYPING_DELAY_MAX_MS || 3000);   // hard cap: after this, stop simulating and just send the bubble
const TYPING_DELAY_MIN_MS = Number(process.env.TYPING_DELAY_MIN_MS || 600);    // floor: even a 5-char bubble still reads as typed, not machine-gunned
const TYPING_FIRST_BUBBLE_MAX_MS = Number(process.env.TYPING_FIRST_BUBBLE_MAX_MS || 800); // bubble 1 only: dots were already up all through the LLM call
const TYPING_JITTER_PCT = Number(process.env.TYPING_JITTER_PCT || 15);         // ±% humanizing wobble on the hold; 0 disables
const TYPING_REFRESH_MS = Number(process.env.TYPING_REFRESH_MS || 2000);       // re-ping the typing indicator this often so it stays visible (no dead air)
const PACING: PacingConfig = { cpm: TYPING_CPM, minMs: TYPING_DELAY_MIN_MS, maxMs: TYPING_DELAY_MAX_MS, firstBubbleMaxMs: TYPING_FIRST_BUBBLE_MAX_MS, jitterPct: TYPING_JITTER_PCT };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setTyping(chatId: string, isTyping: boolean) {
  typingState.set(chatId, { isTyping, at: Date.now() });
}

// Thin wrapper over the pure batchTiming helper (typing only counts as fresh for one settle
// window after the last event, so a stale 'started' with no 'stopped' self-expires).
function isTypingFresh(chatId: string): boolean {
  return isTypingFreshAt(typingState.get(chatId), Date.now(), BATCH_SETTLE_MS);
}

async function waitForUserQuiet(chatId: string) {
  if (!PAUSE_WHILE_TYPING) return;              // disabled by default: never hold our send for the user's typing
  if (!isTypingFresh(chatId)) return;

  console.log(`[main] Pausing agent send because user is currently typing...`);
  await stopTyping(chatId);
  // Wait out the typing, then require an extra quiet window; loop if they start again. Bounded by
  // typing-staleness (isTypingFresh self-expires), so this can never spin forever.
  do {
    while (isTypingFresh(chatId)) await sleep(250);
    await sleep(USER_QUIET_WAIT_MS);
  } while (isTypingFresh(chatId));
}

async function processPendingChat(chatId: string) {
  const pending = pendingChats.get(chatId);
  if (!pending || pending.isProcessing) return;
  if (pending.messages.length === 0) { pendingChats.delete(chatId); return; }

  pending.isProcessing = true;
  try {
    const messagesToProcess = pending.messages.splice(0);
    if (messagesToProcess.length === 0) return;
    // Visible to the pending-inbound glance until this batch's turn has fully recorded (cleared in
    // finally): from here to addMessage these texts exist nowhere else a voicer could see them.
    pending.inFlightBatch = messagesToProcess;

    // A turn has exactly ONE identity (`from` picks whose memory loads, whose data the engine reads,
    // whose profile the reply addresses), so a multi-sender group batch becomes one turn per
    // CONSECUTIVE same-sender run, answered in arrival order. 1:1 chats and single-sender
    // bursts are one run — identical to the old single-turn path.
    const runs = splitBurstBySender(messagesToProcess);
    if (runs.length > 1) console.log(`[main] Batch spans ${runs.length} sender runs — answering each in turn`);

    for (const run of runs) {
      // Combine the run into ONE agent turn. mergeBurst keeps the per-message ids + numbered
      // manifest (older code discarded everything but the last id) so each outgoing bubble can
      // thread back to the specific incoming message it answers.
      const merged = mergeBurst(run);
      console.log(`[main] Processing ${run.length} queued message${run.length === 1 ? '' : 's'} as one prompt`);
      try {
        await processMessage(
          pending.agentClient,
          chatId,
          merged.from,
          merged.combinedText,
          merged.lastMessageId,
          merged.media,
          merged.incomingReplyTo,
          merged.incomingMessageIds,
          merged.manifest,
          merged.earliestReceivedAt,
          // Late-arrival fold: once the turn owns the chat mouth, it drains anything that queued
          // while it waited and answers the full, latest burst. SAME-SENDER only: a late text from
          // another sender stays queued and becomes its own next batch instead of riding along
          // under this run's identity. Drained lates join `messagesToProcess` (= inFlightBatch) so
          // the pending-inbound glance keeps seeing them until this turn records them.
          {
            batch: run,
            drain: () => {
              const late: PendingMessage[] = [];
              for (let i = 0; i < pending.messages.length; ) {
                if (pending.messages[i].from === merged.from) late.push(...pending.messages.splice(i, 1));
                else i++;
              }
              if (late.length) messagesToProcess.push(...late);
              return late;
            },
          },
        );
      } catch (error) {
        console.error(`[main] Error processing run for ${merged.from} in chat ${chatId}:`, error);
        // A turn that dies here answered nobody — the user is left on read. Durable, not just logged.
        reportError({ source: 'convo', category: 'turn_failure', err: error, chatId, handle: merged.from });
      } finally {
        // This run's texts (including drained lates — same object identities) are recorded now:
        // stop advertising them to the pending-inbound glance while later runs process.
        for (const m of run) {
          const i = messagesToProcess.indexOf(m);
          if (i !== -1) messagesToProcess.splice(i, 1);
        }
      }
    }
  } catch (error) {
    console.error(`[main] Error processing debounced chat ${chatId}:`, error);
    reportError({ source: 'convo', category: 'turn_failure', err: error, chatId, detail: { scope: 'debouncedBatch' } });
  } finally {
    pending.isProcessing = false;
    pending.inFlightBatch = null;
    // Messages that arrived while we were processing become the next batch.
    if (pending.messages.length > 0) scheduleTick(chatId, BATCH_SETTLE_MS);
    else pendingChats.delete(chatId);
  }
}

// ONE self-rescheduling timer per chat. Purely message-driven — it does not consult the (flaky)
// user typing indicator, so a reply is flushed reliably `BATCH_SETTLE_MS` after the last message.
function scheduleTick(chatId: string, delayMs: number) {
  const pending = pendingChats.get(chatId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => onTick(chatId), Math.max(50, delayMs));
}

function onTick(chatId: string) {
  const pending = pendingChats.get(chatId);
  if (!pending) return;                                  // chat deleted → stop (no timer leak)
  pending.timer = null;
  if (pending.isProcessing) { scheduleTick(chatId, BATCH_SETTLE_MS); return; }
  if (pending.messages.length === 0) { pendingChats.delete(chatId); return; }

  const now = Date.now();
  const settle = burstSettleMs(pending);   // grows with how many messages are queued this burst
  if (shouldFlush(pending, now, settle)) { void processPendingChat(chatId); return; }

  // Not ready: re-arm for the time remaining in the (rolling, grown) settle window.
  const remSettle = settle - (now - pending.lastActivityAt);
  scheduleTick(chatId, Math.max(remSettle, 50));
}

interface SendBubbleOpts {
  replyToFirst?: ReplyTo;         // thread-reply attaches only to the first bubble (fallback when no targets)
  targets?: (ReplyTo | undefined)[]; // per-bubble native-reply targets, aligned by bubble index (overrides replyToFirst)
  record?: boolean;               // append the joined text to history (default true)
  paced?: boolean;                // simulate typing between bubbles (default true). false = send now (critical alerts)
}

// Simulated typing time for a bubble — pure math in state/pacing.ts (floor/cap/jitter, plus the
// tighter first-bubble cap: the user already waited through batching + the LLM call with dots up).
function typingDelayMs(text: string, isFirstBubble: boolean): number {
  return pacedTypingDelayMs(text, PACING, isFirstBubble);
}

// Hold the typing indicator visible for `totalMs`, re-pinging it every TYPING_REFRESH_MS so it
// never auto-expires into dead air. Pings are fire-and-forget (the channel's startTyping swallows
// its own errors) so their HTTP round trips no longer stack on top of the sleep budget. `finalPing`
// re-asserts the dots right before we return so they're fresh at the exact send moment — the
// caller passes false before the LAST bubble, where a ping racing past the final send would
// re-show dots after the reply completed.
async function holdTyping(chatId: string, totalMs: number, finalPing: boolean): Promise<void> {
  await holdLoop(totalMs, TYPING_REFRESH_MS, finalPing, {
    sleep,
    ping: () => { void startTyping(chatId); },
    now: Date.now,
  });
}

// Keep the typing indicator alive for the duration of an async task (chiefly the LLM
// generation call). A single startTyping ping auto-expires after a few seconds on the
// platform, so a reply that takes longer than that leaves a dead-air gap ("dots vanish,
// then the message pops in later"). This re-pings every TYPING_REFRESH_MS while `work`
// runs and is GUARANTEED to stop on resolve OR reject, so no interval ever leaks.
async function withTypingKeptAlive<T>(chatId: string, work: Promise<T>): Promise<T> {
  void startTyping(chatId);
  const timer = setInterval(() => { void startTyping(chatId); }, TYPING_REFRESH_MS);
  (timer as { unref?: () => void }).unref?.();  // don't keep the process alive just for this
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Send pre-split bubbles with a live typing indicator. Before every bubble we hold the
 * typing indicator for a simulated-typing beat (character count at a fast-texter speed,
 * floored/capped/jittered — and only a SHORT beat before the first bubble, since the user
 * already waited through the LLM call), refreshing it so it never lapses into dead air, then
 * send. That makes each bubble read as typed out. waitForUserQuiet keeps us from talking over
 * the user.
 * Single send path for the live reply and out-of-band follow-ups (Ops, engine push) —
 * and for EVERY channel, so web and the bridge pace exactly the same.
 */
async function sendBubbles(chatId: string, rawBubbles: string[], opts: SendBubbleOpts = {}): Promise<void> {
  if (rawBubbles.length === 0) return;
  // Hard guardrail: this is the single send path for EVERY user-facing bubble (live reply,
  // Ops follow-up, engine push). Per bubble we (1) strip any `[[re:N]]` reply-routing tag
  // — a backstop so a model slip from ANY agent can never leak it, even when targets aren't supplied
  // — (2) scrub internal tool names, and (3) strip raw Ops summary scaffolding (ANSWER:/SOURCE:/
  // FLAGS:/Subject:/Sender: labels), so nothing — a model slip, or the composer-failure path that
  // falls back to Ops' raw summary — can ever reach the user as a labeled machine block. A bubble
  // that is empty after stripping (e.g. it was only a tag or a bare SOURCE:/FLAGS: line) is dropped
  // so we never send blank text over the channel. Inter-agent text (meta-prompts to Ops) never passes through
  // here. `targets` (aligned to rawBubbles by index) gives each surviving bubble its own native
  // reply target; without it we fall back to replyToFirst.
  const prepared: { text: string; replyTo?: ReplyTo }[] = [];
  for (let i = 0; i < rawBubbles.length; i++) {
    let stripped = stripReplyTag(rawBubbles[i]);
    if (stripped !== rawBubbles[i]) console.warn('[guardrail] stripped a reply-routing tag from a user-facing bubble');
    // History turns now carry `[9:14 AM]`-style timestamp markers (chatTime.ts); a model slip that
    // echoes one at the head of a bubble is scrubbed here, same rationale as the [[re:N]] backstop.
    const unstamped = stripTimestampMarker(stripped);
    if (unstamped !== stripped) {
      console.warn('[guardrail] stripped an echoed timestamp marker from a user-facing bubble');
      stripped = unstamped;
    }
    const text = stripOpsScaffolding(redactInternalTools(stripped));
    if (!text) continue;
    const replyTo = opts.targets?.[i] ?? (i === 0 ? opts.replyToFirst : undefined);
    prepared.push({ text, replyTo });
  }
  if (prepared.length === 0) return;

  const paced = opts.paced !== false;
  for (let i = 0; i < prepared.length; i++) {
    const { text, replyTo } = prepared[i];
    const isLast = i === prepared.length - 1;
    if (paced) {
      await waitForUserQuiet(chatId);
      // Hold a LIVE typing indicator for a simulated-typing beat before every bubble (the
      // first gets only a short beat — the user already waited through the LLM call), then
      // send. No freshness ping before the last bubble: it could race past the send and
      // re-show dots after the reply is done.
      await holdTyping(chatId, typingDelayMs(text, i === 0), !isLast);
      await waitForUserQuiet(chatId);
    }
    const sent = await sendMessage(chatId, text, replyTo);
    // Remember this bubble by its channel message id so a later inbound reply_to can be resolved
    // back to what Irises said. `replyTo?.message_id` is the anchor this bubble was threaded to (an
    // inbound id) — the join key when a later tapped reply collapses to that thread root.
    // Fire-and-forget; never blocks the send.
    if (sent?.message?.id) void recordSentBubble(chatId, sent.message.id, text, replyTo?.message_id);
    // Sending a message clears the recipient's typing dots. If MORE bubbles are coming, re-assert
    // them immediately so there's no dark gap — the user sees "bubble → dots again" = more coming.
    // After the last bubble we intentionally don't, so the dots clear (= done). Fire-and-forget:
    // startTyping swallows its own errors, and the next bubble's hold re-pings anyway.
    if (paced && !isLast) void startTyping(chatId);
  }
  // Log this send (ONE entry per delivery ≈ one assistant history row): so a later message answered
  // after these bubbles is treated as "gapped" and gets a quote, and so a queued message that predates
  // this send is flagged stale to the next turn's prompt (outboundLog.countSendsSince).
  noteSend(chatId);
  if (opts.record !== false) await addMessage(chatId, 'assistant', prepared.map(p => p.text).join(' '));
}

/**
 * Send an out-of-band message (Ops follow-up, progress ping, proactive alert, post-OAuth reply)
 * through the per-chat mouth (state/mouth.ts). `content` may be pre-voiced text, or a VOICER THUNK
 * that runs only once it owns the chat lock — at which point every earlier outbound has been fully
 * sent and recorded, so whatever the thunk reads (conversation history) is exactly the thread its
 * reply will land on. That is the temporal-consistency guarantee: no follow-up is ever voiced
 * against a thread that moves before it sends. `dropIf` / `staleIfSpokenSince` let pre-voiced
 * content (pings) be dropped at the last instant instead of landing stale. A `priority: 'critical'`
 * alert (suspected fraud) still BYPASSES the queue and the typing pacing — the one deliberate
 * exception, where interleaving a live reply beats delaying an emergency.
 */
const speak = createMouth({
  sendBubbles,
  splitIntoBubbles,
  lastSpokenAt: chatId => lastSendAt(chatId),
  voiceTimeoutMs: Number(process.env.FOLLOWUP_VOICE_TIMEOUT_MS || 120_000),
  // The user sees "Irises is typing…" while a follow-up composes under the lock, not dead air.
  keepTypingAlive: withTypingKeptAlive,
});
async function sendFollowUp(chatId: string, content: SpeakContent, opts: SpeakOpts = {}): Promise<SpeakResult> {
  // replyTo quotes only the FIRST bubble (the Composer's late reply anchors to the original
  // question on its first line, then flows naturally — a person doesn't re-quote every bubble).
  return speak(chatId, content, opts);
}


// The core processing logic extracted from the webhook handler. `lateArrivals`, when given, lets
// the turn fold in messages that arrive while it WAITS for the chat mouth (see the drain block
// inside the critical section below); `batch` must be the same array the pending-inbound glance
// reads (pending.inFlightBatch), so drained texts stay visible to out-of-band voicers.
async function processMessage(agentClient: AgentClient, chatId: string, from: string, text: string, messageId: string, media: IncomingMedia, incomingReplyTo?: ReplyTo, incomingMessageIds: string[] = [], manifest: { text: string; handle: string; receivedAt: number }[] = [], earliestReceivedAt = 0, lateArrivals?: { batch: PendingMessage[]; drain: () => PendingMessage[] }) {

  const start = Date.now();
  console.log(`[main] Processing message from ${from}`);

  // Open a new diagnostics turn: everything recorded from here (classify, convo, delegation,
  // the async Ops→Composer tail via taskId) groups under this user message in /dashboard.
  beginTurn(chatId, from, text, incomingReplyTo?.message_id);

  // Track message count for this chat
  const count = (chatMessageCount.get(chatId) || 0) + 1;
  chatMessageCount.set(chatId, count);

  // Share Irises's own card on the very first message (name/photo instead of a bare number);
  // the every-N-messages re-share is opt-in via CONTACT_CARD_PROMO (default off — it reads
  // as self-promo spam mid-conversation).
  const shouldShareContact = count === 1 || (CONTACT_CARD_PROMO && count % CONTACT_CARD_INTERVAL === 0);

  // Mark as read, start typing, get chat info, and fetch user profile in parallel
  const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
  if (shouldShareContact) {
    console.log(`[main] Sharing contact card (message #${count})`);
    parallelTasks.push(shareContactCard(chatId));
  }
  const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
  console.log(`[timing] markAsRead+startTyping+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
  if (senderProfile?.name) {
    console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
  }

  // Group-chat detection: trust the channel's own flag when present; the participant-count
  // heuristic is the fallback only (it misfires when one person appears twice under
  // two handles).
  const isGroupChat = typeof chatInfo.is_group === 'boolean' ? chatInfo.is_group : chatInfo.handles.length > 2;
  const participantNames = chatInfo.handles.map(h => h.handle);

  // In group chats, check if agent should respond, react, or ignore
  // Always respond to any media (image/audio/video/doc) - someone sending media is clearly communicating
  if (isGroupChat && !hasMedia(media)) {
    await waitForUserQuiet(chatId);
    const { action, reaction: quickReaction } = await agentClient.getGroupChatAction(text, from, chatId);

    if (action === 'ignore') {
      console.log(`[main] Ignoring group chat message`);
      return;
    }

    if (action === 'react') {
      // Just send a reaction, no full response needed
      if (quickReaction) {
        await sendReaction(chatId, messageId, quickReaction);
        console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

        // Save to conversation history so agent knows what happened (include sender for group chats)
        await addMessage(chatId, 'user', text, from);
        const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
        await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

        console.log(`[main] Reacted to ${from} with ${reactionDisplay}`);
      }
      return;
    }

    console.log(`[main] Agent should respond to this group message`);
  } else if (isGroupChat) {
    console.log(`[main] Responding to group media (skipping classifier)`);
  }

  // If the user tapped reply on an earlier message, resolve WHAT they meant, thread-aware: one of
  // Irises's own bubbles, the user's own thread root (the transport collapses a tapped reply to the
  // root — for a reply on an Ops answer that's the originating question), or an honest unresolved.
  // `let`: re-resolved if a late-drained message brings a different tapped-reply target.
  let repliedTo: ResolvedReply | undefined = incomingReplyTo ? await resolveTappedReply(incomingReplyTo.message_id, chatId) : undefined;

  // Get agent's response (typing indicator shows while this runs)
  await waitForUserQuiet(chatId);

  // The turn's WHOLE life — think (the LLM call, which reads history) → speak (every bubble) →
  // remember (the history record) — is ONE per-chat critical section. Holding the mouth across the
  // LLM call, not just the sends, is what makes the agents one entity in time (INV-2, extended):
  //   • no follow-up (an Ops answer or engine push) can land between this turn's history read and its reply,
  //     so the reply is never voiced blind to a message that would precede it on screen;
  //   • a queued follow-up voices only AFTER this reply is sent and recorded, so it speaks with
  //     full awareness of it. Order of voicing === order on screen === order in history.
  // withTypingKeptAlive wraps the WHOLE critical section (queue wait included): the dots stay live
  // while this turn waits for a follow-up mid-delivery and through its own LLM call, so a queued
  // turn never reads as dead air. sendBubbles manages its own dots per bubble; overlap is harmless.
  let turnOut: AgentChatResult | null = null;
  let opsCancel: AbortController | null = null;
  await withTypingKeptAlive(chatId, withChatLock(chatId, async () => {
  // Fold in texts that arrived while this turn WAITED for the mouth (a follow-up mid-delivery, a
  // long prior send). The turn hasn't started thinking yet, so a message that would otherwise sit
  // a whole settle-cycle behind joins THIS reply instead — the way a person reads every new text
  // on their screen before starting to type. Never runs one message behind under bursty chatting.
  // Group-chat classification ran on the original batch only (a drained late rides along — we had
  // already decided to respond); `from` deliberately stays the original sender (their profile was
  // fetched above), the manifest still labels each message's own handle.
  if (lateArrivals) {
    const late = lateArrivals.drain();
    if (late.length) {
      console.log(`[main] folding ${late.length} late-arriving message(s) into this turn`);
      lateArrivals.batch.push(...late); // same array the pending-inbound glance reads — stays exact
      const remerged = mergeBurst(lateArrivals.batch);
      if ((remerged.incomingReplyTo?.message_id ?? null) !== (incomingReplyTo?.message_id ?? null)) {
        incomingReplyTo = remerged.incomingReplyTo;
        repliedTo = incomingReplyTo ? await resolveTappedReply(incomingReplyTo.message_id, chatId) : undefined;
      }
      text = remerged.combinedText;
      messageId = remerged.lastMessageId;
      media = remerged.media;
      incomingMessageIds = remerged.incomingMessageIds;
      manifest = remerged.manifest;
      earliestReceivedAt = remerged.earliestReceivedAt;
    }
  }
  // Per-message staleness, computed AFTER the drain so a folded-in late message is measured against the
  // sends that actually preceded it: how many of Irises's bubbles landed after each text-bearing message
  // arrived. arrivals[i].sendsAfterArrival > 0 ⇒ [msg i+1] was typed before bubbles it never saw, so the
  // prompt tells the model to check whether those already answered it before re-answering (outboundLog).
  const arrivals = manifest.map(m => ({
    receivedAt: m.receivedAt,
    sendsAfterArrival: m.receivedAt > 0 ? countSendsSince(chatId, m.receivedAt) : 0,
  }));
  const staleArrivals = arrivals.filter(a => a.sendsAfterArrival > 0).length;
  if (staleArrivals) console.log(`[main] ${staleArrivals}/${arrivals.length} queued message(s) predate later sends`);
  const out = await agentClient.chat(chatId, text, media, {
    isGroupChat,
    participantNames,
    chatName: chatInfo.display_name,
    senderHandle: from,
    senderProfile,
    incomingMessageId: messageId,
    repliedTo,
    // Deprecated alias kept for the soak — 'assistant' only; every reader prefers `repliedTo`.
    repliedToText: repliedTo?.kind === 'assistant' ? repliedTo.text : undefined,
    // On a burst (2+ text-bearing messages), hand the model the numbered manifest so it can tag
    // each bubble [[re:N]] with the message it answers. Omitted for a single message (no tagging).
    burstManifest: manifest.length > 1 ? manifest : undefined,
    // Per-message arrival truth (aligned to burstManifest / [msg N]), so the prompt can flag a queued
    // message Irises has already sent past as answering an older state of the thread.
    arrivals,
  });
  turnOut = out;
  const { text: responseText, reaction, renameChat, rememberedUser, generatedImage, groupChatIcon, removeMember, delegatedTask } = out;
  console.log(`[timing] agent: ${Date.now() - start}ms`);
  console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, renameChat: ${renameChat || 'null'}, generatedImage: ${generatedImage ? 'yes' : 'null'}, removeMember: ${removeMember || 'null'}`);
  // Send reaction if agent wants to. On a burst the model may target a specific [msg N] via `re` (e.g.
  // tapback the one message a later send already answered); resolveReactionTarget maps it to that id,
  // falling back to the latest message when there's no valid target.
  if (reaction) {
    await sendReaction(chatId, resolveReactionTarget(reaction.re, incomingMessageIds, messageId), reaction);
    console.log(`[timing] reaction: ${Date.now() - start}ms`);
  }

  // Rename group chat if agent wants to
  if (renameChat && isGroupChat) {
    await renameGroupChat(chatId, renameChat);
    console.log(`[timing] renameChat: ${Date.now() - start}ms`);
  }

  // Remove member from group chat if agent wants to
  if (removeMember && isGroupChat) {
    try {
      await removeParticipant(chatId, removeMember);
      console.log(`[timing] removeMember: ${Date.now() - start}ms`);
    } catch (error) {
      console.error(`[main] Failed to remove member ${removeMember}:`, error);
    }
  }

  // Send text response if there is one
  let finalText = responseText;

  // If agent renamed chat but didn't send text, Fallfirm voices the confirmation (group chats only)
  if (!finalText && renameChat && isGroupChat) {
    console.log(`[main] Agent renamed chat without text, voicing acknowledgment`);
    finalText = await voiceOutcome({ kind: 'confirmed', summary: 'you renamed the group chat', facts: `the new name is "${renameChat}"` }, chatId, from);
  }

  // If agent used remember_user without text, just log it - no automatic acknowledgments
  if (!finalText && rememberedUser) {
    console.log(`[main] Agent saved user info without text response (no auto-ack)`);
  }

  // Per-bubble native reply threading. In a burst the model tags each bubble [[re:N]]; resolve those
  // to the specific incoming message ids so each answer quotes the text it belongs to. On a single
  // message we anchor the FIRST bubble to it (then flow) only when it needs it: they tapped reply, OR
  // the reply is "gapped" — Irises already sent bubbles after this message arrived (e.g. a burst reply
  // to earlier messages), so those now sit between it and this reply and a bare reply would look detached.
  const isBurst = incomingMessageIds.length > 1;
  // "Gapped" ⟺ Irises sent at least one bubble after the earliest message arrived. Equivalent to the old
  // lastSend > earliestReceivedAt (sends are monotonic, so any-after ⟺ latest-after); the log hasn't
  // moved since the pre-LLM read (Convo's own sends happen below, in sendBubbles).
  const gapped = earliestReceivedAt > 0 && countSendsSince(chatId, earliestReceivedAt) > 0;
  const anchorFirstTo = (incomingReplyTo || gapped) ? { message_id: messageId } : undefined;

  if (finalText || generatedImage || groupChatIcon) {
    // Split into bubbles, strip the routing tags, and compute each bubble's native-reply target.
    const { bubbles, targets } = finalText
      ? resolveOutboundBubbles(splitIntoBubbles(finalText), incomingMessageIds, { isBurst, anchorFirstTo })
      : { bubbles: [] as string[], targets: [] as (ReplyTo | undefined)[] };

    // If we're delegating, thread the LATE Ops follow-up to the message that actually asked, not the
    // last burst message (which may be a "thanks"). Prefer the message a holding bubble quoted; else,
    // in a burst, default to the FIRST message (the substantive ask usually leads).
    if (delegatedTask) {
      const quoted = targets.find(t => t?.message_id)?.message_id;
      if (quoted) delegatedTask.replyToMessageId = quoted;
      else if (isBurst && incomingMessageIds.length) delegatedTask.replyToMessageId = incomingMessageIds[0];
    }

    // Send text messages first (before generating image). The Convo client already
    // recorded the assistant turn, so don't double-record here (record: false).
    if (bubbles.length > 0) {
      await sendBubbles(chatId, bubbles, {
        targets,
        record: false,
      });
      console.log(`[timing] sendMessage (${bubbles.length} text msg${bubbles.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
    }

    // Now generate and send image if requested
    if (generatedImage) {
      await startTyping(chatId);
      console.log(`[main] Generating image after sending text...`);
      const imageUrl = await agentClient.generateImage(generatedImage.prompt);
      if (imageUrl) {
        await new Promise(resolve => setTimeout(resolve, 300));
        // Record a placeholder so a reply tapped on the image bubble resolves to something meaningful
        // (this path bypasses sendBubbles, hence the explicit recordSentBubble).
        const sentImg = await sendMessage(chatId, '', undefined, [{ url: imageUrl }]);
        if (sentImg?.message?.id) void recordSentBubble(chatId, sentImg.message.id, `[you sent a generated image: ${generatedImage.prompt.slice(0, 80)}]`);
        await addMessage(chatId, 'assistant', `[generated an image: ${generatedImage.prompt.substring(0, 50)}...]`);
        console.log(`[timing] generateImage + sendImage: ${Date.now() - start}ms`);
      } else {
        const line = await voiceOutcome({ kind: 'failed', summary: "generating that image didn't work", nextStep: 'ask them to try again' }, chatId, from);
        const sentFail = await sendMessage(chatId, line);
        if (sentFail?.message?.id) void recordSentBubble(chatId, sentFail.message.id, line);
        console.log(`[main] Image generation failed`);
      }
    }

    // Generate and set group chat icon if requested
    if (groupChatIcon && isGroupChat) {
      await startTyping(chatId);
      console.log(`[main] Generating group chat icon...`);
      const imageUrl = await agentClient.generateImage(groupChatIcon.prompt);
      if (imageUrl) {
        await setGroupChatIcon(chatId, imageUrl);
        await addMessage(chatId, 'assistant', `[set group chat icon]`);
        console.log(`[timing] generateIcon + setIcon: ${Date.now() - start}ms`);
      } else {
        const line = await voiceOutcome({ kind: 'failed', summary: "setting the group chat icon didn't work", nextStep: 'ask them to try again' }, chatId, from);
        const sentFail = await sendMessage(chatId, line);
        if (sentFail?.message?.id) void recordSentBubble(chatId, sentFail.message.id, line);
        console.log(`[main] Group icon generation failed`);
      }
    }

    const threaded = anchorFirstTo || targets.some(Boolean);
    const extras = [threaded && 'thread', generatedImage && 'image', groupChatIcon && 'icon', removeMember && 'removeMember'].filter(Boolean).join(', ');
    console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
  } else if (reaction) {
    console.log(`[main] Reaction-only response (saved to history for context)`);
  }

  // Mark delegated work in-flight AND kick it off, at the END of the critical section (after the
  // holding line has already been sent above — Ops therefore starts once the ack is out, never before
  // it). markOpsStart stays INSIDE the lock (INV-1, airtight): between the delegation decision and this
  // marker no other turn can even start its LLM call, so none can observe "delegated but unmarked" and
  // double-run the same ask. The AbortController is registered alongside so a user cancel
  // (cancel_research) reaches the running loop. The follow-up arrives via sendFollowUp, which
  // re-acquires the mouth and VOICES under it. A media_read task goes to MM (silent run), everything
  // else to Ops (progress-pinged).
  if (delegatedTask) {
    opsCancel = new AbortController();
    markOpsStart(chatId, delegatedTask.id, { kind: delegatedTask.kind, request: delegatedTask.request, estimate: estimateOpsEta({ kind: delegatedTask.kind, request: delegatedTask.request, forceGrounding: delegatedTask.forceGrounding }) }, opsCancel);
    console.log(`[main] Delegating ${delegatedTask.kind} task to the engine`);
    void runOpsAndFollowUp(delegatedTask, sendFollowUp, opsCancel.signal);
  }
  })); // end withChatLock — think + speak went out as one ordered, uninterleaved unit

  console.log(`[main] Reply sent to ${from}`);
}

/**
 * Enqueue one inbound message into the per-chat batching/mouth pipeline. This is the SINGLE inbound
 * entry every channel funnels through — the web/CLI channel and the engine bridge — so
 * burst-merge, the rolling settle window, the late-arrival fold, the mouth lock, and diagnostics
 * all apply uniformly regardless of transport.
 */
export function enqueueInbound(
  agentClient: AgentClient,
  chatId: string,
  from: string,
  text: string,
  messageId: string,
  media: IncomingMedia,
  incomingReplyTo?: ReplyTo,
): void {
  if (!pendingChats.has(chatId)) {
    pendingChats.set(chatId, {
      chatId, messages: [], timer: null, lastActivityAt: 0, isProcessing: false, inFlightBatch: null, agentClient,
    });
  }
  const pending = pendingChats.get(chatId)!;
  pending.messages.push({ from, text, messageId, media, incomingReplyTo, receivedAt: Date.now() });

  // Index this inbound message's id → text so a LATER tapped reply that the transport collapses to
  // the thread root (this user's own message) resolves to what they said. Sits HERE, in the single
  // inbound entry point, so web/bridge inherit it for free. Fire-and-forget; the burst settle
  // window guarantees the write lands well before any turn reads it. Media-only messages carry no
  // resolvable text, so they're skipped.
  if (text?.trim()) void recordInboundMessage(chatId, messageId, text, from);

  // Reset the rolling window from THIS message; its length grows with the burst size (5s, 6s, …).
  pending.lastActivityAt = Date.now();
  // They just sent — they're not mid-typing THIS message anymore (feeds only waitForUserQuiet).
  setTyping(chatId, false);
  scheduleTick(chatId, burstSettleMs(pending));
}

/** Feed a channel's typing-indicator event into the send-pause tracker (opt-in waitForUserQuiet).
 *  DORMANT: no surviving inbound door emits typing events (web/CLI and the bridge don't forward
 *  them), so this — and the PAUSE_WHILE_TYPING knob it feeds — is inert until a channel wires it. */
export function setTypingInbound(chatId: string, isTyping: boolean): void {
  setTyping(chatId, isTyping);
}

/** The enqueueInbound signature — channel routers receive it via dependency injection. */
export type EnqueueInbound = typeof enqueueInbound;

// The ENGINE owns email and every other account connection. Engine-initiated
// proactive messages (reminders, mail nudges, background findings) arrive here instead, voiced
// by Fallfirm in Irises's tone and delivered through the per-chat mouth like any follow-up.
app.use(createEnginePushRouter({ sendFollowUp }));

// In-app prompt diagnostics dashboard (guarded by DEBUG_TOKEN / localhost).
app.use(createDiagnosticsRouter());

// Admin orchestration dashboard — the password-gated GUI at /dashboard showing the
// agent-to-agent prompt flow graph per chat/user (password: DASHBOARD_PASSWORD).
app.use(createAdminDashboardRouter());

// ── Channels ─────────────────────────────────────────────────────────────────
// The web/CLI debug channel (chat with Irises in the browser or via `npm run chat` — no external
// messaging setup needed) is on unless WEB_ENABLED=false. The bridge fronts the engine's own channel
// connections. Outbound routes by chatId prefix (channels/registry).
if (process.env.WEB_ENABLED !== 'false') {
  registerChannel(webChannel);
  app.use(createWebRouter({ enqueueInbound, agentClient: convoClient as unknown as AgentClient }));
}
// Bridge mode: engine-fronted chats (eng:<platform>:<chat>) — the engine's irises-bridge plugin
// forwards fronted inbound turns to /api/bridge/inbound (having suppressed the engine's own reply)
// and Irises answers back out through the engine's channel connections (EngineBackend.channelSend).
// Registered whenever an engine is configured; inert until a plugin actually posts.
if (process.env.OPS_BACKEND) {
  registerChannel(bridgeChannel);
  app.use(createBridgeInboundRouter({ enqueueInbound, agentClient: convoClient as unknown as AgentClient }));
}

// Serve the web debug client's static build (web/out from `npm run build:web`) at `/`, LAST so it
// never shadows the API/webhook routes above. Same-origin as /api/web/* → no CORS for the SSE stream.
// Missing in dev (use `npm run dev:web` on its own port instead) — express.static just 404s then.
app.use(express.static(path.resolve(process.cwd(), 'web/out')));

// Start server
app.listen(PORT, () => {
  // Slim boot: no local schedulers or email watchers — the ENGINE owns reminders and mail.
  // Its cron jobs deliver back through POST /api/engine/push, voiced by the Composer.
  // The only local timers are storage retention sweeps (short-tier expiry, 7d message
  // windows, ledger age-out, LONG revision caps) + the error/history prunes that arm
  // inside their own modules.
  startRetentionTimers();

  console.log(`
  Irises — a general, casual, do-anything assistant
  Server running on http://localhost:${PORT}

  Endpoints:
    POST /api/web/message         - Web / CLI chat → Convo→Ops
    POST /api/bridge/inbound      - Engine bridge inbound (OpenClaw/Hermes)
    POST /api/engine/push         - Engine push door (scheduled/proactive delivery)
    GET  /debug                   - Prompt diagnostics
    GET  /dashboard               - Admin orchestration
    GET  /health                  - Health check

  Chat with Irises over the web debug client or the terminal (npm run chat).
  Bridge mode fronts your engine's own messaging (WhatsApp, Telegram, Signal, …).
  `);
});

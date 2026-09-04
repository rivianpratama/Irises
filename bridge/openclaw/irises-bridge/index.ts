/**
 * irises-bridge — front OpenClaw channels with Irises. Zero OpenClaw source changes.
 *
 * Install (OpenClaw's own official mechanisms):
 *     openclaw plugins install /path/to/irises/bridge/openclaw/irises-bridge
 *     openclaw plugins enable irises-bridge   # = config plugins.entries.irises-bridge.enabled: true
 * Environment (for the gateway process):
 *     IRISES_URL           where Irises runs                (default http://127.0.0.1:3000)
 *     IRISES_BRIDGE_TOKEN  shared secret = Irises's ENGINE_PUSH_TOKEN
 *     IRISES_FRONT         comma-separated glob patterns over "<channel>:<conversation>"
 *                          e.g. "whatsapp:*" or "telegram:123,discord:*"
 *                          EMPTY = front nothing (default — OpenClaw behaves normally).
 *     IRISES_BRIDGE_FAIL   open (default: on bridge error OpenClaw answers itself) | closed
 *
 * How it works (verified against OpenClaw source):
 *   - `before_dispatch` is a GLOBAL claiming hook (all plugins, all channels) consumed in
 *     dispatch-from-config.choose-route.ts BEFORE slash-command processing and the agent.
 *     Returning `{ handled: true }` with no text = the agent never runs and nothing is sent.
 *   - Irises answers asynchronously through the gateway `send` RPC (its own WS client), so this
 *     handler never waits on Irises's LLM latency — it forwards fire-and-forget and claims.
 *   - Slash-command bodies (`/…`) always fall through so the operator keeps `/status`, `/reset`,
 *     etc. (`/stop` and `/approve` fast-path before this hook anyway.)
 *
 * WHY THE TURN IS CLAIMED BEFORE IRISES HAS ACKNOWLEDGED IT
 *   `before_dispatch`'s RETURN VALUE is the suppression decision, and OpenClaw consumes it
 *   synchronously in choose-route.ts. There is no "claim later" — awaiting the forward here would
 *   couple every turn to Irises's round trip, and the hook's own 5s timeout would fire first
 *   anyway. So the handler starts the forward and claims in the same tick, and a forward that
 *   never lands is a message nobody answered. That is what the retries below are for; making the
 *   claim conditional on the ack would need a change inside the OpenClaw engine, which this repo
 *   does not own.
 *
 *   The retries are only safe because every payload carries a STABLE message_id (the platform's
 *   own, or a content digest), and Irises dedupes inbound on (platform, chat_id, message_id) — a
 *   retry after a lost 202 is answered "duplicate" instead of becoming a second turn in the chat.
 */
import { createHash } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

/** The inbound payload version this plugin speaks. Irises's door accepts any sender declaring the
 *  same MAJOR; the field list itself is written down in bridge/contract-fixtures/inbound-v1.json
 *  and checked against this file by src/channels/bridge/contract.test.ts. */
const SCHEMA_VERSION = 1;
/** One forward, then one retry — deliberately small: the hook has already claimed the turn, so a
 *  long retry tail just delays the moment the chat is known to be silent. Mirrors the hermes
 *  plugin's _FORWARD_ATTEMPTS / _backoff_s. */
const FORWARD_ATTEMPTS = 2;
const BACKOFF_MS = [500, 2_000];
const FORWARD_TIMEOUT_MS = 15_000;

interface BeforeDispatchEvent {
  messageId?: string;
  content?: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToText?: string;   // the quoted message's content, when the event carries it
  quotedText?: string;    // alternate field name some channels use
  isGroup?: boolean;
  timestamp?: number;
}

// Mirrors PluginHookBeforeDispatchContext (src/plugins/hook-types.ts) — note: no sender display
// name exists in this hook; Irises renders the sender from its own per-chat memory instead.
interface BeforeDispatchCtx {
  accountId?: string;
  conversationId?: string;
  channelId?: string;
  sessionKey?: string;
}

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function patterns(): string[] {
  return env("IRISES_FRONT").split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
}

/** Minimal glob (only `*` wildcards) — enough for "<channel>:<conversation>" patterns. */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(value);
}

function fronted(channel: string, conversation: string): boolean {
  const key = `${channel}:${conversation}`.toLowerCase();
  return patterns().some(p => globMatch(p, key));
}

/** Sleep before retrying a failed forward: 500ms after the first miss, 2s after the second. Clamped
 *  at both ends exactly like the hermes plugin's _backoff_s, so only the first step is reachable at
 *  two attempts and raising FORWARD_ATTEMPTS needs no second edit here. */
function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
}

/**
 * The id Irises dedupes retried forwards on — its key is (platform, chat_id, message_id).
 *
 * The channel's own id when it has one. When it has none, a fresh id per attempt would be no id
 * at all and a retry after a lost 202 would land as a SECOND turn, so the fallback is
 * content-addressed: the same message digests to the same id however many times it is sent.
 *
 * The trade: two identical messages ("ok", "thanks") from the same sender in the same chat with
 * the same timestamp collapse to one id, and Irises drops the second. The timestamp is what keeps
 * them apart, so this only bites on a channel that carries no timestamp at all.
 */
function stableMessageId(
  platformId: string | undefined,
  parts: { platform: string; chatId: string; senderId?: string; text: string; timestamp?: number },
): string {
  if (platformId != null && String(platformId).trim()) return String(platformId);
  const raw = [parts.platform, parts.chatId, parts.senderId, parts.text, parts.timestamp]
    .map(p => (p == null ? "" : String(p)))
    .join("|");
  return `eng-o-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/**
 * POST one inbound payload to Irises, retrying a TRANSPORT failure once. Never throws — the caller
 * has already claimed the turn and cannot act on the outcome; the log is the only report.
 */
async function forwardInbound(url: string, token: string, payload: unknown, label: string): Promise<void> {
  for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-token": token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      // fetch resolves for a 4xx/5xx, so without this a rejected forward looked exactly like a
      // delivered one — the message vanished and nothing was logged.
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const status = (err as { status?: number })?.status;
      // A 4xx is the door's ANSWER, not a transport failure: a retry gets the same one and only
      // burns the backoff. 401/403 = the shared secret doesn't match Irises's ENGINE_PUSH_TOKEN;
      // 404 = Irises is running without OPS_BACKEND, so /api/bridge/inbound was never mounted.
      const permanent = typeof status === "number" && status >= 400 && status < 500;
      if (!permanent && attempt < FORWARD_ATTEMPTS) {
        console.warn(`[irises-bridge] forward attempt ${attempt}/${FORWARD_ATTEMPTS} failed (${label}): ${msg}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs(attempt)));
        continue;
      }
      // LOUD: OpenClaw has already been told to stay silent for this turn, so the user got nothing.
      console.warn(
        `[irises-bridge] forward ${permanent ? `REJECTED with ${msg}` : `FAILED after ${FORWARD_ATTEMPTS} attempts`}`
        + ` (${label}) — the message is LOST and OpenClaw stayed silent for it`
        + (permanent ? " (check IRISES_BRIDGE_TOKEN, and that Irises runs with OPS_BACKEND set)" : `: ${msg}`),
      );
      return;
    }
  }
}

export default definePluginEntry({
  id: "irises-bridge",
  name: "Irises Bridge",
  register(api: { on: (hook: string, handler: unknown, opts?: Record<string, unknown>) => void }) {
    api.on(
      "before_dispatch",
      async (event: BeforeDispatchEvent, ctx: BeforeDispatchCtx) => {
        const failClosed = env("IRISES_BRIDGE_FAIL", "open").toLowerCase() === "closed";
        try {
          const body = (event.content ?? event.body ?? "").trim();
          // Operator slash commands always stay with OpenClaw.
          if (body.startsWith("/")) return undefined;
          const channel = (event.channel ?? ctx.channelId ?? "").toLowerCase();
          const conversation = String(ctx.conversationId ?? event.senderId ?? "");
          if (!channel || !conversation || !fronted(channel, conversation)) return undefined;

          // The channel's own id when it has one, else a content digest — see stableMessageId.
          const messageId = stableMessageId(event.messageId, {
            platform: channel, chatId: conversation, senderId: event.senderId,
            text: body, timestamp: event.timestamp,
          });
          const payload = {
            engine: "openclaw",
            platform: channel,
            chat_id: conversation,
            sender_id: event.senderId,
            text: body,
            message_id: messageId,
            schema_version: SCHEMA_VERSION,
            reply_to_id: event.replyToId,
            // The quoted message's text (so Irises can show what was replied to even without a resolvable
            // id) and the platform send time (used as receivedAt) — both when the event carries them.
            reply_to_text: event.replyToText ?? event.quotedText,
            timestamp: event.timestamp,
            is_group: event.isGroup === true,
          };
          // Fire-and-forget: never couple OpenClaw's dispatch lane to Irises's latency. The claim
          // below returns in this same tick — see the file header for why it cannot wait.
          void forwardInbound(
            `${env("IRISES_URL", "http://127.0.0.1:3000").replace(/\/$/, "")}/api/bridge/inbound`,
            env("IRISES_BRIDGE_TOKEN"),
            payload,
            `${channel}:${conversation}`,
          );

          return { handled: true }; // silence — Irises replies via the gateway `send` RPC
        } catch (err) {
          console.warn("[irises-bridge] hook error:", (err as Error)?.message ?? err);
          return failClosed ? { handled: true } : undefined; // fail-open: OpenClaw answers itself
        }
      },
      // No default timeout exists for before_dispatch — a hung handler would stall the turn.
      { priority: 100, timeoutMs: 5_000 },
    );

    // Also claim the engine's OWN reply path for fronted chats, so an engine-authored system notice —
    // notably "⚡ Interrupting current task. I'll respond to your message shortly." when a new message
    // lands mid-turn — never reaches a chat Irises is fronting. before_dispatch suppresses the normal
    // agent reply, but that busy/interrupt notice fires on a DIFFERENT path (docs/ENGINES.md documents
    // `before_agent_reply` as the hook that covers it). Registering an unknown hook must never throw at
    // load: guarded so an older OpenClaw without this hook simply logs once and keeps working (the
    // notice just isn't suppressed there — the hermes session-split is the primary fix for that anyway).
    try {
      api.on(
        "before_agent_reply",
        async (event: BeforeDispatchEvent, ctx: BeforeDispatchCtx) => {
          try {
            const channel = (event?.channel ?? ctx?.channelId ?? "").toLowerCase();
            const conversation = String(ctx?.conversationId ?? event?.senderId ?? "");
            if (channel && conversation && fronted(channel, conversation)) return { handled: true };
          } catch { /* fall through — never break the engine's own reply path */ }
          return undefined; // not fronted → the engine's reply/notice proceeds untouched
        },
        { priority: 100, timeoutMs: 5_000 },
      );
    } catch (err) {
      console.warn("[irises-bridge] before_agent_reply not available on this OpenClaw — interrupt-notice suppression skipped:", (err as Error)?.message ?? err);
    }
  },
});

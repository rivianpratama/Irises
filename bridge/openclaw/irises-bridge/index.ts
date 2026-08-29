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
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

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

          const payload = {
            engine: "openclaw",
            platform: channel,
            chat_id: conversation,
            sender_id: event.senderId,
            text: body,
            message_id: event.messageId,
            reply_to_id: event.replyToId,
            // The quoted message's text (so Irises can show what was replied to even without a resolvable
            // id) and the platform send time (used as receivedAt) — both when the event carries them.
            reply_to_text: event.replyToText ?? event.quotedText,
            timestamp: event.timestamp,
            is_group: event.isGroup === true,
          };
          // Fire-and-forget: never couple OpenClaw's dispatch lane to Irises's latency.
          void fetch(`${env("IRISES_URL", "http://127.0.0.1:3000").replace(/\/$/, "")}/api/bridge/inbound`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-bridge-token": env("IRISES_BRIDGE_TOKEN") },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
          }).catch(err => console.warn(`[irises-bridge] forward failed (${channel}:${conversation}):`, err?.message ?? err));

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

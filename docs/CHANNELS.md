# Channels

Irises is one server-side brain (the Convo → Ops/MM multi-agent pipeline) reachable over several
transports. Each transport is a **channel**. The brain never talks to a transport directly — it
only ever calls `resolveChannel(chatId)` and speaks through the `Channel` interface.

## How routing works

Outbound is keyed by `chatId`, and the channel is derived from the `chatId` **prefix**, statelessly
(so it survives process restarts — the proactive sweeper reads persisted rows carrying a bare
`chatId`):

| Prefix            | Channel   | Example `chatId`      |
|-------------------|-----------|-----------------------|
| `web:`            | web       | `web:debug`           |
| `tg:`             | telegram  | `tg:123456789`        |
| *(anything else)* | linq      | `+15551234567`        |

Inbound: every transport funnels into the single `enqueueInbound(...)` entry in `src/index.ts`, so
burst-batching, the rolling settle window, the per-chat "mouth" lock, simulated-typing pacing, and
diagnostics apply uniformly regardless of channel.

Code: `src/channels/` — `types.ts` (the `Channel` interface + capabilities), `registry.ts`
(`registerChannel` / `resolveChannel` / `parseChannelKind`), and one folder per transport.

## Web (debug chat)

Talk to Irises in the browser — no Linq/iMessage setup needed. The `web/` Next.js app is a **thin
client**: it POSTs your message and streams Irises's reply bubbles back over SSE. All the real work is
server-side, using the server's `.env` API keys (no browser keys).

- `POST /api/web/message` `{ text, clientId? }` → `202` (the reply is not here — it streams).
- `GET  /api/web/stream` → long-lived Server-Sent Events. The live reply **and** later async Ops
  follow-ups arrive on the same stream, in order. Reconnect replays missed events via `Last-Event-ID`
  from a ~200-event ring buffer — a tab offline long enough for the ring to overflow silently misses
  the older events (acceptable for a debug channel).
- `POST /api/web/cancel` `{ clientId? }` → the Stop button; cancels in-flight research.

**Auth** — same policy as `/debug`: with no `DEBUG_TOKEN` set, the endpoints only answer localhost;
when `DEBUG_TOKEN` is set (do this in prod — messages spend real LLM tokens), every call needs it.
Open the web client as `/?token=YOUR_DEBUG_TOKEN` and it forwards the token on every request.

On by default (`WEB_ENABLED` != `false`). Single-user identity defaults to `web:debug` /
`WEB_DEBUG_HANDLE` (`web:guest`) — deliberately distinct from any real Linq handle so debug turns
don't pollute a real user's memory.

Serving: `npm run dev:web` runs the Next dev server on its own port for local development. In
production the server serves the static export (`web/out`, from `npm run build:web`) at `/`, so the
SSE stream is same-origin (no CORS). Behind Caddy, the reverse-proxy sets `flush_interval -1` so SSE
events flush immediately.

## iMessage (Linq Blue)

The original transport. Inbound arrives at `POST /webhook` (the Linq Blue webhook); outbound uses the
Linq partner API (`src/linq/client.ts`). Set `LINQ_API_TOKEN` and `LINQ_AGENT_BOT_NUMBERS`, expose
the server (e.g. `ngrok http 3000`), and point the Linq Blue webhook at `https://<host>/webhook`.

## Telegram (prepared skeleton)

Wired but **off by default**. The adapter (`src/channels/telegram/`) implements the `Channel`
interface (Bot API `sendMessage` / `sendChatAction` / `getChat` / `setMessageReaction`) and parses
inbound `Update`s at `POST /webhook/telegram` into the same `enqueueInbound` pipeline.

To enable:

1. Create a bot with [@BotFather](https://t.me/BotFather) and get its token.
2. Set env: `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN=<token>`, and optionally
   `TELEGRAM_WEBHOOK_SECRET=<random>` (validated against the `X-Telegram-Bot-Api-Secret-Token` header).
3. Register the webhook with Telegram (one-time), pointing at your public URL:
   ```
   curl "https://api.telegram.org/bot<token>/setWebhook" \
     -d url="https://<your-host>/webhook/telegram" \
     -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
   ```

**Left as TODOs in the skeleton** (not run live): inbound media download (`file_id` → `getFile` →
URL), group-admin ops, and the `setWebhook` registration call above.

## Adding a channel

1. Implement `Channel` (see `src/channels/types.ts`) — advertise `caps` honestly; unsupported
   optional ops are skipped by the send path, not errored.
2. Choose a `chatId` prefix and register it in `parseChannelKind` (`src/channels/registry.ts`).
3. Add an inbound route that parses your transport's payload and calls `enqueueInbound(...)`.
4. `registerChannel(yourChannel)` at boot (gate it behind an env flag if it needs credentials).

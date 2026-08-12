# Channels

Irises is one server-side brain (the Convo → Ops/MM multi-agent pipeline) reachable over several
transports. Each transport is a **channel**. The brain never talks to a transport directly — it
only ever calls `resolveChannel(chatId)` and speaks through the `Channel` interface.

## How routing works

Outbound is keyed by `chatId`, and the channel is derived from the `chatId` **prefix**, statelessly
(so it survives process restarts — the proactive sweeper reads persisted rows carrying the
`chatId`):

| Prefix            | Channel   | Example `chatId`         |
|-------------------|-----------|--------------------------|
| `web:`            | web / CLI | `web:debug`              |
| `eng:`            | bridge    | `eng:telegram:123456789` |

Any `chatId` without a recognized prefix is **unroutable** — `resolveChannel` throws a clear error
(`expected web: or eng:`) rather than guessing a default. Irises is a front-end for the
OpenClaw/Hermes engines, so every live chatId carries one of these prefixes; legacy bare / `tg:` ids
from the removed channels no longer resolve.

Inbound: every transport funnels into the single `enqueueInbound(...)` entry in `src/index.ts`, so
burst-batching, the rolling settle window, the per-chat "mouth" lock, simulated-typing pacing, and
diagnostics apply uniformly regardless of channel.

Code: `src/channels/` — `types.ts` (the `Channel` interface + capabilities), `registry.ts`
(`registerChannel` / `resolveChannel` / `parseChannelKind`), and one folder per transport.

## Web (debug chat + CLI)

Talk to Irises in the browser — no accounts or engine setup needed. The `web/` Next.js app is a **thin
client**: it POSTs your message and streams Irises's reply bubbles back over SSE. All the real work is
server-side, using the server's `.env` API keys (no browser keys). The terminal REPL (`npm run chat`,
`scripts/irises-chat.ts`) is the same channel from a shell — it talks to the same
`/api/web/message` · `/api/web/stream` · `/api/web/cancel` endpoints.

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
`WEB_DEBUG_HANDLE` (`web:guest`) — deliberately distinct from any real chat identity so debug turns
don't pollute a real user's memory.

Serving: `npm run dev:web` runs the Next dev server on its own port for local development. In
production the server serves the static export (`web/out`, from `npm run build:web`) at `/`, so the
SSE stream is same-origin (no CORS). Behind Caddy, the reverse-proxy sets `flush_interval -1` so SSE
events flush immediately.

## Bridge (engine-owned channels)

When Irises sits in front of an engine (`OPS_BACKEND` set), it can answer on **every channel the
engine already speaks** — Telegram, WhatsApp, Signal, Discord, LINE, … — without the engine giving
up the connection. A small plugin in the engine forwards each fronted inbound turn to
`POST /api/bridge/inbound`; Irises voices a reply and sends it **back out through the engine**, so it
lands on the same channel. Fronted chats carry `eng:<platform>:<chat>` chatIds and are chosen by the
engine-side `IRISES_FRONT` glob list (e.g. `IRISES_FRONT=telegram:*`). Full setup, hooks, and failure
policy live in **[docs/ENGINES.md](ENGINES.md)**.

## Adding a channel

1. Implement `Channel` (see `src/channels/types.ts`) — advertise `caps` honestly; unsupported
   optional ops are skipped by the send path, not errored.
2. Choose a `chatId` prefix and register it in `parseChannelKind` (`src/channels/registry.ts`).
3. Add an inbound route that parses your transport's payload and calls `enqueueInbound(...)`.
4. `registerChannel(yourChannel)` at boot (gate it behind an env flag if it needs credentials).

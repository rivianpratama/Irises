# Irises + your engine

Irises is the **persona**: a fast, warm texting front line (Convo), a re-voicer that makes deep
results land in one voice (Composer), an honest failure voice (Fallfirm), and the glue between
them. Everything **deep** — research, email, reading files, reminders, long-term memory — runs on
an **engine you already have**: [hermes-agent](https://github.com/NousResearch/hermes-agent) or
[OpenClaw](https://github.com/openclaw/openclaw). The engine is never modified; Irises speaks only
its public API, and either side can update independently.

```
                              THE IRISES REPO
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   USER ──text──▶ Channels ──▶ Convo (instant reply)          Irises's voice │
│    ▲             (web chat /                   │                            │
│    │              Telegram)                    │ deep work?                 │
│    │                                           ▼                            │
│    └──reply──── Composer ◀───────────── runTask() seam                      │
│                 (re-voices,                    │                            │
│                  hides the seam)               │  OPS_BACKEND = ?           │
│                                        ┌───────┴───────┐                    │
│                                        ▼               ▼                    │
│                                  hermesBackend   openclawBackend            │
│                                        │               │                    │
└────────────────────────────────────────┼───────────────┼────────────────────┘
                                         │               │
                              HTTP :8642 │               │ WS :18789
                              (OpenAI-   │               │ (gateway `agent`
                               compat)   ▼               ▼  RPC, protocol v4)
                                 ┌──────────────┐ ┌──────────────┐
                                 │ HERMES-AGENT │ │   OPENCLAW   │
                                 │ (unmodified) │ │ (unmodified) │
                                 └──────────────┘ └──────────────┘
```

There is deliberately **no built-in research engine**: if no engine is configured, Irises still
chats — and says honestly that its deep half is offline when you ask for more.

## Quick start (engine users)

**Hermes users** — in your hermes chat, or by hand:

```bash
hermes skills install https://raw.githubusercontent.com/rivianpratama/irises/main/skills/irises-setup-hermes/SKILL.md
# then, in any hermes chat:   /irises-setup-hermes
```

**OpenClaw users:**

```bash
openclaw skills install git:rivianpratama/irises
# then ask your OpenClaw to run the irises-setup-openclaw skill
```

**Anyone, manually:**

```bash
git clone https://github.com/rivianpratama/irises && cd irises
bash scripts/engine-setup.sh --engine hermes     # or: --engine openclaw
```

The script is idempotent, prints every change before making it, and never edits engine code. For
hermes it appends two lines to `~/.hermes/.env` (`API_SERVER_ENABLED`, `API_SERVER_KEY`) — the
documented way to enable its API server; for OpenClaw it only *reads* the existing gateway token.

## Same Telegram bot, new brain (the handoff)

If you already text your engine's Telegram bot, Irises can take the bot over — same bot, same chat
thread, the brain behind it becomes Irises (which uses your engine for everything deep):

```
        BEFORE                                   AFTER the handoff
 ───────────────────────                 ──────────────────────────────────
  Telegram app                            Telegram app
        │  same chat ────────────────────────▶ │   (nothing changes here)
        ▼                                      ▼
   @YourBot (token T)                     @YourBot (token T)
        │                                      │  token moved by the script;
        ▼                                      ▼  engine's channel disabled
 ┌──────────────────┐                   ┌───────────────────┐
 │  ENGINE gateway  │                   │      IRISES       │
 │  owns the bot,   │                   │ owns the bot,     │
 │  replies itself  │                   │ Convo/Composer    │
 └──────────────────┘                   │ voice; engine does│
                                        │ the deep work     │
                                        └───────────────────┘
```

- The setup script offers this interactively (`--revert` hands the bot back).
- Telegram only allows ONE consumer per bot token, which is why the engine's channel must be
  disabled — and why the handoff works cleanly once it is.
- **`TELEGRAM_ALLOWED_CHAT_IDS` is required.** After the handoff your engine's pairing/allowlist
  no longer guards the bot; Irises refuses to start the channel without its own allowlist.
  (DM `@userinfobot` to find your chat id.) v1 is DMs-only; groups stay with the engine.
- Every other engine channel (WhatsApp, Discord, Slack…) stays with the engine, untouched.

## Where to talk to what

```
 TERMINAL
 ├── hermes                    → your engine, directly (unchanged)
 │   openclaw dashboard / tui  → your engine, directly (unchanged)
 └── npm run chat              → Irises (same brain the Telegram bot uses)

 BROWSER   http://localhost:3000        → Irises web chat (DEBUG_TOKEN-gated)
 TELEGRAM  @YourBot (after handoff)     → Irises
```

## Proactive messages (reminders, watched email)

Scheduling lives ON THE ENGINE (its cron), not in Irises. When you ask Irises for a reminder,
it creates an engine cron job whose prompt ends with "deliver the result to Irises"; when the job
fires, the engine does any work needed and POSTs to Irises, which voices it to your chat:

```
 engine cron fires ──▶ engine agent run ──▶ POST /api/engine/push ──▶ Composer/Fallfirm
                        (tools, email,       (x-engine-token)          voice it → your chat
                         research)
```

- `ENGINE_PUSH_TOKEN` guards that endpoint — it can make Irises speak, treat it as a credential.
- Engine-side email watching (the old "flag important mail" feature) is configured on the engine
  (hermes: its email skills + a cron job that ends with the same POST) — see the prompt templates
  the script prints, or write your own; the body contract is
  `{"chatId": "...", "kind": "reminder"|"email"|"memo", "text": "..."}`.
- **v1 gap:** reminders require the hermes engine; the OpenClaw cron wiring is pending (its
  `cron.add` RPC payload needs live verification). Everything else works on OpenClaw.

## Environment reference

| Key | Mode | Meaning |
|---|---|---|
| `OPS_BACKEND` | both | `hermes` \| `openclaw` — unset = deep work offline (Convo still chats) |
| `HERMES_BASE_URL` | hermes | default `http://127.0.0.1:8642` |
| `HERMES_API_KEY` | hermes | the `API_SERVER_KEY` from `~/.hermes/.env` |
| `OPENCLAW_URL` | openclaw | default `ws://127.0.0.1:18789` |
| `OPENCLAW_TOKEN` | openclaw | `gateway.auth.token` from the OpenClaw config |
| `OPENCLAW_AGENT_ID` | openclaw | default `main` |
| `ENGINE_PUSH_TOKEN` | both | guards `POST /api/engine/push` (generated by setup) |
| `ENGINE_TIMEOUT_MS` | both | per-engine-call budget (default: `OPS_TASK_TIMEOUT_MS` − 15s) |
| `ENGINE_MAX_CONCURRENT` | both | engine-call semaphore (default 2) |
| `TELEGRAM_ENABLED` / `TELEGRAM_BOT_TOKEN` | — | the bot identity (often handed off from the engine) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | **required** comma-separated allowlist |
| `TELEGRAM_MODE` | — | `polling` (default, no public URL) \| `webhook` |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | — | Irises's own voice models (setup reuses the engine's when present) |

## Security notes (read before exposing anything)

- **The engine credential is operator-grade.** `API_SERVER_KEY` / the gateway token grant the
  engine's FULL toolset — on default engine configs that includes a real shell on the host. Keep
  both engines loopback-only (the defaults) and never expose :8642 / :18789 publicly.
- **Prompt injection reaches a capable agent.** Whatever users text Irises is distilled into
  engine prompts. If people other than you can text your bot, consider your engine's sandboxing
  options and keep the Telegram allowlist tight.
- **Telegram media URLs embed the bot token.** Irises passes them to the engine for the current
  turn only and never logs or persists them.
- **Engine memory scope:** hermes scopes per-chat memory via session keys. OpenClaw's curated
  memory files are per-agent — all Irises chats share one engine-side user model there.
- The engine can only make Irises SPEAK via the push endpoint with the right token; it can never
  read Irises state or act as a user.

## Troubleshooting

- *"ran into a problem completing that" on every deep question* — the engine is unreachable.
  Hermes: is `hermes gateway` running, and was it restarted after `API_SERVER_ENABLED=true`?
  Check `curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/capabilities`.
  OpenClaw: is the gateway up (`openclaw gateway status`)? Is `@openclaw/gateway-client` installed?
- *Telegram silent after handoff* — the engine's channel must be disabled (one poller per token),
  and `TELEGRAM_ALLOWED_CHAT_IDS` must include your chat id (check the boot log).
- *Reminders never fire* — hermes engine only (v1); check `GET /api/jobs` on the hermes API for
  the job, and that `ENGINE_PUSH_TOKEN` in the job's environment matches Irises's `.env`.
- *Deep answers time out* — engines can take minutes on hard tasks. Raise `OPS_TASK_TIMEOUT_MS`
  (and `ENGINE_TIMEOUT_MS` follows it) if your engine's typical runs exceed 4 minutes.

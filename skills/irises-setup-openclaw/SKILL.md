---
name: irises-setup-openclaw
description: "Set up Irises — a texting persona (web chat, Telegram) that uses this OpenClaw as its deep-work engine."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌸",
        "requires": { "bins": ["git", "node", "npm"] },
      },
  }
---

# Irises Setup (OpenClaw engine)

Irises is a user-facing texting assistant — a fast conversational front line with a warm persona —
that delegates ALL deep work (research, files, memory) to the OpenClaw gateway it is pointed at.
OpenClaw stays completely unmodified; Irises talks to it only over the Gateway WebSocket `agent`
RPC using the existing gateway token.

## What setup does

The repository ships an idempotent script that performs every step and prints each change before
making it. Walk the user through these stages, running the script for the mechanical parts:

1. Confirm prerequisites: Node 22+, git, and a running OpenClaw gateway (`openclaw gateway status`).
2. Clone `https://github.com/rivianpratama/irises` into a folder the user picks (default `~/irises`).
3. From the clone, run: `bash scripts/engine-setup.sh --engine openclaw`
   The script (read it first if the user wants — it is short and commented):
   - reads the existing gateway URL + token via `openclaw config get` (no OpenClaw config changes),
   - installs the `@openclaw/gateway-client` package into the Irises clone,
   - writes the Irises `.env`: `OPS_BACKEND=openclaw`, `OPENCLAW_URL`, `OPENCLAW_TOKEN`, a generated
     `ENGINE_PUSH_TOKEN`, and `DATA_BACKEND=memory` (no database needed),
   - asks for an `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` for Irises's own small voice models
     (reusing one from the OpenClaw config/environment when present),
   - offers OPTIONAL bridge mode (front chosen OpenClaw channels — WhatsApp, Discord, any of them —
     with Irises, via a plugin installed with `openclaw plugins install`; opt-in per chat via
     `IRISES_FRONT` patterns, off by default — see `docs/ENGINES.md` § Bridge mode),
   - offers the OPTIONAL Telegram bot-token handoff (moves the bot from OpenClaw's
     `channels.telegram` to Irises so the user keeps texting the same bot; reversible with
     `--revert`) — the plugin-free alternative for Telegram only; skip it if bridge mode already
     fronts the bot,
   - installs dependencies, builds, starts Irises, and runs a health + engine round-trip check.
4. Tell the user where to talk to Irises: the web chat URL the script prints, `npm run chat` in the
   clone for a terminal session, or their same Telegram bot if they did the handoff.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- Known v1 gap: reminders scheduled through Irises require the hermes engine for now (OpenClaw
  cron wiring is pending) — everything else works on OpenClaw.
- The user keeps using OpenClaw directly exactly as before; Irises is an additional,
  differently-voiced front door that uses it as an engine.
- To undo the Telegram handoff: `bash scripts/engine-setup.sh --engine openclaw --revert`.

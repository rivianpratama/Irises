---
name: irises-setup-openclaw
description: "Set up Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this OpenClaw as its deep-work engine."
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

Irises rides **on top of** this OpenClaw: on boot it auto-detects it (sets `OPS_BACKEND=openclaw`),
reuses the gateway token, and makes its own voice **inherit OpenClaw's model** — so there is nothing
to configure by hand. The setup below just installs the gateway client and generates the push token;
everything else is derived at boot.

## What setup does

The repository ships an idempotent script that performs every step and prints each change before
making it. Walk the user through these stages, running the script for the mechanical parts:

1. Confirm prerequisites: Node 22.13+ (Irises's local store uses the builtin `node:sqlite`), git, and a running OpenClaw gateway (`openclaw gateway status`).
2. Clone `https://github.com/rivianpratama/irises` into a folder the user picks (default `~/irises`).
3. From the clone, run: `bash scripts/engine-setup.sh --engine openclaw`
   The script (read it first if the user wants — it is short and commented):
   - reads the existing gateway URL + token via `openclaw config get` (no OpenClaw config changes),
   - installs the `@openclaw/gateway-client` package into the Irises clone,
   - writes the Irises `.env`: `OPS_BACKEND=openclaw`, `OPENCLAW_URL`, `OPENCLAW_TOKEN`, and a
     generated `ENGINE_PUSH_TOKEN` (no database needed — Irises persists to `~/.irises` on its own),
   - asks for an `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` for Irises's own small voice models
     (reusing one from the OpenClaw config/environment when present),
   - offers OPTIONAL bridge mode (front chosen OpenClaw channels — WhatsApp, Discord, any of them —
     with Irises, via a plugin installed with `openclaw plugins install`; opt-in per chat via
     `IRISES_FRONT` patterns, off by default — see `docs/ENGINES.md` § Bridge mode),
   - installs dependencies, builds, starts Irises, and runs a health check (`curl /health`).
4. Tell the user where to talk to Irises: the web chat URL the script prints, `npm run chat` in the
   clone for a terminal session, or — if they enabled bridge mode — the engine's own channels they
   chose to front.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- On its first boot, Irises sends this OpenClaw a one-time **engine-mode onboarding** over the
  gateway: how to recognize a delegated request, the reply contract, the full-reach invitation and
  its hard limits. The agent saves it to its own instructions by its own hand (nothing in OpenClaw
  is edited). To remove it later, tell the agent by chat to delete that section; to skip the send
  entirely, set `ENGINE_ONBOARDING=off` in the Irises `.env`.
- Known v1 gap: reminders scheduled through Irises require the hermes engine for now (OpenClaw
  cron wiring is pending), so the reminder tools aren't offered on OpenClaw at all and Irises never
  promises a reminder that can't fire. Everything else runs full-reach here: real code, this
  agent's own skills, parallel subagents, artifacts.
- The user keeps using OpenClaw directly exactly as before; Irises is an additional,
  differently-voiced front door that uses it as an engine.
- To undo bridge mode: `bash scripts/engine-setup.sh --engine openclaw --revert`.
- To update later: `bash scripts/update.sh` from the clone (pull + rebuild, then restart). Irises
  also checks for new versions itself and mentions them in chat.

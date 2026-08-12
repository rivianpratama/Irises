---
name: irises-setup-hermes
description: "Set up Irises — a texting persona (web chat, Telegram) that uses this hermes as its deep-work engine."
version: 1.0.0
author: Irises
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Irises, assistant, persona, frontend, setup]
prerequisites:
  commands: [git, node, npm]
---

# Irises Setup (hermes engine)

Irises is a user-facing texting assistant — a fast conversational front line with a warm persona —
that delegates ALL deep work (research, email, files, reminders, memory) to a hermes-agent it is
pointed at. This hermes stays completely unmodified; Irises talks to it only through the
OpenAI-compatible API server (`API_SERVER_ENABLED`) and the cron REST API.

## What setup does

The repository ships an idempotent script that performs every step and prints each change before
making it. Walk the user through these stages, running the script for the mechanical parts:

1. Confirm prerequisites: Node 22+, git, and this hermes installation.
2. Clone `https://github.com/rivianpratama/irises` into a folder the user picks (default `~/irises`).
3. From the clone, run: `bash scripts/engine-setup.sh --engine hermes`
   The script (read it first if the user wants — it is short and commented):
   - enables the hermes API server if it is not already on (the documented `API_SERVER_ENABLED`
     switch plus a generated key, appended to hermes's own environment config — the script prints
     the exact change first — then asks you to restart `hermes gateway`),
   - writes the Irises `.env`: `OPS_BACKEND=hermes`, the API key, a generated `ENGINE_PUSH_TOKEN`,
     and `DATA_BACKEND=memory` (no database needed),
   - offers to reuse the Anthropic/OpenRouter key hermes already uses for Irises's own small voice
     models (never overwrites values the user set themselves),
   - offers OPTIONAL bridge mode (front chosen hermes channels — WhatsApp, Discord, any of them —
     with Irises, via a plugin installed through hermes's own plugin system; opt-in per chat via
     `IRISES_FRONT` patterns, off by default — see `docs/ENGINES.md` § Bridge mode),
   - offers the OPTIONAL Telegram bot-token handoff (moves the bot from hermes to Irises so the
     user keeps texting the same bot; reversible with `--revert`) — the plugin-free alternative
     for Telegram only; skip it if bridge mode already fronts the bot,
   - installs dependencies, builds, starts Irises, and runs a health + engine round-trip check.
4. Tell the user where to talk to Irises: the web chat URL the script prints, `npm run chat` in the
   clone for a terminal session, or their same Telegram bot if they did the handoff.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- The user keeps talking to hermes directly exactly as before (`hermes` in a terminal); Irises is
  an additional, differently-voiced front door that uses hermes as its engine.
- To undo the Telegram handoff: `bash scripts/engine-setup.sh --engine hermes --revert`.

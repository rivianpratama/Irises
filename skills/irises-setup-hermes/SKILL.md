---
name: irises-setup-hermes
description: "Set up Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this hermes as its deep-work engine."
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

Irises rides **on top of** this hermes: on boot it auto-detects it (sets `OPS_BACKEND=hermes`),
reuses this hermes's API key, and makes its own voice **inherit this hermes's model** — so there is
nothing to configure by hand. The setup below just enables the API surface and generates the push
token; everything else is derived at boot.

## What setup does

The repository ships an idempotent script that performs every step and prints each change before
making it. Walk the user through these stages, running the script for the mechanical parts:

1. Confirm prerequisites: Node 22.13+ (Irises's local store uses the builtin `node:sqlite`), git, and this hermes installation.
2. Clone `https://github.com/rivianpratama/irises` into a folder the user picks (default `~/irises`).
3. From the clone, run: `bash ./scripts/engine-setup.sh --engine hermes --yes`
   `--yes` means non-interactive: assume every default and never prompt (a run whose stdin is not a
   terminal behaves that way on its own). Bridge mode is **ON by default** now — Irises fronts this
   hermes's channels (iMessage, etc.) so it answers there in its own voice — and `IRISES_FRONT`
   defaults to `*:*` (every chat, every platform). Opt out entirely with `--no-bridge`; narrow the
   scope later by editing the `IRISES_FRONT` line in hermes's env.
   The script (read it first if the user wants — it is short and commented):
   - enables the hermes API server if it is not already on (the documented `API_SERVER_ENABLED`
     switch plus a generated key, appended to hermes's own environment config — the script prints
     the exact change first — then asks you to restart `hermes gateway`),
   - writes the Irises `.env`: `OPS_BACKEND=hermes`, the API key, a generated `ENGINE_PUSH_TOKEN`,
     and `PORT=3000` — the committed `deploy/app.env` baseline says `8080`, which is the Docker
     image's port behind Caddy, so a local install pins 3000 and the server, the printed web URL
     and `npm run chat` all agree (no database needed — Irises persists to `~/.irises` on its own),
   - offers to reuse the Anthropic/OpenRouter key hermes already uses for Irises's own small voice
     models (never overwrites values the user set themselves),
   - sets up bridge mode **by default** (front this hermes's channels — iMessage, WhatsApp, Discord,
     any of them — with Irises, via a plugin installed AND enabled through hermes's own plugin
     system; writes `IRISES_FRONT=*:*` so Irises fronts everything out of the box, narrow it per chat
     with fnmatch patterns over `<platform>:<chat_id>`; turn it off with `--no-bridge` — see
     `docs/ENGINES.md` § Bridge mode),
   - installs dependencies and builds both halves: the server and the web client,
   - starts Irises **detached**, so it outlives the shell (and the session) that ran the script,
     then health-checks it with retries — and, when the hermes gateway is up, runs a real engine
     round-trip against the API server (`GET /v1/capabilities` with the key). If the gateway is not
     running it prints the exact command to bring it up (`hermes gateway restart`, or
     `hermes gateway install` when it was never installed as a service) and notes that Irises
     reconnects by itself once it is up — nothing to re-run,
   - **leaves Irises running** and prints the web chat URL (`http://127.0.0.1:3000`), `npm run chat`,
     and how to stop it. Run it again on a box where a healthy Irises already serves that port and
     it reports "already running" and skips the start.
4. Tell the user where to talk to Irises. With bridge mode on (the default), **Irises answers this
   hermes's own channels** (iMessage, etc.) — the user just messages hermes as usual and Irises
   replies in its own voice — BUT only after the gateway is restarted (see the gateway-guard note
   below): until then hermes still answers. And set one expectation: shortly after that restart,
   **Irises usually texts first** — a one-time introduction, sent only on a chat this hermes has
   genuinely exchanged messages in before (the "first move", see Notes) — so a text from her out of
   the blue is the feature working, not a glitch. Also available anytime: the web chat URL the
   script prints, and `npm run chat` in the clone for a terminal session.

## Running this as the agent

- **Don't block on questions.** Take the defaults: clone into `~/irises`, **bridge mode ON** (the
  default — Irises fronts hermes's channels so it answers iMessage etc. in its own voice), and run
  `bash ./scripts/engine-setup.sh --engine hermes --yes`. Mention in the final summary that bridge
  can be turned off with `--no-bridge` and the front scope narrowed via `IRISES_FRONT`, rather than
  asking first.
- **Work only in the fresh clone.** If some other Irises checkout already exists elsewhere on this
  machine, leave it alone completely — never build, edit, or start it.
- **Node version.** If `node -v` in your shell is below 22.13, look for a newer Node already
  installed (nvm under `~/.nvm/versions/node/`, or Homebrew) and prefix `PATH` for these commands
  only. If there is none, hand the user the install command instead of attempting a system install.
- **Don't fight the gateway guard — and the restart is what turns the bridge ON.** The API server
  AND the bridge plugin (with `IRISES_FRONT`) are only read when the gateway (re)starts, and the
  hermes CLI correctly refuses to let you restart your own supervisor. That guard is right — do not
  route around it with `launchctl`, `kickstart`, or any direct process control, and do not restart
  the gateway from inside your own turn (you would kill your own reply mid-send). Finish everything
  else, then give the user the single command to run themselves — `hermes gateway restart` (or
  `hermes gateway install` if the gateway was never installed as a service) — and tell them plainly:
  **until they run it, hermes still answers its channels; once it restarts, Irises fronts them —
  and her one-time introduction text usually follows within minutes (see Notes).**
  Verify after they run it.
- **The script leaves Irises running.** Don't start extra copies, and don't launch one as a child of
  your own session — report the URL the script printed.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- On its first boot, Irises sends this hermes a one-time **engine-mode onboarding** over the API
  server: how to recognize a delegated request, the reply contract, the full-reach invitation and
  its hard limits (including never messaging the user on any channel itself). Hermes appends it to
  its own SOUL.md by its own hand — nothing in hermes is edited by Irises. To remove it later, tell
  hermes by chat to delete that section; to skip the send entirely, set `ENGINE_ONBOARDING=off` in
  the Irises `.env`. Manual fallback: `bridge/hermes/engine-onboarding-message.md`.
- Once after that, Irises makes the **first move**: she asks this hermes what it already knows about
  its user — a normal chat message hermes answers in its own words, nothing in hermes is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this hermes has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they
  text her. It happens exactly once per install; to skip it entirely, set `FIRST_MOVE_ENABLED=false`
  in the Irises `.env`.
- With bridge mode on (the default), Irises **fronts** this hermes's messaging channels: a user
  texting a fronted channel (iMessage, etc.) now reaches Irises, which answers in its own voice and
  uses hermes as its engine. Hermes itself is unchanged and still reachable directly in a terminal
  (`hermes`), and it transparently answers anything `IRISES_FRONT` does not cover — and any chat at
  all whenever Irises is down (fail-open, so a broken front never drops messages).
- To undo bridge mode: `bash ./scripts/engine-setup.sh --engine hermes --revert`.
- To update later: `bash ./scripts/update.sh` from the clone (pull + rebuild, then restart). Irises
  also checks for new versions itself and mentions them in chat.

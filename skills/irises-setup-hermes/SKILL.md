---
name: irises-setup-hermes
description: "Guide a person through installing Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this hermes as its deep-work engine. Explains it, checks prerequisites, hands over the exact terminal commands, and verifies afterwards. It does not install anything itself."
version: 2.0.0
author: Irises
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Irises, assistant, persona, frontend, setup]
prerequisites:
  commands: [git, node, npm]
---

# Irises Setup (hermes engine) — a guide, not an installer

**You do not install Irises. The person does, in their own terminal.** Your job is to explain what
Irises is, check that the box can run it, hand over the exact commands, set the right expectations,
and verify the result once they say they are done.

Why it works this way: the installer's last step restarts the hermes gateway, because the API server
and the bridge plugin are only read when the gateway comes up. From a gateway-hosted chat, hermes
blocks the script outright (its terminal tool reads the contents of any `.sh` you reference, and this
one cycles the supervisor). From a CLI session it would be worse — it would kill the supervisor
running your own turn, mid-reply. So the command belongs in a human's shell, not in yours.

## What Irises is (say this in your own words)

A user-facing texting assistant — a fast conversational front line — that delegates ALL deep work
(research, email, files, reminders, memory) to this hermes. This hermes stays completely unmodified;
Irises talks to it only through the OpenAI-compatible API server (`API_SERVER_ENABLED`) and the cron
REST API.

Irises rides **on top of** this hermes: on boot it auto-detects it (sets `OPS_BACKEND=hermes`),
reuses this hermes's API key, and makes its own voice **inherit this hermes's provider, endpoint and
model** — including when this hermes runs on an OpenAI-compatible or otherwise obscure API (OpenAI,
Azure, vLLM, deepseek-direct, Groq, a self-hosted gateway…), not just OpenRouter or Anthropic. The
voice keeps a cheap, fast model on that same API so replies stay snappy; deep work always uses this
hermes's own model. There is nothing to configure by hand.

## 1. Check the prerequisites (read-only — these you MAY run)

```bash
node --version          # needs 22.13+ (Irises's local store uses the builtin node:sqlite)
git --version
hermes gateway status
```

That is the entire list of commands you are allowed to run in this skill, plus the health check in
step 5. If `node --version` is below 22.13, look for a newer Node already on the box (nvm under
`~/.nvm/versions/node/`, or Homebrew) and tell the person which one to put on `PATH` — do not attempt
a system install, and do not install it for them.

On **Windows**, the person needs a bash to run the install in: **Git Bash**, which ships with the Git
for Windows they already need for the clone, or a **WSL2** shell. Say so up front, and say the honest
part too — the Windows paths are stub-tested only and have not yet been run on a real Windows box,
so Linux and macOS are the platforms with mileage on them.

## 2. Hand them the install (they run this, you do not)

Give them these two commands, exactly as written, and tell them to run them in a terminal on this
machine (Git Bash or WSL2 if that machine is Windows):

```bash
git clone https://github.com/rivianpratama/irises ~/irises && cd ~/irises
bash ./scripts/engine-setup.sh --engine hermes --yes
```

`--yes` means non-interactive: assume every default, never prompt. Drop it if they would rather be
asked. `~/irises` is just the usual spot — any folder they pick is fine, and the second command must
run from inside whichever folder they chose.

What the script does, so you can answer questions about it (it is short and commented — they can read
it first):

- checks node 22.13+, git, curl, and that the port is free,
- writes the Irises `.env` (mode 600): `OPS_BACKEND=hermes`, the API key, a generated
  `ENGINE_PUSH_TOKEN`, and `PORT=3000` (the committed `deploy/app.env` baseline says `8080`, which is
  the Docker image's port behind Caddy, so a local install pins 3000). No database — Irises persists
  to `~/.irises` on its own,
- reuses the Anthropic / OpenRouter / OpenAI key (and `OPENAI_BASE_URL`) this hermes already uses,
  for Irises's own small voice models, and never overwrites a value they set themselves,
- installs dependencies and builds; the web client is rebuilt only when it was built before,
- registers Irises as a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS, a
  Task Scheduler task named `Irises` on Windows, with a detached `nohup` fallback where none of those
  exists — so she survives a reboot without root,
- waits for her to answer `/health` on the new build, and only then touches hermes: enables the
  hermes API server if it is not already on (the documented `API_SERVER_ENABLED` switch plus a
  generated key, appended to hermes's own environment config after a backup, every change printed
  first and recorded in `~/.irises/install-manifest.json`),
- sets up **bridge mode by default** and writes `IRISES_FRONT=*:*`, so Irises fronts every chat on
  every platform out of the box (see the consequences below). `--no-bridge` skips the plugin and the
  fronting,
- **restarts the hermes gateway last**, so the API server and the bridge plugin are live, and prints a
  summary with an honest exit code.

## 3. Set these three expectations before they run it

- **The gateway will restart at the end.** Any hermes chat in flight ends there. This is normal and
  it is the step that turns the bridge on: until it happens, hermes still answers its own channels.
- **Hermes will announce its own return** — *"♻️ Gateway online — Hermes is back and ready."* — in
  their home channel, after that restart and after every future one. That is hermes's message, not
  Irises's. If they would rather not see it, hermes silences it per platform with
  `<platform>.gateway_restart_notification: false` in hermes's own config. Mention it as optional;
  never edit hermes's config for them.
- **`IRISES_FRONT=*:*` means Irises answers everything.** With bridge mode on, a person texting any
  channel this hermes owns (iMessage, WhatsApp, Discord, …) reaches Irises, who answers in her own
  voice and uses hermes as her engine. Hermes is unchanged, still reachable directly in a terminal
  (`hermes`), still transparently answers anything `IRISES_FRONT` does not cover — and answers
  everything whenever Irises is down (fail-open, so a broken front never drops messages). Narrow the
  scope by editing the `IRISES_FRONT` line in hermes's env to fnmatch patterns over
  `<platform>:<chat_id>`; blanking it makes the plugin inert instantly. Tell them their operator and
  control chats are inside `*:*` too.

Also worth saying once: **shortly after that restart, Irises usually texts first** — a one-time
introduction, sent only on a chat this hermes has genuinely exchanged messages in before (the "first
move", see Notes). A text from her out of the blue is the feature working, not a glitch.

## 4. Never do any of this

- **Never clone, install, build, or start anything.** Not in a temp folder, not "just to check".
- **Never run the setup script or the updater**, and never run any command that restarts or cycles
  the gateway or its supervisor — not through the hermes CLI's own gateway subcommands, not through
  `systemctl`, `launchctl`, `kickstart`, `schtasks`, or direct process control. That guard is
  correct; do not route around it.
- **Never touch another Irises checkout** that already exists somewhere on this machine.
- **Never edit hermes's config**, including for the restart-notification key above.

## 5. Verify after they report back (read-only)

```bash
curl -s http://127.0.0.1:3000/health
```

Use the port they actually installed on if it is not 3000. A JSON body with a `version` object is a
healthy install. Then tell them where to talk to her: any fronted engine channel, the web chat at
`http://127.0.0.1:3000`, or `npm run chat` in the clone for a terminal session. If the health check
fails, point them at `~/.irises/logs/server.log` and the script's own output — do not try to fix it by
starting anything.

## 6. The other two commands, for later

**Update** (from the Irises folder, in their terminal):

```bash
bash ./scripts/update.sh
```

It pulls, rebuilds, restarts Irises, and restarts the hermes gateway. If the new build fails to
compile or fails to come up, it rolls back to the build that was running. There is no chat command for
it — Irises will say so herself if asked, and hand over that same line. She does check for new builds
on her own and mentions one once, in chat, when it is waiting.

**Uninstall** (from the Irises folder):

```bash
bash ./scripts/engine-setup.sh --uninstall
```

Stops and unregisters the service, removes the bridge plugin and the engine-side keys the installer
added, restarts the gateway, and keeps their data. `--purge-data` deletes `~/.irises` too, and that is
not reversible.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- **Which model is live:** Irises's voice model vs. this hermes's deep-work model show in `/health`,
  on the `/dashboard` overview, and via `npx tsx ./scripts/print-model-map.ts`. Irises will also tell
  the person her model plainly if they ask in chat, and her build, and whether an update is waiting.
  Override any voice role with `<ROLE>_PROVIDER` / `<ROLE>_MODEL_OPENROUTER` / `<ROLE>_MODEL_OPENAI` /
  `<ROLE>_MODEL`, or turn inheritance off with `ENGINE_MODEL_INHERIT=off` (see `docs/ENGINES.md`
  § Model inheritance).
- On its first boot, Irises sends this hermes a one-time **engine-mode onboarding** over the API
  server: how to recognize a delegated request, the reply contract, the full-reach invitation and its
  hard limits (including never messaging the user on any channel itself). Hermes appends it to its own
  SOUL.md by its own hand — nothing in hermes is edited by Irises. To remove it later, tell hermes by
  chat to delete that section; to skip the send entirely, set `ENGINE_ONBOARDING=off` in the Irises
  `.env`. The text is printed by `npx tsx ./scripts/print-engine-doctrine.ts` inside the clone.
- Once after that, Irises makes the **first move**: she asks this hermes what it already knows about
  its user — a normal chat message hermes answers in its own words, nothing in hermes is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this hermes has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they text
  her. Exactly once per install; skip it with `FIRST_MOVE_ENABLED=false` in the Irises `.env`.

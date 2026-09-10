---
name: irises-setup-openclaw
description: "Guide a person through installing Irises — a user-facing front-end (web chat / CLI, plus the engine bridge) that uses this OpenClaw as its deep-work engine. Explains it, checks prerequisites, hands over the exact terminal commands, and verifies afterwards. It does not install anything itself."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌸",
        "requires": { "bins": ["git", "node", "npm"] },
      },
  }
---

# Irises Setup (OpenClaw engine) — a guide, not an installer

**You do not install Irises. The person does, in their own terminal.** Your job is to explain what
Irises is, check that the box can run it, hand over the exact commands, set the right expectations,
and verify the result once they say they are done.

Why it works this way: the installer's last step restarts the gateway, because the plugin and its
token are only read when the gateway comes up — and from your own session that means killing the
supervisor running your turn, mid-reply. So the command belongs in a human's shell, not in yours.

## What Irises is (say this in your own words)

A user-facing texting assistant — a fast conversational front line — that delegates ALL deep work
(research, files, memory) to this OpenClaw gateway. OpenClaw stays completely unmodified; Irises talks
to it only over the Gateway WebSocket `agent` RPC using the existing gateway token.

Irises rides **on top of** this OpenClaw: on boot it auto-detects it (sets `OPS_BACKEND=openclaw`),
reuses the gateway token, and makes its own voice **inherit OpenClaw's model** — so there is nothing
to configure by hand.

## 1. Check the prerequisites (read-only — these you MAY run)

```bash
node --version          # needs 22.13+ (Irises's local store uses the builtin node:sqlite)
git --version
openclaw gateway status
```

That is the entire list of commands you are allowed to run in this skill, plus the health check in
step 5. If `node --version` is below 22.13, tell the person which newer Node already on the box to put
on `PATH` (nvm under `~/.nvm/versions/node/`, or Homebrew) — do not attempt a system install.

On **Windows**, the person needs a bash to run the install in: **Git Bash**, which ships with the Git
for Windows they already need for the clone, or a **WSL2** shell. Say so up front, and say the honest
part too — the Windows paths are stub-tested only and have not yet been run on a real Windows box,
so Linux and macOS are the platforms with mileage on them.

## 2. Hand them the install (they run this, you do not)

```bash
git clone https://github.com/rivianpratama/irises ~/irises && cd ~/irises
bash ./scripts/engine-setup.sh --engine openclaw --yes
```

`--yes` means non-interactive: assume every default, never prompt. Drop it if they would rather be
asked. Any folder is fine — the second command runs from inside whichever one they chose, in a
terminal on this machine (Git Bash or WSL2 if that machine is Windows).

What the script does, so you can answer questions about it:

- checks node 22.13+, git, curl, and that the port is free,
- reads the existing gateway URL + token via `openclaw config get` (no OpenClaw config changes),
- installs the `@openclaw/gateway-client` package into the Irises clone,
- writes the Irises `.env` (mode 600): `OPS_BACKEND=openclaw`, `OPENCLAW_URL`, `OPENCLAW_TOKEN`, a
  generated `ENGINE_PUSH_TOKEN`, and `PORT=3000` (the committed `deploy/app.env` baseline `8080` is
  the Docker image's port). No database — Irises persists to `~/.irises` on its own,
- reuses an `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY` from the OpenClaw
  config/environment when present, for Irises's own small voice models,
- installs dependencies and builds; the web client is rebuilt only when it was built before,
- registers Irises as a **user-level service** — `systemd --user` on Linux, a LaunchAgent on macOS, a
  Task Scheduler task named `Irises` on Windows, with a detached `nohup` fallback where none of those
  exists — so she survives a reboot without root,
- waits for her to answer `/health`, then sets up **bridge mode by default**: installs the plugin
  with `openclaw plugins install` and writes `IRISES_FRONT=*:*`, so Irises fronts every chat on every
  channel out of the box (see the consequences below). `--no-bridge` skips the plugin and the
  fronting,
- **restarts the gateway last** so the plugin is live, and prints a summary with an honest exit code.

## 3. Set these two expectations before they run it

- **The gateway will restart at the end.** Anything in flight there ends. It is the step that turns
  the bridge on: until it happens, OpenClaw still answers its own channels.
- **`IRISES_FRONT=*:*` means Irises answers everything.** A person texting any channel this OpenClaw
  owns (WhatsApp, Discord, …) reaches Irises, who answers in her own voice and uses OpenClaw as her
  engine. OpenClaw is unchanged and still reachable directly, still transparently answers anything
  `IRISES_FRONT` does not cover — and answers everything whenever Irises is down (fail-open, so a
  broken front never drops messages). Narrow it to fnmatch patterns over `<channel>:<conversation>`,
  or blank it to make the plugin inert instantly. Tell them their operator and control chats are
  inside `*:*` too.

Also worth saying once: **shortly after that restart, Irises usually texts first** — a one-time
introduction, sent only on a chat this agent has genuinely exchanged messages in before (the "first
move", see Notes). A text from her out of the blue is the feature working, not a glitch.

## 4. Never do any of this

- **Never clone, install, build, or start anything.** Not in a temp folder, not "just to check".
- **Never run the setup script or the updater**, and never run any command that restarts or cycles
  the gateway or its supervisor — not through the OpenClaw CLI's own gateway subcommands, not through
  `systemctl`, `launchctl`, `kickstart`, `schtasks`, or direct process control.
- **Never touch another Irises checkout** that already exists on this machine.

## 5. Verify after they report back (read-only)

```bash
curl -s http://127.0.0.1:3000/health
```

Use the port they actually installed on if it is not 3000. A JSON body with a `version` object is a
healthy install. Then tell them where to talk to her: any fronted engine channel, the web chat at
`http://127.0.0.1:3000`, or `npm run chat` in the clone. If the health check fails, point them at
`~/.irises/logs/server.log` and the script's own output — do not try to fix it by starting anything.

## 6. The other two commands, for later

**Update** (from the Irises folder, in their terminal):

```bash
bash ./scripts/update.sh
```

It pulls, rebuilds, restarts Irises, and restarts the gateway. If the new build fails to compile or
fails to come up, it rolls back to the build that was running. There is no chat command for it —
Irises will say so herself if asked, and hand over that same line. She does check for new builds on
her own and mentions one once, in chat, when it is waiting.

**Uninstall** (from the Irises folder):

```bash
bash ./scripts/engine-setup.sh --uninstall
```

Stops and unregisters the service, removes the bridge plugin, restarts the gateway, and keeps their
data. `--purge-data` deletes `~/.irises` too, and that is not reversible.

## Notes

- Details, security notes, and troubleshooting live in `docs/ENGINES.md` inside the clone.
- On its first boot, Irises sends this OpenClaw a one-time **engine-mode onboarding** over the
  gateway: how to recognize a delegated request, the reply contract, the full-reach invitation and its
  hard limits. The agent saves it to its own instructions by its own hand (nothing in OpenClaw is
  edited). To remove it later, tell the agent by chat to delete that section; to skip the send
  entirely, set `ENGINE_ONBOARDING=off` in the Irises `.env`.
- Once after that, Irises makes the **first move**: she asks this OpenClaw what it already knows about
  its user — a normal chat message the agent answers in its own words, no OpenClaw file is read or
  edited — and keeps a sanitized version in her own memory so her first words are not cold. Then she
  either texts the user first, **only** on a chat this agent has genuinely exchanged messages in
  before, or sends nothing at all and folds the introduction into her reply the first time they text
  her. Exactly once per install; skip it with `FIRST_MOVE_ENABLED=false` in the Irises `.env`.
- Known v1 gap: reminders scheduled through Irises require the hermes engine for now (OpenClaw cron
  wiring is pending), so the reminder tools aren't offered on OpenClaw at all and Irises never
  promises a reminder that can't fire. Everything else runs full-reach here: real code, this agent's
  own skills, parallel subagents, artifacts.
- **Which model is live:** Irises's voice model vs. OpenClaw's deep-work model show in `/health`, on
  the `/dashboard` overview, and via `npx tsx ./scripts/print-model-map.ts`; Irises will also tell the
  person her model, her build, and whether an update is waiting if they ask. OpenClaw's
  `provider/model` slug routes the voice automatically; if this OpenClaw runs on an
  OpenAI-compatible/obscure API, point the voice at it by hand with `<ROLE>_PROVIDER=openai` +
  `OPENAI_BASE_URL` + `OPENAI_API_KEY` (the auto endpoint/key inheritance is hermes-only for now — see
  `docs/ENGINES.md` § Model inheritance).
- The user keeps using OpenClaw directly exactly as before; Irises is an additional,
  differently-voiced front door that uses it as an engine.

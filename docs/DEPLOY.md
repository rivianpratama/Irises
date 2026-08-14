# Irises — Setup & Deployment Runbook

> Secrets live in `.env`, which is gitignored — never commit it. If a key ever
> lands in a remote, rotate it in the provider console immediately.

## 1. Prerequisites
- **Node 22.13+** and npm (the local store uses the builtin `node:sqlite`).
- **Anthropic** API key, **OpenRouter** API key (fallback + voice transcription).
- A public HTTPS host for production (any small VM running Docker — §5 handles this with Caddy).
- Optionally, an **engine** (OpenClaw or hermes-agent) for email/reminders/deep work — see
  `docs/ENGINES.md`. Email, OAuth, and push webhooks live on the engine side, not in this app.

---

## 2. Run locally

### 2a. Fastest path (no infra at all)
```bash
git clone https://github.com/rivianpratama/Irises.git
cd Irises
npm install
cp .env.example .env
```
Edit `.env` and set at minimum:
```
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-... # for voice + fallback
```
State persists to `~/.irises` out of the box (override with `IRISES_HOME`); add
`DATA_BACKEND=memory` if you want a throwaway run that leaves nothing behind.
Run it:
```bash
npm run dev          # tsx watch (hot reload)
# in another shell:
curl http://localhost:3000/health      # -> {"status":"ok",...}
```
Diagnostics dashboard: open `http://localhost:3000/debug` (localhost is allowed without a token).

### 2b. Connect an engine locally (optional)
Email, reminders, and deep work run on an external engine (OpenClaw or hermes-agent), not in
this app — set `OPS_BACKEND` + the engine keys in `.env` and follow `docs/ENGINES.md`. Without
an engine, the web chat still works; Irises just can't do engine-backed research or reminders.

`npm run build` compiles to `dist/` and copies the agent `Context.md` files; `npm start` runs the built server. Build it once to confirm everything compiles:
```bash
npm run build && npm start
```

---

## 3. Local storage

There is no database to provision. All state lives under **`IRISES_HOME`** (default
`~/.irises`; `/data` inside the Docker image), in the same style as the engines it fronts:

```
$IRISES_HOME/
├── irises.db                # SQLite (node:sqlite): conversations, profiles, prefs,
│                            # short-term memory, reply threading, token ledger,
│                            # error log, diagnostics
└── memories/<handle>/       # per-user curated memory, human-readable markdown
    ├── LONG.md + revisions/ # the long-term doc, every version snapshotted
    ├── MEDIUM.md            # active directives/notes/facts (+ MEDIUM.archive.md lineage)
    └── DOSSIER.md           # the LLM-merged dossier prose
```

- Schema is created automatically on first boot; retention sweeps (hourly/daily/6h) keep
  the store bounded on a small VM.
- **Backing up Irises = backing up this directory** (the `irises_state` volume in compose).
  The database runs in WAL mode, so copy it **quiesced**: `docker compose stop app`, copy the
  volume (all of it — `irises.db` plus any `-wal`/`-shm` siblings), `docker compose start app`.
  For a hot backup use `sqlite3 irises.db ".backup backup.db"` instead of a raw file copy.
- `DATA_BACKEND=memory` runs the same code against an ephemeral root — nothing persists
  (used by the test suite and throwaway runs).
- The daily token caps (`OPS_DAILY_TOKEN_CAP` / `LLM_DAILY_TOKEN_CAP` in `deploy/app.env`)
  enforce out of the box now that the ledger is always present.

---

## 4. Other keys
```
TRANSCRIBE_MODEL=google/gemini-2.5-flash
# per-agent model config lives in deploy/app.env: <AGENT>_PROVIDER (anthropic|openrouter) +
# <AGENT>_MODEL (Anthropic slug) + <AGENT>_MODEL_OPENROUTER (OpenRouter slug) for CONVO /
# CLASSIFY / FALLFIRM. Deep research has no model here — it runs on your engine's model.
# PDF engine: OPENROUTER_PDF_ENGINE.
```

---

## 5. Deploy to a VM

Any small VM running Docker works (1 GB RAM is enough with the compose memory limits). The
stack is two containers via `docker compose`: the app and **Caddy**, which terminates HTTPS
(automatic Let's Encrypt) for a `<VM_IP>.nip.io` host or a real domain and reverse-proxies
to `app:8080`. All secrets live in a single **`/opt/irises/.env`** (chmod 600) read by
Docker Compose; the committed non-secret baseline is `deploy/app.env`.

1. Build and ship the image:
   ```bash
   docker build -t irises:latest .
   # push to any registry the VM can pull from (ghcr.io/<you>/irises:latest, Docker Hub, …),
   # or skip the registry entirely: docker save irises:latest | gzip > irises.tar.gz, scp it
   # to the VM, and docker load < irises.tar.gz there.
   ```
2. On the VM, create `/opt/irises/` and copy in `deploy/docker-compose.yml`,
   `deploy/Caddyfile`, and `deploy/app.env`.
3. Create `/opt/irises/.env` from `deploy/env.vm.example`: set `IMAGE` to your image ref,
   `SITE_ADDRESS` to `<VM_IP>.nip.io` or your domain, and fill in the API keys.
   `chmod 600 /opt/irises/.env`. Open ports 80/443 in the host firewall.
4. Start it:
   ```bash
   cd /opt/irises && docker compose up -d --wait
   ```
5. Optional — a systemd unit so the stack returns after a reboot:
   ```ini
   # /etc/systemd/system/irises.service
   [Unit]
   Description=Irises (docker compose)
   Requires=docker.service
   After=docker.service network-online.target
   [Service]
   Type=oneshot
   RemainAfterExit=yes
   WorkingDirectory=/opt/irises
   ExecStart=/usr/bin/docker compose up -d
   ExecStop=/usr/bin/docker compose down
   [Install]
   WantedBy=multi-user.target
   ```
   Then `systemctl daemon-reload && systemctl enable irises`.

To ship an update: rebuild + push the image, then `docker compose pull && docker compose up -d --wait` on the VM.

### Updating a git-clone install

Installs made with `git clone` + `scripts/engine-setup.sh` (rather than the Docker image) update in
place:

```bash
bash scripts/update.sh        # add --check to preview, --yes to skip the prompt, --restart to relaunch
```

The script fast-forwards `git pull`s the current branch, runs `npm ci && npm run build` (and
`npm run install:web && npm run build:web` when the web client is present), refreshes the engine
bridge plugin only if `bridge/` changed between the old and new commit — then reminds you to restart
the engine gateway — and writes `$IRISES_HOME/update-receipt.json`. Restart the server (or pass
`--restart`, which cycles it via `$IRISES_HOME/irises.pid`) to run the new build. Your data under
`$IRISES_HOME` is never touched, and a divergent local branch is never auto-merged (the script stops
and tells you to reconcile it).

Or skip the terminal entirely: tell Irises **"update yourself"** in chat. It spawns the same
`scripts/update.sh --yes --restart` as a detached process (so the updater survives the restart), acks
immediately, and voices the result — "got my upgrades" on success, "already on the latest" or the
failure reason otherwise. This is single-user by design (`UPDATE_SELF_ENABLED`, default `true`); if
bridge mode fronts other people's chats, set `UPDATE_SELF_ENABLED=false` so only the terminal path
remains.

One edge to know: if a new build *compiles* but then crashes on boot, the self-update has already
stopped the old server to relaunch, so nothing is left running to voice the failure — check
`$IRISES_HOME/logs/server.log` and `self-update.log`. (A build that fails to compile never restarts, so
the old server keeps running and voices the failure normally.)

The running server also checks the remote itself and reports what it finds:

- `GET /health` gains a `version` object (git `sha` / `branch` / build stamp) and an `update` object
  (`available`, `remoteSha`, `lastCheckAt`, `lastCheckOk`).
- The `/dashboard` overview shows a **version** card that turns amber when an update is available.
- In chat, Irises mentions a waiting upgrade once to recently-active chats and voices a short
  confirmation after you apply it.

Knobs (in `deploy/app.env` / `.env`): `UPDATE_CHECK_ENABLED` (default `true`),
`UPDATE_CHECK_INTERVAL_MS` (default 6h, floored at 15min), `UPDATE_CHECK_BRANCH` (defaults to the
clone's branch), `UPDATE_ANNOUNCE_ENABLED` (default `true` — `false` keeps detection but sends no
chat messages), `UPDATE_ANNOUNCE_ACTIVE_WINDOW_MS` (default 48h, the "recently active" window),
`UPDATE_SELF_ENABLED` (default `true` — the chat "update yourself" trigger). A
Docker image built without `.git` reports `version.source: "unknown"` and disables the checker.

---

## 6. Verification checklist
- `curl https://your-domain.com/health` → 200.
- Open the web chat URL (served at `/`) or run `npm run chat` → Irises replies (paced bubbles).
- Ask "what does AS-IS mean" → answered inline (no delegation).
- Ask a question that needs research → instant ack, then a follow-up.
- `/debug?token=…` shows the prompts and the Convo→Ops delegation graph.
- With an engine connected: ask for a reminder a couple of minutes out → the engine's cron
  delivers it back through `POST /api/engine/push` and Irises pings you proactively.
- Logs: `sudo docker compose -f /opt/irises/docker-compose.yml logs -f app` shows the boot
  banner's endpoint list and `[channels] registered "web"` (plus `"bridge"` when an engine fronts chats).

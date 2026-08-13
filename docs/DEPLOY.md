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

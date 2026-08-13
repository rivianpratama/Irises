# Irises — Setup & Deployment Runbook

> Secrets live in `.env`, which is gitignored — never commit it. If a key ever
> lands in a remote, rotate it in the provider console immediately.

## 1. Prerequisites
- **Node 22+** and npm.
- **Anthropic** API key, **OpenRouter** API key (fallback + voice transcription).
- **Supabase** project (free tier is fine).
- A public HTTPS host for production (the GCP VM path in §5 handles this with Caddy).
- Optionally, an **engine** (OpenClaw or hermes-agent) for email/reminders/deep work — see
  `docs/ENGINES.md`. Gmail, OAuth, and push webhooks live on the engine side, not in this app.

---

## 2. Run locally

### 2a. Fastest path (in-memory, no infra)
```bash
git clone https://github.com/rivianpratama/Irises.git
cd Irises
npm install
cp .env.example .env
```
Edit `.env` and set at minimum:
```
DATA_BACKEND=memory          # no Supabase needed
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-... # for voice + fallback
```
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

## 3. Supabase setup
1. Create a project at supabase.com → **Project Settings → API**: copy the **Project URL**
   and the **service_role** key (server-side; bypasses RLS — never expose it client-side).
2. Put them in `.env`:
   ```
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...   # service_role
   # remove DATA_BACKEND=memory to use Supabase
   ```
3. Apply the schema. **SQL Editor → New query**, paste and run **every file in
   `supabase/migrations/` in filename order** (`0001_init.sql` … `0003_telemetry.sql`).
   (Or with the Supabase CLI: `supabase link` then `supabase db push`.)
4. The migrations create all tables and enable RLS with no policies — the service-role
   key is what the server uses.
5. Optional: enable the `pg_cron` extension if you want DB-side cleanup of expired
   `messages`; otherwise it's harmless to skip.

Without these env vars the app silently falls back to the in-memory store (dev only — data is lost on restart).

---

## 4. Other keys
```
TRANSCRIBE_MODEL=google/gemini-2.5-flash
# per-agent model config lives in deploy/app.env: <AGENT>_PROVIDER (anthropic|openrouter) +
# <AGENT>_MODEL (Anthropic slug) + <AGENT>_MODEL_OPENROUTER (OpenRouter slug) for CONVO / OPS /
# CLASSIFY / AUTONOME / JUDGE. Web search + PDF work on both providers; on OpenRouter they need a
# tools-capable model (supported_parameters includes "tools"). PDF engine: OPENROUTER_PDF_ENGINE.
```

---

## 5. Deploy to a GCP Compute Engine VM

Deployment is fully automated. A single Compute Engine VM (e2-micro free-tier, or
e2-small) runs the app and **Caddy** as **Docker containers** via `docker compose`. Images
are built by **GitHub Actions** and pushed to **Artifact Registry**; every push to `main`
auto-deploys over an **IAP SSH tunnel** (`docker compose pull && docker compose up -d --wait`).
All config/secrets live in a single **`/opt/irises/.env`** (chmod 600) read by Docker Compose.
The app listens on **PORT 8080**; Caddy terminates HTTPS (automatic Let's Encrypt) for a
`<VM_IP>.nip.io` host or a real domain and reverse-proxies to `app:8080`.

For the full runbook see the repo-root **DEPLOY.md**.

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

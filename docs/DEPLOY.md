# Irises — Setup & Deployment Runbook

> Secrets live in `.env`, which is gitignored — never commit it. If a key ever
> lands in a remote, rotate it in the provider console immediately.

## 1. Prerequisites
- **Node 22+** and npm.
- A **Linq Blue** partner account + an assigned phone number + API token.
- **Anthropic** API key, **OpenRouter** API key (fallback + voice transcription).
- **Supabase** project (free tier is fine).
- **Google Cloud** project (for Gmail OAuth) + a public HTTPS domain for production.
- For local webhook/OAuth testing: **ngrok** (or any HTTPS tunnel).

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
AUTONOME_ENABLED=false       # don't send proactive texts locally
EMAIL_BACKSTOP_ENABLED=false
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-... # for voice + fallback
LINQ_API_TOKEN=...           # only needed to actually send/receive
```
Run it:
```bash
npm run dev          # tsx watch (hot reload)
# in another shell:
curl http://localhost:3000/health      # -> {"status":"ok",...}
```
Diagnostics dashboard: open `http://localhost:3000/debug` (localhost is allowed without a token).

### 2b. Connect it to real iMessage + Gmail locally
Irises needs a public HTTPS URL for Linq webhooks and the Google OAuth redirect.
```bash
ngrok http 3000
# note the https URL, e.g. https://ab12.ngrok-free.app
```
Then:
- In `.env`, set `PUBLIC_BASE_URL=https://ab12.ngrok-free.app` and
  `GOOGLE_OAUTH_REDIRECT_URI=https://ab12.ngrok-free.app/oauth/google/callback`.
- In the **Linq dashboard**, point the webhook for your number at `https://ab12.ngrok-free.app/webhook`.
- In **Google Cloud Console**, add that same redirect URI to your OAuth client (see §4).
- Restart `npm run dev`, then text your Linq number.

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
3. Apply the schema. **SQL Editor → New query**, paste and run, in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_agent_memory.sql`
   (Or with the Supabase CLI: `supabase link` then `supabase db push`.)
4. The migrations create all tables, the `claim_due_reminders` RPC (used by the sweeper),
   and enable RLS with no policies — the service-role key is what the server uses.
5. Optional: enable the `pg_cron` extension if you want DB-side cleanup of expired
   `messages`/`oauth_state`; otherwise it's harmless to skip.

Without these env vars the app silently falls back to the in-memory store (dev only — data is lost on restart).

---

## 4. Google Gmail OAuth setup
1. Google Cloud Console → create/select a project → **APIs & Services**.
2. **Enable the Gmail API**.
3. **OAuth consent screen**: external, add the scope
   `https://www.googleapis.com/auth/gmail.readonly`. While testing, add the agent's Google
   account under **Test users** (no full verification needed until you go broad).
4. **Credentials → Create OAuth client ID → Web application**. Add an **Authorized redirect URI**:
   - local: `https://<your-ngrok>/oauth/google/callback`
   - prod: `https://<your-domain>/oauth/google/callback`
5. Copy the client ID/secret into `.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_OAUTH_REDIRECT_URI=https://<domain-or-ngrok>/oauth/google/callback
   PUBLIC_BASE_URL=https://<domain-or-ngrok>
   ```
6. Generate the token-encryption key (32 bytes):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   → `TOKEN_ENCRYPTION_KEY=...`

The agent connects Gmail in-chat: Irises sends a consent link, the user taps it, Google
redirects to `/oauth/google/callback`, the encrypted refresh token is stored, and the
inbox backfill + reminders begin.

---

## 5. Other keys
```
LINQ_API_TOKEN=...                      # Linq Blue partner token
LINQ_AGENT_BOT_NUMBERS=+1XXXXXXXXXX     # the bot's number(s)
TRANSCRIBE_MODEL=google/gemini-2.5-flash
# per-agent model config lives in deploy/app.env: <AGENT>_PROVIDER (anthropic|openrouter) +
# <AGENT>_MODEL (Anthropic slug) + <AGENT>_MODEL_OPENROUTER (OpenRouter slug) for CONVO / OPS /
# CLASSIFY / AUTONOME / JUDGE. Web search + PDF work on both providers; on OpenRouter they need a
# tools-capable model (supported_parameters includes "tools"). PDF engine: OPENROUTER_PDF_ENGINE.
```

---

## 6. Deploy to a GCP Compute Engine VM

Deployment is fully automated. A single Compute Engine VM (e2-micro free-tier, or
e2-small) runs the app and **Caddy** as **Docker containers** via `docker compose`. Images
are built by **GitHub Actions** and pushed to **Artifact Registry**; every push to `main`
auto-deploys over an **IAP SSH tunnel** (`docker compose pull && docker compose up -d --wait`).
All config/secrets live in a single **`/opt/irises/.env`** (chmod 600) read by Docker Compose.
The app listens on **PORT 8080**; Caddy terminates HTTPS (automatic Let's Encrypt) for a
`<VM_IP>.nip.io` host or a real domain and reverse-proxies to `app:8080`.

For the full runbook see the repo-root **DEPLOY.md**.

---

## 7. Verification checklist
- `curl https://your-domain.com/health` → 200.
- Text the Linq number → Irises replies (paced bubbles).
- Ask "what does AS-IS mean" → answered inline (no delegation).
- Ask a property/contract question → instant ack, then a follow-up.
- Onboarding: new number → asked name → offered Gmail link; tap it → "gmail connected ✅",
  inbox backfill runs, and a `gmail_oauth_tokens` row appears in Supabase.
- `/debug?token=…` shows the prompts and the Convo→Ops delegation graph.
- Seed a near-term deadline (or let an email come in) → a proactive reminder fires.
- Logs: `sudo docker compose -f /opt/irises/docker-compose.yml logs -f app` shows `[sweeper]` and `[email] poller` running.

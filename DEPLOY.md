# Deploying Irises to a GCP VM (Compute Engine)

Push to `main` → GitHub Actions builds the Docker image, pushes it to Artifact Registry,
then over an **IAP SSH tunnel** ships the compose files to a small always-on VM and restarts
the container, waiting for `/health` before it calls the deploy good. **Caddy** on the VM
gives it automatic HTTPS. Cost: **~$3–15/mo** (vs ~$50 on Cloud Run).

```
git push origin main
  └─► GitHub Actions (.github/workflows/deploy.yml)
        ├─ auth to GCP via the GCP_SA_KEY secret (deploy-SA key)
        ├─ docker build → push to Artifact Registry
        └─ IAP SSH to the VM → docker compose pull && up -d --wait
                                   │
                          [ VM: app container + Caddy (auto-HTTPS) ]
                             reads /opt/irises/.env (never committed)
```


> This file is the working runbook.

---

## Where you run things

Almost everything happens in **Cloud Shell** (a browser terminal in the GCP console — nothing
to install). `deploy/gcp-setup.sh` does the entire setup there, including wiring GitHub for you.
The only other place you act is your repo on github.com (push) and a one-time edit of the VM's
`.env` (over SSH, from Cloud Shell).

## Prerequisites

- Access to the client's GCP project as **Owner**, with **billing enabled**. (Editor alone can't grant IAM roles — if you must use Editor, also get `roles/resourcemanager.projectIamAdmin`, or `gcp-setup.sh` fails at the role-binding step.)
- The GitHub repo `rivianpratama/Irises` (you have push access).
- API keys for `/opt/irises/.env`: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
  (required); Supabase / engine keys (optional, add later).

> **GO / NO-GO:** the only org-policy blocker for this path is
> `constraints/iam.disableServiceAccountKeyCreation` (the setup creates one deploy key). If the
> client's org enforces it, ask an admin to allow it for `gh-deployer`, or we switch CI auth to
> Workload Identity Federation. (No public `allUsers` IAM is needed — fewer blockers than Cloud Run.)

---

## 1. One command sets everything up — *Cloud Shell*

Open [Cloud Shell](https://shell.cloud.google.com), then:

```bash
gh auth login                                   # once, so the script can set the GitHub secret/vars
gh repo clone rivianpratama/Irises && cd Irises
nano deploy/gcp-setup.sh                         # set PROJECT_ID, REGION, ZONE, GITHUB_REPO, MACHINE
bash deploy/gcp-setup.sh
```

`gcp-setup.sh` enables APIs, creates the Artifact Registry repo, the two service accounts + roles,
the firewall rules, and the **e2-micro** VM; **bootstraps the VM over IAP SSH** (installs Docker,
swap, registry auth, scaffolds `/opt/irises/.env`, and a boot-time systemd unit) — which also
**confirms the SSH tunnel works before any deploy**; creates the deploy key and **sets the GitHub
secret + variables for you**; and prints your VM IP and `<ip>.nip.io` HTTPS host.

> The script is idempotent — safe to re-run if a step fails. It needs `gh auth login` to wire
> GitHub automatically; otherwise it prints the exact `gh` commands to run yourself.

## 2. Add your API keys — *Cloud Shell → the VM*

The VM's `/opt/irises/.env` holds **only secrets** (image, URLs, HTTPS host, and a generated
`TOKEN_ENCRYPTION_KEY` are already scaffolded). You fill in the API keys here — all *non-secret*
config lives in `deploy/app.env` (committed; see "Everyday workflow"). Edit the secrets:

```bash
gcloud compute ssh irises --zone us-central1-a --tunnel-through-iap \
  --ssh-flag="-t" --command 'sudo nano /opt/irises/.env'
```

Set `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY`. Leave optional integrations blank for now.

## 3. Deploy — *local machine or Cloud Shell*

```bash
git add -A && git commit -m "Switch deploy to Compute Engine VM" && git push origin main
```

Watch the run in the repo's **Actions** tab (build → push → ship → `up -d --wait`). The deploy
fails loudly if the app doesn't pass `/health`, so a green run means it's actually serving.

> If `git commit` says *"nothing to commit"*, trigger a deploy with an empty commit
> (`git commit --allow-empty -m "Deploy" && git push`) or the **Run workflow** button (`workflow_dispatch`).

Verify (HTTPS comes up within a minute or two as Caddy gets its cert):

```bash
curl https://<YOUR_VM_IP>.nip.io/health
```

## 4. Connect the app

1. **Web chat / CLI** → the web debug chat is served at `/` (gated by `DEBUG_TOKEN`); from a shell, `npm run chat` reaches the same endpoints. Engine-owned channels (Telegram, WhatsApp, …) are fronted through the bridge via `IRISES_FRONT` — see `docs/CHANNELS.md` and `docs/ENGINES.md`.
2. **Real domain (recommended for the client-facing prod):** point an `A` record at the VM IP, then
   set `SITE_ADDRESS` in `/opt/irises/.env` to the domain and restart
   (`cd /opt/irises && sudo docker compose up -d`).
3. **Email, reminders, deep work** → these live on the external engine (OpenClaw or hermes-agent),
   not in this app; connect one via `OPS_BACKEND` + engine keys in `/opt/irises/.env` and see
   `docs/ENGINES.md`. (The old in-app Gmail OAuth/Pub/Sub push flow — `/webhook/gmail`,
   `/oauth/google/callback` — was removed with the engine split; don't wire anything to those paths.)

---

## Everyday workflow

```bash
git push origin main      # builds, ships, restarts, and health-checks automatically
```

**Config vs secrets — what to edit where:**
- **Non-secret config** (models, pacing, feature flags) lives in **`deploy/app.env`** — edit in your IDE, commit, push. The deploy ships it to `/opt/irises/app.env` and restarts. No SSH.
- **Secrets** (API keys, `SUPABASE_*`, engine keys, `TOKEN_ENCRYPTION_KEY`) live **only** in `/opt/irises/.env` on the VM. A deploy never touches that file, so a push can't clobber your keys — edit them over SSH (Step 2) only when a key changes.
- On any overlapping key, `app.env` wins, so the committed config is authoritative.

**Logs / rollback** (from Cloud Shell or local, over IAP):

```bash
# Tail logs
gcloud compute ssh irises --zone us-central1-a --tunnel-through-iap \
  --command "cd /opt/irises && sudo docker compose logs -n 100 app"

# Roll back: set IMAGE=...:<previous-commit-sha> in /opt/irises/.env, then
gcloud compute ssh irises --zone us-central1-a --tunnel-through-iap \
  --command "cd /opt/irises && sudo docker compose up -d --wait"
```

Each deploy pushes `:latest` and `:<commit-sha>` and keeps images for 72h, so recent commits are
rollback-able. After a VM reboot the `irises` systemd unit brings the stack back automatically.

---

## Cost

| | ~Monthly |
|---|---|
| e2-micro (Always-Free) + external IP | **~$3** |
| e2-small (2 GB) + external IP | **~$15** |

Hosting only — your **LLM API spend (Anthropic, OpenRouter) is separate** and
usually larger. To resize: `gcloud compute instances stop irises` →
`set-machine-type --machine-type e2-small` → `start`. The 2 GB swap + 512 MB heap cap let the free
e2-micro hold up; move to e2-small if you see OOM-kills in the logs.

## Handing the repo to the client (end of project)

1. **Scrub secrets from git history** (`.env` is in history): `git rm --cached .env`, rotate the keys,
   and purge with `git filter-repo --path .env --invert-paths` before transfer.
2. **Transfer the repo**; re-create the `GCP_SA_KEY` secret and `GCP_*` variables (or just re-run
   `gcp-setup.sh` from the new clone with `gh` logged in).
3. **Rotate the deploy key** to cut your interim access. Optionally switch CI auth to Workload
   Identity Federation now that repo + GCP are both the client's.

## Security notes

- **SSH is closed to the internet** — reachable only through Google's IAP tunnel (port 22 allowed
  only from `35.235.240.0/20`). Only 80/443 are public (that's the app).
- `/opt/irises/.env` holds all secrets at `chmod 600`, lives only on the VM, never committed.
- The VM pulls images using its own service account (`irises-vm`, read-only on Artifact Registry).
- The app container runs as a non-root user with a memory cap.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| CI fails at the IAP SSH step | `gcp-setup.sh` already bootstrapped over IAP, so the tunnel works; check that `GCP_SA_KEY` + the 4 `GCP_*` variables are set on the repo. |
| Deploy fails: "App did not become healthy" | The container logged the reason (printed in the job). Usually a missing required key in `/opt/irises/.env` or a bad `IMAGE`. |
| `curl https://<ip>.nip.io/health` hangs / bad cert | Caddy is still getting a cert, or Let's Encrypt rate-limited `nip.io` (429). Wait, check `sudo docker compose logs caddy`, or switch to a real domain. |
| `denied: permission` on image pull | Re-run `sudo gcloud auth configure-docker <region>-docker.pkg.dev` on the VM. |
| App didn't come back after reboot | `sudo systemctl start irises` (the unit is enabled; this also runs on boot). |

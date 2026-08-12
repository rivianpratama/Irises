// Runtime env loader (imported first by index.ts, before anything reads process.env).
//
// Single source of config truth: deploy/app.env — the SAME committed file prod uses —
// is loaded as the baseline, then your local, gitignored .env is layered ON TOP to
// override the few things that must differ locally (dev keys, the ngrok PUBLIC_BASE_URL,
// and the sweeper/email-poller safety toggles).
//
// Inside the Docker container NEITHER file exists (env is injected by docker compose),
// so both calls are harmless no-ops there and the compose-provided process.env stands.
import dotenv from 'dotenv';

dotenv.config({ path: 'deploy/app.env' });          // shared baseline (local only; absent in prod image)
dotenv.config({ path: '.env', override: true });    // local secrets + overrides (gitignored)

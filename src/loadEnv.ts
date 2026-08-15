// Runtime env loader (imported first by index.ts, before anything reads process.env).
//
// Single source of config truth, layered LOWEST → HIGHEST:
//   1. deploy/app.env      — the SAME committed baseline prod uses (models, pacing, intervals).
//   2. engine discovery    — Irises rides ON TOP OF the hermes-agent / OpenClaw you already run:
//                            it auto-detects the engine (OPS_BACKEND), reuses its API key, and makes
//                            Irises's own voice models inherit the engine's model. It OVERRIDES the
//                            baseline's model choices (so "no .env" still gives you the engine's
//                            model) but never a value you exported in the shell — and step 3 still
//                            wins over it.  See src/agents/ops/engineDiscovery.ts.
//   3. local .env          — your gitignored secrets + overrides, layered ON TOP to win over both.
//
// Inside the Docker container NEITHER file exists (env is injected by docker compose) and no local
// engine is reachable, so the dotenv calls are no-ops and discovery finds nothing — the
// compose-provided process.env stands unchanged.
import dotenv from 'dotenv';
import { runEngineDiscovery } from './agents/ops/engineDiscovery.js';

// Keys already in the REAL environment are explicit user choices discovery must never override.
const shellKeys = new Set(Object.keys(process.env));

dotenv.config({ path: 'deploy/app.env' });          // 1. shared baseline (local only; absent in prod image)
runEngineDiscovery(shellKeys);                        // 2. detect engine + inherit its model/keys (overrides baseline)
dotenv.config({ path: '.env', override: true });      // 3. local secrets + overrides (gitignored) win over all

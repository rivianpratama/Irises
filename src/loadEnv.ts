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
// Debug/standalone (no engine): set OPS_BACKEND=off (in .env or the shell) — discovery then skips
// detection AND model inheritance, so Irises runs on its own shipped models with deep work offline,
// even on a machine that has an engine installed.
//
// Inside the Docker container NEITHER file exists (env is injected by docker compose) and no local
// engine is reachable, so the dotenv calls are no-ops and discovery finds nothing — the
// compose-provided process.env stands unchanged.
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { runEngineDiscovery } from './agents/ops/engineDiscovery.js';

// Keys already in the REAL environment are explicit user choices discovery must never override.
const shellKeys = new Set(Object.keys(process.env));

dotenv.config({ path: 'deploy/app.env' });          // 1. shared baseline (local only; absent in prod image)

// Peek the local .env for an explicit OPS_BACKEND so a pinned engine — or OPS_BACKEND=off for the
// debug path — governs the auto-detection below (the full .env still loads in step 3). Without this,
// .env loads too late and discovery would auto-detect an installed engine before the pin applied.
if (!process.env.OPS_BACKEND) {
  try {
    const pinned = dotenv.parse(readFileSync('.env')).OPS_BACKEND;
    if (pinned) process.env.OPS_BACKEND = pinned;
  } catch { /* no local .env — fine */ }
}

runEngineDiscovery(shellKeys);                        // 2. detect engine + inherit its model/keys (overrides baseline)
dotenv.config({ path: '.env', override: true });      // 3. local secrets + overrides (gitignored) win over all

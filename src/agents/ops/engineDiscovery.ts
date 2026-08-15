// Zero-config engine discovery — makes Irises ride ON TOP OF the hermes-agent / OpenClaw the user
// already runs, with no hand-written .env. Runs ONCE at boot (from loadEnv.ts, BETWEEN the
// deploy/app.env baseline load and the local .env override) and front-fills process.env from the
// detected engine:
//   • OPS_BACKEND        — auto-detected from which engine is installed (explicit value wins)
//   • engine creds       — HERMES_API_KEY / OPENCLAW_TOKEN + loopback URLs (filled only when unset)
//   • the LLM key        — reuse the engine's ANTHROPIC/OPENROUTER key (filled only when unset)
//   • the voice model     — ALL of Irises's own roles (convo/classify/fallfirm) inherit the engine's
//                          model so "the model used for Irises" == the model the engine uses.
//
// Precedence (why this runs between the two dotenv loads): deploy/app.env SETS the model vars, so a
// plain "set if unset" could never make the engine's model the default. Model inheritance therefore
// OVERRIDES the committed baseline — but yields to (a) anything the user exported in the real shell
// (`protectedKeys`) and (b) the local .env, which loadEnv applies AFTER this with override:true.
// Deep work already runs on the engine's own model (the `ops` role is engine-owned); this only
// governs Irises's OWN small voice models. Transcription is deliberately excluded — it needs an
// audio-capable model, not a chat model.
//
// Everything is best-effort and wrapped so a boot NEVER fails because an engine read failed: on any
// error the step is skipped and Irises keeps its shipped defaults. Testable via DI (no module
// mocking) — the impure edges (fs, child_process, os, logging) are injected.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

/** Injectable impure edges — the repo's DI testing convention. */
export interface DiscoveryDeps {
  /** The env map to READ and FILL (process.env in production). */
  env: Record<string, string | undefined>;
  /** Keys present in the REAL shell environment before any dotenv load — explicit user choices we
   *  must never override. */
  protectedKeys: Set<string>;
  homedir: () => string;
  fileExists: (p: string) => boolean;
  /** File text, or null if unreadable. */
  readFileText: (p: string) => string | null;
  /** A CLI's trimmed stdout, or null on any failure (missing binary, non-zero exit, timeout). */
  runCli: (cmd: string, args: string[]) => string | null;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Irises's own voice roles that inherit the engine model (env-var prefixes). `ops` is engine-owned
 *  already; `transcribe` needs an audio model, so both are excluded. */
const VOICE_ROLES = ['CONVO', 'CLASSIFY', 'FALLFIRM'] as const;

const HERMES_DEFAULT_URL = 'http://127.0.0.1:8642';
const OPENCLAW_DEFAULT_URL = 'ws://127.0.0.1:18789';

/** Read a KEY=VALUE from dotenv-style text (last assignment wins, quotes stripped, `export ` ok). */
export function envFileValue(text: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    found = v || null;
  }
  return found;
}

/** Last-resort, dependency-free scan of ~/.hermes/config.yaml for the model — used only when the
 *  `hermes` CLI is unavailable. Handles both `model: "slug"` and a `model:` block with a nested
 *  `default:`/`model:`/`name:`. Not a full YAML parser; the CLI is the authoritative path. */
export function scanYamlModel(text: string | null): string | null {
  if (!text) return null;
  const strip = (s: string): string => {
    let v = s.trim();
    // drop trailing inline comment on unquoted scalars
    if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  };
  const lines = text.split('\n');
  let inModel = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // Only a TOP-LEVEL (column-0) `model:` opens the block — a `model:` nested under another key is
    // unrelated (hermes keeps `model:` at the top level of config.yaml).
    const top = line.match(/^model:\s*(.*)$/);
    if (top) {
      const inline = strip(top[1]);
      if (inline) return inline; // `model: "anthropic/claude-opus-4.6"`
      inModel = true;
      continue;
    }
    if (inModel) {
      const indent = line.match(/^(\s*)/)![1].length;
      if (indent === 0) { inModel = false; continue; } // dedented back to a top-level key
      const kv = line.match(/^\s*(default|model|name):\s*(.+)$/);
      if (kv) { const v = strip(kv[2]); if (v) return v; }
    }
  }
  return null;
}

/** Core discovery — pure over its injected deps. Mutates `deps.env` in place. */
export function applyEngineDiscovery(deps: DiscoveryDeps): void {
  const { env, protectedKeys } = deps;
  const has = (k: string): boolean => !!(env[k] && env[k]!.trim());

  /** Fill a GAP only: set when the key is unset and not shell-protected (creds, keys, backend). */
  const fill = (k: string, v: string | null | undefined, note?: string): void => {
    if (!v || protectedKeys.has(k) || has(k)) return;
    env[k] = v;
    deps.log(`set ${k}${note ? ` (${note})` : ''}`);
  };
  /** OVERRIDE the committed baseline, but never a shell-exported value (model/provider inheritance).
   *  The local .env, applied after discovery, still wins. */
  const override = (k: string, v: string | null | undefined): void => {
    if (!v || protectedKeys.has(k) || env[k] === v) return;
    env[k] = v;
  };

  // ── 1. Detect the engine → OPS_BACKEND ────────────────────────────────────
  let backend = (env.OPS_BACKEND || '').trim().toLowerCase();
  const userSet = backend !== '';

  // A user who pinned OPS_BACKEND to a non-engine value (off / none / offline / …) wants deep work
  // OFF — the debug/standalone path. Respect it fully: no detection, no cred/model inheritance, even
  // if an engine is installed on this machine.
  if (userSet && backend !== 'hermes' && backend !== 'openclaw') {
    deps.log(`OPS_BACKEND="${backend}" — deep work offline (debug/standalone); skipping engine discovery`);
    return;
  }

  const hermesHome = env.HERMES_HOME || path.join(deps.homedir(), '.hermes');
  const hermesEnvPath = path.join(hermesHome, '.env');
  const hermesConfigPath = path.join(hermesHome, 'config.yaml');
  const hermesPresent = deps.fileExists(hermesEnvPath) || deps.fileExists(hermesConfigPath);

  // cached so we read the OpenClaw token at most once
  let openclawToken: string | null | undefined;
  const readOpenclawToken = (): string | null => {
    if (openclawToken === undefined) {
      const t = deps.runCli('openclaw', ['config', 'get', 'gateway.auth.token']);
      openclawToken = t && t !== 'undefined' ? t : null;
    }
    return openclawToken;
  };

  if (!userSet) {
    if (hermesPresent) {
      backend = 'hermes'; // tie-break: prefer hermes (reminders need it) when both are present
    } else if (readOpenclawToken()) {
      backend = 'openclaw';
    } else {
      deps.log('no engine detected — deep work stays offline (Convo still chats). Set OPS_BACKEND or run scripts/engine-setup.sh to connect one.');
      return;
    }
    env.OPS_BACKEND = backend;
    deps.log(`detected ${backend} → OPS_BACKEND=${backend} (set OPS_BACKEND=off to force the debug/offline path)`);
  }

  // ── model inheritance opt-out (default on) ────────────────────────────────
  const inheritRaw = (env.ENGINE_MODEL_INHERIT || '').trim().toLowerCase();
  const inheritEnabled = !['off', 'false', '0', 'no'].includes(inheritRaw);

  // A CLI `config get` on an unset key can print a null-ish literal instead of failing — never
  // inherit those as a model.
  const nullish = (v: string | null): boolean =>
    ['', 'none', 'null', 'undefined', 'nil', 'not set'].includes((v || '').trim().toLowerCase());

  // Map the engine's `provider/model` slug onto Irises's two lanes, for ALL voice roles.
  const applyModel = (slug: string | null): void => {
    if (!inheritEnabled) return;
    if (nullish(slug)) {
      deps.warn('could not read the engine model — keeping Irises\'s own model defaults');
      return;
    }
    const s = slug!.trim();
    const hasOR = has('OPENROUTER_API_KEY');
    const hasAnthropic = has('ANTHROPIC_API_KEY');
    if (hasOR || !hasAnthropic) {
      // OpenRouter lane. Both engines emit `provider/model`, which the OpenRouter lane consumes
      // verbatim — an exact model match. Also the fall-through when no key is present yet.
      for (const r of VOICE_ROLES) {
        override(`${r}_MODEL_OPENROUTER`, s);
        override(`${r}_PROVIDER`, 'openrouter');
      }
      deps.log(`inheriting engine model "${s}" on all voice roles (OpenRouter lane)`);
      if (!hasOR) deps.warn(`inherited "${s}" but no OPENROUTER_API_KEY is set — add one so Irises's voice can use it`);
    } else if (s.startsWith('anthropic/')) {
      // Anthropic-only deployment: strip the vendor prefix for the Anthropic lane (best-effort —
      // the version format may differ from a valid Anthropic API id).
      const bare = s.slice('anthropic/'.length);
      for (const r of VOICE_ROLES) {
        override(`${r}_MODEL`, bare);
        override(`${r}_PROVIDER`, 'anthropic');
      }
      deps.log(`inheriting engine model "${bare}" on all voice roles (Anthropic lane)`);
      deps.warn(`applied "${bare}" to the Anthropic lane as-is; if the API rejects it, set <ROLE>_MODEL to override`);
    } else {
      deps.warn(`engine model "${s}" needs OpenRouter but no OPENROUTER_API_KEY is set — keeping Irises defaults`);
    }
  };

  // ── 2/3/4. per-backend creds, LLM key, and model ──────────────────────────
  if (backend === 'hermes') {
    fill('HERMES_BASE_URL', HERMES_DEFAULT_URL, 'hermes default');
    const hermesEnv = deps.readFileText(hermesEnvPath);
    if (hermesEnv) {
      fill('HERMES_API_KEY', envFileValue(hermesEnv, 'API_SERVER_KEY'), 'from ~/.hermes/.env');
      fill('OPENROUTER_API_KEY', envFileValue(hermesEnv, 'OPENROUTER_API_KEY'), 'reused from hermes');
      fill('ANTHROPIC_API_KEY', envFileValue(hermesEnv, 'ANTHROPIC_API_KEY'), 'reused from hermes');
    }
    // `hermes config get model.default` resolves aliases + the HERMES_MODEL env fallback correctly;
    // fall back to the .env var, then a crude config.yaml scan, if the CLI isn't on PATH.
    const slug = deps.runCli('hermes', ['config', 'get', 'model.default'])
      || deps.runCli('hermes', ['config', 'get', 'model.model'])
      || deps.runCli('hermes', ['config', 'get', 'model.name'])
      || (hermesEnv ? envFileValue(hermesEnv, 'HERMES_MODEL') : null)
      || scanYamlModel(deps.readFileText(hermesConfigPath));
    applyModel(slug);
    if (!has('OPENROUTER_API_KEY') && !has('ANTHROPIC_API_KEY')) {
      deps.warn('no ANTHROPIC_API_KEY or OPENROUTER_API_KEY found — add one so Irises\'s own voice can call an LLM');
    }
  } else if (backend === 'openclaw') {
    fill('OPENCLAW_URL', OPENCLAW_DEFAULT_URL, 'openclaw default');
    fill('OPENCLAW_TOKEN', readOpenclawToken(), 'from openclaw config');
    const agentId = env.OPENCLAW_AGENT_ID || 'main';
    // Prefer the model bound to the agent Irises delegates to, else the global default.
    const slug = deps.runCli('openclaw', ['config', 'get', `agents.entries.${agentId}.model`])
      || deps.runCli('openclaw', ['config', 'get', 'agents.defaults.model.primary'])
      || deps.runCli('openclaw', ['config', 'get', 'agents.defaults.model']);
    applyModel(slug);
    if (!has('OPENROUTER_API_KEY') && !has('ANTHROPIC_API_KEY')) {
      deps.warn('no ANTHROPIC_API_KEY or OPENROUTER_API_KEY found — add one so Irises\'s own voice can call an LLM');
    }
  }
}

/** Production entry: build real deps over process.env and run discovery once. Called from loadEnv.ts
 *  between the deploy/app.env baseline load and the local .env override. */
export function runEngineDiscovery(protectedKeys: Set<string>): void {
  try {
    applyEngineDiscovery({
      env: process.env,
      protectedKeys,
      homedir,
      fileExists: (p) => { try { return existsSync(p); } catch { return false; } },
      readFileText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
      runCli: (cmd, args) => {
        try {
          const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
          const trimmed = out.trim();
          return trimmed || null;
        } catch {
          return null;
        }
      },
      log: (m) => console.log(`[engine-discovery] ${m}`),
      warn: (m) => console.warn(`[engine-discovery] ${m}`),
    });
  } catch (err) {
    // Discovery is a convenience layer — never let it stop the process from booting.
    console.warn(`[engine-discovery] skipped (${(err as Error)?.message ?? err})`);
  }
}

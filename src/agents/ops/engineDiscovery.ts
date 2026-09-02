// Zero-config engine discovery — makes Irises ride ON TOP OF the hermes-agent / OpenClaw the user
// already runs, with no hand-written .env. Runs ONCE at boot (from loadEnv.ts, BETWEEN the
// deploy/app.env baseline load and the local .env override) and front-fills process.env from the
// detected engine:
//   • OPS_BACKEND        — auto-detected from which engine is installed (explicit value wins)
//   • engine creds       — HERMES_API_KEY / OPENCLAW_TOKEN + the engine's own bind address (filled
//                          only when unset)
//   • the LLM key        — reuse the engine's ANTHROPIC/OPENROUTER key (filled only when unset)
//   • the voice model     — ALL of Irises's own roles (convo/classify/fallfirm) inherit the engine's
//                          model so "the model used for Irises" == the model the engine uses — but
//                          only when the engine's model AND provider together say which of Irises's
//                          lanes can actually call it (see applyModel).
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

const HERMES_DEFAULT_HOST = '127.0.0.1';
const HERMES_DEFAULT_PORT = '8642';
const OPENCLAW_DEFAULT_URL = 'ws://127.0.0.1:18789';

/** Which of Irises's voice LANES a host provider maps to. `foreign` = an auth/protocol none of the
 *  lanes can speak directly (SigV4/GCP/native/OAuth), so it is not inheritable. */
type LaneClass = 'anthropic' | 'openrouter' | 'openai' | 'foreign';

/** Provider names that speak the Anthropic Messages API. */
const ANTHROPIC_PROVIDERS = new Set(['anthropic']);

/** Provider names that speak the OpenAI chat/completions schema — reachable via the generic `openai`
 *  lane pointed at the host's base URL. Drawn from hermes's provider profiles (api_mode
 *  chat_completions). Heuristic, not exhaustive: a misclassified provider fails loud at call time and
 *  falls back, and api_mode from the host config is preferred over this table when readable. */
const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openai', 'azure', 'azure-foundry', 'azure-openai', 'deepseek', 'fireworks', 'together', 'togetherai',
  'groq', 'nvidia', 'novita', 'deepinfra', 'minimax', 'minimax-cn', 'alibaba', 'alibaba-coding-plan',
  'stepfun', 'upstage', 'kimi-coding', 'kimi-coding-cn', 'qwen', 'qwen-oauth', 'xiaomi', 'zai', 'arcee',
  'gmi', 'huggingface', 'opencode-go', 'opencode-zen', 'ai-gateway', 'kilocode', 'actual', 'custom',
  'ollama', 'ollama-cloud', 'vllm', 'llamacpp', 'llama.cpp', 'local', 'xai', 'openai-codex',
]);

/** Providers whose auth/protocol neither Irises voice lane can speak directly. */
const FOREIGN_PROVIDERS = new Set(['bedrock', 'vertex', 'gemini', 'copilot', 'copilot-acp', 'nous', 'moa']);

/** The cheap, fast voice model Irises defaults to per host provider — so the chat voice stays snappy
 *  even when the host runs a big deep-work model. Keyed by the EXACT provider (not the lane class):
 *  a host on some other OpenAI-compatible provider (deepseek-direct, azure, vllm…) has no curated
 *  slug and falls through to the host's own model. Overridable per role via <ROLE>_MODEL* /
 *  <ROLE>_PROVIDER. The slugs are lane-native (`:nitro` is OpenRouter-only; `gpt-5.6-luna` is an
 *  OpenAI-native id; `claude-sonnet-5` is Anthropic-native). */
const CURATED_VOICE_MODEL: Record<string, string> = {
  openrouter: 'deepseek/deepseek-v4-flash:nitro',
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-sonnet-5',
};

/** Best-effort default endpoints for common OpenAI-compatible providers whose base URL lives in a
 *  hermes provider PROFILE rather than in config.yaml's model.base_url. Config / ~/.hermes/.env
 *  always win over this; it only spares the user a manual OPENAI_BASE_URL for the common hosts. */
const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  togetherai: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  xai: 'https://api.x.ai/v1',
  novita: 'https://api.novita.ai/v3/openai',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

/** The host engine's OWN deep-work model, captured at discovery for the model map (getModelMap in
 *  src/llm/modelMap.ts). Deep work ALWAYS runs on this — the engine's config — regardless of what
 *  Irises's voice lanes inherit, so it is captured even when the provider is foreign / not inherited.
 *  Module-level (last discovery wins); production runs discovery once at boot. */
let discoveredEngine: { backend: string; model: string | null; provider: string | null } | null = null;
export function getDiscoveredEngine(): { backend: string; model: string | null; provider: string | null } | null {
  return discoveredEngine;
}

/** Where the hermes API server listens, from its OWN bind settings in ~/.hermes/.env (the multi-
 *  profile docs tell users to move the port, and the gateway reads these two keys from that same
 *  file). A wildcard bind is not a dialable address, so it maps back to loopback. */
function hermesBaseUrl(host: string | null, port: string | null): string {
  let h = (host || '').trim() || HERMES_DEFAULT_HOST;
  if (h === '0.0.0.0' || h === '::' || h === '[::]') h = HERMES_DEFAULT_HOST;
  if (h.includes(':') && !h.startsWith('[')) h = `[${h}]`; // a bare IPv6 literal needs brackets in a URL
  return `http://${h}:${(port || '').trim() || HERMES_DEFAULT_PORT}`;
}

/** Read a KEY=VALUE from dotenv-style text (last assignment wins, quotes stripped, `export ` ok). */
export function envFileValue(text: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // The capture keeps any whitespace after `=` (it is trimmed below): it is what tells
    // `K= # comment` — a value that is only a comment — apart from `K=#abc`, a value containing one.
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2];
    // dotenv strips a whitespace-preceded `# comment` from an UNQUOTED value, and these files
    // routinely carry one. Without this, `API_SERVER_KEY=sk-abc # hermes api server` shipped the
    // comment inside the Authorization header — a well-formed request, so no throw, just a permanent
    // 401 blaming HERMES_API_KEY. Stripped BEFORE trimming so a value that is nothing but a comment
    // reduces to empty; `abc#123` (no space) stays whole, as dotenv also keeps it.
    // (scanYamlModel below already did this; envFileValue was the omission.)
    if (!v.trim().startsWith('"') && !v.trim().startsWith("'")) v = v.replace(/\s+#.*$/, '');
    v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    found = v || null;
  }
  return found;
}

/** Last-resort, dependency-free scan of ~/.hermes/config.yaml's top-level `model:` block for the
 *  first of `keys` — used only when the `hermes` CLI is unavailable. `takeInline` claims the scalar
 *  form (`model: "slug"`), which IS the model and can never be a sibling key like `provider:`. Not a
 *  full YAML parser; the CLI is the authoritative path. */
function scanModelBlock(text: string | null, keys: readonly string[], takeInline: boolean): string | null {
  if (!text) return null;
  const kvRe = new RegExp(`^\\s*(?:${keys.join('|')}):\\s*(.+)$`);
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
      if (inline) return takeInline ? inline : null; // `model: "anthropic/claude-opus-4.6"`
      inModel = true;
      continue;
    }
    if (inModel) {
      const indent = line.match(/^(\s*)/)![1].length;
      if (indent === 0) { inModel = false; continue; } // dedented back to a top-level key
      const kv = line.match(kvRe);
      if (kv) { const v = strip(kv[1]); if (v) return v; }
    }
  }
  return null;
}

/** The engine's model id: the inline `model: "slug"` form, or `default:`/`model:`/`name:` in the block. */
export function scanYamlModel(text: string | null): string | null {
  return scanModelBlock(text, ['default', 'model', 'name'], true);
}

/** The engine's provider slug — hermes keeps `provider:` as a SIBLING of `default:` in that block,
 *  and the id alone cannot say which API it is native to. */
export function scanYamlProvider(text: string | null): string | null {
  return scanModelBlock(text, ['provider'], false);
}

/** A CLI `config get` on an unset key can print a null-ish literal instead of failing — never treat
 *  one as a real value. Module-level so both the CLI reader and applyModel can use it. */
function nullish(v: string | null): boolean {
  return ['', 'none', 'null', 'undefined', 'nil', 'not set'].includes((v || '').trim().toLowerCase());
}

/** Slug shapes of model families that spend chain-of-thought BY DEFAULT, with no reasoning param
 *  asked for. `o[134]` needs a `/` or `-` in front so `gpt-4o` and `claude-opus-*` don't match. */
const REASONING_FAMILY: readonly RegExp[] = [
  /deepseek-v4/,
  /deepseek-r/,
  /(?:^|[/-])o[134](?:$|[-.:])/,
  /-thinking(?:$|[-.:])/,
];

/** True for a model slug whose family reasons by default (see REASONING_FAMILY). Exported for the
 *  test table — the inheritance heads-up below is the only production caller. */
export function isReasoningFamilyModel(slug: string): boolean {
  const s = slug.trim().toLowerCase();
  return REASONING_FAMILY.some(re => re.test(s));
}

/** Values of `<ROLE>_THINKING` that ARM thinking (mirrors models.ts parseThinking; every voice role
 *  defaults off, so anything else — unset included — means off). */
const THINKING_ON_VALUES = ['adaptive', 'on', 'true', '1', 'enabled', 'yes'];

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

  /** runCli, with null-ish literals filtered AT THE SOURCE. The model lookups below chain with `||`,
   *  so a CLI that prints the literal `undefined` for an unset key returned a TRUTHY string and stopped
   *  the chain at rung 1 — the .env fallback and the config.yaml scan were never reached, and the
   *  real model was unreachable even though it was right there. */
  const cliValue = (cmd: string, args: string[]): string | null => {
    const v = deps.runCli(cmd, args);
    return nullish(v) ? null : v;
  };

  // cached so we read the OpenClaw token at most once
  let openclawToken: string | null | undefined;
  const readOpenclawToken = (): string | null => {
    if (openclawToken === undefined) {
      openclawToken = cliValue('openclaw', ['config', 'get', 'gateway.auth.token']);
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

  // Map the engine's model onto one of Irises's two voice lanes, for ALL voice roles.
  //
  // The id alone is NOT enough to pick the lane: hermes stores a PROVIDER-NATIVE id in `model.default`
  // plus the provider in `model.provider` (`vendor/model` is only the aggregator shape), so an
  // Anthropic-direct hermes reads `claude-sonnet-4-5-20250929`, an Azure one `gpt-4o`, and a MoA one a
  // local preset name. Sent to the OpenRouter lane those 400 on every turn — auto-detection breaking
  // an install that worked before it ran. So: inherit only when the (id, provider) pair is
  // conclusive, otherwise leave the shipped defaults alone and say why.
  const applyModel = (
    slug: string | null,
    provider: string | null,
    opts?: { baseUrl?: string | null; apiKey?: string | null; apiMode?: string | null },
  ): void => {
    if (!inheritEnabled) return;
    if (nullish(slug)) {
      deps.warn('could not read the engine model — keeping Irises\'s own model defaults');
      return;
    }
    const s = slug!.trim();
    // `auto` is hermes's "not pinned to a provider" sentinel (logout resets it, pointing base_url back
    // at OpenRouter) — unknown, not a provider of its own.
    const raw = nullish(provider) ? '' : provider!.trim().toLowerCase();
    const p = raw === 'auto' ? '' : raw;
    const apiMode = nullish(opts?.apiMode ?? null) ? '' : (opts!.apiMode as string).trim().toLowerCase();

    // All lane setters override the same three VOICE_ROLES + <ROLE>_PROVIDER. The curated cheap model
    // is used for the three named providers; other reachable hosts get their own model slug.
    const setLane = (lane: 'openrouter' | 'openai' | 'anthropic', model: string): void => {
      for (const r of VOICE_ROLES) {
        if (lane === 'anthropic') override(`${r}_MODEL`, model);
        else if (lane === 'openrouter') override(`${r}_MODEL_OPENROUTER`, model);
        else override(`${r}_MODEL_OPENAI`, model);
        override(`${r}_PROVIDER`, lane);
      }
      noteReasoningInherit(lane, model);
    };

    /** What Irises actually does about a thinking model on each lane — the heads-up below promises
     *  exactly this and nothing more. The starved retry lives in the OpenAI-compatible lanes
     *  (llm/callLLM.callOpenAICompatible; callAnthropic is untouched), and reasoning-disable is an
     *  OpenRouter body field (llm/openrouterRequest.ts) that the structured-output roles skip because
     *  it would narrow their provider filter. The Anthropic lane has neither, and says so. */
    const REASONING_MITIGATION: Record<'openrouter' | 'openai' | 'anthropic', string> = {
      openrouter: 'Irises retries a starved call once with a bigger cap and asks for reasoning off '
        + 'where the request allows it',
      openai: 'Irises retries a starved call once with a bigger cap (reasoning-disable is an '
        + 'OpenRouter-only field)',
      anthropic: 'neither of Irises\'s mitigations runs on the Anthropic lane — a starved call there '
        + 'falls back to another lane on a doubled budget instead',
    };

    /** One informational line when a voice role just inherited a model that reasons BY DEFAULT while
     *  that role asked for no thinking: chain-of-thought is billed against max_tokens, and these
     *  roles run deliberately tiny per-call caps (the climate eval's 200, validateDirective's 20), so
     *  the budget can go entirely to thinking. The mitigation clause is per LANE (see
     *  REASONING_MITIGATION) — this is the heads-up that says WHY, and names the opt-out. Log only;
     *  nothing here changes what was inherited. */
    function noteReasoningInherit(lane: 'openrouter' | 'openai' | 'anthropic', model: string): void {
      if (!isReasoningFamilyModel(model)) return;
      const unarmed = VOICE_ROLES.filter(
        r => !THINKING_ON_VALUES.includes((env[`${r}_THINKING`] || '').trim().toLowerCase()),
      );
      if (!unarmed.length) return;
      deps.log(
        `inherited model "${model}" is a reasoning-family slug, but ${unarmed.join(', ')}_THINKING `
        + 'is off — those roles run small per-call caps that a thinking model can spend before it '
        + `answers (${REASONING_MITIGATION[lane]}). `
        + 'Set ENGINE_MODEL_INHERIT=off to keep Irises\'s own voice models instead.',
      );
    }

    // ── Recognised provider (or a decisive api_mode from host config) → a specific lane ──
    // A readable api_mode is AUTHORITATIVE (it disambiguates a generic provider name like `custom`
    // that actually speaks the Anthropic Messages API), so it wins over the provider-name table.
    const openaiApiMode = apiMode === 'chat_completions' || apiMode === 'responses' || apiMode === 'codex_responses' || apiMode === 'openai';
    const anthropicHost = apiMode === 'anthropic' || (!apiMode && (p ? ANTHROPIC_PROVIDERS.has(p) : false));
    const openrouterHost = apiMode !== 'anthropic' && p === 'openrouter';
    const openaiHost = apiMode !== 'anthropic'
      && ((openaiApiMode && p !== 'openrouter') || (p !== 'openrouter' && OPENAI_COMPATIBLE_PROVIDERS.has(p)));
    const foreignHost = apiMode !== 'anthropic' && !openaiApiMode && (p ? FOREIGN_PROVIDERS.has(p) : false);

    if (anthropicHost) {
      // Honour a custom Anthropic-compatible gateway (the SDK reads ANTHROPIC_BASE_URL) + reuse key.
      if (opts?.apiKey) fill('ANTHROPIC_API_KEY', opts.apiKey, `reused from ${backend}`);
      if (opts?.baseUrl) fill('ANTHROPIC_BASE_URL', opts.baseUrl, `from ${backend}`);
      setLane('anthropic', CURATED_VOICE_MODEL.anthropic);
      deps.log(`engine provider anthropic → voice on ${CURATED_VOICE_MODEL.anthropic} (Anthropic lane)`);
      if (!has('ANTHROPIC_API_KEY') && !has('ANTHROPIC_AUTH_TOKEN')) deps.warn('voice set to the Anthropic lane but no ANTHROPIC_API_KEY is set — add one');
      return;
    }
    if (openrouterHost) {
      setLane('openrouter', CURATED_VOICE_MODEL.openrouter);
      deps.log(`engine provider openrouter → voice on ${CURATED_VOICE_MODEL.openrouter} (OpenRouter lane)`);
      if (!has('OPENROUTER_API_KEY')) deps.warn('voice set to the OpenRouter lane but no OPENROUTER_API_KEY is set — add one');
      return;
    }
    if (openaiHost) {
      const cfgUrl = (opts?.baseUrl || '').trim();
      const envUrl = (env.OPENAI_BASE_URL || '').trim();
      const baseUrl = cfgUrl || envUrl || PROVIDER_DEFAULT_BASE_URL[p] || (p === 'openai' ? 'https://api.openai.com/v1' : null);
      if (!baseUrl) {
        deps.warn(`engine model "${s}" runs on OpenAI-compatible provider "${p || apiMode}" but its base URL couldn't be resolved — set OPENAI_BASE_URL to inherit it; keeping Irises's own model defaults`);
        return;
      }
      const key = (opts?.apiKey || '').trim() || (env.OPENAI_API_KEY || '').trim() || null;
      if (key) fill('OPENAI_API_KEY', key, `reused from ${backend}`);
      // Only mark a non-default endpoint (an official-OpenAI host keeps the SDK/env default).
      if (baseUrl !== 'https://api.openai.com/v1') override('OPENAI_BASE_URL', baseUrl);
      // Official OpenAI → curated cheap model; any other OpenAI-compatible host → its own model slug.
      const model = p === 'openai' ? CURATED_VOICE_MODEL.openai : s;
      setLane('openai', model);
      deps.log(`engine provider ${p || 'openai-compatible'} (${baseUrl}) → voice on ${model} (OpenAI lane)`);
      if (!has('OPENAI_API_KEY')) deps.warn(`voice set to the OpenAI lane (${baseUrl}) but no OPENAI_API_KEY is set — add one`);
      return;
    }
    if (foreignHost) {
      // bedrock / vertex / gemini / copilot / nous / moa — the id is native to an auth/protocol none
      // of Irises's voice lanes can speak. Deep work still runs on it (engine-delegated); the voice
      // keeps a working fallback lane rather than taking a baseline offline.
      deps.log(`engine model "${s}" runs on provider "${p}", which Irises's voice cannot call directly — deep work still uses it; keeping Irises's own model defaults`);
      return;
    }

    // ── Unrecognised or no readable provider → slug-shape heuristic (preserves prior behaviour,
    //    the OpenClaw path) ──
    // A `/` is the de-facto aggregator slug shape, which the OpenRouter lane consumes verbatim; a
    // bare id is provider-native and unattributable — guessing there is the bug.
    if (!s.includes('/')) {
      deps.log(`engine model "${s}" is a bare provider-native id and no model.provider was readable, so its lane is unknown — keeping Irises's own model defaults`);
      return;
    }
    const hasOR = has('OPENROUTER_API_KEY');
    const hasAnthropic = has('ANTHROPIC_API_KEY');
    if (hasOR || !hasAnthropic) {
      setLane('openrouter', s);
      deps.log(`inheriting engine model "${s}" on all voice roles (OpenRouter lane)`);
      if (!hasOR) deps.warn(`inherited "${s}" but no OPENROUTER_API_KEY is set — add one so Irises's voice can use it`);
      return;
    }
    if (s.startsWith('anthropic/')) {
      const bare = s.slice('anthropic/'.length);
      setLane('anthropic', bare);
      deps.log(`inheriting engine model "${bare}" on all voice roles (Anthropic lane)`);
      deps.warn(`applied "${bare}" to the Anthropic lane as-is; if the API rejects it, set <ROLE>_MODEL to override`);
      return;
    }
    deps.warn(`engine model "${s}" needs OpenRouter but no OPENROUTER_API_KEY is set — keeping Irises defaults`);
  };

  // ── 2/3/4. per-backend creds, LLM key, and model ──────────────────────────
  if (backend === 'hermes') {
    const hermesEnv = deps.readFileText(hermesEnvPath);
    // cached: the yaml is the last rung of BOTH the model and the provider fallback chains
    let hermesYaml: string | null | undefined;
    const readHermesYaml = (): string | null => {
      if (hermesYaml === undefined) hermesYaml = deps.readFileText(hermesConfigPath);
      return hermesYaml;
    };
    fill(
      'HERMES_BASE_URL',
      hermesBaseUrl(
        hermesEnv && envFileValue(hermesEnv, 'API_SERVER_HOST'),
        hermesEnv && envFileValue(hermesEnv, 'API_SERVER_PORT'),
      ),
      'hermes default',
    );
    if (hermesEnv) {
      fill('HERMES_API_KEY', envFileValue(hermesEnv, 'API_SERVER_KEY'), 'from ~/.hermes/.env');
      fill('OPENROUTER_API_KEY', envFileValue(hermesEnv, 'OPENROUTER_API_KEY'), 'reused from hermes');
      fill('ANTHROPIC_API_KEY', envFileValue(hermesEnv, 'ANTHROPIC_API_KEY'), 'reused from hermes');
      // OpenAI-namespaced creds are reused ONLY into their own env vars, which the openai lane reads
      // directly (applyModel's openaiHost branch) — never folded into the shared model.* opts below,
      // so they can never leak onto the Anthropic/OpenRouter lanes.
      fill('OPENAI_API_KEY', envFileValue(hermesEnv, 'OPENAI_API_KEY'), 'reused from hermes');
      fill('OPENAI_BASE_URL', envFileValue(hermesEnv, 'OPENAI_BASE_URL'), 'reused from hermes');
    }
    // `hermes config get model.default` resolves aliases + the HERMES_MODEL env fallback correctly;
    // fall back to the .env var, then a crude config.yaml scan, if the CLI isn't on PATH.
    const slug = cliValue('hermes', ['config', 'get', 'model.default'])
      || cliValue('hermes', ['config', 'get', 'model.model'])
      || cliValue('hermes', ['config', 'get', 'model.name'])
      || (hermesEnv ? envFileValue(hermesEnv, 'HERMES_MODEL') : null)
      || scanYamlModel(readHermesYaml());
    const provider = cliValue('hermes', ['config', 'get', 'model.provider']) || scanYamlProvider(readHermesYaml());
    // `model.base_url` / `model.api_key` are the host's OWN config for its CURRENT provider — so they
    // are lane-appropriate (a custom Anthropic gateway for an anthropic host, the endpoint for an
    // openai-compatible host). Read config ONLY here (no OPENAI_* .env fallback), so the anthropic
    // branch can never receive a leftover OPENAI_BASE_URL/OPENAI_API_KEY; the openai lane still gets
    // those via env.OPENAI_* filled just above. model.api_mode is anthropic|chat_completions|….
    const baseUrl = cliValue('hermes', ['config', 'get', 'model.base_url']);
    const apiKey = cliValue('hermes', ['config', 'get', 'model.api_key']);
    const apiMode = cliValue('hermes', ['config', 'get', 'model.api_mode']);
    // Deep work always runs on THIS (the engine's own model) regardless of what the voice inherits —
    // capture it for the model map (src/llm/modelMap.ts) even when the provider is foreign.
    discoveredEngine = { backend, model: slug, provider };
    applyModel(slug, provider, { baseUrl, apiKey, apiMode });
    if (!has('OPENROUTER_API_KEY') && !has('ANTHROPIC_API_KEY')) {
      deps.warn('no ANTHROPIC_API_KEY or OPENROUTER_API_KEY found — add one so Irises\'s own voice can call an LLM');
    }
  } else if (backend === 'openclaw') {
    fill('OPENCLAW_URL', OPENCLAW_DEFAULT_URL, 'openclaw default');
    fill('OPENCLAW_TOKEN', readOpenclawToken(), 'from openclaw config');
    const agentId = env.OPENCLAW_AGENT_ID || 'main';
    // Prefer the model bound to the agent Irises delegates to, else the global default.
    const slug = cliValue('openclaw', ['config', 'get', `agents.entries.${agentId}.model`])
      || cliValue('openclaw', ['config', 'get', 'agents.defaults.model.primary'])
      || cliValue('openclaw', ['config', 'get', 'agents.defaults.model']);
    // OpenClaw binds models as `provider/model` slugs — there is no separate provider key to read, so
    // the slug-shape heuristic in applyModel routes it (as before). Auto openai-lane inheritance is
    // hermes-focused; an OpenClaw user on an obscure API can set <ROLE>_PROVIDER=openai + OPENAI_*.
    discoveredEngine = { backend, model: slug, provider: null };
    applyModel(slug, null);
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

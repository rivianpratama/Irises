// Discovery tests: engine detection → OPS_BACKEND, cred/key fill, and the engine→Irises model
// inheritance mapping — all over injected fs/CLI stubs (no real filesystem or child processes), and
// against fresh plain-object envs so nothing touches the real process.env.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEngineDiscovery, envFileValue, scanYamlModel, scanYamlProvider, getDiscoveredEngine, isReasoningFamilyModel, type DiscoveryDeps } from './engineDiscovery.js';

const HERMES_ENV = '/home/user/.hermes/.env';
const HERMES_YAML = '/home/user/.hermes/config.yaml';

interface World {
  files?: Record<string, string>;
  cli?: Record<string, string>;
  home?: string;
}

function mkDeps(
  env: Record<string, string | undefined>,
  world: World = {},
  protectedKeys: string[] = [],
): { deps: DiscoveryDeps; logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  const files = world.files ?? {};
  const cli = world.cli ?? {};
  const deps: DiscoveryDeps = {
    env,
    protectedKeys: new Set(protectedKeys),
    homedir: () => world.home ?? '/home/user',
    fileExists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileText: (p) => (p in files ? files[p] : null),
    runCli: (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      return key in cli ? cli[key] : null;
    },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
  return { deps, logs, warns };
}

// A committed-baseline env like deploy/app.env: models pre-set (so inheritance must OVERRIDE them).
function baselineEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    CONVO_PROVIDER: 'openrouter', CONVO_MODEL: 'claude-sonnet-5', CONVO_MODEL_OPENROUTER: 'openai/gpt-5.6-luna:nitro',
    CLASSIFY_PROVIDER: 'openrouter', CLASSIFY_MODEL: 'claude-sonnet-4-6', CLASSIFY_MODEL_OPENROUTER: 'openai/gpt-5.6-luna:nitro',
    FALLFIRM_PROVIDER: 'openrouter', FALLFIRM_MODEL: 'claude-sonnet-4-6', FALLFIRM_MODEL_OPENROUTER: 'openai/gpt-5.6-luna:nitro',
    ...extra,
  };
}

test('hermes-only: detects backend, fills creds/key, inherits model on ALL roles (OpenRouter lane)', () => {
  const env = baselineEnv();
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk-hermes\nOPENROUTER_API_KEY=or-key\n' },
    cli: { 'hermes config get model.default': 'anthropic/claude-opus-4.6' },
  });
  applyEngineDiscovery(deps);

  assert.equal(env.OPS_BACKEND, 'hermes');
  assert.equal(env.HERMES_BASE_URL, 'http://127.0.0.1:8642');
  assert.equal(env.HERMES_API_KEY, 'sk-hermes');
  assert.equal(env.OPENROUTER_API_KEY, 'or-key');
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL_OPENROUTER`], 'anthropic/claude-opus-4.6', `${r} openrouter slot`);
    assert.equal(env[`${r}_PROVIDER`], 'openrouter', `${r} provider`);
  }
});

test('model inheritance OVERRIDES the committed baseline model', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'anthropic/claude-opus-4.6' },
  });
  applyEngineDiscovery(deps);
  // baseline had openai/gpt-5.6-luna:nitro — must now be the engine's model
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'anthropic/claude-opus-4.6');
});

test('openclaw-only: token + per-agent model via CLI', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    cli: {
      'openclaw config get gateway.auth.token': 'gw-tok',
      'openclaw config get agents.entries.main.model': 'anthropic/claude-opus-5',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'openclaw');
  assert.equal(env.OPENCLAW_URL, 'ws://127.0.0.1:18789');
  assert.equal(env.OPENCLAW_TOKEN, 'gw-tok');
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'anthropic/claude-opus-5');
});

test('openclaw: falls back to global default model when no per-agent binding', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    cli: {
      'openclaw config get gateway.auth.token': 'gw-tok',
      'openclaw config get agents.defaults.model.primary': 'openai/gpt-5.6-sol',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-sol');
});

test('both engines present → hermes wins the tie-break', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'anthropic/claude-opus-4.6',
      'openclaw config get gateway.auth.token': 'gw-tok',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'hermes');
});

test('no engine detected → no-op, OPS_BACKEND stays unset', () => {
  const env = baselineEnv();
  const { deps, logs } = mkDeps(env, {});
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, undefined);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // untouched
  assert.ok(logs.some((l) => l.includes('no engine detected')));
});

test('explicit OPS_BACKEND is respected; shell-protected model vars are NOT overridden', () => {
  const env = baselineEnv({ OPS_BACKEND: 'hermes', OPENROUTER_API_KEY: 'or-key', CONVO_MODEL_OPENROUTER: 'user/pinned-model' });
  const { deps } = mkDeps(
    env,
    {
      files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
      cli: { 'hermes config get model.default': 'anthropic/claude-opus-4.6' },
    },
    ['OPS_BACKEND', 'CONVO_MODEL_OPENROUTER'], // exported in the real shell
  );
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'hermes');
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'user/pinned-model'); // protected
  // a non-protected role still inherits
  assert.equal(env.CLASSIFY_MODEL_OPENROUTER, 'anthropic/claude-opus-4.6');
});

test('Anthropic-only deployment: anthropic/<x> maps to the bare Anthropic-lane slug + warns', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' }); // no OpenRouter key
  const { deps, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'anthropic/claude-opus-4.6' },
  });
  applyEngineDiscovery(deps);
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL`], 'claude-opus-4.6', `${r} anthropic slot`);
    assert.equal(env[`${r}_PROVIDER`], 'anthropic', `${r} provider`);
  }
  assert.ok(warns.some((w) => w.includes('Anthropic lane')));
});

test('Anthropic-only + non-anthropic slug → cannot map, keeps defaults + warns', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'openai/gpt-5.6-sol' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // unchanged
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5'); // unchanged
  assert.ok(warns.some((w) => w.includes('needs OpenRouter')));
});

// ── provider-aware lane routing ─────────────────────────────────────────────
// hermes stores a PROVIDER-NATIVE id in model.default plus the provider in model.provider, so the id
// alone cannot say which lane can call it. Guessing from whichever API key happened to be present put
// e.g. `claude-sonnet-4-5-20250929` or `gpt-4o` on the OpenRouter lane, which 400s every voice turn —
// auto-detection breaking an install that worked before it ran.

test('provider openrouter → OpenRouter lane, curated cheap voice model (not the host deep-work slug)', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key', ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'anthropic/claude-opus-4.6',
      'hermes config get model.provider': 'openrouter',
    },
  });
  applyEngineDiscovery(deps);
  // The voice keeps a cheap, fast model on the host's provider — NOT the engine's big deep-work slug.
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL_OPENROUTER`], 'deepseek/deepseek-v4-flash:nitro', `${r} openrouter slot`);
    assert.equal(env[`${r}_PROVIDER`], 'openrouter', `${r} provider`);
  }
});

test('provider anthropic → Anthropic lane, curated cheap voice model (NOT the host deep-work slug, NOT OpenRouter)', () => {
  // An OPENROUTER_API_KEY is present (hermes's headline aggregator); the voice must still land on the
  // Anthropic lane (its provider), on the curated cheap model rather than the engine's big slug.
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key', ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'claude-sonnet-4-5-20250929',
      'hermes config get model.provider': 'anthropic',
    },
  });
  applyEngineDiscovery(deps);
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL`], 'claude-sonnet-5', `${r} anthropic slot`);
    assert.equal(env[`${r}_PROVIDER`], 'anthropic', `${r} provider`);
  }
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // OpenRouter slot untouched
});

test('provider anthropic + an anthropic/-prefixed slug → curated Anthropic voice model', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'anthropic/claude-opus-4.6',
      'hermes config get model.provider': 'anthropic',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5');
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
});

// Not directly reachable this config → shipped defaults kept. moa/copilot are foreign auth/protocols;
// azure-foundry is OpenAI-compatible but keeps defaults here because no base URL is resolvable (a
// separate test covers azure-foundry WITH a base URL inheriting via the openai lane).
for (const [provider, model] of [['azure-foundry', 'gpt-4o'], ['moa', 'default'], ['copilot', 'claude-sonnet-4.6']]) {
  test(`provider ${provider} → not directly reachable, shipped defaults kept, one line naming it`, () => {
    const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
    const { deps, logs, warns } = mkDeps(env, {
      files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
      cli: {
        'hermes config get model.default': model,
        'hermes config get model.provider': provider,
      },
    });
    applyEngineDiscovery(deps);
    assert.equal(env.OPS_BACKEND, 'hermes');          // detection/creds still happen
    assert.equal(env.HERMES_API_KEY, 'k');
    for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
      assert.equal(env[`${r}_MODEL_OPENROUTER`], 'openai/gpt-5.6-luna:nitro', `${r} openrouter slot`);
      assert.equal(env[`${r}_MODEL`], baselineEnv()[`${r}_MODEL`], `${r} anthropic slot`);
      assert.equal(env[`${r}_PROVIDER`], 'openrouter', `${r} provider`);
    }
    const line = [...logs, ...warns].find((l) => l.includes(model) && l.includes(provider));
    assert.ok(line, `a line names the model and the provider: ${JSON.stringify({ logs, warns })}`);
    assert.ok(line!.includes('keeping Irises'), 'and says the defaults were kept');
  });
}

// ── the generic openai lane: reaching an arbitrary OpenAI-compatible host ────

test('provider openai → OpenAI lane, curated cheap model, host key reused, DEFAULT endpoint (no marker)', () => {
  const env = baselineEnv();
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\nOPENAI_API_KEY=sk-openai\n' },
    cli: { 'hermes config get model.default': 'gpt-5.6-terra', 'hermes config get model.provider': 'openai' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPENAI_API_KEY, 'sk-openai');   // reused from ~/.hermes/.env
  assert.equal(env.OPENAI_BASE_URL, undefined);    // official OpenAI → SDK/default endpoint, no marker
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL_OPENAI`], 'gpt-5.6-luna', `${r} openai slot (curated cheap)`);
    assert.equal(env[`${r}_PROVIDER`], 'openai', `${r} provider`);
  }
});

test('OpenAI-compatible host (deepseek) with model.base_url + model.api_key → openai lane at the host endpoint, host model', () => {
  const env = baselineEnv();
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'deepseek-chat',
      'hermes config get model.provider': 'deepseek',
      'hermes config get model.base_url': 'https://api.deepseek.com/v1',
      'hermes config get model.api_key': 'sk-deepseek',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com/v1'); // host endpoint inherited
  assert.equal(env.OPENAI_API_KEY, 'sk-deepseek');                  // host key reused
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL_OPENAI`], 'deepseek-chat', `${r} openai slot (host's own model, no curated slug for deepseek)`);
    assert.equal(env[`${r}_PROVIDER`], 'openai', `${r} provider`);
  }
});

test('OpenAI-compatible host with NO resolvable base URL → keeps defaults + warns to set OPENAI_BASE_URL', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'foundry-model', 'hermes config get model.provider': 'azure-foundry' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // unchanged
  assert.ok(warns.some((w) => w.includes('OPENAI_BASE_URL') && w.includes('keeping Irises')));
});

test('api_mode anthropic is authoritative → Anthropic lane even without a provider name', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'some-messages-api-model',
      'hermes config get model.api_mode': 'anthropic',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5'); // curated
});

test('getDiscoveredEngine captures the host deep-work model + provider (even for a foreign provider)', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'anthropic.claude-v2', 'hermes config get model.provider': 'bedrock' },
  });
  applyEngineDiscovery(deps);
  const eng = getDiscoveredEngine();
  assert.equal(eng?.backend, 'hermes');
  assert.equal(eng?.model, 'anthropic.claude-v2');
  assert.equal(eng?.provider, 'bedrock');
  assert.equal(env.CONVO_PROVIDER, 'openrouter'); // foreign → voice keeps its shipped default lane
});

test('anthropic host with a leftover OPENAI_BASE_URL in ~/.hermes/.env does NOT leak into ANTHROPIC_BASE_URL', () => {
  // Regression: the OpenAI-namespaced .env fallback must never reach the anthropic branch, or a
  // stale OPENAI_BASE_URL points the Anthropic Messages lane at an OpenAI endpoint (404 every turn).
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\nOPENAI_BASE_URL=https://api.deepseek.com/v1\n' },
    cli: {
      'hermes config get model.default': 'claude-sonnet-4-5-20250929',
      'hermes config get model.provider': 'anthropic', // no model.base_url — api.anthropic.com
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);            // the OpenAI leftover must NOT leak here
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5');
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com/v1'); // reused into its OWN var, harmless
});

test('a custom Anthropic gateway (model.base_url on an anthropic host) DOES set ANTHROPIC_BASE_URL', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'claude-opus-4.6',
      'hermes config get model.provider': 'anthropic',
      'hermes config get model.base_url': 'https://anthropic.gw.example/v1',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://anthropic.gw.example/v1');
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
});

test('api_mode anthropic wins over an OpenAI-compatible provider NAME (custom) → Anthropic lane', () => {
  const env = baselineEnv({ ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: {
      'hermes config get model.default': 'claude-via-custom-gateway',
      'hermes config get model.provider': 'custom',    // in OPENAI_COMPATIBLE_PROVIDERS…
      'hermes config get model.api_mode': 'anthropic',  // …but actually speaks the Messages API
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5');
  assert.equal(env.CONVO_MODEL_OPENAI, undefined); // NOT misrouted to the openai lane
});

test('openai lane inherits OPENAI_BASE_URL from ~/.hermes/.env when model.base_url is unset', () => {
  const env = baselineEnv();
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\nOPENAI_API_KEY=sk-x\nOPENAI_BASE_URL=https://vllm.internal/v1\n' },
    cli: {
      'hermes config get model.default': 'my-local-model',
      'hermes config get model.provider': 'custom', // OpenAI-compatible; endpoint comes from .env
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPENAI_BASE_URL, 'https://vllm.internal/v1');
  assert.equal(env.OPENAI_API_KEY, 'sk-x');
  for (const r of ['CONVO', 'CLASSIFY', 'FALLFIRM']) {
    assert.equal(env[`${r}_MODEL_OPENAI`], 'my-local-model');
    assert.equal(env[`${r}_PROVIDER`], 'openai');
  }
});

test('a bare un-slashed id with no readable provider → no inheritance, defaults kept', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, logs } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'gpt-4o' }, // no model.provider anywhere
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro');
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5');
  assert.ok(logs.some((l) => l.includes('gpt-4o') && l.includes('lane is unknown')));
});

test('the provider comes from the config.yaml sibling key when the CLI is unavailable', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key', ANTHROPIC_API_KEY: 'ak' });
  const { deps } = mkDeps(env, {
    files: {
      [HERMES_ENV]: 'API_SERVER_KEY=k\n',
      [HERMES_YAML]: 'terminal:\n  backend: tmux\nmodel:\n  provider: anthropic\n  default: claude-sonnet-5\n',
    },
    cli: {},
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL, 'claude-sonnet-5');
  assert.equal(env.CONVO_PROVIDER, 'anthropic');
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro');
});

// ── HERMES_BASE_URL from the engine's own bind settings ─────────────────────

test('HERMES_BASE_URL follows API_SERVER_PORT/HOST from ~/.hermes/.env', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\nAPI_SERVER_HOST=192.168.1.9\nAPI_SERVER_PORT=9642\n' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.HERMES_BASE_URL, 'http://192.168.1.9:9642');
});

test('HERMES_BASE_URL: a wildcard bind dials loopback, a bare port keeps the default host', () => {
  const wild = baselineEnv();
  const { deps: d1 } = mkDeps(wild, { files: { [HERMES_ENV]: 'API_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=9000\n' } });
  applyEngineDiscovery(d1);
  assert.equal(wild.HERMES_BASE_URL, 'http://127.0.0.1:9000');

  const portOnly = baselineEnv();
  const { deps: d2 } = mkDeps(portOnly, { files: { [HERMES_ENV]: 'API_SERVER_PORT=9000\n' } });
  applyEngineDiscovery(d2);
  assert.equal(portOnly.HERMES_BASE_URL, 'http://127.0.0.1:9000');

  const stock = baselineEnv();
  const { deps: d3 } = mkDeps(stock, { files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' } });
  applyEngineDiscovery(d3);
  assert.equal(stock.HERMES_BASE_URL, 'http://127.0.0.1:8642');
});

test('an explicit HERMES_BASE_URL still wins over the engine\'s bind settings', () => {
  const env = baselineEnv({ HERMES_BASE_URL: 'http://hermes.local:7000' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\nAPI_SERVER_PORT=9642\n' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.HERMES_BASE_URL, 'http://hermes.local:7000');
});

test('engine detected but model unreadable → warns, keeps model defaults, still sets backend/creds', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\n' },
    cli: {}, // no model reads succeed
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'hermes');
  assert.equal(env.HERMES_API_KEY, 'sk');
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // unchanged
  assert.ok(warns.some((w) => w.includes('could not read the engine model')));
});

test('ENGINE_MODEL_INHERIT=off disables model inheritance but keeps detection/creds', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key', ENGINE_MODEL_INHERIT: 'off' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\n' },
    cli: { 'hermes config get model.default': 'anthropic/claude-opus-4.6' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'hermes');
  assert.equal(env.HERMES_API_KEY, 'sk');
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // NOT inherited
});

test('hermes model via HERMES_MODEL .env fallback when the CLI is unavailable', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\nHERMES_MODEL=anthropic/claude-opus-4.6\n' },
    cli: {}, // no hermes CLI
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'anthropic/claude-opus-4.6');
});

test('hermes model via config.yaml scan when neither CLI nor HERMES_MODEL is present', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: {
      [HERMES_ENV]: 'API_SERVER_KEY=sk\n',
      [HERMES_YAML]: 'terminal:\n  backend: tmux\nmodel:\n  provider: auto\n  default: "anthropic/claude-opus-4.6"\n',
    },
    cli: {},
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'anthropic/claude-opus-4.6');
});

test('OPS_BACKEND=off forces the debug/offline path — no detection, creds, or model inheritance, even with an engine present', () => {
  const env = baselineEnv({ OPS_BACKEND: 'off', OPENROUTER_API_KEY: 'or-key' });
  const { deps, logs } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\n' },       // engine IS installed…
    cli: {
      'hermes config get model.default': 'anthropic/claude-opus-4.6',
      'openclaw config get gateway.auth.token': 'gw-tok',
    },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, 'off');                    // …but we stay off
  assert.equal(env.HERMES_API_KEY, undefined);             // no creds derived
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // model untouched
  assert.ok(logs.some((l) => l.includes('debug/standalone')));
});

test('a null-ish CLI model value (e.g. "None") is not inherited', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\n' },
    cli: { 'hermes config get model.default': 'None' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna:nitro'); // unchanged
  assert.ok(warns.some((w) => w.includes('could not read the engine model')));
});

test('a CLI that prints "undefined" for an unset key does NOT short-circuit the fallback chain', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=sk\nHERMES_MODEL=anthropic/claude-opus-4.6\n' },
    // A truthy null-ish literal at rung 1 used to stop the `||` chain dead, so the .env fallback
    // (and the config.yaml scan below it) were never reached — the real model was right there.
    cli: { 'hermes config get model.default': 'undefined' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'anthropic/claude-opus-4.6');
});

test('an "undefined" openclaw token is not a token — detection falls through to "no engine"', () => {
  const env = baselineEnv();
  const { deps, logs } = mkDeps(env, { cli: { 'openclaw config get gateway.auth.token': 'null' } });
  applyEngineDiscovery(deps);
  assert.equal(env.OPS_BACKEND, undefined);
  assert.ok(logs.some((l) => l.includes('no engine detected')));
});

// ── pure helpers ────────────────────────────────────────────────────────────

test('envFileValue: quotes, export prefix, last-assignment-wins', () => {
  const text = 'export API_SERVER_KEY="abc"\nOPENROUTER_API_KEY=or1\nOPENROUTER_API_KEY=or2\nEMPTY=\n';
  assert.equal(envFileValue(text, 'API_SERVER_KEY'), 'abc');
  assert.equal(envFileValue(text, 'OPENROUTER_API_KEY'), 'or2');
  assert.equal(envFileValue(text, 'EMPTY'), null);
  assert.equal(envFileValue(text, 'MISSING'), null);
});

test('envFileValue: a trailing inline comment is stripped from an unquoted value, kept inside quotes', () => {
  // Unstripped, this shipped as `Authorization: Bearer sk-abc # hermes api server` — a well-formed
  // header, so no throw, just a permanent 401 pointing the operator at HERMES_API_KEY.
  assert.equal(envFileValue('API_SERVER_KEY=sk-abc123 # hermes api server\n', 'API_SERVER_KEY'), 'sk-abc123');
  assert.equal(envFileValue('API_SERVER_KEY=sk-abc123\t# note\n', 'API_SERVER_KEY'), 'sk-abc123');
  // A `#` with no leading whitespace is part of the value (dotenv's own rule), and a quoted value is
  // taken whole — some keys legitimately contain one.
  assert.equal(envFileValue('K=abc#123\n', 'K'), 'abc#123');
  assert.equal(envFileValue('K="abc # still mine"\n', 'K'), 'abc # still mine');
  assert.equal(envFileValue('K= # only a comment\n', 'K'), null);
});

test('scanYamlModel: inline and nested block forms, ignores unrelated top-level model-ish keys', () => {
  assert.equal(scanYamlModel('model: "anthropic/claude-opus-4.6"'), 'anthropic/claude-opus-4.6');
  assert.equal(scanYamlModel('model:\n  provider: auto\n  default: anthropic/claude-opus-4.6\n'), 'anthropic/claude-opus-4.6');
  assert.equal(scanYamlModel('model:\n  name: openai/gpt-5.6-sol # comment\n'), 'openai/gpt-5.6-sol');
  assert.equal(scanYamlModel('other:\n  model: nested/should-not-leak\n'), null);
  assert.equal(scanYamlModel(null), null);
});

test('scanYamlProvider: the provider sibling, and nothing from the inline scalar form', () => {
  assert.equal(scanYamlProvider('model:\n  provider: azure-foundry\n  default: gpt-4o\n'), 'azure-foundry');
  assert.equal(scanYamlProvider('model:\n  default: gpt-4o\n  provider: moa # local preset\n'), 'moa');
  assert.equal(scanYamlProvider('model:\n  provider: "anthropic"\n'), 'anthropic');
  assert.equal(scanYamlProvider('model: "anthropic/claude-opus-4.6"'), null); // a scalar has no sibling
  assert.equal(scanYamlProvider('other:\n  provider: nested-should-not-leak\n'), null);
  assert.equal(scanYamlProvider(null), null);
});

// ── Reasoning-family inheritance heads-up (informational; no behavior change) ─
// The live failure this names: the engine's model lands on every voice role, and a reasoning-family
// slug thinks BY DEFAULT while CONVO/CLASSIFY/FALLFIRM_THINKING are all off — so the small per-call
// caps (classify's 20, the climate eval's 200) go to thinking and the call comes back empty.

test('isReasoningFamilyModel: the four families, and the slugs that must NOT match', () => {
  for (const slug of [
    'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash:nitro', 'deepseek/deepseek-r1',
    'openai/o1', 'openai/o3-mini', 'o4-mini', 'qwen/qwen3-235b-thinking', 'google/gemini-3-pro-thinking:free',
  ]) {
    assert.equal(isReasoningFamilyModel(slug), true, `${slug} reasons by default`);
  }
  for (const slug of [
    'openai/gpt-5.6-luna', 'openai/gpt-5.6-luna:nitro', 'anthropic/claude-opus-4.8', 'claude-sonnet-5',
    'openai/gpt-4o', 'deepseek/deepseek-v3', 'meta-llama/llama-4-scout', 'mistralai/mistral-large',
  ]) {
    assert.equal(isReasoningFamilyModel(slug), false, `${slug} is not a reasoning-family slug`);
  }
});

test('inheriting a reasoning-family model with thinking off logs one heads-up naming the opt-out', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, logs } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'deepseek/deepseek-v4-flash' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'deepseek/deepseek-v4-flash', 'still inherited — log only');
  const lines = logs.filter((l) => l.includes('reasoning-family'));
  assert.equal(lines.length, 1, 'exactly one heads-up');
  assert.match(lines[0], /deepseek\/deepseek-v4-flash/);
  assert.match(lines[0], /CONVO, CLASSIFY, FALLFIRM/, 'names the roles whose thinking is off');
  assert.match(lines[0], /ENGINE_MODEL_INHERIT=off/, 'names the opt-out');
});

test('a non-reasoning inherited model logs no heads-up', () => {
  const env = baselineEnv({ OPENROUTER_API_KEY: 'or-key' });
  const { deps, logs, warns } = mkDeps(env, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'openai/gpt-5.6-luna' },
  });
  applyEngineDiscovery(deps);
  assert.equal(env.CONVO_MODEL_OPENROUTER, 'openai/gpt-5.6-luna');
  assert.equal([...logs, ...warns].filter((l) => l.includes('reasoning-family')).length, 0);
});

test('the heads-up skips a role whose own <ROLE>_THINKING is armed, and goes silent when all are', () => {
  const armed = baselineEnv({ OPENROUTER_API_KEY: 'or-key', CLASSIFY_THINKING: 'on' });
  const one = mkDeps(armed, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'deepseek/deepseek-v4-flash' },
  });
  applyEngineDiscovery(one.deps);
  const line = one.logs.find((l) => l.includes('reasoning-family'));
  assert.ok(line);
  assert.match(line!, /CONVO, FALLFIRM/);
  assert.equal(/CLASSIFY/.test(line!), false, 'a role that armed thinking asked for this');

  const all = baselineEnv({
    OPENROUTER_API_KEY: 'or-key', CONVO_THINKING: 'true', CLASSIFY_THINKING: 'adaptive', FALLFIRM_THINKING: '1',
  });
  const every = mkDeps(all, {
    files: { [HERMES_ENV]: 'API_SERVER_KEY=k\n' },
    cli: { 'hermes config get model.default': 'deepseek/deepseek-v4-flash' },
  });
  applyEngineDiscovery(every.deps);
  assert.equal(every.logs.filter((l) => l.includes('reasoning-family')).length, 0);
});

// Discovery tests: engine detection → OPS_BACKEND, cred/key fill, and the engine→Irises model
// inheritance mapping — all over injected fs/CLI stubs (no real filesystem or child processes), and
// against fresh plain-object envs so nothing touches the real process.env.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEngineDiscovery, envFileValue, scanYamlModel, type DiscoveryDeps } from './engineDiscovery.js';

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

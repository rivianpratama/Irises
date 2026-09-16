// Run with: npm test   (scripts/**/*.test.ts is in the test glob). NOTHING HERE CONFIGURES ANYTHING
// on this machine: every run either stops in the argument parser (exit 2, before the script has
// opened a single file) or runs inside a throwaway HOME / IRISES_ROOT / IRISES_HOME / HERMES_HOME
// (see `sandbox()`, lifted from engine-setup.test.ts). What is covered here is the ARGUMENT and
// EXIT-CODE contract plus the read-only `--show` report — the parts an operator, the menu and a
// wrapping script depend on, and that a rewrite silently changes. Applying settings is covered by
// its own tests and by scripts/e2e/lifecycle-sandbox.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'configure.sh');

function run(args: string[], extraEnv: Record<string, string> = {}): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

/**
 * A throwaway everything, exactly as engine-setup.test.ts builds one and for the same reason:
 * IRISES_HOME alone is NOT a sandbox. `service_installed` reads $HOME/.config/systemd/user/… and
 * $HOME/Library/LaunchAgents/…, and `engine_kind` reads the CLONE's .env OPS_BACKEND — so all four
 * roots move into one mkdtemp dir and the fixture .env pins OPS_BACKEND=off, and no engine is
 * detected, contacted or bounced.
 *
 * `envBody` null makes a clone with NO .env at all: the never-installed case `--show` must survive.
 * The fixture root holds a .env and nothing else, which is also what proves the documented-key
 * lookup falls back to this script's own clone for .env.example / deploy/app.env.
 */
function sandbox(envBody: string | null = 'OPS_BACKEND=off\nPORT=3999\n'): {
  env: Record<string, string>;
  root: string;
  state: string;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'irises-configure-'));
  const home = join(tmp, 'home');
  const state = join(tmp, 'state');
  const root = join(tmp, 'root');
  for (const d of [home, state, root]) mkdirSync(d, { recursive: true });
  if (envBody !== null) writeFileSync(join(root, '.env'), envBody);
  return {
    root,
    state,
    env: {
      HOME: home,
      IRISES_HOME: state,
      IRISES_ROOT: root,
      HERMES_HOME: join(tmp, 'hermes'),
    },
  };
}

/**
 * …and the one box the sandbox cannot reach. On Windows `service_installed` runs
 * `schtasks //Query //TN Irises` against a machine-wide registry that no HOME redirects, so the two
 * tests that render the full `--show` report (the only ones that probe the service at all) carry
 * this gate. The argument-and-exit-code tests never get that far and stay unconditional.
 */
const SKIP_ON_WINDOWS = {
  skip:
    process.platform === 'win32'
      ? 'the service probe reaches Task Scheduler, which the sandbox cannot scope'
      : false,
};

/** Every flag the parser accepts. --help is the only documentation an operator gets for them. */
const FLAGS = [
  '--show',
  '--port',
  '--service',
  '--front',
  '--model-lane',
  '--model-slug',
  '--model-base-url',
  '--model-inherit',
  '--web',
  '--tz',
  '--set',
  '--unset',
  '--allow-unknown',
  '--yes',
  '-y',
  '--no-restart',
  '--no-gateway-restart',
  '-h',
  '--help',
];

test('--help documents every flag and the exit-code table, and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of FLAGS) assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  assert.match(r.out, /RESULT:/, 'the machine-readable last line is part of the contract');
  for (const token of ['ok', 'noop', 'health-failed', 'gateway-failed', 'partial']) {
    assert.ok(r.out.includes(token), `--help must name the RESULT token ${token}\n${r.out}`);
  }
  for (const row of ['0 ', '1 ', '2 ', '4 ', '5 ']) assert.ok(r.out.includes(row), `${r.out}`);
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
});

test('the exit-code table is documented in the header', () => {
  const r = run(['--help']);
  assert.match(r.out, /2[^\n]*usage/i);
  assert.match(r.out, /4[^\n]*health/i);
  assert.match(r.out, /5[^\n]*gateway/i);
});

test('an unknown flag exits 2 and prints no RESULT line', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--frobnicate/);
  assert.match(r.err, /--help/);
  assert.ok(!r.out.includes('RESULT:'), `a usage error changed nothing and reports nothing:\n${r.out}`);
});

test("--set with a secret's value on argv exits 2 and names IRISES_SET_VALUE", () => {
  // argv is readable by every other process on the box (ps, /proc) and lands in shell history.
  const r = run(['--set', 'OPENAI_API_KEY=x', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /IRISES_SET_VALUE/);
  assert.match(r.err, /OPENAI_API_KEY/);
});

test('--set of an undocumented key exits 2 without --allow-unknown and passes with it', () => {
  // Not a *_KEY name: that would be refused one rule earlier, for carrying a secret on argv.
  const box = sandbox();
  const refused = run(['--set', 'NOT_A_REAL_SETTING=1', '--no-restart', '--yes'], box.env);
  assert.equal(refused.code, 2, `${refused.out}\n${refused.err}`);
  assert.match(refused.err, /--allow-unknown/);
  assert.match(refused.err, /NOT_A_REAL_SETTING/);
  // With the escape hatch the key is no longer a USAGE error — validation is what this task owns,
  // so all that matters is that exit 2 is gone.
  const allowed = run(['--set', 'NOT_A_REAL_SETTING=1', '--allow-unknown', '--no-restart', '--yes'], box.env);
  assert.notEqual(allowed.code, 2, `--allow-unknown must clear the usage error:\n${allowed.err}`);
});

test('--set PORT=1 exits 2 and points at --port', () => {
  const r = run(['--set', 'PORT=1', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--port/);
});

test('--unset IRISES_HOME exits 2', () => {
  // The service unit embeds it; a clone .env edit would move the data out from under a running unit.
  const r = run(['--unset', 'IRISES_HOME', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /IRISES_HOME/);
});

test('--set ENGINE_PUSH_TOKEN exits 2 and points at the install', () => {
  const r = run(['--set', 'ENGINE_PUSH_TOKEN', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /engine-setup\.sh/);
});

test('--port abc exits 2', () => {
  const r = run(['--port', 'abc', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--port/);
});

test('--port 70000 exits 2', () => {
  const r = run(['--port', '70000', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /65535/);
});

test('--service maybe exits 2', () => {
  const r = run(['--service', 'maybe', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--service/);
});

test('--web sometimes exits 2', () => {
  const r = run(['--web', 'sometimes', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--web/);
});

test('--front "bad pattern" exits 2', () => {
  // The engine fronts NOTHING for an IRISES_FRONT it cannot parse, which looks exactly like a
  // configure run that silently did not work.
  const r = run(['--front', 'bad pattern', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--front/);
});

test('--front none passes validation', () => {
  const box = sandbox();
  const r = run(['--front', 'none', '--no-restart', '--yes'], box.env);
  assert.notEqual(r.code, 2, `none is how you front nothing:\n${r.err}`);
});

test('--model-slug x without a lane exits 2', () => {
  const r = run(['--model-slug', 'x', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--model-lane/);
});

test('--model-lane openai --model-slug m without a base URL exits 2', () => {
  const r = run(['--model-lane', 'openai', '--model-slug', 'm', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--model-base-url/);
});

test('--model-inherit with --model-lane exits 2', () => {
  const r = run(['--model-inherit', '--model-lane', 'anthropic', '--model-slug', 'm', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--model-inherit/);
});

test('a bare --set KEY without IRISES_SET_VALUE exits 2', () => {
  const box = sandbox();
  const r = run(['--set', 'CONVO_EFFORT', '--no-restart', '--yes'], { ...box.env, IRISES_SET_VALUE: '' });
  assert.equal(r.code, 2, `${r.out}\n${r.err}`);
  assert.match(r.err, /IRISES_SET_VALUE/);
});

test('two bare --set keys exit 2', () => {
  // One environment variable cannot carry two values.
  const r = run(['--set', 'CONVO_EFFORT', '--set', 'WEB_ENABLED', '--yes'], { IRISES_SET_VALUE: 'x' });
  assert.equal(r.code, 2);
  assert.match(r.err, /--set/);
});

test('no flags exit 2 and point at --show', () => {
  const r = run([], { IRISES_DASHBOARD_PASSWORD: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /--show/);
  assert.ok(!r.out.includes('RESULT:'), `${r.out}`);
});

test('--show with --tz UTC exits 2', () => {
  // A report and a write are opposite requests; running both would print a report of the OLD values
  // and then change them.
  const r = run(['--show', '--tz', 'UTC']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--show/);
});

test('IRISES_MODEL_API_KEY without --model-lane is warned about and ignored, not refused', () => {
  // The installer does exactly this. Refusing would make a shell that exports the key for one
  // command unable to run any other configure command.
  const box = sandbox();
  const r = run(['--tz', 'UTC', '--no-restart', '--yes'], { ...box.env, IRISES_MODEL_API_KEY: 'sk-not-a-key' });
  assert.notEqual(r.code, 2, `${r.out}\n${r.err}`);
  assert.match(r.err, /ignored/i);
  assert.ok(!r.out.includes('sk-not-a-key'), 'the key is named, never printed');
  assert.ok(!r.err.includes('sk-not-a-key'), 'the key is named, never printed');
});

test('--show in a sandbox prints every setting, masks a lane key and never prints its value', SKIP_ON_WINDOWS, () => {
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nOPENROUTER_API_KEY=zzz-not-a-key\nIRISES_TZ=UTC\nWEB_ENABLED=false\n');
  const r = run(['--show'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  for (const needle of [
    'port:',
    '3999',
    'service:',
    'build:',
    'manifest:',
    'engine:',
    'fronts:',
    'voice model:',
    'inherited',
    'browser chat:',
    'off',
    'timezone:',
    'UTC',
    'dashboard password:',
    'lane keys:',
    'OPENROUTER_API_KEY <set>',
    'data:',
    'RESULT: ok',
  ]) {
    assert.ok(r.out.includes(needle), `--show must report ${needle}\n${r.out}`);
  }
  assert.ok(!r.out.includes('zzz-not-a-key'), `a secret VALUE is never printed:\n${r.out}`);
  assert.ok(!r.err.includes('zzz-not-a-key'), `not on stderr either:\n${r.err}`);
});

test('--show on a clone with no .env and no manifest still prints and exits 0', SKIP_ON_WINDOWS, () => {
  // A report that only works on a finished install is useless at the moment you most want it.
  const box = sandbox(null);
  const r = run(['--show'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /manifest:/);
  assert.match(r.out, /none/);
  assert.match(r.out, /RESULT: ok/);
});

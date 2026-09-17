// Run with: npm test   (scripts/**/*.test.ts is in the test glob). NOTHING HERE CONFIGURES ANYTHING
// on this machine: every run either stops in the argument parser (exit 2, before the script has
// opened a single file) or runs inside a throwaway HOME / IRISES_ROOT / IRISES_HOME / HERMES_HOME
// (see `sandbox()`, lifted from engine-setup.test.ts). What is covered here is the ARGUMENT and
// EXIT-CODE contract, the read-only `--show` report, and the plan/preview/confirm/apply pass over
// this clone's .env — the parts an operator, the menu and a wrapping script depend on, and that a
// rewrite silently changes. The restart itself only reaches its "nothing is running" branch here;
// a live cycle is scripts/e2e/lifecycle-sandbox.sh's job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'configure.sh');
const LIB = join(process.cwd(), 'scripts', 'lib', 'irises-lib.sh');

function run(
  args: string[],
  extraEnv: Record<string, string> = {},
  input?: string,
): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    ...(input === undefined ? {} : { input }),
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

/** What is in the sandbox clone's .env right now. */
function envText(root: string): string {
  return readFileSync(join(root, '.env'), 'utf8');
}

/** The `.env.bak-irises-<timestamp>` siblings a run left behind. */
function backups(root: string): string[] {
  return readdirSync(root).filter((f) => f.startsWith('.env.bak-irises-'));
}

/** The last line of stdout is the machine-readable one, and callers read only it. */
function resultLine(out: string): string {
  const lines = out.trimEnd().split('\n');
  return lines[lines.length - 1];
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

/**
 * A PATH holding nothing but the tools the script may reach for, plus stubs that log their argv.
 * Lifted from `runLib` in scripts/lib/irises-lib.test.ts, and here for the same reason: a service
 * manager is DETECTED by looking for systemctl / launchctl / schtasks, so the only way to test a box
 * that has one — or has none — is to build the box.
 *
 * The script calls `augment_path`, which APPENDS /usr/bin and /bin, so a real systemctl on the host
 * is still reachable from here. What makes these tests deterministic is therefore the `uname` stub
 * (which platform) plus the bus variables (what systemd --user additionally needs), not the bin dir.
 */
const SCRATCH_TOOLS = [
  'cat', 'rm', 'mkdir', 'cp', 'mv', 'chmod', 'find', 'grep', 'sed', 'head', 'tail', 'cut', 'tr',
  'sleep', 'date', 'printf', 'ps', 'uname', 'id', 'dirname', 'basename', 'curl', 'node', 'git',
  'awk', 'sort', 'stat', 'env', 'sh', 'pgrep', 'mktemp', 'kill', 'touch', 'ln', 'bash',
];

function scratchPath(stubs: Record<string, string> = {}): { dir: string; bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'irises-configure-bin-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of SCRATCH_TOOLS) {
    const p = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const real = (p.stdout ?? '').trim();
    if (p.status === 0 && real.length > 0 && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  for (const [name, body] of Object.entries(stubs)) {
    // Unlink first: a stub for a tool that is also a symlink here would otherwise be written
    // THROUGH the link, into the host's own copy of that tool.
    rmSync(join(bin, name), { force: true });
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  }
  return { dir, bin, log: join(dir, 'stub.log') };
}

/** A stub that appends `<name> argv:<args>` to $STUB_LOG and succeeds. */
function recordingStub(name: string): string {
  return `printf "${name} argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0`;
}

function stubLog(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

/** Every field engine-setup.sh records, so manifest_update can carry the untouched ones forward. */
const MANIFEST_FIELDS = [
  'root', 'irisesHome', 'port', 'engine', 'engineEnvFile', 'engineEnvBackup', 'pluginDir',
  'serviceKind', 'serviceUnit', 'nodeBin', 'keysAdded', 'keysPreExisting', 'keysRetargeted',
  'bridge', 'frontPattern', 'engineEnvApplied', 'modelLane', 'engineEnvPending',
];

/**
 * An install manifest written by the LIB, never by hand: manifest_read is line-anchored and
 * manifest_update rewrites every field, so a fixture the library did not produce would be testing a
 * format nothing in the product writes.
 */
function writeManifest(env: Record<string, string>, fields: Record<string, string>): void {
  const pairs = MANIFEST_FIELDS.map((k) => `${k}=${fields[k] ?? ''}`);
  const r = spawnSync(
    '/bin/bash',
    ['-c', `source ${JSON.stringify(LIB)}; manifest_write "$(manifest_path)" "$@"`, 'fixture', ...pairs],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } },
  );
  assert.equal(r.status, 0, `the manifest fixture must write: ${r.stderr}`);
}

/**
 * A sandbox wired to a hermes install that HAS an engine .env of ours: the shape --front and a
 * port move both need before they will write a byte on the engine's side.
 */
function hermesBox(engineEnvBody: string, manifest: Record<string, string> = {}) {
  const box = sandbox('OPS_BACKEND=hermes\nPORT=3999\n');
  const hermesHome = box.env.HERMES_HOME;
  mkdirSync(hermesHome, { recursive: true });
  const engineEnv = join(hermesHome, '.env');
  writeFileSync(engineEnv, engineEnvBody);
  writeManifest(box.env, {
    root: box.root,
    irisesHome: box.state,
    port: '3999',
    engine: 'hermes',
    engineEnvFile: engineEnv,
    bridge: '1',
    engineEnvApplied: 'true',
    keysPreExisting: 'IRISES_URL',
    ...manifest,
  });
  return { ...box, engineEnv, manifestPath: join(box.state, 'install-manifest.json') };
}

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
  // This fixture's .env DOES carry OPS_BACKEND, so the line names the key it was read from.
  const engineLine = r.out.split('\n').find((l) => l.includes('engine:')) ?? '';
  assert.match(engineLine, /\(\.env OPS_BACKEND\)/, engineLine);
});

test('--show on a clone with no .env and no manifest still prints and exits 0', SKIP_ON_WINDOWS, () => {
  // A report that only works on a finished install is useless at the moment you most want it.
  const box = sandbox(null);
  const r = run(['--show'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /manifest:/);
  assert.match(r.out, /none/);
  assert.match(r.out, /RESULT: ok/);
  // …and the engine's SOURCE is honest about where the answer came from. With no .env there is no
  // OPS_BACKEND to have read, so naming that key would send the operator to a file that does not
  // exist — engine_kind fell back to probing this box.
  const engineLine = r.out.split('\n').find((l) => l.includes('engine:')) ?? '';
  assert.match(engineLine, /detected/, `no .env, so no OPS_BACKEND to have read it from: ${engineLine}`);
});

test('--show does not head its report with the non-interactive notice', SKIP_ON_WINDOWS, () => {
  // The menu renders this report inline under "Status", and a line about stdin is noise on top of a
  // read-only report that asks nothing.
  const box = sandbox();
  const r = run(['--show'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(!r.out.includes('stdin is not a terminal'), `--show asks nothing:\n${r.out}`);
});

test('--show with IRISES_DASHBOARD_PASSWORD in the environment exits 2', SKIP_ON_WINDOWS, () => {
  // The variable's presence IS the request to set the password, so it is a setting flag in every
  // way that matters — and a report of the old values plus a write of new ones is neither request.
  const box = sandbox();
  const r = run(['--show'], { ...box.env, IRISES_DASHBOARD_PASSWORD: 'hunter2-not-a-password' });
  assert.equal(r.code, 2, `${r.out}\n${r.err}`);
  assert.match(r.err, /--show/);
  assert.ok(!r.out.includes('hunter2-not-a-password'), `${r.out}`);
  assert.ok(!r.err.includes('hunter2-not-a-password'), `${r.err}`);
});

// ── the plan / preview / confirm / apply pass ────────────────────────────────

test('--tz Europe/Paris --no-restart --yes writes IRISES_TZ, backs the file up and ends RESULT: ok', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const before = envText(box.root);
  const r = run(['--tz', 'Europe/Paris', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^IRISES_TZ=Europe\/Paris$/m);
  const b = backups(box.root);
  assert.equal(b.length, 1, `one backup, taken once: ${b.join(', ')}`);
  assert.equal(readFileSync(join(box.root, b[0]), 'utf8'), before, 'the backup holds the PRE-change file');
  assert.ok(r.out.includes('+ IRISES_TZ=Europe/Paris'), `the preview names the addition:\n${r.out}`);
  assert.match(r.out, /changed:.*IRISES_TZ/);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('the same run again ends RESULT: noop and takes no second backup', SKIP_ON_WINDOWS, () => {
  // A configure that rewrites and restarts for a value already in the file teaches the operator
  // that running it twice is free. It is not: the second run bounces the server for nothing.
  const box = sandbox();
  const first = run(['--tz', 'Europe/Paris', '--no-restart', '--yes'], box.env);
  assert.equal(first.code, 0, `${first.out}\n${first.err}`);
  const again = run(['--tz', 'Europe/Paris', '--no-restart', '--yes'], box.env);
  assert.equal(again.code, 0, `${again.out}\n${again.err}`);
  assert.equal(resultLine(again.out), 'RESULT: noop', again.out);
  assert.match(again.out, /nothing to change/);
  assert.equal(backups(box.root).length, 1, 'the second run backs nothing up');
});

test('--tz host removes IRISES_TZ and previews it as a removal', SKIP_ON_WINDOWS, () => {
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nIRISES_TZ=UTC\n');
  const r = run(['--tz', 'host', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('- IRISES_TZ'), `a removal previews as a removal:\n${r.out}`);
  assert.ok(!/^IRISES_TZ=/m.test(envText(box.root)), `the line is gone:\n${envText(box.root)}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--web off --yes with nothing running says so and still ends RESULT: ok', SKIP_ON_WINDOWS, () => {
  // No service and no live pid is not a failed restart: the change is on disk and takes at boot.
  const box = sandbox();
  const r = run(['--web', 'off', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^WEB_ENABLED=false$/m);
  assert.ok(r.out.includes('not running'), `the report says why nothing was restarted:\n${r.out}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--model-inherit removes the override, keeps the lane key and records the lane', SKIP_ON_WINDOWS, () => {
  // Undoing OUR choice of model must not cost the operator a credential they paid for and still
  // need — so the key stays, and is named on stdout so nobody has to guess that it did.
  const box = sandbox(
    'OPS_BACKEND=off\nPORT=3999\n' +
      'CONVO_MODEL_OPENROUTER=m\nCLASSIFY_MODEL_OPENROUTER=m\nFALLFIRM_MODEL_OPENROUTER=m\n' +
      'CONVO_PROVIDER=openrouter\nCLASSIFY_PROVIDER=openrouter\nFALLFIRM_PROVIDER=openrouter\n' +
      'ENGINE_MODEL_INHERIT=off\nOPENROUTER_API_KEY=zzz-not-a-key\n',
  );
  // The manifest this run has to correct: it still names the lane the override was written on, and
  // --uninstall / the detach rewrite carry that field forward to whatever runs next.
  writeManifest(box.env, {
    root: box.root, irisesHome: box.state, port: '3999', engine: 'off', modelLane: 'openrouter',
  });
  const r = run(['--model-inherit', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const body = envText(box.root);
  for (const key of [
    'CONVO_MODEL_OPENROUTER',
    'CLASSIFY_MODEL_OPENROUTER',
    'FALLFIRM_MODEL_OPENROUTER',
    'CONVO_PROVIDER',
    'CLASSIFY_PROVIDER',
    'FALLFIRM_PROVIDER',
    'ENGINE_MODEL_INHERIT',
  ]) {
    assert.ok(!new RegExp(`^${key}=`, 'm').test(body), `${key} must be gone:\n${body}`);
  }
  assert.match(body, /^OPENROUTER_API_KEY=zzz-not-a-key$/m, 'the key the operator gave stays');
  assert.ok(r.out.includes('keeping OPENROUTER_API_KEY'), `${r.out}`);
  assert.ok(!r.out.includes('zzz-not-a-key'), `by name only:\n${r.out}`);
  assert.ok(!r.err.includes('zzz-not-a-key'), `by name only:\n${r.err}`);
  assert.match(
    readFileSync(join(box.state, 'install-manifest.json'), 'utf8'),
    /"modelLane": "inherit"/,
    'the manifest stops naming the lane the override was written on',
  );
});

test('--model-lane openrouter --model-slug m --no-restart --yes with IRISES_MODEL_API_KEY writes the override through the lib and never prints the key', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  writeManifest(box.env, {
    root: box.root, irisesHome: box.state, port: '3999', engine: 'off', modelLane: 'inherit',
  });
  const r = run(['--model-lane', 'openrouter', '--model-slug', 'm', '--no-restart', '--yes'], {
    ...box.env,
    IRISES_MODEL_API_KEY: 'zzz-not-a-key',
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const body = envText(box.root);
  for (const line of [
    'CONVO_MODEL_OPENROUTER=m',
    'CLASSIFY_MODEL_OPENROUTER=m',
    'FALLFIRM_MODEL_OPENROUTER=m',
    'CONVO_PROVIDER=openrouter',
    'CLASSIFY_PROVIDER=openrouter',
    'FALLFIRM_PROVIDER=openrouter',
    'ENGINE_MODEL_INHERIT=off',
    'OPENROUTER_API_KEY=zzz-not-a-key',
  ]) {
    assert.ok(new RegExp(`^${line}$`, 'm').test(body), `${line} must be in .env:\n${body}`);
  }
  assert.ok(r.out.includes('+ OPENROUTER_API_KEY=<set>'), `the key is previewed by name:\n${r.out}`);
  assert.ok(!r.out.includes('zzz-not-a-key'), `never the value:\n${r.out}`);
  assert.ok(!r.err.includes('zzz-not-a-key'), `never the value:\n${r.err}`);
  assert.match(
    readFileSync(join(box.state, 'install-manifest.json'), 'utf8'),
    /"modelLane": "openrouter"/,
    'the manifest learns the lane the voice is on now',
  );
});

test('a --set of a key the override also writes beats the override, as the preview showed', SKIP_ON_WINDOWS, () => {
  // The apply skips the override's OWN plan entries, by index — never every entry that happens to
  // name one of its keys. Skipping by name would preview the operator's line and then let
  // model_override_write silently win, which is a preview promising a write that never happens.
  //
  // The lane API KEY is the case that can still reach here: the guard below refuses a --set of a
  // key the lane OWNS, and the lane keys are deliberately not on that list — the operator pays for
  // them, and the override only ever writes one when IRISES_MODEL_API_KEY says to.
  const box = sandbox();
  const r = run(['--model-lane', 'openrouter', '--model-slug', 'm', '--set', 'OPENROUTER_API_KEY', '--no-restart', '--yes'], {
    ...box.env,
    IRISES_MODEL_API_KEY: 'zzz-lane-not-a-key',
    IRISES_SET_VALUE: 'zzz-operator-not-a-key',
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const body = envText(box.root);
  assert.match(body, /^OPENROUTER_API_KEY=zzz-operator-not-a-key$/m, "the operator's line is the last word");
  assert.match(body, /^CONVO_PROVIDER=openrouter$/m, 'the rest of the override still lands');
  assert.match(body, /^CONVO_MODEL_OPENROUTER=m$/m);
  assert.match(body, /^ENGINE_MODEL_INHERIT=off$/m);
  for (const secret of ['zzz-lane-not-a-key', 'zzz-operator-not-a-key']) {
    assert.ok(!r.out.includes(secret), `by name only:\n${r.out}`);
    assert.ok(!r.err.includes(secret), `by name only:\n${r.err}`);
  }
  // Both entries are written, so both are previewed — but the summary names the key once.
  const changed = r.out.split('\n').find((l) => l.includes('changed:')) ?? '';
  assert.equal(changed.split('OPENROUTER_API_KEY').length - 1, 1, `named once: ${changed}`);
});

test('a model-lane run still reaches the restart decision, though the walk wrote none of its entries', SKIP_ON_WINDOWS, () => {
  // Every entry the override owns is skipped in the apply walk (the lib writes them in one call),
  // so a run carrying nothing else would look as if this clone's .env never moved — and .env is
  // parsed once at boot, which makes "nothing moved, nothing to restart" the wrong answer.
  const box = sandbox();
  const r = run(['--model-lane', 'anthropic', '--model-slug', 'm', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('not running'), `the restart decision was taken, not skipped:\n${r.out}`);
  assert.ok(!r.out.includes("only the engine's side changed"), `and not skipped as an engine-only run:\n${r.out}`);
});

test('--model-lane with a --set of a key that lane writes exits 2', SKIP_ON_WINDOWS, () => {
  // Two answers to one question, and the preview cannot show which wins: every line in it is
  // measured against the file ON DISK, not against the other entries of the same plan.
  const box = sandbox();
  const r = run(
    ['--model-lane', 'openrouter', '--model-slug', 'm', '--set', 'CONVO_PROVIDER=anthropic', '--no-restart', '--yes'],
    box.env,
  );
  assert.equal(r.code, 2, `${r.out}\n${r.err}`);
  // One line, whole: a refusal split over two of them is a sentence nobody can grep for.
  assert.match(
    r.err,
    /CONVO_PROVIDER is written by --model-lane openrouter — set the lane's model with the model flags, or drop --model-lane and set the key alone/,
  );
  assert.ok(!r.out.includes('RESULT:'), `a usage error changed nothing and reports nothing:\n${r.out}`);
  const unset = run(['--model-lane', 'openrouter', '--model-slug', 'm', '--unset', 'ENGINE_MODEL_INHERIT', '--yes'], box.env);
  assert.equal(unset.code, 2, `${unset.out}\n${unset.err}`);
  assert.match(unset.err, /ENGINE_MODEL_INHERIT/);
});

test('a non-secret change previews its old value', SKIP_ON_WINDOWS, () => {
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nWEB_ENABLED=true\n');
  const r = run(['--web', 'off', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('~ WEB_ENABLED=false     (was true)'), `${r.out}`);
});

test('a duplicated key previews the collapse and leaves one line', SKIP_ON_WINDOWS, () => {
  // dotenv takes the LAST assignment, so two lines are a value plus a decoy. Collapsing them is a
  // change in its own right and the preview says so.
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nCONVO_EFFORT=low\nCONVO_EFFORT=low\n');
  const r = run(['--set', 'CONVO_EFFORT=high', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('(2 copies, collapsed onto one line)'), `${r.out}`);
  const lines = envText(box.root)
    .split('\n')
    .filter((l) => l.startsWith('CONVO_EFFORT='));
  assert.deepEqual(lines, ['CONVO_EFFORT=high'], `exactly one line survives:\n${envText(box.root)}`);
});

test('--set CONVO_EFFORT=low --no-restart --yes writes a documented key', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--set', 'CONVO_EFFORT=low', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^CONVO_EFFORT=low$/m);
  assert.ok(r.out.includes('+ CONVO_EFFORT=low'), r.out);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--unset CONVO_EFFORT removes it', SKIP_ON_WINDOWS, () => {
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nCONVO_EFFORT=low\n');
  const r = run(['--unset', 'CONVO_EFFORT', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(!/^CONVO_EFFORT=/m.test(envText(box.root)), envText(box.root));
  assert.ok(r.out.includes('- CONVO_EFFORT'), r.out);
  assert.match(envText(box.root), /^PORT=3999$/m, 'the rest of the file is untouched');
});

test('--set OPENROUTER_API_KEY with IRISES_SET_VALUE writes the value and never prints it', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--set', 'OPENROUTER_API_KEY', '--no-restart', '--yes'], {
    ...box.env,
    IRISES_SET_VALUE: 'zzz-not-a-key',
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^OPENROUTER_API_KEY=zzz-not-a-key$/m);
  assert.ok(r.out.includes('+ OPENROUTER_API_KEY=<set>'), `${r.out}`);
  assert.ok(!r.out.includes('zzz-not-a-key'), `${r.out}`);
  assert.ok(!r.err.includes('zzz-not-a-key'), `${r.err}`);
});

test('IRISES_DASHBOARD_PASSWORD alone is a setting: DASHBOARD_PASSWORD is written and never printed', SKIP_ON_WINDOWS, () => {
  // No flag carries it: a password on argv is readable by every other process on the box.
  const box = sandbox();
  const r = run(['--no-restart', '--yes'], { ...box.env, IRISES_DASHBOARD_PASSWORD: 'hunter2-not-a-password' });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^DASHBOARD_PASSWORD=hunter2-not-a-password$/m);
  assert.ok(r.out.includes('+ DASHBOARD_PASSWORD=<set>'), `${r.out}`);
  assert.ok(!r.out.includes('hunter2-not-a-password'), `${r.out}`);
  assert.ok(!r.err.includes('hunter2-not-a-password'), `${r.err}`);
});

test("a piped run auto-confirms, as the menu's child must", SKIP_ON_WINDOWS, () => {
  // The menu runs this script with ITS stdin, and eating one line would cost the menu its next
  // answer — so a pipe is treated as "nobody can answer", and the obvious answer is taken. The `n`
  // below is never read, which is the whole point of the assertion.
  const box = sandbox();
  const r = run(['--tz', 'Europe/Paris'], box.env, 'n\n');
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('stdin is not a terminal'), `${r.out}`);
  assert.match(envText(box.root), /^IRISES_TZ=Europe\/Paris$/m);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('a run mixing --tz with --port applies both in one preview', SKIP_ON_WINDOWS, () => {
  // One preview, one question, one backup, whatever mix of settings a run carries.
  const box = sandbox();
  const r = run(['--tz', 'Europe/Paris', '--port', '4002', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const body = envText(box.root);
  assert.match(body, /^IRISES_TZ=Europe\/Paris$/m);
  assert.match(body, /^PORT=4002$/m);
  assert.equal(backups(box.root).length, 1, 'one backup, taken once');
  const headers = r.out.split('\n').filter((l) => l.startsWith('changes to '));
  assert.equal(headers.length, 1, `one file moved, so one heading:\n${r.out}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('a changed secret previews as not shown', SKIP_ON_WINDOWS, () => {
  // Neither half of a `~` line may carry a secret: not the new value, and not the old one.
  const box = sandbox('OPS_BACKEND=off\nPORT=3999\nOPENROUTER_API_KEY=zzz-old-not-a-key\n');
  const r = run(['--set', 'OPENROUTER_API_KEY', '--no-restart', '--yes'], {
    ...box.env,
    IRISES_SET_VALUE: 'zzz-new-not-a-key',
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(r.out.includes('~ OPENROUTER_API_KEY=<set>     (was not shown)'), `${r.out}`);
  for (const secret of ['zzz-old-not-a-key', 'zzz-new-not-a-key']) {
    assert.ok(!r.out.includes(secret), `${secret} must not reach stdout:\n${r.out}`);
    assert.ok(!r.err.includes(secret), `${secret} must not reach stderr:\n${r.err}`);
  }
  assert.match(envText(box.root), /^OPENROUTER_API_KEY=zzz-new-not-a-key$/m);
});

// ── the port, the service and the front: the settings with side effects ──────

test('--port refuses a port something already listens on, before any write', SKIP_ON_WINDOWS, async () => {
  // Finding this out AFTER the write leaves .env naming a port Irises can never bind — and the
  // restart that follows verifies against whatever is already answering there.
  const net = await import('node:net');
  const srv = net.createServer(() => {});
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const taken = (srv.address() as { port: number }).port;
  try {
    const box = sandbox();
    const before = envText(box.root);
    const r = run(['--port', String(taken), '--yes'], box.env);
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.match(r.err, /already listens on/);
    assert.equal(envText(box.root), before, 'not one byte of .env moved');
    assert.equal(backups(box.root).length, 0, 'and nothing was backed up');
    assert.equal(resultLine(r.out), 'RESULT: partial', r.out);
  } finally {
    srv.close();
  }
});

test('--port writes PORT, says the manifest is absent, and previews the change', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--port', '4001', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^PORT=4001$/m);
  assert.ok(r.out.includes('~ PORT=4001     (was 3999)'), `the preview names the move:\n${r.out}`);
  assert.ok(r.out.includes('no install manifest'), `a clone with no manifest is still configurable:\n${r.out}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--port equal to the current port is a noop', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--port', '3999', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.equal(resultLine(r.out), 'RESULT: noop', r.out);
  assert.equal(backups(box.root).length, 0, 'a noop backs nothing up and restarts nothing');
});

test('--port moves IRISES_URL when the manifest says the engine .env is ours', SKIP_ON_WINDOWS, () => {
  // The engine calls Irises back on IRISES_URL, so a port move that leaves it behind silently stops
  // every inbound message — and the uninstaller has to learn that the key is now one it retargeted.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n');
  const r = run(['--port', '4001', '--no-restart', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^PORT=4001$/m);
  const engine = readFileSync(box.engineEnv, 'utf8');
  assert.match(engine, /^IRISES_URL=http:\/\/127\.0\.0\.1:4001$/m);
  assert.match(engine, /^IRISES_FRONT=\*:\*$/m, 'nothing else in the engine .env moved');
  const engineBackups = readdirSync(box.env.HERMES_HOME).filter((f) => f.startsWith('.env.bak-irises-'));
  assert.equal(engineBackups.length, 1, `the engine .env is backed up first: ${engineBackups.join(', ')}`);
  const man = readFileSync(box.manifestPath, 'utf8');
  assert.match(man, /"port": "4001"/);
  assert.match(man, /"keysRetargeted": "IRISES_URL"/);
  assert.ok(r.out.includes('skipped (--no-gateway-restart)'), `the summary says the engine has not read it yet:\n${r.out}`);
  assert.ok(r.out.includes(`changes to ${box.engineEnv}`), `the engine's file announces itself:\n${r.out}`);
  // An engine key in `changed:` is prefixed — IRISES_URL alone says nothing about which file moved.
  const changed = r.out.split('\n').find((l) => l.includes('changed:')) ?? '';
  assert.match(changed, /\bPORT\b/, changed);
  assert.match(changed, /engine:IRISES_URL/, changed);
});

test('--front at the value the engine already carries plans nothing and records nothing', SKIP_ON_WINDOWS, () => {
  // --port only plans IRISES_URL where the file still names the old port; --front planned
  // unconditionally, and FRONT_PLANNED is what the manifest step reads. So a front asked for at the
  // value it already has wrote frontPattern and keysRetargeted for a byte that never moved — the
  // manifest claiming a scope this run took over, which is what --uninstall then restores.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=telegram:1\n', {
    keysPreExisting: 'IRISES_FRONT',
    keysRetargeted: '',
    frontPattern: '*:*',
  });
  const engineBefore = readFileSync(box.engineEnv, 'utf8');
  const r = run(['--front', 'telegram:1', '--tz', 'Europe/Paris', '--no-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^IRISES_TZ=Europe\/Paris$/m, 'the setting that DID change applies');
  const man = readFileSync(box.manifestPath, 'utf8');
  assert.match(man, /"keysRetargeted": ""/, 'a front that did not move retargets nothing');
  assert.match(man, /"frontPattern": "\*:\*"/, 'and does not rewrite the pattern either');
  assert.equal(readFileSync(box.engineEnv, 'utf8'), engineBefore, "the engine's .env is byte-identical");
  const engineBackups = readdirSync(box.env.HERMES_HOME).filter((f) => f.startsWith('.env.bak-irises-'));
  assert.deepEqual(engineBackups, [], `nothing to back up: ${engineBackups.join(', ')}`);
  assert.ok(!r.out.includes('IRISES_FRONT'), `and the preview never offers the line:\n${r.out}`);

  // …and on its own there is nothing left for the run to do at all.
  const alone = run(['--front', 'telegram:1', '--yes'], box.env);
  assert.equal(alone.code, 0, `${alone.out}\n${alone.err}`);
  assert.equal(resultLine(alone.out), 'RESULT: noop', alone.out);
});

test('a --port whose engine IRISES_URL already names the new port retargets nothing', SKIP_ON_WINDOWS, () => {
  // The bookkeeping and the warning both have to mean "this run wrote it". Here the key already
  // points where the move is going, so it is not one this run moved: the plan never gains an entry
  // for it (the value does not name the port being moved OFF, so it was not ours to move), nothing
  // is written to the engine's file, and keysRetargeted must stay exactly as the install left it.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:4001\n', { keysRetargeted: '' });
  const r = run(['--port', '4001', '--no-restart', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^PORT=4001$/m, "this clone's own move still applies");
  assert.match(readFileSync(box.manifestPath, 'utf8'), /"keysRetargeted": ""/, 'nothing was retargeted');
  const engineBackups = readdirSync(box.env.HERMES_HOME).filter((f) => f.startsWith('.env.bak-irises-'));
  assert.deepEqual(engineBackups, [], `the engine's file was never opened: ${engineBackups.join(', ')}`);
  assert.ok(!r.err.includes('still listens on'), `and nothing warns about a move that did not happen:\n${r.err}`);
  // WHY it is safe, stated where it can fail: the entry is never planned at all. A URL that does
  // not name the port being moved off takes the "not ours to move" arm, so there is no plan entry
  // for the preview to drop — which is also why the planned-then-dropped case cannot exist: the
  // planned value is always http://127.0.0.1:<new port> and the entry is only planned when the file
  // still says <old port>, so the two can never already be equal.
  assert.match(r.err, /was not ours to move/, `the stray arm, not a dropped plan entry:\n${r.err}`);
});

test('--service on where no service manager exists exits 1', SKIP_ON_WINDOWS, () => {
  // Linux by the uname stub, no systemctl on the scratch PATH and no user bus in the environment:
  // the fresh-SSH box, where Irises can only ever run detached.
  const box = sandbox();
  const bin = scratchPath({ uname: 'echo Linux' });
  try {
    const r = run(['--service', 'on', '--yes'], {
      ...box.env,
      PATH: bin.bin,
      XDG_RUNTIME_DIR: bin.bin,
      DBUS_SESSION_BUS_ADDRESS: '',
    });
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    assert.match(r.err, /no user service manager/);
    assert.equal(backups(box.root).length, 0, 'it refused before the first write');
  } finally {
    rmSync(bin.dir, { recursive: true, force: true });
  }
});

test('--service off with none installed is a noop', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--service', 'off', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.equal(resultLine(r.out), 'RESULT: noop', r.out);
});

test('--service on installs through the manager and records it', SKIP_ON_WINDOWS, () => {
  // The transition IS the restart, and this proves its ORDER: unit written, daemon reloaded, and
  // only THEN started — a start before the reload starts whatever the manager still has cached.
  // The verification, in a sandbox where nothing really listens, is expected to fail; `curl`
  // refuses and `sleep` returns at once, so the 60s budget costs no wall time.
  //
  // `--no-restart` is carried on purpose: a unit installed and left stopped is neither state anyone
  // asked for, so the transition runs anyway — and the summary says that, rather than leaving the
  // operator to reconcile a flag they passed with a server that moved.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\n', { serviceKind: 'none' });
  mkdirSync(join(box.root, 'dist'), { recursive: true });
  writeFileSync(join(box.root, 'dist', 'index.js'), '// not a real server\n');
  const bin = scratchPath({
    uname: 'echo Linux',
    systemctl: recordingStub('systemctl'),
    loginctl: recordingStub('loginctl'),
    curl: 'exit 1',
    sleep: 'exit 0',
  });
  try {
    const r = run(['--service', 'on', '--no-restart', '--yes'], {
      ...box.env,
      PATH: bin.bin,
      STUB_LOG: bin.log,
      XDG_RUNTIME_DIR: bin.bin,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null',
    });
    assert.equal(r.code, 4, `${r.out}\n${r.err}`);
    assert.equal(resultLine(r.out), 'RESULT: health-failed', r.out);
    const unit = join(box.env.HOME, '.config', 'systemd', 'user', 'irises.service');
    assert.ok(existsSync(unit), `the unit must be written under the sandbox HOME: ${unit}`);
    const log = stubLog(bin.log);
    const reload = log.indexOf('systemctl argv:--user daemon-reload');
    const start = log.indexOf('systemctl argv:--user restart irises');
    assert.notEqual(reload, -1, log.join('\n'));
    assert.notEqual(start, -1, log.join('\n'));
    assert.ok(reload < start, `the daemon is reloaded BEFORE the service is started:\n${log.join('\n')}`);
    // …and the manifest learns what it will have to take out again: --uninstall reads these two.
    const man = readFileSync(box.manifestPath, 'utf8');
    assert.match(man, /"serviceKind": "systemd"/);
    assert.match(man, new RegExp(`"serviceUnit": "${unit}"`));
    assert.ok(r.out.includes('~ service: detached → systemd'), `the transition is previewed:\n${r.out}`);
    // The LAST one: the summary's own line, under the banner that also carries the word.
    const irises = r.out.split('\n').filter((l) => l.includes('Irises:')).pop() ?? '';
    assert.match(irises, /--no-restart/, `the summary says the flag did not apply here: ${irises}`);
  } finally {
    rmSync(bin.dir, { recursive: true, force: true });
  }
});

test('--front with no engine exits 1', SKIP_ON_WINDOWS, () => {
  const box = sandbox();
  const r = run(['--front', 'telegram:1', '--yes'], box.env);
  assert.equal(r.code, 1, `${r.out}\n${r.err}`);
  assert.match(r.err, /OPS_BACKEND=off/);
});

test('--front on a --no-bridge install exits 1', SKIP_ON_WINDOWS, () => {
  // Without the bridge plugin the gateway has nothing to hand a fronted chat to.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\n', { bridge: '0' });
  const r = run(['--front', 'telegram:1', '--yes'], box.env);
  assert.equal(r.code, 1, `${r.out}\n${r.err}`);
  assert.match(r.err, /--no-bridge/);
});

test('--front when the engine .env carries nothing of ours exits 1', SKIP_ON_WINDOWS, () => {
  // The install was declined or printed, so that file is the operator's alone — writing to it now
  // would put a key there that --uninstall does not know to take out.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\n', { engineEnvApplied: 'false' });
  const r = run(['--front', 'telegram:1', '--yes'], box.env);
  assert.equal(r.code, 1, `${r.out}\n${r.err}`);
  assert.match(r.err, /carries nothing of ours/);
});

test('--front rewrites IRISES_FRONT in the engine .env, records it, and skips the bounce when told', SKIP_ON_WINDOWS, () => {
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n');
  const before = envText(box.root);
  const r = run(['--front', 'telegram:1', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(readFileSync(box.engineEnv, 'utf8'), /^IRISES_FRONT=telegram:1$/m);
  assert.match(readFileSync(box.manifestPath, 'utf8'), /"frontPattern": "telegram:1"/);
  assert.equal(envText(box.root), before, "a front is the ENGINE's key — this clone's .env never moves");
  assert.equal(backups(box.root).length, 0, 'and a file that did not move is not backed up');
  assert.ok(r.out.includes('~ IRISES_FRONT=telegram:1     (was *:*)'), `${r.out}`);
  const gateway = r.out.split('\n').find((l) => l.includes('gateway:')) ?? '';
  assert.match(gateway, /skipped \(--no-gateway-restart\)/, `the summary says the engine has not read it yet: ${gateway}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('a front-only run never names this clone\'s .env, --no-restart or not', SKIP_ON_WINDOWS, () => {
  // --no-restart has nothing to skip on a run that changed nothing of hers, and said otherwise the
  // run announces a new value in a file it never opened and asks for a restart that reads none.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n');
  for (const args of [
    ['--front', 'telegram:2', '--no-gateway-restart', '--yes'],
    ['--front', 'telegram:3', '--no-restart', '--no-gateway-restart', '--yes'],
  ]) {
    const r = run(args, box.env);
    assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}\n${r.err}`);
    assert.ok(r.out.includes("only the engine's side changed"), `${args.join(' ')}:\n${r.out}`);
    assert.ok(!r.out.includes(join(box.root, '.env')), `the clone .env is never named:\n${r.out}`);
  }
});

test('--front none blanks IRISES_FRONT', SKIP_ON_WINDOWS, () => {
  // `none` is an EMPTY IRISES_FRONT, not a missing one: the gateway fronts nothing for an empty
  // value, and a removed key would fall back to whatever its own default is.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n');
  const r = run(['--front', 'none', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(readFileSync(box.engineEnv, 'utf8'), /^IRISES_FRONT=$/m);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('an entry the preview skipped is not written: --front (unchanged) --tz Europe/Paris rewrites only the clone .env', SKIP_ON_WINDOWS, () => {
  // The preview does not list a key already carrying the value asked for, and what it did not list
  // is exactly what the apply must not write. Written anyway, a front that did not move still backs
  // up and rewrites the ENGINE's .env and bounces its gateway — a run that announced one line and
  // cycled the engine for a byte nobody changed.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=telegram:1\n');
  const engineBefore = readFileSync(box.engineEnv, 'utf8');
  const r = run(
    ['--front', 'telegram:1', '--tz', 'Europe/Paris', '--no-restart', '--no-gateway-restart', '--yes'],
    box.env,
  );
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(envText(box.root), /^IRISES_TZ=Europe\/Paris$/m, 'the entry the preview DID list still applies');
  assert.equal(readFileSync(box.engineEnv, 'utf8'), engineBefore, "not one byte of the engine's .env moved");
  const engineBackups = readdirSync(box.env.HERMES_HOME).filter((f) => f.startsWith('.env.bak-irises-'));
  assert.deepEqual(engineBackups, [], `a file that did not move is not backed up: ${engineBackups.join(', ')}`);
  assert.ok(!r.out.includes('IRISES_FRONT'), `the unchanged front is in neither the preview nor the summary:\n${r.out}`);
  const gateway = r.out.split('\n').find((l) => l.includes('gateway:')) ?? '';
  assert.match(gateway, /n\/a/, `nothing engine-side changed, so there is nothing to bounce: ${gateway}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--tz UTC (unchanged) --front telegram:2 touches only the engine .env', SKIP_ON_WINDOWS, () => {
  // The mirror image, and the costlier half: a clone .env rewritten for a value already in it takes
  // a backup nobody needs and restarts Irises unannounced, in the middle of whatever she was saying.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=telegram:1\n');
  writeFileSync(join(box.root, '.env'), 'OPS_BACKEND=hermes\nPORT=3999\nIRISES_TZ=UTC\n');
  const cloneBefore = envText(box.root);
  const r = run(['--tz', 'UTC', '--front', 'telegram:2', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(readFileSync(box.engineEnv, 'utf8'), /^IRISES_FRONT=telegram:2$/m, 'the listed entry applies');
  assert.equal(envText(box.root), cloneBefore, "not one byte of this clone's .env moved");
  assert.equal(backups(box.root).length, 0, 'and a file that did not move is not backed up');
  assert.ok(r.out.includes("not restarting: only the engine's side changed"), `nothing of hers changed:\n${r.out}`);
  assert.ok(!r.out.includes(join(box.root, '.env')), `and her .env is never named:\n${r.out}`);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

test('--front over a pre-existing IRISES_FRONT records the retarget, and over one we added does not', SKIP_ON_WINDOWS, () => {
  // keysRetargeted is the list --uninstall and the detach put back FROM the pre-install backup. A
  // front this run pointed somewhere else, on a key the operator already had, is exactly that — and
  // unrecorded it is a scope the uninstall leaves on ours instead of restoring to theirs.
  const theirs = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n', {
    keysPreExisting: 'IRISES_FRONT',
    keysRetargeted: '',
  });
  const r = run(['--front', 'telegram:2', '--no-gateway-restart', '--yes'], theirs.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(readFileSync(theirs.manifestPath, 'utf8'), /"keysRetargeted": "IRISES_FRONT"/);

  // A key the install ADDED comes out on uninstall rather than going back to a value it never had,
  // so it must not land on the retargeted list at all.
  const ours = hermesBox('IRISES_URL=http://127.0.0.1:3999\nIRISES_FRONT=*:*\n', {
    keysAdded: 'IRISES_FRONT',
    keysPreExisting: '',
    keysRetargeted: '',
  });
  const r2 = run(['--front', 'telegram:2', '--no-gateway-restart', '--yes'], ours.env);
  assert.equal(r2.code, 0, `${r2.out}\n${r2.err}`);
  assert.match(readFileSync(ours.manifestPath, 'utf8'), /"keysRetargeted": ""/);
});

test('--show names the engine keys an install left for the operator to add', SKIP_ON_WINDOWS, () => {
  // `--engine-env print`, or an `ask` answered no: the install wrote nothing to the engine's .env
  // and recorded what it would have written. Without that line the report says "n/a" about the
  // fronts and stops, and the operator has to read the manifest by hand to find out what is missing.
  const box = hermesBox("# the operator's own file\n", {
    engineEnvApplied: 'false',
    engineEnvPending: 'API_SERVER_ENABLED IRISES_URL',
  });
  const r = run(['--show'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.ok(
    r.out.includes('left for you to add: API_SERVER_ENABLED IRISES_URL'),
    `the report names what is still missing from the engine's .env:\n${r.out}`,
  );
});

test('--set HERMES_API_KEY=x is refused as engine wiring, in one step', () => {
  // Reserved is checked BEFORE the secret-on-argv rule: a key that may not be set here at all must
  // not first send the operator off to re-run the same refused command through IRISES_SET_VALUE.
  const r = run(['--set', 'HERMES_API_KEY=x', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /engine wiring/);
  assert.match(r.err, /engine-setup\.sh/);
  assert.ok(!r.err.includes('IRISES_SET_VALUE'), `not the two-step detour:\n${r.err}`);
});

test('--port --no-restart warns that the engine now calls the new port while Irises is still on the old', SKIP_ON_WINDOWS, () => {
  // The engine's IRISES_URL moved and Irises did not: every inbound message goes to a port nothing
  // is listening on, with no error on either side, until someone restarts her.
  const box = hermesBox('IRISES_URL=http://127.0.0.1:3999\n');
  const r = run(['--port', '4001', '--no-restart', '--no-gateway-restart', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.err, /:4001/, `the port the engine now calls:\n${r.err}`);
  assert.match(r.err, /still listens on :3999/, `and the one she is still on:\n${r.err}`);
});

test('--help says a --service transition starts or stops Irises whatever --no-restart says', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  const help = r.out;
  assert.match(
    help,
    /--no-restart[\s\S]{0,200}--service on\|off/,
    `--no-restart is absolute everywhere except here, and the help has to say so:\n${help}`,
  );
});

test('--front on OpenClaw prints the line and applies nothing', SKIP_ON_WINDOWS, () => {
  // OpenClaw's gateway reads its own process environment, not a file this script can edit.
  const box = sandbox('OPS_BACKEND=openclaw\nPORT=3999\n');
  const before = envText(box.root);
  const r = run(['--front', 'telegram:1', '--yes'], box.env);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.err, /IRISES_FRONT=telegram:1/);
  assert.equal(envText(box.root), before, 'nothing was applied');
  assert.equal(backups(box.root).length, 0);
  assert.equal(resultLine(r.out), 'RESULT: ok', r.out);
});

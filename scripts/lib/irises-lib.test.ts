// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The lib is exercised the way the lifecycle scripts use it: sourced into a bash shell that already
// has `set -euo pipefail` in force, on a SCRATCH PATH built from symlinks to the few real tools the
// lib may use plus stub executables that log their argv and environment. That combination is the
// point — the two bugs this library exists to kill are (a) a function that returns non-zero as its
// last command and aborts its caller under `set -e`, and (b) a tool the lib assumed was on PATH.
//
// The scratch PATH deliberately does NOT include /usr/bin, so `service_kind` can be observed with
// systemctl/launchctl genuinely absent. Tests that need them ask for them by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'scripts', 'lib', 'irises-lib.sh');

/** Tools the lib is allowed to reach for. Anything missing on the host is skipped silently. */
const DEFAULT_TOOLS = [
  'cat', 'rm', 'mkdir', 'cp', 'mv', 'chmod', 'find', 'grep', 'sed', 'head', 'tail', 'cut', 'tr',
  'sleep', 'date', 'printf', 'ps', 'uname', 'id', 'dirname', 'basename', 'du', 'curl', 'node',
  'npm', 'git', 'awk', 'sort', 'stat', 'env', 'sh', 'pgrep', 'mktemp', 'kill', 'touch', 'ln', 'od',
  // bash: the stubs below are `#!/usr/bin/env bash` scripts, so the interpreter has to be reachable
  // on the scratch PATH or every stub invocation dies with "env: bash: No such file or directory".
  'bash',
];

function realPath(tool: string): string | null {
  const r = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', env: process.env });
  const p = (r.stdout ?? '').trim();
  return r.status === 0 && p.length > 0 ? p : null;
}

export interface LibRun { out: string; err: string; code: number; log: string[]; dir: string }
export interface RunOpts {
  /** Extra tool names to symlink onto the scratch PATH (e.g. 'systemctl', 'launchctl'). */
  tools?: string[];
  /** name -> bash body. Written executable onto the scratch PATH, shadowing any real tool. */
  stubs?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
}

/** Source the lib under `set -euo pipefail` and run `body`. */
export function runLib(body: string, opts: RunOpts = {}): LibRun {
  const dir = mkdtempSync(join(tmpdir(), 'irises-lib-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const log = join(dir, 'stub.log');
  for (const tool of [...DEFAULT_TOOLS, ...(opts.tools ?? [])]) {
    const real = realPath(tool);
    if (real && !existsSync(join(bin, tool))) symlinkSync(real, join(bin, tool));
  }
  for (const [name, script] of Object.entries(opts.stubs ?? {})) {
    // Unlink first. A stub for a tool that is also in DEFAULT_TOOLS (node, npm, uname…) already has
    // a SYMLINK at this path pointing at the real binary, and writeFileSync follows it — writing the
    // stub straight into the host's node/npm install. Removing the link makes the stub a plain file
    // that shadows the real tool, which is all the scratch PATH ever wanted.
    rmSync(join(bin, name), { force: true });
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  }
  const script = join(dir, 'body.sh');
  writeFileSync(script, ['set -euo pipefail', `source ${JSON.stringify(LIB)}`, body, ''].join('\n'));
  const res = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    cwd: opts.cwd ?? dir,
    env: {
      PATH: bin,
      HOME: home,
      NO_COLOR: '1',
      STUB_LOG: log,
      IRISES_HOME: join(dir, 'state'),
      ...(opts.env ?? {}),
    },
  });
  return {
    out: res.stdout ?? '',
    err: res.stderr ?? '',
    code: res.status ?? -1,
    log: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    dir,
  };
}

/**
 * A health endpoint in its OWN process, answering every path with the Irises /health shape.
 *
 * It cannot live in this process: runLib is spawnSync, which stops this event loop dead, so an
 * in-process http server never accepts the lib's curl — it just times out after -m 5. The child
 * re-reads `shaFile` on every request, which is how a test flips which build is "live".
 */
export function startHealthServer(shaFile: string): { base: string; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'irises-health-'));
  const portFile = join(dir, 'port');
  const src = join(dir, 'health-server.mjs');
  writeFileSync(src, [
    "import http from 'node:http';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const [shaPath, portPath] = process.argv.slice(2);',
    'const srv = http.createServer((_q, s) => {',
    "  let sha = '';",
    "  try { sha = readFileSync(shaPath, 'utf8').trim(); } catch { sha = ''; }",
    "  s.setHeader('content-type', 'application/json');",
    "  s.end(JSON.stringify({",
    "    status: 'ok',",
    '    version: { sha, shortSha: sha.slice(0, 7) },',
    "    update: { remoteSha: 'c'.repeat(40) },",
    '  }));',
    '});',
    "srv.listen(0, '127.0.0.1', () => writeFileSync(portPath, String(srv.address().port)));",
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [src, shaFile, portFile], { stdio: 'ignore' });
  let port = '';
  for (let i = 0; i < 200 && port === ''; i += 1) {
    if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').trim();
    if (port === '') spawnSync('/bin/sleep', ['0.05']);
  }
  if (port === '') {
    child.kill('SIGKILL');
    throw new Error('the health server child never reported a port');
  }
  return { base: `http://127.0.0.1:${port}`, stop: () => { child.kill('SIGKILL'); } };
}

/** A scratch clone root with a .env (and optionally deploy/app.env) for the path/engine resolvers. */
export function fixtureRoot(env: string, appEnv?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'irises-root-'));
  writeFileSync(join(root, '.env'), env);
  if (appEnv !== undefined) {
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(join(root, 'deploy', 'app.env'), appEnv);
  }
  return root;
}

test('the lib is valid bash and safe to source twice', () => {
  execFileSync('/bin/bash', ['-n', LIB], { encoding: 'utf8' });
  const r = runLib([
    `source ${JSON.stringify(LIB)}`,
    `source ${JSON.stringify(LIB)}`,
    'say "sourced three times, still fine"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sourced three times, still fine/);
});

test('sourcing the lib runs nothing and prints nothing', () => {
  const r = runLib('true');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
});

test('say goes to stdout; log, warn and err go to stderr; die carries its exit code', () => {
  const r = runLib('say hello; log quietly; warn careful; err broken; die 7 "gone"');
  assert.equal(r.code, 7);
  assert.match(r.out, /\[irises\] hello/);
  assert.match(r.err, /\[irises\] quietly/);
  assert.match(r.err, /\[irises\] careful/);
  assert.match(r.err, /\[irises\] broken/);
  assert.match(r.err, /\[irises\] gone/);
  assert.ok(!r.out.includes('careful'), 'warn must not pollute stdout — RESULT lines are parsed there');
  assert.ok(!r.out.includes('quietly'), 'log is for value-returning functions whose stdout is captured');
});

test('env_get matches dotenv: last assignment wins, export prefix, quotes, inline comments', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    '# a comment',
    'API_SERVER_KEY=first',
    '  export  API_SERVER_KEY = second  ',
    'QUOTED="a b # not a comment"',
    "SINGLE='c d'",
    'OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED; set to force one',
    'EMPTY=',
    'NODE_OPTIONS=--max-old-space-size=512   # heap cap',
  ].join('\n'));
  const r = runLib([
    `printf 'KEY=[%s]\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'QUOTED=[%s]\\n' "$(env_get ${JSON.stringify(f)} QUOTED)"`,
    `printf 'SINGLE=[%s]\\n' "$(env_get ${JSON.stringify(f)} SINGLE)"`,
    `printf 'BACKEND=[%s]\\n' "$(env_get ${JSON.stringify(f)} OPS_BACKEND)"`,
    `printf 'EMPTY=[%s]\\n' "$(env_get ${JSON.stringify(f)} EMPTY)"`,
    `printf 'OPTS=[%s]\\n' "$(env_get ${JSON.stringify(f)} NODE_OPTIONS)"`,
    `printf 'ABSENT=[%s]\\n' "$(env_get ${JSON.stringify(f)} NOPE)"`,
    `printf 'NOFILE=[%s]\\n' "$(env_get /nonexistent/file KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /KEY=\[second\]/, 'dotenv is last-wins; the production hermes .env has two API_SERVER_KEY blocks');
  assert.match(r.out, /QUOTED=\[a b # not a comment\]/);
  assert.match(r.out, /SINGLE=\[c d\]/);
  assert.match(r.out, /BACKEND=\[hermes\]/, 'the inline comment must not become part of the engine kind');
  assert.match(r.out, /EMPTY=\[\]/);
  assert.match(r.out, /OPTS=\[--max-old-space-size=512\]/);
  assert.match(r.out, /ABSENT=\[\]/);
  assert.match(r.out, /NOFILE=\[\]/);
});

test('env_set rewrites in place, collapses duplicates, and appends when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'A=1\nAPI_SERVER_KEY=old1\nB=2\nAPI_SERVER_KEY=old2\n# trailing comment');
  const r = runLib([
    `env_set ${JSON.stringify(f)} API_SERVER_KEY live`,
    `env_set ${JSON.stringify(f)} NEW_KEY newval`,
    `printf 'COUNT=%s\\n' "$(env_count ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'VALUE=%s\\n' "$(env_get ${JSON.stringify(f)} API_SERVER_KEY)"`,
    `printf 'NEW=%s\\n' "$(env_get ${JSON.stringify(f)} NEW_KEY)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /COUNT=1/, 'the duplicate block is collapsed to one line');
  assert.match(r.out, /VALUE=live/);
  assert.match(r.out, /NEW=newval/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^A=1$/m, 'unrelated keys survive');
  assert.match(body, /^B=2$/m);
  assert.match(body, /^# trailing comment$/m, 'a file with no trailing newline keeps its last line');
  assert.equal(body.slice(-1), '\n', 'the rewrite always leaves a trailing newline');
});

test('env_set_default never overwrites a value the user already set', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'PORT=3999\nBLANK=\n');
  const r = runLib([
    `env_set_default ${JSON.stringify(f)} PORT 3000`,
    `env_set_default ${JSON.stringify(f)} BLANK filled`,
    `env_set_default ${JSON.stringify(f)} FRESH yes`,
    `printf 'PORT=%s BLANK=%s FRESH=%s\\n' "$(env_get ${JSON.stringify(f)} PORT)" "$(env_get ${JSON.stringify(f)} BLANK)" "$(env_get ${JSON.stringify(f)} FRESH)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PORT=3999 BLANK=filled FRESH=yes/);
});

test('env_append_block writes one dated marker above its keys, on a file with no trailing newline', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'MODEL=gpt');   // no trailing newline: the bug that glued two keys into one line
  const r = runLib(`env_append_block ${JSON.stringify(f)} "bridge mode" IRISES_URL=http://127.0.0.1:3000 IRISES_FRONT='*:*'`);
  assert.equal(r.code, 0, r.err);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^MODEL=gpt$/m, 'the pre-existing last line is not glued to our first key');
  assert.match(body, /^# — added by Irises setup \(\d{4}-\d{2}-\d{2}\) — bridge mode —$/m);
  assert.match(body, /^IRISES_URL=http:\/\/127\.0\.0\.1:3000$/m);
  assert.match(body, /^IRISES_FRONT=\*:\*$/m);
});

test('env_remove_irises_block drops our keys plus the orphaned marker, and counts them', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, [
    'ANTHROPIC_API_KEY=keepme',
    '',
    '# — added by Irises setup (2026-09-01) — reminder push-back —',
    'IRISES_PUSH_TOKEN=abc',
    '',
    '# — added by Irises setup (2026-09-01) — bridge mode —',
    'IRISES_BRIDGE_TOKEN=def',
    'KEEP_THIS=1',
    '',
  ].join('\n'));
  const r = runLib([
    `printf 'REMOVED=%s\\n' "$(env_remove_irises_block ${JSON.stringify(f)} IRISES_PUSH_TOKEN IRISES_BRIDGE_TOKEN)"`,
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REMOVED=2/);
  const body = readFileSync(f, 'utf8');
  assert.match(body, /^ANTHROPIC_API_KEY=keepme$/m);
  assert.match(body, /^KEEP_THIS=1$/m);
  assert.ok(!body.includes('IRISES_PUSH_TOKEN'), body);
  assert.ok(!body.includes('IRISES_BRIDGE_TOKEN'), body);
  assert.ok(!body.includes('reminder push-back'), 'a marker whose keys all went must go too');
  assert.ok(!body.includes('bridge mode'), body);
});

test('env_backup copies to a 0600 sibling and prints ONLY its path on stdout', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'irises-env-')), '.env');
  writeFileSync(f, 'SECRET=shhh\n', { mode: 0o644 });
  const r = runLib(`env_backup ${JSON.stringify(f)} pre-uninstall`);
  assert.equal(r.code, 0, r.err);
  const backup = r.out.trim();
  assert.match(backup, /\.env\.bak-irises-\d{8}-\d{6}$/, 'callers capture this — a log line here would corrupt the path');
  assert.equal(readFileSync(backup, 'utf8'), 'SECRET=shhh\n');
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.match(r.err, /backed up/);
});

test('irises_home resolves .env over the shell over app.env over ~/.irises', () => {
  const withEnv = fixtureRoot('IRISES_HOME=~/from-dotenv\n', 'IRISES_HOME=/from-appenv\n');
  const appOnly = fixtureRoot('# nothing here\n', 'IRISES_HOME=/from-appenv\n');
  const bare = fixtureRoot('# nothing here\n');
  const call = (root: string, shell?: string) => runLib('irises_home', {
    env: { IRISES_ROOT: root, ...(shell ? { IRISES_HOME: shell } : { IRISES_HOME: '' }) },
  });
  const a = call(withEnv, '/from-shell');
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /\/home\/from-dotenv$/, 'a leading ~ expands against HOME');
  const b = call(appOnly, '/from-shell');
  assert.equal(b.out, '/from-shell');
  const c = call(appOnly);
  assert.equal(c.out, '/from-appenv', 'deploy/app.env is a legitimate operator config tier');
  const d = call(bare);
  assert.match(d.out, /\/home\/\.irises$/);
});

test('portable_timeout kills a hung command and reports 124', () => {
  const started = Date.now();
  const r = runLib([
    'rc=0',
    'portable_timeout 2 sleep 30 || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
  assert.ok(elapsed < 15000, `the bash fallback must not wait for the command (took ${elapsed}ms)`);
});

test('portable_timeout passes a fast command through with its own exit code', () => {
  const r = runLib([
    'rc=0; portable_timeout 10 sh -c "exit 3" || rc=$?; printf "RC=%s\\n" "$rc"',
    'rc2=0; portable_timeout 10 sh -c "exit 0" || rc2=$?; printf "RC2=%s\\n" "$rc2"',
  ].join('\n'), { env: { IRISES_FORCE_TIMEOUT_FALLBACK: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=3/);
  assert.match(r.out, /RC2=0/);
});

test('portable_timeout can time-box a shell FUNCTION (timeout(1) cannot exec one)', () => {
  const r = runLib([
    'slow() { sleep 30; }',
    'rc=0; portable_timeout 2 slow || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=124/);
});

test('require_tools names every missing tool and returns 1', () => {
  const r = runLib([
    'rc=0; require_tools cat definitely-not-here also-missing || rc=$?',
    'printf "RC=%s\\n" "$rc"',
  ].join('\n'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /definitely-not-here/);
  assert.match(r.err, /also-missing/);
});

test('require_node_version accepts the node running these tests', () => {
  const r = runLib('require_node_version 22.13; printf "OK\\n"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /OK/);
});

test('require_node_version fails loudly when the only node is too old', () => {
  // IRISES_NODE_CANDIDATES pins the fallback search to a path that does not exist; otherwise a
  // Homebrew or nvm node on the developer's own machine would satisfy the floor and pass this test.
  const r = runLib([
    'rc=0; require_node_version 22.13 || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), {
    stubs: { node: 'if [ "${1:-}" = "-p" ]; then echo "18.20.0"; else echo "v18.20.0"; fi' },
    env: { IRISES_NODE_CANDIDATES: '/nonexistent/bin/node' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /22\.13/);
});

test('augment_path appends the common bin dirs it needs and never drops the caller PATH', () => {
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"');
  assert.equal(r.code, 0, r.err);
  const line = r.out.split('\n').find(l => l.startsWith('PATH='))!;
  assert.ok(line.includes('/bin:') || line.endsWith('/bin'), line);
  assert.ok(line.includes('/usr/bin'), 'a non-login shell PATH must still reach the base tools');
  assert.match(line, /^PATH=[^:]*\/bin:/, 'the caller PATH stays first — an explicit node choice wins');
});

test('augment_path picks the newest nvm node >= 22 and ignores older trees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-nvm-'));
  for (const v of ['v18.20.0', 'v22.9.0', 'v22.17.0', 'v24.1.0', 'garbage']) {
    mkdirSync(join(dir, 'versions', 'node', v, 'bin'), { recursive: true });
  }
  const r = runLib('augment_path; printf "PATH=%s\\n" "$PATH"', { env: { NVM_DIR: dir } });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(join(dir, 'versions', 'node', 'v24.1.0', 'bin')), r.out);
  assert.ok(!r.out.includes('v18.20.0'), 'below the floor');
  assert.ok(!r.out.includes('v22.9.0'), 'only the newest is added');
});

test('mem_available_mb is a number on Linux and empty elsewhere', () => {
  const r = runLib('printf "MB=[%s]\\n" "$(mem_available_mb)"');
  assert.equal(r.code, 0, r.err);
  const m = /MB=\[(.*)\]/.exec(r.out);
  assert.ok(m, r.out);
  if (process.platform === 'linux') assert.match(m![1], /^\d+$/);
  else assert.equal(m![1], '');
});

test('tcp_open sees a listening socket and rejects a closed port', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_q, s) => s.end('ok'));
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  try {
    const open = runLib(`rc=0; tcp_open 127.0.0.1 ${port} || rc=$?; printf "OPEN=%s\\n" "$rc"`);
    assert.equal(open.code, 0, open.err);
    assert.match(open.out, /OPEN=0/);
  } finally {
    srv.close();
  }
  const closed = runLib('rc=0; tcp_open 127.0.0.1 1 || rc=$?; printf "CLOSED=%s\\n" "$rc"');
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /CLOSED=1/);
});

// ── section E: engine, gateway, plugins, web ────────────────────────────────────────────────────

/** A stub that records `argv` plus the environment bits we assert on, then exits with $STUB_RC. */
const RECORDING_STUB = [
  '{',
  '  printf "%s argv:%s\\n" "$(basename "$0")" "$*"',
  '  printf "%s env:HERMES_RESTART_AFTER_TURN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_AFTER_TURN_TIMEOUT:-unset}"',
  '  printf "%s env:HERMES_RESTART_DRAIN_TIMEOUT=%s\\n" "$(basename "$0")" "${HERMES_RESTART_DRAIN_TIMEOUT:-unset}"',
  '  printf "%s env:_HERMES_GATEWAY=%s\\n" "$(basename "$0")" "${_HERMES_GATEWAY:-unset}"',
  '} >> "$STUB_LOG"',
  'exit "${STUB_RC:-0}"',
].join('\n');

test('engine_kind reads OPS_BACKEND past its inline comment, and honours an override', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes             # hermes | openclaw — AUTO-DETECTED\n');
  const a = runLib('engine_kind', { env: { IRISES_ROOT: root } });
  assert.equal(a.code, 0, a.err);
  assert.equal(a.out, 'hermes');
  const b = runLib('engine_kind openclaw', { env: { IRISES_ROOT: root } });
  assert.equal(b.out, 'openclaw');
  const off = fixtureRoot('OPS_BACKEND=off\n');
  assert.equal(runLib('engine_kind', { env: { IRISES_ROOT: off } }).out, 'off');
  const junk = fixtureRoot('OPS_BACKEND=banana\n');
  const j = runLib('engine_kind', { env: { IRISES_ROOT: junk } });
  assert.equal(j.out, 'off');
  assert.match(j.err, /banana/);
});

test('engine_kind falls back to what is installed when OPS_BACKEND is unset', () => {
  const root = fixtureRoot('# no backend pinned\n');
  const withHermes = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: root } });
  assert.equal(withHermes.out, 'hermes', 'the hermes home existing is the proof of installation');
  const withClaw = runLib('engine_kind', {
    env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') },
    stubs: { openclaw: 'exit 0' },
  });
  assert.equal(withClaw.out, 'openclaw');
  const neither = runLib('engine_kind', { env: { IRISES_ROOT: root, HERMES_HOME: join(root, 'nope') } });
  assert.equal(neither.out, 'off');
});

test('hermes_run finds ~/.local/bin/hermes when PATH is minimal, and strips _HERMES_GATEWAY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'hermes'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run plugins enable irises-bridge',
  ].join('\n'), { env: { HOME: home, _HERMES_GATEWAY: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*\.local\/bin\/hermes/, 'the real location on a Mac, which the old resolver missed');
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
  assert.ok(
    r.log.includes('hermes env:_HERMES_GATEWAY=unset'),
    'inherited _HERMES_GATEWAY=1 makes the CLI refuse gateway work with exit 1',
  );
});

test('hermes_run falls back to the venv python module form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-hcli-'));
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'hermes-agent', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(hhome, 'hermes-agent', 'venv', 'bin', 'python'), `#!/usr/bin/env bash\n${RECORDING_STUB}\n`, { mode: 0o755 });
  const r = runLib([
    'printf "CLI=%s\\n" "$(hermes_cli)"',
    'hermes_run gateway status',
  ].join('\n'), { env: { HERMES_HOME: hhome } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=.*venv\/bin\/python -m hermes_cli\.main/);
  assert.ok(r.log.includes('python argv:-m hermes_cli.main gateway status'), r.log.join('\n'));
});

test('hermes_cli is empty and hermes_run returns 127 when no CLI exists', () => {
  const r = runLib([
    'printf "CLI=[%s]\\n" "$(hermes_cli)"',
    'rc=0; hermes_run gateway status || rc=$?; printf "RC=%s\\n" "$rc"',
  ].join('\n'), { env: { HERMES_HOME: '/nonexistent' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /CLI=\[\]/);
  assert.match(r.out, /RC=127/);
});

test('gateway_restart bounces hermes through its CLI with both drain caps capped', () => {
  // The engine's /v1/health must answer from ANOTHER process (see startHealthServer). Otherwise the
  // probe falls through to the service/process branch — and on any machine that actually runs hermes
  // that branch says "up" no matter what this fixture does, so the http path is never exercised.
  const shaFile = join(mkdtempSync(join(tmpdir(), 'irises-gw-')), 'live-sha');
  writeFileSync(shaFile, 'a'.repeat(40));
  const { base, stop } = startHealthServer(shaFile);
  const root = fixtureRoot(`OPS_BACKEND=hermes\nHERMES_BASE_URL=${base}\n`);
  try {
    const r = runLib('gateway_restart hermes 20', {
      env: { IRISES_ROOT: root, _HERMES_GATEWAY: '1' },
      stubs: { hermes: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('hermes argv:'));
    assert.ok(argv, r.log.join('\n'));
    assert.match(argv!, /^hermes argv:gateway re?start$/, 'the verb is assembled at runtime, and still arrives whole');
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_AFTER_TURN_TIMEOUT=45'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:HERMES_RESTART_DRAIN_TIMEOUT=10'), r.log.join('\n'));
    assert.ok(r.log.includes('hermes env:_HERMES_GATEWAY=unset'), r.log.join('\n'));
    assert.match(r.out, /gateway is back/);
  } finally {
    stop();
  }
});

test('gateway_restart reports failure (1) when the gateway never answers again', () => {
  const root = fixtureRoot('OPS_BACKEND=hermes\nHERMES_BASE_URL=http://127.0.0.1:1\n');
  const r = runLib('rc=0; gateway_restart hermes 4 || rc=$?; printf "RC=%s\\n" "$rc"', {
    env: { IRISES_ROOT: root },
    // pgrep too, and not for neatness: the service probe's last resort is "is a gateway PROCESS
    // alive?", which on a developer's own machine (one running hermes) is true no matter what this
    // fixture does. Stubbing it is what makes "the gateway never answers again" the actual scenario.
    stubs: { hermes: RECORDING_STUB, systemctl: 'exit 1', launchctl: 'exit 1', pgrep: 'exit 1' },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.match(r.err, /did not come back/);
});

test('gateway_restart on an engine that is off does nothing and succeeds', () => {
  const root = fixtureRoot('OPS_BACKEND=off\n');
  const r = runLib('gateway_restart', { env: { IRISES_ROOT: root } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /engine is off/);
});

test('gateway_restart bounces openclaw through its own CLI and waits on the gateway port', async () => {
  const net = await import('node:net');
  const srv = net.createServer(sock => sock.end());
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  const root = fixtureRoot(`OPS_BACKEND=openclaw\nOPENCLAW_URL=ws://127.0.0.1:${port}\n`);
  try {
    const r = runLib('gateway_restart openclaw 20', {
      env: { IRISES_ROOT: root },
      stubs: { openclaw: RECORDING_STUB },
    });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const argv = r.log.find(l => l.startsWith('openclaw argv:'));
    assert.match(argv!, /^openclaw argv:gateway re?start$/);
    assert.match(r.out, /gateway is back/);
  } finally {
    srv.close();
  }
});

test('plugin_refresh copies the hermes plugin without __pycache__ and enables it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__init__.py'), 'x = 1\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', 'plugin.yaml'), 'name: irises-bridge\n');
  writeFileSync(join(root, 'bridge', 'hermes', 'irises-bridge', '__pycache__', 'stale.pyc'), 'junk');
  const hhome = join(dir, 'hermes');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  writeFileSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py'), 'old\n');
  const r = runLib(`plugin_refresh hermes ${JSON.stringify(root)}`, {
    env: { HERMES_HOME: hhome },
    stubs: { hermes: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(hhome, 'plugins', 'irises-bridge', '__init__.py')));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge', '__pycache__')), 'stale bytecode must not ship');
  assert.ok(
    !existsSync(join(hhome, 'plugins', 'irises-bridge', 'REMOVED_UPSTREAM.py')),
    'rm before cp: cp -R onto an existing dir merges and leaves deleted files behind',
  );
  assert.ok(r.log.includes('hermes argv:plugins enable irises-bridge'), r.log.join('\n'));
});

test('plugin_refresh deletes the openclaw target first, because install refuses an existing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const root = join(dir, 'clone');
  mkdirSync(join(root, 'bridge', 'openclaw', 'irises-bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'openclaw', 'irises-bridge', 'package.json'), '{"name":"irises-bridge"}');
  const state = join(dir, 'openclaw');
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  writeFileSync(join(state, 'extensions', 'irises-bridge', 'old.js'), 'stale\n');
  const r = runLib(`plugin_refresh openclaw ${JSON.stringify(root)}`, {
    env: { OPENCLAW_STATE_DIR: state },
    stubs: { openclaw: RECORDING_STUB },
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'the CLI copies it back in; we only clear the way');
  const argv = r.log.find(l => l.startsWith('openclaw argv:plugins install'));
  assert.ok(argv, r.log.join('\n'));
  assert.match(argv!, /bridge\/openclaw\/irises-bridge$/);
});

test('plugin_remove disables then deletes, on both engines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-plug-'));
  const hhome = join(dir, 'hermes');
  const state = join(dir, 'openclaw');
  mkdirSync(join(hhome, 'plugins', 'irises-bridge'), { recursive: true });
  mkdirSync(join(state, 'extensions', 'irises-bridge'), { recursive: true });
  const h = runLib('plugin_remove hermes', { env: { HERMES_HOME: hhome }, stubs: { hermes: RECORDING_STUB } });
  assert.equal(h.code, 0, h.err);
  assert.ok(h.log.includes('hermes argv:plugins disable irises-bridge'), h.log.join('\n'));
  assert.ok(!existsSync(join(hhome, 'plugins', 'irises-bridge')));
  const o = runLib('plugin_remove openclaw', { env: { OPENCLAW_STATE_DIR: state }, stubs: { openclaw: RECORDING_STUB } });
  assert.equal(o.code, 0, o.err);
  assert.ok(o.log.includes('openclaw argv:plugins disable irises-bridge'), o.log.join('\n'));
  assert.ok(!existsSync(join(state, 'extensions', 'irises-bridge')), 'openclaw has no `plugins uninstall` — rm is the removal');
});

test('web_build skips a fresh install, builds an install that already serves web/out, never fails', () => {
  const npmStub = 'printf "npm argv:%s\\n" "$*" >> "$STUB_LOG"; exit "${NPM_RC:-0}"';
  const mk = (withOut: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'irises-web-'));
    mkdirSync(join(root, 'web', 'node_modules'), { recursive: true });
    if (withOut) mkdirSync(join(root, 'web', 'out'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"irises"}');
    return root;
  };
  const fresh = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub } });
  assert.equal(fresh.code, 0, fresh.err);
  assert.deepEqual(fresh.log, [], 'not one npm call on a box that never served the page');
  assert.match(fresh.out, /web UI not built here/);

  const serving = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub } });
  assert.equal(serving.code, 0, serving.err);
  assert.equal(serving.log.length, 2, serving.log.join('\n'));
  assert.match(serving.log[0], /^npm argv:--prefix .*\/web ci$/, 'ci, not install: install rewrites web/package-lock.json and dirties the tree');
  assert.match(serving.log[1], /^npm argv:run build:web$/);

  const failing = runLib(`web_build ${JSON.stringify(mk(true))}; printf "SURVIVED\\n"`, {
    stubs: { npm: npmStub }, env: { NPM_RC: '1' },
  });
  assert.equal(failing.code, 0, failing.err);
  assert.match(failing.out, /SURVIVED/, 'a next build that dies of memory must not abort the lifecycle action');
  assert.match(failing.err, /web client build failed/);

  const opted = runLib(`web_build ${JSON.stringify(mk(false))}`, { stubs: { npm: npmStub }, env: { IRISES_WEB: '1' } });
  assert.equal(opted.code, 0, opted.err);
  assert.equal(opted.log.length, 2, 'IRISES_WEB=1 opts a fresh install in');

  const skipped = runLib(`web_build ${JSON.stringify(mk(true))}`, { stubs: { npm: npmStub }, env: { IRISES_SKIP_WEB_BUILD: '1' } });
  assert.deepEqual(skipped.log, []);
  assert.match(skipped.out, /IRISES_SKIP_WEB_BUILD=1/);
});

// ── section F: service, process, health, manifest, lock, summary ────────────────────────────────

test('service_kind is none with no systemctl and no launchctl on PATH', () => {
  const r = runLib('service_kind');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'none', 'the scratch PATH has neither — the detached fallback must be chosen');
});

test('service_kind needs systemctl AND a reachable user bus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const bus = join(dir, 'run');
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, 'bus'), '');
  const noBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: join(dir, 'absent') },
  });
  assert.equal(noBus.out, 'none', 'systemctl present but no user bus is the fresh-SSH case');
  const withBus = runLib('service_kind', {
    stubs: { systemctl: 'exit 0', uname: 'echo Linux' },
    env: { XDG_RUNTIME_DIR: bus, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(bus, 'bus')}` },
  });
  assert.equal(withBus.out, 'systemd');
  const mac = runLib('service_kind', { stubs: { launchctl: 'exit 0', uname: 'echo Darwin' } });
  assert.equal(mac.out, 'launchd');
});

test('service_install renders the systemd unit with an absolute node, PATH, logs and reload, and prints only its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\nNODE_OPTIONS=--max-old-space-size=512   # heap cap\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /usr/local/bin/node`, {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux', loginctl: 'printf "loginctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const unitPath = join(home, '.config', 'systemd', 'user', 'irises.service');
  assert.equal(r.out.trim(), unitPath, 'callers capture this — the "wrote" line must be on stderr');
  const unit = readFileSync(unitPath, 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node .*\/clone\/dist\/index\.js$/m, 'a bare `node` never resolves in a unit');
  assert.match(unit, new RegExp(`^WorkingDirectory=${root}$`, 'm'));
  assert.match(unit, new RegExp(`^Environment="IRISES_HOME=${state}"$`, 'm'));
  assert.match(unit, /^Environment="NODE_OPTIONS=--max-old-space-size=512"$/m, 'app.env sets it too late for V8 — the unit is the only place it works');
  assert.match(unit, /^Environment="PATH=[^"]*\/usr\/bin[^"]*"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^TimeoutStopSec=30$/m);
  assert.match(unit, new RegExp(`^StandardOutput=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, new RegExp(`^StandardError=append:${state}/logs/server\\.log$`, 'm'));
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.ok(r.log.some(l => l === 'systemctl argv:--user daemon-reload'), r.log.join('\n'));
  assert.ok(r.log.some(l => l === 'systemctl argv:--user enable irises'), r.log.join('\n'));
  assert.ok(r.log.some(l => l.startsWith('loginctl argv:enable-linger')), 'without linger the unit dies at logout');
});

test('service_install renders the LaunchAgent plist that stays stopped after a clean stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  const root = join(dir, 'clone');
  const state = join(dir, 'state');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.env'), 'PORT=3000\n');
  const r = runLib(`service_install ${JSON.stringify(root)} /opt/homebrew/bin/node`, {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home, IRISES_HOME: state, IRISES_ROOT: root },
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.irises.server.plist');
  assert.equal(r.out.trim(), plistPath);
  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<key>Label<\/key>\s*<string>ai\.irises\.server<\/string>/);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(plist, new RegExp(`<string>${root}/dist/index.js</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    'a plain KeepAlive=true would relaunch the server we just asked to stop');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${state}/logs/server.log</string>`));
  assert.ok(r.log.some(l => /^launchctl argv:bootstrap gui\/\d+ .*ai\.irises\.server\.plist$/.test(l)), r.log.join('\n'));
});

test('service_restart and service_uninstall use the right verbs per platform', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-svc-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'irises.service'), '[Service]\n');
  const linux = runLib('service_restart; service_uninstall', {
    stubs: { systemctl: 'printf "systemctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Linux' },
    env: { HOME: home, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
  });
  assert.equal(linux.code, 0, linux.err);
  assert.ok(linux.log.includes('systemctl argv:--user restart irises'), linux.log.join('\n'));
  assert.ok(linux.log.includes('systemctl argv:--user disable irises'), linux.log.join('\n'));
  assert.ok(!existsSync(join(home, '.config', 'systemd', 'user', 'irises.service')), 'the unit file goes with it');

  const home2 = join(dir, 'home2');
  mkdirSync(join(home2, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist'), '<plist/>\n');
  const mac = runLib('service_restart; service_uninstall', {
    stubs: { launchctl: 'printf "launchctl argv:%s\\n" "$*" >> "$STUB_LOG"; exit 0', uname: 'echo Darwin' },
    env: { HOME: home2 },
  });
  assert.equal(mac.code, 0, mac.err);
  assert.ok(mac.log.some(l => /^launchctl argv:kickstart -k gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(mac.log.some(l => /^launchctl argv:bootout gui\/\d+\/ai\.irises\.server$/.test(l)), mac.log.join('\n'));
  assert.ok(!existsSync(join(home2, 'Library', 'LaunchAgents', 'ai.irises.server.plist')));
});

test('is_our_server and server_pid only ever claim a live Irises process', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-pid-'));
  const stale = runLib([
    `printf '999999\\n' > "$(irises_home)/irises.pid"`,
    'printf "PID=[%s]\\n" "$(server_pid)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /PID=\[\]/, 'a dead pid is not a server');

  const mine = runLib([
    'printf "SELF=%s\\n" "$(is_our_server $$ && echo yes || echo no)"',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.match(mine.out, /SELF=no/, 'this bash is not dist/index.js');
  const junk = runLib('printf "JUNK=%s\\n" "$(is_our_server not-a-pid && echo yes || echo no)"', { env: { IRISES_HOME: state } });
  assert.match(junk.out, /JUNK=no/);
});

test('wait_health_sha waits for the sha the new build stamped, ignoring update.remoteSha', () => {
  const oldSha = 'a'.repeat(40);
  const newSha = 'b'.repeat(40);
  const shaFile = join(mkdtempSync(join(tmpdir(), 'irises-sha-')), 'live-sha');
  writeFileSync(shaFile, oldSha);
  const { base, stop } = startHealthServer(shaFile);
  try {
    const ok = runLib(`wait_health ${base} 5 && printf "\\nHEALTH=ok\\n"`);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /HEALTH=ok/);

    const wrong = runLib(`rc=0; wait_health_sha ${base} ${newSha} 3 || rc=$?; printf "\\nRC=%s\\n" "$rc"`);
    assert.match(wrong.out, /RC=1/, 'the old build answering must NOT be read as the new build');

    writeFileSync(shaFile, newSha);
    const right = runLib(`wait_health_sha ${base} ${newSha} 5; printf "\\nRC=0\\n"`);
    assert.equal(right.code, 0, right.err);
    assert.match(right.out, new RegExp(newSha));
    const short = runLib(`wait_health_sha ${base} ${newSha.slice(0, 7)} 5; printf "\\nRC=0\\n"`);
    assert.equal(short.code, 0, 'a short sha from dist/version.json must match the full one');
  } finally {
    stop();
  }
});

test('wait_health fails within its budget when nothing is listening', () => {
  const started = Date.now();
  const r = runLib('rc=0; wait_health http://127.0.0.1:1 3 || rc=$?; printf "RC=%s\\n" "$rc"');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /RC=1/);
  assert.ok(Date.now() - started < 20000);
});

test('manifest_write and manifest_read round-trip without node, and survive a reformat', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-man-'));
  const p = join(state, 'install-manifest.json');
  const r = runLib([
    `manifest_write ${JSON.stringify(p)} engine=hermes root=/home/ubuntu/irises port=3000 serviceKind=systemd 'keysAdded=API_SERVER_ENABLED IRISES_PUSH_TOKEN' keysPreExisting=API_SERVER_KEY`,
    `printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`,
    `printf 'ADDED=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} keysAdded)"`,
    `printf 'PRE=%s\\n' "$(manifest_read ${JSON.stringify(p)} keysPreExisting)"`,
    `printf 'MISSING=[%s]\\n' "$(manifest_read ${JSON.stringify(p)} nope)"`,
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ENGINE=hermes/);
  assert.match(r.out, /ADDED=\[API_SERVER_ENABLED IRISES_PUSH_TOKEN\]/);
  assert.match(r.out, /PRE=API_SERVER_KEY/);
  assert.match(r.out, /MISSING=\[\]/);
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
  assert.equal(parsed.engine, 'hermes', 'it must be valid JSON for anyone who looks at it');
  assert.equal(parsed.serviceKind, 'systemd');
  writeFileSync(p, JSON.stringify(parsed));    // one line: the grep reader misses, node must catch it
  const reformatted = runLib(`printf 'ENGINE=%s\\n' "$(manifest_read ${JSON.stringify(p)} engine)"`, { env: { IRISES_HOME: state } });
  assert.match(reformatted.out, /ENGINE=hermes/);
});

test('lock_acquire keeps a second run out and reclaims a lock whose holder is gone', () => {
  const state = mkdtempSync(join(tmpdir(), 'irises-lock-'));
  const held = runLib([
    'lock_acquire',
    'rc=0; ( lock_acquire ) || rc=$?; printf "SECOND=%s\\n" "$rc"',
    'lock_release',
    'lock_acquire && printf "AFTER_RELEASE=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /SECOND=1/);
  assert.match(held.out, /AFTER_RELEASE=ok/);
  const stale = runLib([
    'mkdir -p "$(irises_home)/lifecycle.lock"',
    'printf "999999\\n" > "$(irises_home)/lifecycle.lock/pid"',
    'lock_acquire && printf "RECLAIMED=ok\\n"',
    'lock_release',
  ].join('\n'), { env: { IRISES_HOME: state } });
  assert.equal(stale.code, 0, stale.err);
  assert.match(stale.out, /RECLAIMED=ok/);
});

test('summary prints its lines and ends with exactly one RESULT line on stdout', () => {
  const r = runLib('summary rolled-back "old -> new reverted" "server untouched"');
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n').filter(Boolean);
  assert.equal(lines[lines.length - 1], 'RESULT: rolled-back');
  assert.equal(lines.filter(l => l.startsWith('RESULT:')).length, 1);
  assert.match(r.out, /old -> new reverted/);
  assert.match(r.out, /server untouched/);
});

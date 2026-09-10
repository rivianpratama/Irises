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
import { execFileSync, spawnSync } from 'node:child_process';
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

// Run with: npm test   (scripts/**/*.test.ts is in the test glob). No update is ever applied here:
// the script is syntax-checked as a whole, and its ONE optional step — the web client rebuild — is
// lifted out of the real file and run in a bash harness with `npm`, `say` and `warn` stubbed.
//
// Why that step has a test at all: on the 408 MB VPS the web build died with a bus error INSIDE
// `next build`, and because the whole updater runs under `set -e` the server was left updated on
// disk, never restarted, and the receipt never written — the optional half took the mandatory half
// down with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'update.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

test('the script is valid bash (bash -n, no execution)', () => {
  execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
});

test('--help prints the whole header, including the skip switch, and no code', () => {
  // --help is a `sed` range over this file's own comment block, so a header edit can silently
  // truncate it (or start printing the script). Both directions are checked here.
  const help = execFileSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(help, /IRISES_SKIP_WEB_BUILD=1 skips the optional web-client rebuild/);
  assert.match(help, /After the restart, Irises mentions the upgrade in chat itself\./, 'the last header line survives');
  assert.ok(!help.includes('set -euo pipefail'), 'the range stops at the header');
});

/** The real `build_web` definition, lifted verbatim out of update.sh — so this exercises the
 *  shipped code rather than a copy of it that could drift. */
function buildWebFunction(): string {
  const start = SOURCE.indexOf('build_web() {');
  assert.notEqual(start, -1, 'update.sh defines build_web');
  const end = SOURCE.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'build_web is closed by a bare } on its own line');
  return SOURCE.slice(start, end + 3);
}

interface Run { out: string; npm: string[]; rc: number; }

/**
 * Run `build_web` with the whole updater's own `set -euo pipefail` in force — the condition the bug
 * lived under — and with `npm` stubbed by a shell function that reports every invocation and fails
 * the one named by NPM_FAIL.
 */
function runBuildWeb(opts: { web?: boolean; fail?: 'install:web' | 'build:web'; env?: Record<string, string> } = {}): Run {
  const root = mkdtempSync(join(tmpdir(), 'irises-update-'));
  if (opts.web !== false) {
    mkdirSync(join(root, 'web', 'node_modules'), { recursive: true });
  }
  const harness = [
    'set -euo pipefail',
    `ROOT=${JSON.stringify(root)}`,
    'PHASE="build"',
    "say()  { printf 'SAY %s\\n' \"$*\"; }",
    "warn() { printf 'WARN %s\\n' \"$*\"; }",
    "npm() { printf 'NPM %s\\n' \"$*\"; if [ \"${NPM_FAIL:-none}\" = \"$2\" ]; then return 1; fi; return 0; }",
    buildWebFunction(),
    // The updater calls it as a bare command under set -e, so a non-zero return would abort the
    // whole update — the `if` here only records the code without giving up that guarantee.
    'if build_web; then rc=0; else rc=$?; fi',
    'printf "RC %s\\n" "$rc"',
    'printf "PHASE %s\\n" "$PHASE"',
  ].join('\n');
  const file = join(root, 'harness.sh');
  writeFileSync(file, harness);
  const out = execFileSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, NPM_FAIL: opts.fail ?? 'none', ...(opts.env ?? {}) },
  });
  const lines = out.split('\n');
  return {
    out,
    npm: lines.filter(l => l.startsWith('NPM ')).map(l => l.slice(4)),
    rc: Number(lines.find(l => l.startsWith('RC '))?.slice(3) ?? -1),
  };
}

const WEB_FAIL_WARNING = 'web client build failed — server updated; web UI not rebuilt';

test('a healthy web install is still installed and built, in that order', () => {
  const r = runBuildWeb();
  assert.deepEqual(r.npm, ['run install:web', 'run build:web']);
  assert.equal(r.rc, 0);
  assert.ok(!r.out.includes('WARN'), 'nothing to warn about');
});

test('a failing web BUILD warns and keeps going — the receipt and restart still come', () => {
  const r = runBuildWeb({ fail: 'build:web' });
  assert.deepEqual(r.npm, ['run install:web', 'run build:web']);
  assert.equal(r.rc, 0, 'a non-zero return here is exactly what aborted the update under set -e');
  assert.ok(r.out.includes(`WARN ${WEB_FAIL_WARNING}`), `expected the exact warning, got:\n${r.out}`);
});

test('a failing web INSTALL warns too, and does not go on to build', () => {
  const r = runBuildWeb({ fail: 'install:web' });
  assert.deepEqual(r.npm, ['run install:web'], 'no point building what did not install');
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes(`WARN ${WEB_FAIL_WARNING}`));
});

test('IRISES_SKIP_WEB_BUILD=1 skips the step entirely', () => {
  const r = runBuildWeb({ env: { IRISES_SKIP_WEB_BUILD: '1' } });
  assert.deepEqual(r.npm, [], 'not one npm call on a box that cannot afford them');
  assert.equal(r.rc, 0);
  assert.match(r.out, /SAY .*IRISES_SKIP_WEB_BUILD/);
});

test('an install that does not serve the web client says so and stays quiet', () => {
  const r = runBuildWeb({ web: false });
  assert.deepEqual(r.npm, []);
  assert.equal(r.rc, 0);
  assert.match(r.out, /SAY web client not installed here/);
});

test('both web-build sites go through the one function (nothing calls build:web directly)', () => {
  // The self-heal rebuild and the normal apply had their own copies of this step; a soft-fail that
  // only covers one of them is the same bug on the other path.
  // Lines that RUN the commands, not the ones that print them (say/warn) or explain them (#).
  const direct = SOURCE.split('\n')
    .map(l => l.trim())
    .filter(l => /npm run (install|build):web/.test(l) && !/^(#|say |warn )/.test(l));
  assert.equal(direct.length, 1, `only build_web may run the web commands, found:\n${direct.join('\n')}`);
});

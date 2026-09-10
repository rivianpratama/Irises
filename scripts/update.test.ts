// Run with: npm test   (scripts/**/*.test.ts is in the test glob). No update is ever applied here:
// these are the ARGUMENT, EXIT-CODE and RESULT-LINE contracts. The optional web step used to be
// lifted out of this file by string-slicing between `build_web() {` and the next `\n}\n`; it now
// lives in the shared library and is tested directly in scripts/lib/irises-lib.test.ts, so the
// slicing (and the way an unrelated edit could break it) is gone.
//
// The whole apply-and-roll-back flow is covered end to end by scripts/e2e/lifecycle-sandbox.sh
// (npm run e2e:lifecycle), which publishes a real commit to a fake origin and then a commit that
// compiles but crashes on boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'update.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

function run(args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

test('the script is valid bash (bash -n, no execution)', () => {
  execFileSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
});

test('--help lists every flag and the whole exit-code table', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of ['--check', '--yes', '--no-restart', '--no-gateway-restart']) {
    assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  }
  for (const code of ['0', '1', '2', '3', '4', '5', '10']) {
    assert.match(r.out, new RegExp(`^\\s*${code}\\s`, 'm'), `exit code ${code} must be documented\n${r.out}`);
  }
  assert.match(r.out, /IRISES_SKIP_WEB_BUILD=1/, 'the escape hatch a small box needs stays documented');
  assert.match(r.out, /RESULT:/);
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
});

test('an unknown flag exits 2', () => {
  const r = run(['--rebase']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--rebase/);
  assert.match(r.err, /--help/);
});

test('--restart is gone: restarting is what an update DOES now', () => {
  // The old script defaulted to printing instructions and only restarted when asked. A flag that
  // silently became a no-op would leave anyone scripting it believing they had opted in.
  const r = run(['--restart']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--no-restart/);
});

test('the updater no longer writes update-status.json anywhere', () => {
  // Nothing reads it: the chat-triggered self-update that watched it is gone, and the boot receipt
  // is what voices a successful upgrade. A leftover writer is a file that rots in $IRISES_HOME.
  assert.ok(!SOURCE.includes('update-status.json'), 'update-status.json must not be written');
  assert.ok(!SOURCE.includes('write_status'), 'write_status must be gone');
});

test('the receipt is still written — it is how Irises voices the upgrade after the restart', () => {
  assert.match(SOURCE, /write_receipt/);
  assert.match(SOURCE, /update-receipt\.json/);
  assert.match(SOURCE, /write-update-receipt\.js/);
});

test('every npm and web command goes through the library, not through this script', () => {
  const direct = SOURCE.split('\n')
    .map(l => l.trim())
    .filter(l => /npm (run )?(install:web|build:web|--prefix)/.test(l) && !/^(#|say |warn |err )/.test(l));
  assert.deepEqual(direct, [], `the web build belongs to web_build() in the library:\n${direct.join('\n')}`);
});

test('the apply path is guarded by a rollback that restores BOTH the tree and the build', () => {
  // The old script had none: a failed `npm ci` after the merge left HEAD new, node_modules wiped
  // and dist old, with no way back but by hand.
  assert.match(SOURCE, /git reset --hard/, 'a rollback must move HEAD back');
  assert.match(SOURCE, /rollback/i);
  const rollback = SOURCE.slice(SOURCE.indexOf('rollback_to() {'));
  assert.match(rollback, /npm ci --include=dev/, 'the old node_modules has to come back too');
  assert.match(rollback, /npm run build/, 'and the old dist');
});

test('--check on this clone reports one of the two check results and exits 0 or 10', () => {
  const r = run(['--check']);
  assert.ok(r.code === 0 || r.code === 10, `expected 0 or 10, got ${r.code}\n${r.out}\n${r.err}`);
  if (r.code === 0) assert.match(r.out, /RESULT: up-to-date/);
  else assert.match(r.out, /RESULT: update-available/);
});

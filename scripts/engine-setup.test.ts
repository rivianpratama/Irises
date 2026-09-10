// Run with: npm test   (scripts/**/*.test.ts is in the test glob). Nothing here installs anything:
// these are the ARGUMENT and EXIT-CODE contracts, the parts an operator or a script depends on and
// that a rewrite silently changes. The lifecycle itself is covered end to end by
// scripts/e2e/lifecycle-sandbox.sh (npm run e2e:lifecycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'engine-setup.sh');

function run(args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? -1 };
}

test('--help documents every flag it accepts, and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0, r.err);
  for (const flag of ['--engine', '--uninstall', '--yes', '--no-bridge', '--no-service', '--port', '--purge-data']) {
    assert.ok(r.out.includes(flag), `--help must document ${flag}\n${r.out}`);
  }
  assert.ok(!r.out.includes('set -euo pipefail'), 'the help text stops at the header');
  assert.match(r.out, /RESULT:/, 'the machine-readable last line is part of the contract');
});

test('an unknown flag exits 2 and points at --help', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /--frobnicate/);
  assert.match(r.err, /--help/);
});

test('an unknown engine exits 2 without touching anything', () => {
  const r = run(['--engine', 'banana', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /banana/);
});

test('--revert is gone and says so, with exit 2', () => {
  const r = run(['--revert']);
  assert.equal(r.code, 2, 'a silent no-op would let someone believe bridge mode was undone');
  assert.match(r.err, /--uninstall/);
});

test('--port rejects a non-numeric value with exit 2', () => {
  const r = run(['--port', 'http://3000', '--yes']);
  assert.equal(r.code, 2);
  assert.match(r.err, /port/i);
});

test('the exit-code table is documented in the header', () => {
  const r = run(['--help']);
  for (const line of ['0 ', '1 ', '2 ', '4 ', '5 ']) assert.ok(r.out.includes(line), `${r.out}`);
  assert.match(r.out, /4[^\n]*health/i);
  assert.match(r.out, /5[^\n]*gateway/i);
});

// Run with: npm test   (scripts/**/*.test.ts is in the test glob). Spawns the real node helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'write-update-receipt.js');

function run(input: string, args: string[]): { oldSha: string; newSha: string; branch?: string; appliedAt: string; changes: string[] } {
  const out = execFileSync('node', [SCRIPT, ...args], { input, encoding: 'utf8' });
  return JSON.parse(out);
}

test('builds a receipt from stdin log + argv', () => {
  const r = run('a123456 first commit\nb234567 second commit\n', ['a'.repeat(40), 'b'.repeat(40), 'main']);
  assert.equal(r.oldSha, 'a'.repeat(40));
  assert.equal(r.newSha, 'b'.repeat(40));
  assert.equal(r.branch, 'main');
  assert.deepEqual(r.changes, ['a123456 first commit', 'b234567 second commit']);
  assert.ok(typeof r.appliedAt === 'string' && r.appliedAt.length > 0);
});

test('caps changes at 50 lines and drops blank lines', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `sha${i} commit ${i}`).join('\n') + '\n\n\n';
  const r = run(lines, ['a'.repeat(40), 'c'.repeat(40), 'main']);
  assert.equal(r.changes.length, 50);
  assert.equal(r.changes[0], 'sha0 commit 0');
});

test('omits branch when not provided', () => {
  const r = run('x000000 only\n', ['a'.repeat(40), 'b'.repeat(40), '']);
  assert.equal(r.branch, undefined);
});

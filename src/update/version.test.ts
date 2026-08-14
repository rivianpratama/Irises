// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStamp, getVersion, _resetVersionForTests } from './version.js';

test('parseStamp reads a valid stamp', () => {
  const v = parseStamp(JSON.stringify({ sha: '1CE8EF57636D90BC26C0C96D97F2AC6A57380855', branch: 'main', builtAt: '2026-01-01T00:00:00.000Z' }));
  assert.ok(v);
  assert.equal(v!.sha, '1ce8ef57636d90bc26c0c96d97f2ac6a57380855'); // lowercased
  assert.equal(v!.shortSha, '1ce8ef5');
  assert.equal(v!.branch, 'main');
  assert.equal(v!.source, 'stamp');
});

test('parseStamp rejects a gitless stamp (sha:null) and malformed input', () => {
  assert.equal(parseStamp(JSON.stringify({ sha: null, builtAt: 'x' })), null);
  assert.equal(parseStamp(JSON.stringify({ sha: 'not-a-sha' })), null);
  assert.equal(parseStamp('{ not json'), null);
  assert.equal(parseStamp('{}'), null);
});

test('parseStamp tolerates a missing branch', () => {
  const v = parseStamp(JSON.stringify({ sha: 'abcdef1234567890abcdef1234567890abcdef12' }));
  assert.ok(v);
  assert.equal(v!.branch, null);
  assert.equal(v!.builtAt, null);
});

test('getVersion returns a coherent shape and caches', () => {
  _resetVersionForTests();
  const v = getVersion();
  assert.ok(['stamp', 'git', 'unknown'].includes(v.source));
  if (v.sha) {
    assert.match(v.sha, /^[0-9a-f]{40}$/);
    assert.equal(v.shortSha, v.sha.slice(0, 7));
  } else {
    assert.equal(v.source, 'unknown');
    assert.equal(v.shortSha, null);
  }
  assert.strictEqual(getVersion(), v); // cached (same object)
});

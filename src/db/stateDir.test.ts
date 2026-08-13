// Run with: npm test   (TZ=UTC tsx --test)
// State-dir resolution + handle encoding on the sqlite driver, with a throwaway
// IRISES_HOME so nothing touches the real ~/.irises.
//
// NOTE: static imports are hoisted (ESM semantics, honored by tsx even in CJS
// emit), so an env assignment in the module body runs AFTER them. The module
// under test is loaded with a dynamic import() inside before(), which runs
// after these assignments.
process.env.DATA_BACKEND = 'sqlite';
process.env.IRISES_HOME = '';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

let sd: typeof import('./stateDir.js');
before(async () => {
  sd = await import('./stateDir.js');
});

test('irisesHome resolves at CALL time — env changes after import take effect', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'irises-test-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'irises-test-b-'));
  try {
    process.env.IRISES_HOME = a;
    assert.equal(sd.irisesHome(), path.resolve(a));
    assert.equal(sd.dbPath(), path.join(path.resolve(a), 'irises.db'));
    process.env.IRISES_HOME = b;
    assert.equal(sd.irisesHome(), path.resolve(b));
  } finally {
    process.env.IRISES_HOME = '';
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('irisesHome defaults to ~/.irises and expands a leading tilde', () => {
  process.env.IRISES_HOME = '';
  assert.equal(sd.irisesHome(), path.join(os.homedir(), '.irises'));
  process.env.IRISES_HOME = '~/irises-tilde-test';
  assert.equal(sd.irisesHome(), path.join(os.homedir(), 'irises-tilde-test'));
  process.env.IRISES_HOME = '';
});

test('encodeHandle: filesystem-hostile characters become %XX bytes', () => {
  assert.equal(sd.encodeHandle('sam'), 'sam');
  assert.equal(sd.encodeHandle('web:guest'), 'web%3Aguest');
  assert.equal(sd.encodeHandle('+15551234'), '%2B15551234');
  assert.equal(sd.encodeHandle('eng:whatsapp:+62812'), 'eng%3Awhatsapp%3A%2B62812');
  // multi-byte chars encode per UTF-8 byte
  assert.equal(sd.encodeHandle('ɑ'), '%C9%91');
});

test('encodeHandle is injective where naive schemes collide', () => {
  // '%' itself is always escaped, so no percent-ambiguity
  assert.notEqual(sd.encodeHandle('%1'), sd.encodeHandle('ɑ'));
  assert.notEqual(sd.encodeHandle('a_b'), sd.encodeHandle('a:b'));
});

test('encodeHandle guards the dirname edge cases', () => {
  assert.equal(sd.encodeHandle(''), '%');
  assert.equal(sd.encodeHandle('.'), '%2E');
  assert.equal(sd.encodeHandle('..'), '%2E%2E');
  // Windows strips a trailing dot from dirnames — encoded so 'web.' ≠ 'web'
  assert.equal(sd.encodeHandle('web.'), 'web%2E');
});

test('memoriesDir scopes per encoded handle under <home>/memories', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'irises-test-m-'));
  try {
    process.env.IRISES_HOME = a;
    assert.equal(sd.memoriesDir('web:guest'), path.join(path.resolve(a), 'memories', 'web%3Aguest'));
  } finally {
    process.env.IRISES_HOME = '';
    fs.rmSync(a, { recursive: true, force: true });
  }
});

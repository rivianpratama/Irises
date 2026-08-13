// Run with: npm test   (TZ=UTC tsx --test)
// The shared file primitives: atomic replace with no temp residue, the
// "unreadable is not empty" read guard, and append-only ledger writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { atomicWriteText, readTextIfExists, appendText } from './files.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'irises-files-'));
}

test('atomicWriteText creates parents, replaces content, leaves no temp residue', () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'nested', 'LONG.md');
    atomicWriteText(target, 'v1');
    assert.equal(fs.readFileSync(target, 'utf8'), 'v1');
    atomicWriteText(target, 'v2 — replaced');
    assert.equal(fs.readFileSync(target, 'utf8'), 'v2 — replaced');
    const leftovers = fs.readdirSync(path.dirname(target)).filter(f => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextIfExists: null on missing, content when present, THROWS on non-ENOENT', () => {
  const dir = tempDir();
  try {
    assert.equal(readTextIfExists(path.join(dir, 'absent.md')), null);
    const f = path.join(dir, 'present.md');
    fs.writeFileSync(f, 'hello');
    assert.equal(readTextIfExists(f), 'hello');
    // A directory at the path is "present but unreadable as a file" — must throw
    // (EISDIR/EPERM), never masquerade as empty/missing.
    assert.throws(() => readTextIfExists(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendText appends in order and creates the parent dir', () => {
  const dir = tempDir();
  try {
    const f = path.join(dir, 'sub', 'MEDIUM.archive.md');
    appendText(f, 'first');
    appendText(f, '\n§\nsecond');
    assert.equal(fs.readFileSync(f, 'utf8'), 'first\n§\nsecond');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

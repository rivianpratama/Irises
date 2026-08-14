// Run with: npm test   (DATA_BACKEND=memory → $IRISES_HOME is a throwaway temp dir)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { consumeUpdateReceipt, shouldAnnounceReceipt } from './receipt.js';
import { irisesHome } from '../db/stateDir.js';

function receiptPath(): string { return join(irisesHome(), 'update-receipt.json'); }
function updatesDir(): string { return join(irisesHome(), 'updates'); }

beforeEach(() => {
  fs.rmSync(receiptPath(), { force: true });
  fs.rmSync(join(irisesHome(), 'update-receipt.bad.json'), { force: true });
  fs.rmSync(updatesDir(), { recursive: true, force: true });
});

test('consume parses a valid receipt, archives it, and is at-most-once', () => {
  fs.writeFileSync(receiptPath(), JSON.stringify({
    oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), branch: 'main',
    appliedAt: '2026-01-01T00:00:00.000Z', changes: ['b234567 first', 'a123456 second'],
  }));
  const r = consumeUpdateReceipt();
  assert.ok(r);
  assert.equal(r!.newSha, 'b'.repeat(40));
  assert.deepEqual(r!.changes, ['b234567 first', 'a123456 second']);
  // original consumed (renamed away) → next read is null
  assert.equal(fs.existsSync(receiptPath()), false);
  assert.equal(consumeUpdateReceipt(), null);
  // archived under updates/
  const archived = fs.readdirSync(updatesDir());
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^applied-bbbbbbb-\d+\.json$/);
});

test('consume caps changes at 50 lines', () => {
  const changes = Array.from({ length: 80 }, (_, i) => `sha${i} commit ${i}`);
  fs.writeFileSync(receiptPath(), JSON.stringify({ oldSha: 'a'.repeat(40), newSha: 'c'.repeat(40), appliedAt: 'x', changes }));
  const r = consumeUpdateReceipt();
  assert.equal(r!.changes.length, 50);
});

test('malformed receipt is archived as .bad and returns null', () => {
  fs.writeFileSync(receiptPath(), '{ not json');
  assert.equal(consumeUpdateReceipt(), null);
  assert.equal(fs.existsSync(join(irisesHome(), 'update-receipt.bad.json')), true);
  assert.equal(fs.existsSync(receiptPath()), false);
});

test('shouldAnnounceReceipt: only when the running build IS the target (null = benefit of doubt)', () => {
  const r = { oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), appliedAt: 'x', changes: [] };
  assert.equal(shouldAnnounceReceipt(r, 'b'.repeat(40)), true);
  assert.equal(shouldAnnounceReceipt(r, 'B'.repeat(40)), true);  // case-insensitive
  assert.equal(shouldAnnounceReceipt(r, 'd'.repeat(40)), false); // upgrade didn't take
  assert.equal(shouldAnnounceReceipt(r, null), true);            // unknown build
});

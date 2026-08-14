// Run with: npm test   (DATA_BACKEND=memory → $IRISES_HOME is a throwaway temp dir)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import fs from 'node:fs';
import { loadUpdateState, saveUpdateState, recordCheck, claimAnnouncement, _resetStateForTests } from './state.js';
import { irisesHome } from '../db/stateDir.js';

beforeEach(() => _resetStateForTests());

function statePath(): string {
  return join(irisesHome(), 'update-state.json');
}

test('claimAnnouncement is a one-shot test-and-set per (sha, chat)', () => {
  assert.equal(claimAnnouncement('sha1', 'web:a'), true);
  assert.equal(claimAnnouncement('sha1', 'web:a'), false); // same → false
  assert.equal(claimAnnouncement('sha1', 'web:b'), true);  // different chat → true
});

test('a new remoteSha prunes the previous sha\'s announced map', () => {
  claimAnnouncement('sha1', 'web:a');
  assert.ok(loadUpdateState().announced['sha1']?.['web:a']);
  recordCheck('sha2', true); // new remote → prune old
  const s = loadUpdateState();
  assert.equal(s.remoteSha, 'sha2');
  assert.equal(s.announced['sha1'], undefined);
});

test('recordCheck persists check outcome; failure keeps remoteSha', () => {
  recordCheck('sha1', true);
  let s = loadUpdateState();
  assert.equal(s.remoteSha, 'sha1');
  assert.equal(s.lastCheckOk, true);
  recordCheck(null, false);
  s = loadUpdateState();
  assert.equal(s.remoteSha, 'sha1');   // unchanged on failure
  assert.equal(s.lastCheckOk, false);
});

test('a corrupt state file loads as a fresh state, never throws', () => {
  fs.writeFileSync(statePath(), '{ not valid json');
  const s = loadUpdateState();
  assert.equal(s.remoteSha, null);
  assert.deepEqual(s.announced, {});
});

test('saveUpdateState prunes announced to the current remoteSha', () => {
  saveUpdateState({ remoteSha: 'shaX', remoteSeenAt: 1, lastCheckAt: 1, lastCheckOk: true, announced: { shaX: { 'web:a': 1 }, shaOld: { 'web:z': 1 } } });
  const s = loadUpdateState();
  assert.deepEqual(Object.keys(s.announced), ['shaX']);
});

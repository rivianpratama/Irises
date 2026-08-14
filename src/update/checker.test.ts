// Run with: npm test   (DATA_BACKEND=memory). Git/network are injected via CheckerSeams, so these
// tests never shell out.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkOnce, getUpdateStatus, _resetCheckerForTests, type CheckerSeams } from './checker.js';
import { _resetStateForTests } from './state.js';
import { getRecentErrors, _test as errTest } from '../diagnostics/errorLog.js';
import type { VersionInfo } from './version.js';

const CURRENT: VersionInfo = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', branch: 'main', builtAt: null, source: 'stamp' };
const REMOTE = 'b'.repeat(40);

beforeEach(() => {
  _resetCheckerForTests();
  _resetStateForTests();
  errTest.reset();
});

function updateCheckErrors(): number {
  return getRecentErrors().filter(e => e.category === 'update_check').length;
}

test('a new remote sha marks available and fires onDetected exactly once', async () => {
  const fired: string[] = [];
  const seams: CheckerSeams = { current: CURRENT, lsRemote: async () => REMOTE, isAncestorOfRunning: async () => false, onDetected: s => fired.push(s) };
  await checkOnce(seams);
  await checkOnce(seams); // same remote on the next tick → no re-fire
  assert.deepEqual(fired, [REMOTE]);
  assert.equal(getUpdateStatus().updateAvailable, true);
  assert.equal(getUpdateStatus().remoteSha, REMOTE);
});

test('remote equal to current → not an update, no event', async () => {
  const fired: string[] = [];
  await checkOnce({ current: CURRENT, lsRemote: async () => CURRENT.sha!, isAncestorOfRunning: async () => false, onDetected: s => fired.push(s) });
  assert.deepEqual(fired, []);
  assert.equal(getUpdateStatus().updateAvailable, false);
});

test('remote already contained in the running build (local ahead) → not an update', async () => {
  const fired: string[] = [];
  await checkOnce({ current: CURRENT, lsRemote: async () => REMOTE, isAncestorOfRunning: async () => true, onDetected: s => fired.push(s) });
  assert.deepEqual(fired, []);
  assert.equal(getUpdateStatus().updateAvailable, false);
});

test('pull-before-restart stays available: ancestry is vs the running build, not the worktree HEAD', async () => {
  // After `git pull`, HEAD==remote but the process still runs the old build. isAncestorOfRunning
  // (remote vs the RUNNING sha) returns false → the "update pending" signal correctly stays true.
  const fired: string[] = [];
  await checkOnce({ current: CURRENT, lsRemote: async () => REMOTE, isAncestorOfRunning: async () => false, onDetected: s => fired.push(s) });
  assert.equal(getUpdateStatus().updateAvailable, true);
});

test('inconclusive ancestry (object not present locally) → treated as an update', async () => {
  const fired: string[] = [];
  await checkOnce({ current: CURRENT, lsRemote: async () => REMOTE, isAncestorOfRunning: async () => null, onDetected: s => fired.push(s) });
  assert.deepEqual(fired, [REMOTE]);
  assert.equal(getUpdateStatus().updateAvailable, true);
});

test('failures never throw, mark lastCheckOk=false, and warn only at the 3rd consecutive miss', async () => {
  const seams: CheckerSeams = { current: CURRENT, lsRemote: async () => { throw new Error('offline'); } };
  await checkOnce(seams);
  await checkOnce(seams);
  assert.equal(updateCheckErrors(), 0);       // first two are quiet (console only)
  await checkOnce(seams);
  assert.equal(updateCheckErrors(), 1);        // third folds one warn row
  assert.equal(getUpdateStatus().lastCheckOk, false);
});

// Run with: npm test   (DATA_BACKEND=memory). The detached spawn is injected so nothing is launched.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestSelfUpdate, selfUpdateEnabled, statusToOutcome } from './selfUpdate.js';

beforeEach(() => { delete process.env.UPDATE_SELF_ENABLED; });

test('selfUpdateEnabled defaults on and honors the off-switch', () => {
  assert.equal(selfUpdateEnabled(), true);
  process.env.UPDATE_SELF_ENABLED = 'false';
  assert.equal(selfUpdateEnabled(), false);
});

test('disabled → a "switched off" failure, no spawn', async () => {
  process.env.UPDATE_SELF_ENABLED = 'false';
  let spawned = false;
  const o = await requestSelfUpdate('web:a', undefined, { spawnUpdater: () => { spawned = true; } });
  assert.equal(o.kind, 'failed');
  assert.match(o.summary, /switched off/);
  assert.equal(spawned, false);
});

test('enabled + injected spawn → spawns the updater and acks "on it"', async () => {
  let spawned = false;
  const o = await requestSelfUpdate('web:a', undefined, { spawnUpdater: () => { spawned = true; } });
  assert.equal(spawned, true);
  assert.equal(o.kind, 'confirmed');
});

test('a spawn failure degrades to a voiced "couldn\'t start" rather than throwing', async () => {
  const o = await requestSelfUpdate('web:a', undefined, { spawnUpdater: () => { throw new Error('no bash'); } });
  assert.equal(o.kind, 'failed');
  assert.match(o.summary, /couldn't kick off/);
});

test('statusToOutcome: noop → already-current; failure → phase-specific, changelog-free', () => {
  const noop = statusToOutcome({ ok: true, phase: 'noop', at: 1 });
  assert.equal(noop.kind, 'nothing_found');
  assert.match(noop.summary, /already on the latest/);

  const build = statusToOutcome({ ok: false, phase: 'build', at: 1 });
  assert.equal(build.kind, 'failed');
  assert.match(build.summary, /didn't build/);

  const dirty = statusToOutcome({ ok: false, phase: 'preflight', at: 1 });
  assert.match(dirty.summary, /uncommitted changes/);

  const unknown = statusToOutcome({ ok: false, at: 1 });
  assert.equal(unknown.kind, 'failed');
  assert.ok(unknown.summary.length > 0);

  // Applied to disk but couldn't restart itself → a "grabbed it, needs a restart" confirmation.
  const restart = statusToOutcome({ ok: true, phase: 'restart', at: 1 });
  assert.equal(restart.kind, 'confirmed');
  assert.match(restart.summary, /restart/);
});

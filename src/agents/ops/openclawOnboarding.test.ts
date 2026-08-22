// Run with: npm test   (DATA_BACKEND=memory → $IRISES_HOME is a throwaway temp dir)
// The gates that matter here are all "never send twice, never wedge a boot": the engine-name gate,
// the content-version gate, the retry ladder, and the operator's off switch.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import fs from 'node:fs';
import { ensureEngineOnboarded, loadOnboardingState, saveOnboardingState, _resetOnboardingForTests, type OnboardingDeps } from './openclawOnboarding.js';
import { onboardingVersion } from './openclawDoctrine.js';
import { irisesHome } from '../../db/stateDir.js';
import type { EngineBackend } from './engineBackend.js';

beforeEach(() => _resetOnboardingForTests());

function statePath(): string {
  return join(irisesHome(), 'engine-onboarding.json');
}

/** An engine stub that records its onboarding sends. `sendOnboarding` is present even on the hermes
 *  stub, so the name gate is what's actually under test there. */
function fakeEngine(name: 'hermes' | 'openclaw', opts: { fail?: boolean } = {}) {
  const sends: Array<{ text: string; version: string }> = [];
  const engine: EngineBackend = {
    name,
    async runTask() { return ''; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    async sendOnboarding(text: string, version: string) {
      sends.push({ text, version });
      if (opts.fail) throw new Error('gateway not listening yet');
      return 'OK';
    },
  };
  return { engine, sends };
}

type FakeTimer = { ms: number; fire: () => void; unrefs: number };
function fakeTimers() {
  const timers: FakeTimer[] = [];
  const setTimer: OnboardingDeps['setTimer'] = (fn, ms) => {
    const t: FakeTimer = { ms, fire: fn, unrefs: 0 };
    timers.push(t);
    return { unref: () => { t.unrefs += 1; } };
  };
  return { timers, setTimer };
}

/** Let a timer-fired attempt (started with `void attempt(…)`) run to completion. */
const settle = () => new Promise(r => setTimeout(r, 0));

test('a hermes engine is never onboarded automatically — its send is a documented manual step', async () => {
  const { engine, sends } = fakeEngine('hermes');
  const { timers, setTimer } = fakeTimers();
  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 1, setTimer });
  assert.equal(sends.length, 0);
  assert.equal(timers.length, 0);
  assert.equal(fs.existsSync(statePath()), false, 'no state file for an engine that never onboards');
});

test('no engine configured at boot is a plain no-op', async () => {
  const { timers, setTimer } = fakeTimers();
  await ensureEngineOnboarded({ getEngine: () => null, now: () => 1, setTimer });
  assert.equal(fs.existsSync(statePath()), false);
  assert.equal(timers.length, 0);
});

test('openclaw first boot: the doctrine is sent once and the version flag lands', async () => {
  const { engine, sends } = fakeEngine('openclaw');
  const { timers, setTimer } = fakeTimers();

  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 1_700_000, setTimer });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].version, onboardingVersion());
  assert.match(sends[0].text, /## Engine mode \(requests from the Irises front line\)/);
  const stored = loadOnboardingState().openclaw;
  assert.equal(stored?.version, onboardingVersion());
  assert.equal(stored?.sentAt, 1_700_000);
  assert.equal(stored?.reply, 'OK');
  assert.equal(timers.length, 0, 'a successful send arms no retry');

  // Second call in the same process: the chain guard alone stops it, no second send.
  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 1_700_001, setTimer });
  assert.equal(sends.length, 1);
});

test('a stored current version stops a fresh boot before any send', async () => {
  const { engine, sends } = fakeEngine('openclaw');
  const { setTimer } = fakeTimers();
  saveOnboardingState({ openclaw: { version: onboardingVersion(), sentAt: 5, reply: 'OK' } });

  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 9, setTimer });

  assert.equal(sends.length, 0);
  assert.equal(loadOnboardingState().openclaw?.sentAt, 5, 'the existing record is left alone');
});

test('a stale stored version re-onboards — editing the doctrine changes its hash', async () => {
  const { engine, sends } = fakeEngine('openclaw');
  const { setTimer } = fakeTimers();
  saveOnboardingState({ openclaw: { version: 'deadbeef', sentAt: 5, reply: 'OK' } });

  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 9, setTimer });

  assert.equal(sends.length, 1);
  assert.equal(loadOnboardingState().openclaw?.version, onboardingVersion());
});

test('a corrupt state file reads as never-onboarded, never throws', async () => {
  fs.writeFileSync(statePath(), '{ not valid json');
  assert.deepEqual(loadOnboardingState(), {});
  const { engine, sends } = fakeEngine('openclaw');
  const { setTimer } = fakeTimers();

  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 9, setTimer });

  assert.equal(sends.length, 1);
  assert.equal(loadOnboardingState().openclaw?.version, onboardingVersion());
});

test('a failed send writes no flag, retries at 30s/2min/10min, then gives up until the next boot', async () => {
  const { engine, sends } = fakeEngine('openclaw', { fail: true });
  const { timers, setTimer } = fakeTimers();

  await ensureEngineOnboarded({ getEngine: () => engine, now: () => 1, setTimer });

  assert.equal(sends.length, 1);
  assert.equal(loadOnboardingState().openclaw, undefined, 'nothing stored — a lost send must retry');
  assert.deepEqual(timers.map(t => t.ms), [30_000]);

  for (let i = 0; i < 3; i++) {
    timers[timers.length - 1].fire();
    await settle();
  }

  assert.equal(sends.length, 4, 'the first send plus three retries');
  assert.deepEqual(timers.map(t => t.ms), [30_000, 120_000, 600_000], 'ladder spent — no fourth rung armed');
  assert.ok(timers.every(t => t.unrefs === 1), 'every retry timer is unref\'d — onboarding never holds the process open');
  assert.equal(fs.existsSync(statePath()), false);
});

test('ENGINE_ONBOARDING=off is a hard no-op — the operator curates the engine by hand', async () => {
  const prev = process.env.ENGINE_ONBOARDING;
  process.env.ENGINE_ONBOARDING = 'OFF';
  try {
    const { engine, sends } = fakeEngine('openclaw');
    const { timers, setTimer } = fakeTimers();
    await ensureEngineOnboarded({ getEngine: () => engine, now: () => 1, setTimer });
    assert.equal(sends.length, 0);
    assert.equal(timers.length, 0);
    assert.equal(fs.existsSync(statePath()), false);
  } finally {
    if (prev === undefined) delete process.env.ENGINE_ONBOARDING; else process.env.ENGINE_ONBOARDING = prev;
  }
});

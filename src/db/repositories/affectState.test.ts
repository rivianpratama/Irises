// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests } from '../sqlite.js';
import { getAffectState, saveAffectState, clearAffectState } from './affectState.js';
import { coerceStatus, mergeStatus, MOOD_HISTORY_CAP, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';

beforeEach(() => resetStorageForTests());

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 16, 0, 0), 'UTC'),
};

function status(level: number, at: number) {
  const emitted = coerceStatus({
    mood_core: 'peaceful', mood_label: 'content', mood_level: level,
    anxiety: 20, warmth: 70, social_battery: 60, rapport: 50, conviction: 55,
    engagement: 65, patience: 70, intent_mode: 'questioning', epistemic_trigger: 'none',
    meta_prompt: 'steady', profile_note: 'calm', terminal_closure: false,
  })!;
  return mergeStatus(emitted, COMPUTED, at);
}

test('an unknown chat returns an empty state', async () => {
  const s = await getAffectState('chat-none');
  assert.equal(s.last, undefined);
  assert.deepEqual(s.moodHistory, []);
});

test('save then get round-trips the last status and seeds the mood trail', async () => {
  await saveAffectState('chat-a', status(60, 1000));
  const s = await getAffectState('chat-a');
  assert.equal(s.last?.mood_level, 60);
  assert.equal(s.last?.cycle_phase, COMPUTED.cycle.phase);
  assert.equal(s.moodHistory.length, 1);
  assert.equal(s.moodHistory[0].level, 60);
});

test('repeated saves keep the latest as `last` and cap the mood trail', async () => {
  for (let i = 0; i < MOOD_HISTORY_CAP + 4; i++) {
    await saveAffectState('chat-b', status(i, i));
  }
  const s = await getAffectState('chat-b');
  assert.equal(s.moodHistory.length, MOOD_HISTORY_CAP);
  assert.equal(s.last?.mood_level, MOOD_HISTORY_CAP + 3); // newest
  assert.equal(s.moodHistory[s.moodHistory.length - 1].level, MOOD_HISTORY_CAP + 3);
});

test('clear removes the row', async () => {
  await saveAffectState('chat-c', status(50, 1));
  await clearAffectState('chat-c');
  const s = await getAffectState('chat-c');
  assert.equal(s.last, undefined);
});

// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import { getAffectState, saveAffectState, clearAffectState } from './affectState.js';
import {
  coerceStatus, mergeStatus, MOOD_HISTORY_CAP, type AffectStatus, type ComputedState,
} from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { GAUGE_SPECS } from '../../persona/affectDrift.js';

beforeEach(() => resetStorageForTests());

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)),
  circadian: computeCircadian(Date.UTC(2026, 0, 6, 16, 0, 0), 'UTC'),
};

/** A row to save. `mood_level` is code's answer now (persona/affectDrift.ts), so the level a
 *  round-trip test wants to recognise is STATED on the record rather than emitted into it. */
function status(level: number, at: number, extra: Partial<AffectStatus> = {}): AffectStatus {
  const emitted = coerceStatus({
    mood_label: 'content', mood_shift: 'steady', intent_mode: 'questioning',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'steady',
  })!;
  return { ...mergeStatus(emitted, COMPUTED, at), mood_level: level, ...extra };
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

// The gauge LEDGER round-trips, because the two rolling budgets are counted off it: a `broke` that
// forgot itself would let the next turn spend the same six hours again, and an hour of mood rows
// that vanished would hand a spent budget back (persona/affectDrift.ts).
test('the gauge ledger round-trips, and a garbled one degrades to an empty budget history', async () => {
  await saveAffectState('chat-d', status(60, 1000, {
    moves: [{ at: 900, k: 'mood_level', d: -8, broke: true }, { at: 900, k: 'rapport', d: 1 }],
  }));
  const s = await getAffectState('chat-d');
  assert.deepEqual(s.last?.moves, [
    { at: 900, k: 'mood_level', d: -8, broke: true },
    { at: 900, k: 'rapport', d: 1 },
  ]);
});

// THE migration case, end to end: the row on disk the morning after this deploys. It was written by
// the v1 envelope — seventeen keys, ten of them dead, no `mood_shift`, no ledger — and her state has
// to come back off it rather than resetting.
test('a legacy row written before the shrink loads with her gauges intact', async () => {
  const legacy = {
    mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
    anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
    engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat', profile_note: 'warm', terminal_closure: false,
    cycle_phase: 'menstrual', cycle_day: 1, cycle_load: 80,
    circadian_slot: 'afternoon_peak', circadian_energy: 70, at: 1234,
  };
  stmt(
    `INSERT INTO affect_state (chat_id, status_json, mood_history_json, updated_at) VALUES (?, ?, ?, ?)`
  ).run('chat-legacy', JSON.stringify(legacy), '[]', 1234);

  const s = await getAffectState('chat-legacy');
  assert.equal(s.last?.mood_level, 72, 'the level she was actually at, not a default and never 0');
  assert.equal(s.last?.warmth, 80);
  assert.equal(s.last?.patience, 75);
  assert.equal(s.last?.mood_core, 'powerful', 'derived from the word she reported');
  assert.equal(s.last?.mood_shift, 'steady', 'v1 had no shift to report');
  assert.deepEqual(s.last?.moves, []);
  for (const spec of GAUGE_SPECS) assert.ok(s.last![spec.key] >= 1, `${spec.key} came back below 1`);
  // The dead keys are gone from the record — not carried along as ballast on every save from here on.
  for (const dead of ['conviction', 'engagement', 'profile_note']) {
    assert.equal(dead in (s.last as object), false, `${dead} survived the read`);
  }
});

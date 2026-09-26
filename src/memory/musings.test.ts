// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Her own texts, and the one bound the familiarity mask adds to them: she texts first only someone
// she knows (familiar or close). A stranger, including someone with no row yet, is skipped for
// `familiarity`, and with the mask switched off the bound does not exist. `deliver` is always a spy,
// and `rand` always loses the chance draw, so nothing in this file can text anyone.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  familiarityAllows, runMusingSweep, __resetMusingGuardsForTests, MUSING_QUIET_MS, type MusingMessage,
} from './musings.js';
import { FAMILIARITY_BANDS } from '../persona/familiarity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { addMessage } from '../db/repositories/conversations.js';
import { saveFamiliarity } from '../db/repositories/familiarity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';

const H = '+15550007777';
const CHAT = 'web:musings';

/** One sweep, three hours and a minute after their message, with a chance draw that always loses. */
async function sweep(): Promise<{ calls: MusingMessage[]; considered: number; skipped: Record<string, number> }> {
  const calls: MusingMessage[] = [];
  await runMusingSweep(
    { deliver: async (m: MusingMessage) => { calls.push(m); return 'sent'; } },
    { now: Date.now() + MUSING_QUIET_MS + 60_000, rand: () => 0.99 },
  );
  const detail = (getTraces().find(e => e.label === 'musings:sweep')?.detail ?? {}) as { considered?: number; skipped?: Record<string, number> };
  return { calls, considered: detail.considered ?? 0, skipped: detail.skipped ?? {} };
}

beforeEach(async () => {
  resetStorageForTests();
  __resetMusingGuardsForTests();
  clearTraces();
  delete process.env.CONVO_FAMILIARITY_ENABLED;
  delete process.env.IRISES_MUSINGS_ENABLED;
  await addMessage(CHAT, 'user', 'morning', H);
});
afterEach(() => { delete process.env.CONVO_FAMILIARITY_ENABLED; });

test('she texts first only someone she knows: familiar or close', () => {
  assert.deepEqual(FAMILIARITY_BANDS.filter(familiarityAllows), ['familiar', 'close']);
});

test('the sweep skips a stranger for familiarity, and a missing row is a stranger', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const none = await sweep();
  assert.equal(none.considered, 1);
  assert.equal(none.skipped.familiarity, 1, 'no row yet');
  assert.equal(none.calls.length, 0);

  clearTraces();
  await saveFamiliarity(H, { level: 49, turns: 90, activeDays: 12, lastDay: '2026-09-25' });
  assert.equal((await sweep()).skipped.familiarity, 1, 'an acquaintance is still not enough');
});

test('someone she knows passes the gate and meets the rest of the sweep', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  await saveFamiliarity(H, { level: 50, turns: 200, activeDays: 14, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(Object.values(r.skipped).reduce((n, v) => n + v, 0), 1, 'the one chat was still skipped, by a later bound');
  assert.equal(r.calls.length, 0);
});

test('with the mask off there is no gate, and a stranger row costs the sweep nothing', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await saveFamiliarity(H, { level: 1, turns: 1, activeDays: 1, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(r.calls.length, 0);
});

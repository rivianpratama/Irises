// Run with: npm test   (TZ=UTC tsx --test)
// The daily-reflection seed: idempotence via the stable dedupe key, per-user jitter minute,
// the respect_quiet_hours=false invariant (a 00:00 fire must not defer to 8am), timezone
// derivation (explicit agent_tz > default), and retiming.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureReflexionDaily, dailyJitterMinute, REFLEXION_DAILY_KEY } from './seed.js';
import { setPreference } from '../../db/repositories/memory.js';
import { mem } from '../../db/memory.js';
import type { Automation } from '../../db/types.js';

let seq = 0;
function freshHandle(): string {
  return `+1555400${(seq++).toString().padStart(4, '0')}`;
}
function dailyRow(handle: string): Automation | undefined {
  return [...mem.automations.values()].find(a => a.agentHandle === handle && a.dedupeKey === REFLEXION_DAILY_KEY);
}

test('dailyJitterMinute is stable per handle and inside 0–29', () => {
  const h = '+15551230001';
  const m = dailyJitterMinute(h);
  assert.equal(m, dailyJitterMinute(h)); // stable
  assert.ok(m >= 0 && m < 30);
  // Different handles spread (not all the same minute) — probabilistic but 20 handles all
  // colliding on one minute would be a broken hash.
  const minutes = new Set(Array.from({ length: 20 }, (_, i) => dailyJitterMinute(`+1555999${i}`)));
  assert.ok(minutes.size > 1);
});

test('ensureReflexionDaily creates ONE local-midnight cron row with quiet-hours OFF', async () => {
  const h = freshHandle();
  await ensureReflexionDaily(h, 'chat-A');
  const row = dailyRow(h);
  assert.ok(row, 'row created');
  assert.equal(row!.source, 'reflexion');
  assert.equal(row!.scheduleKind, 'cron');
  assert.equal(row!.cron, `${dailyJitterMinute(h)} 0 * * *`); // midnight local + stable jitter minute
  assert.equal(row!.respectQuietHours, false); // MUST be false or 00:00 defers to 8am
  assert.equal(row!.timezone, 'America/Chicago'); // no tz known → default

  // Idempotent: a second call (fresh throttle window is irrelevant — the dedupe key holds).
  await ensureReflexionDaily(h, 'chat-A');
  const rows = [...mem.automations.values()].filter(a => a.agentHandle === h && a.dedupeKey === REFLEXION_DAILY_KEY);
  assert.equal(rows.length, 1);
});

test('timezone: explicit agent_tz wins; garbage falls back to the default', async () => {
  const hExplicit = freshHandle();
  await setPreference(hExplicit, 'agent_tz', 'America/Denver');
  await ensureReflexionDaily(hExplicit, 'chat-B');
  assert.equal(dailyRow(hExplicit)!.timezone, 'America/Denver');

  const hGarbage = freshHandle();
  await setPreference(hGarbage, 'agent_tz', 'Not/AZone');
  await ensureReflexionDaily(hGarbage, 'chat-D');
  assert.equal(dailyRow(hGarbage)!.timezone, 'America/Chicago');
});

test('retimeAutomation moves the daily row to a new tz + chat and recomputes the next fire', async () => {
  const h = freshHandle();
  await ensureReflexionDaily(h, 'chat-old');
  const before = dailyRow(h)!;
  assert.equal(before.timezone, 'America/Chicago');

  const { retimeAutomation } = await import('../../db/repositories/automations.js');
  await retimeAutomation(h, REFLEXION_DAILY_KEY, 'America/Denver', 'chat-new');
  const after = dailyRow(h)!;
  assert.equal(after.timezone, 'America/Denver');
  assert.equal(after.chatId, 'chat-new');
  assert.ok(Date.parse(after.nextRunAt) > Date.now()); // recomputed for the new zone, still future
});

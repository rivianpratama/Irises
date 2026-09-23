// The create-time hold's time rule, read as a table: when does a new reminder share a slot with one
// that already exists? Content is kept unrelated in every row, so only the schedule decides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCollision, type NewReminder } from './reminderCollision.js';
import type { ReminderRef } from '../ops/engineBackend.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

test('slot collisions: one-shots 10 min apart collide, a one-shot never meets a daily, dailies meet across zones', () => {
  const rows: Array<{ name: string; next: NewReminder; existing: ReminderRef; userTz: string; engineTz: string; collides: boolean }> = [
    {
      name: 'one-shots 10 min apart',
      next: { kind: 'once', fireAt: Date.parse('2026-09-24T09:10:00Z'), title: 'laundry', instruction: 'pick up the laundry' },
      existing: { id: 'aa11bb22cc33', title: 'dentist', schedule: '', kind: 'once', runAt: '2026-09-24T09:00:00+00:00', instruction: 'call the dentist' },
      userTz: 'UTC', engineTz: 'UTC', collides: true,
    },
    {
      name: 'a one-shot vs a daily at the same time',
      next: { kind: 'once', fireAt: Date.parse('2026-09-24T09:00:00Z'), title: 'laundry', instruction: 'pick up the laundry' },
      existing: { id: 'dd44ee55ff66', title: 'standup', schedule: '', kind: 'cron', expr: '0 9 * * *', instruction: 'join the standup call' },
      userTz: 'UTC', engineTz: 'UTC', collides: false,
    },
    {
      // 07:00 in Jakarta is 00:00 UTC: one instant, written in two zones' wall clocks. The new cron is
      // in the user's zone and the existing job's expr is in the engine's.
      name: 'a daily vs a daily at the same wall time across zones',
      next: { kind: 'cron', cron: '0 7 * * *', title: 'govt news', instruction: 'send the government headlines' },
      existing: { id: '2448ff495f3b', title: 'vitamins', schedule: '', kind: 'cron', expr: '0 0 * * *', instruction: 'take the vitamins' },
      userTz: 'Asia/Jakarta', engineTz: 'UTC', collides: true,
    },
  ];
  for (const r of rows) {
    const got = detectCollision(r.next, [r.existing], { userTz: r.userTz, engineTz: r.engineTz, nowMs: NOW });
    assert.equal(got.kind !== 'none', r.collides, r.name);
  }
});

// Quiet-hours defer must RE-ARM a one-time automation. The atomic claim retires a
// one-time row to 'done' (migration 0006 / the in-memory mirror), so a defer that only
// moved next_run_at would leave the row permanently unclaimable — the reminder would
// silently vanish instead of firing at 8am. Runs against the in-memory backend (no
// SUPABASE_URL in tests), whose claim mirrors the RPC's retire-at-claim semantics.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  createAutomation, claimDueAutomations, deferAutomation, deriveDedupeKey,
} = require('./automations.js');

test('defer re-arms a one-time row retired by the atomic claim', async () => {
  const created = await createAutomation({
    agentHandle: 'agent-defer-test', chatId: 'chat1', source: 'email',
    title: null, instruction: 'overnight email flag',
    needsOps: false, opsKind: null,
    scheduleKind: 'once', nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    timezone: 'UTC', respectQuietHours: true, dedupeKey: null,
  });
  assert.ok(created, 'automation should be created');

  // Claim: the in-memory mirror of claim_due_automations retires one-time rows at claim.
  const claimed = await claimDueAutomations(50);
  const mine = claimed.find((a) => a.id === created.id);
  assert.ok(mine, 'row should be claimable when due');
  assert.strictEqual(mine.status, 'done', 'one-time row is retired at claim (0006 semantics)');

  // Quiet hours: defer to "8am". The row must come back active and claimable then.
  const morning = new Date(Date.now() - 1_000).toISOString(); // "8am" already reached, for the test
  await deferAutomation(mine, morning);

  const reclaimed = await claimDueAutomations(50);
  const again = reclaimed.find((a) => a.id === created.id);
  assert.ok(again, 'deferred one-time row must be claimable again — otherwise the reminder is silently lost');
  assert.strictEqual(again.status, 'done', 'and the re-claim retires it once more');
});

test('deriveDedupeKey is stable for same input, distinct for different time', () => {
  const a = deriveDedupeKey('convo', 'remind me about the option period', '2026-07-03T14:00:00.000Z');
  const b = deriveDedupeKey('convo', 'Remind me about the option period  ', '2026-07-03T14:00:00.000Z');
  const c = deriveDedupeKey('convo', 'remind me about the option period', '2026-07-04T14:00:00.000Z');
  assert.strictEqual(a, b, 'trim/case-insensitive stability');
  assert.notStrictEqual(a, c, 'different fire time makes a different key');
});

test('a second identical schedule request dedupes to one row', async () => {
  const fireAt = new Date(Date.now() + 3_600_000).toISOString();
  const key = deriveDedupeKey('convo', 'ping me about the maple closing', fireAt);
  const first = await createAutomation({
    agentHandle: 'agent-dedupe-test', chatId: 'chat1', source: 'convo',
    title: null, instruction: 'ping me about the maple closing',
    needsOps: false, opsKind: null,
    scheduleKind: 'once', nextRunAt: fireAt,
    timezone: 'UTC', respectQuietHours: false, dedupeKey: key,
  });
  const second = await createAutomation({
    agentHandle: 'agent-dedupe-test', chatId: 'chat1', source: 'convo',
    title: null, instruction: 'ping me about the maple closing',
    needsOps: false, opsKind: null,
    scheduleKind: 'once', nextRunAt: fireAt,
    timezone: 'UTC', respectQuietHours: false, dedupeKey: key,
  });
  assert.ok(first && second);
  assert.strictEqual(second.id, first.id, 'same dedupe key returns the existing row');
});

// Run with: npm test   (TZ=UTC tsx --test)
// The Autonome runner's SILENT reflexion branch: a claimed reflexion row must never voice
// (sendFollowUp untouched), and its schedule advances BEFORE the run (at-most-once — a
// lease-lapse must not double an expensive Opus pass). Ordinary reminder rows keep voicing.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAutonomeOnce } from './automations.js';
import { createAutomation } from '../db/repositories/automations.js';
import { mem } from '../db/memory.js';
import type { Automation } from '../db/types.js';

let seq = 0;
function freshHandle(): string {
  return `+1555500${(seq++).toString().padStart(4, '0')}`;
}

function rowsFor(handle: string): Automation[] {
  return [...mem.automations.values()].filter(a => a.agentHandle === handle);
}

function makeSpy() {
  const calls: string[] = [];
  const sendFollowUp = async (chatId: string) => { calls.push(chatId); return 'sent'; };
  return { calls, sendFollowUp };
}

test('a due reflexion CRON row never voices and is rescheduled BEFORE the run', async () => {
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'reflexion',
    title: 'daily memory reflection', instruction: 'daily reflection pass',
    scheduleKind: 'cron', cron: '7 0 * * *', timezone: 'America/Chicago',
    respectQuietHours: false, dedupeKey: 'reflexion:daily',
  });
  assert.ok(created);
  // Rewind so this tick claims it. (createAutomation computed the next future occurrence.)
  mem.automations.set(created!.id, { ...mem.automations.get(created!.id)!, nextRunAt: new Date(Date.now() - 1000).toISOString() });

  const { calls, sendFollowUp } = makeSpy();
  // With no chat history, no short-term entries, and no legacy memory, the queued daily run
  // passes through the skip-if-quiet gate — zero LLM calls in this test.
  await runAutonomeOnce(sendFollowUp);
  // Give the detached (void) run a beat to hit the quiet gate and settle.
  await new Promise(r => setTimeout(r, 50));

  assert.deepEqual(calls, []); // SILENT: the mouth was never touched
  const after = rowsFor(h)[0];
  assert.equal(after.status, 'active'); // cron series stays alive
  assert.ok(Date.parse(after.nextRunAt) > Date.now(), 'rescheduled to the next occurrence');
});

test('a due reflexion ONCE row (self-wake) is retired at claim and never voices', async () => {
  const prevEnabled = process.env.REFLEXION_ENABLED;
  process.env.REFLEXION_ENABLED = 'false'; // wake runs skip the quiet gate; kill switch keeps the test LLM-free
  try {
    const h = freshHandle();
    const created = await createAutomation({
      agentHandle: h, chatId: `chat-${h}`, source: 'reflexion',
      title: 'reflexion self-wake', instruction: 'reconcile the lender thread',
      scheduleKind: 'once', nextRunAt: new Date(Date.now() - 1000).toISOString(),
      respectQuietHours: false, dedupeKey: 'reflexion-wake:test',
    });
    assert.ok(created);

    const { calls, sendFollowUp } = makeSpy();
    await runAutonomeOnce(sendFollowUp);
    await new Promise(r => setTimeout(r, 20));

    assert.deepEqual(calls, []); // silent
    assert.equal(rowsFor(h)[0].status, 'done'); // one-shot retired — can never re-fire
  } finally {
    if (prevEnabled === undefined) delete process.env.REFLEXION_ENABLED;
    else process.env.REFLEXION_ENABLED = prevEnabled;
  }
});

test('an ordinary reminder row still voices through sendFollowUp', async () => {
  const h = freshHandle();
  const created = await createAutomation({
    agentHandle: h, chatId: `chat-${h}`, source: 'convo',
    title: 'call the lender', instruction: 'remind them to call the lender',
    scheduleKind: 'once', nextRunAt: new Date(Date.now() - 1000).toISOString(),
    respectQuietHours: false, dedupeKey: 'test:plain-reminder',
  });
  assert.ok(created);

  const { calls, sendFollowUp } = makeSpy();
  await runAutonomeOnce(sendFollowUp);

  assert.deepEqual(calls, [`chat-${h}`]); // the mouth got the voicer thunk
});

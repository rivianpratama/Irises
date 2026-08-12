// buildReflexionSeed — the pure seed assembler. DATA_BACKEND=memory + UTC before imports (the module
// graph pulls in the tier repos via ./tools.js, though the builder itself does no IO).
process.env.DATA_BACKEND = 'memory';
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReflexionSeed, type ReflexionSeedInput } from './seedBuilder.js';
import type { StoredMessage } from '../../db/types.js';
import type { MediumEntry } from '../../db/repositories/memoryMedium.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';

const H = '+15550002000';
const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const DAY = 86_400_000;

function base(over: Partial<ReflexionSeedInput> = {}): ReflexionSeedInput {
  const medium: MediumEntry[] = [{
    id: 'm1', agentHandle: H, kind: 'fact', key: 'employer', body: 'Northwind Labs',
    status: 'active', source: 'reflexion', createdAt: NOW - 10 * DAY, updatedAt: NOW - 2 * DAY,
  }];
  const shortEntries: ShortTermEntry[] = [{
    id: 's1', agentHandle: H, kind: 'ops_research', content: 'looked up flight options to Lisbon',
    meta: {}, createdAt: NOW - 3_600_000, expiresAt: NOW + 20 * 3_600_000,
  }];
  const history = [
    { role: 'user', handle: H, content: 'im at northwind now', at: NOW - 2 * 3_600_000 },
    { role: 'assistant', content: 'got it — noted', at: NOW - 3_500_000 },
  ] as unknown as StoredMessage[];
  return {
    task: { id: 't1', chatId: 'c1', agentHandle: H, kind: 'memory_update', request: '', trigger: 'daily', attempt: 1, createdAt: NOW },
    tz: 'America/Denver',
    nowMs: NOW,
    lastDailyAt: NOW - 20 * 3_600_000,
    lastRunAt: NOW - 20 * 3_600_000,
    needsMigration: false,
    selfPromptMd: 'watch the visa thread',
    selfPromptRevs: [{ md: 'prev note', note: 'started watching the visa thread', at: NOW - DAY }],
    mediumRows: medium,
    longDoc: { version: 3, docMd: '# Who they are\nengineer in Denver' },
    longRevs: [{ version: 3, docMd: '# Who', writtenBy: 'reflexion', createdAt: NOW - 2 * DAY }],
    shortEntries,
    history,
    wakesUsed: 0,
    ...over,
  };
}

const seed = (over?: Partial<ReflexionSeedInput>) => buildReflexionSeed(base(over)).join('\n\n');

test('a normal daily run carries the dated reference point WITHOUT delta-scoping the blocks', () => {
  const s = seed();
  assert.match(s, /reference point: your last daily pass completed 2026-08-02T16:00:00\.000Z/, 'anchor sentence present (NOW − 20h)');
  assert.match(s, /~20h ago/, 'age computed from the anchor');
  // full snapshot intact — every block still present
  assert.match(s, /<medium_term>/);
  assert.match(s, /<recent_chat>/);
  assert.match(s, /im at northwind now/, 'chat still rendered in full, not delta-trimmed');
});

test('the closing instruction makes the day the subject and writes conditional', () => {
  const s = seed();
  assert.match(s, /Read the material above as the day that just happened/);
  assert.match(s, /If nothing durable surfaced, write nothing/);
  assert.doesNotMatch(s, /Reconcile what happened against what you hold/, 'the old unconditional imperative is gone');
});

test('medium rows are dated and the long doc shows its last revision', () => {
  const s = seed();
  assert.match(s, /key=employer @ 2026-08-01\)/, 'medium row carries an @ date (updatedAt)');
  assert.match(s, /version: 3 \(last changed 2026-08-01 by reflexion\)/, 'long_term shows the revision line');
});

test('your_last_passes renders with its framing sentence', () => {
  const s = seed();
  assert.match(s, /<your_last_passes>/);
  assert.match(s, /started watching the visa thread/);
  assert.match(s, /your_last_passes are your own dated notes/);
});

test('the recent_chat leak-guard sentence survives and names the block + the handle', () => {
  const s = seed();
  assert.match(s, new RegExp(`recent_chat holds only messages from \\${'+'}15550002000`));
  assert.match(s, /only from their own "user \(…\)" lines/);
});

test('a null anchor (first run) drops the reference point but keeps the full snapshot', () => {
  const s = seed({ lastDailyAt: null });
  assert.doesNotMatch(s, /reference point/, 'no dated anchor when there is none');
  assert.match(s, /<medium_term>/, 'full snapshot still assembled');
  assert.match(s, /If nothing durable surfaced/, 'still the conditional reflect instruction');
});

test('a migration run gets the migration imperative, not the quiet-day instruction, and no anchor', () => {
  const s = seed({ needsMigration: true, lastDailyAt: null });
  assert.match(s, /FIRST RUN: legacy migration required/);
  assert.match(s, /complete the migration above — omit nothing/);
  assert.doesNotMatch(s, /If nothing durable surfaced, write nothing/, 'the quiet-day line must not starve a migration');
  assert.doesNotMatch(s, /reference point/);
});

test('zero-signal blocks drop out entirely (dataTag elision), framing sentences included', () => {
  const s = seed({ selfPromptRevs: [], selfPromptMd: '' });
  assert.doesNotMatch(s, /<your_last_passes>/);
  assert.doesNotMatch(s, /your_last_passes are your own dated notes/, 'framing sentence dropped with its block');
  assert.doesNotMatch(s, /<self_prompt>/);
});

test('a self_wake run anchors on the last RUN, and a delegated run gets no anchor at all', () => {
  const wake = seed({ task: { ...base().task, trigger: 'self_wake' } });
  assert.match(wake, /reference point: your last run completed/);
  const delegated = seed({ task: { ...base().task, trigger: 'delegated', focus: 'fix the employer' } });
  assert.doesNotMatch(delegated, /reference point/);
  assert.match(delegated, /focus: fix the employer/);
});

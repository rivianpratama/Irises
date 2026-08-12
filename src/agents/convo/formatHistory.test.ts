// Run with: npm test   (TZ=UTC tsx --test)
// formatHistory carries each stored turn's full date+clock label as the STRUCTURED `timestamp`
// field (chatTime.timestampLabel); content stays clean. The provider boundary
// (llm/timedMessages.ts) folds it into wire content.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHistory } from './shared.js';
import { dateTimeInZone } from '../../pipeline/zonedTime.js';
import type { StoredMessage } from '../../state/conversation.js';

test('turns carry a structured full date + clock timestamp, content untouched', () => {
  const history: StoredMessage[] = [
    { role: 'user', content: 'comps on 412 maple?', at: dateTimeInZone('2026-07-03', { hour: 9, minute: 5 }) },
    { role: 'assistant', content: 'pulling those now', at: dateTimeInZone('2026-07-06', { hour: 9, minute: 14 }) },
  ];
  const out = formatHistory(history, false);
  assert.equal(out[0].timestamp, 'Fri, Jul 3, 9:05 AM');
  assert.equal(out[0].content, 'comps on 412 maple?'); // content stays clean
  assert.equal(out[1].timestamp, 'Mon, Jul 6, 9:14 AM');
  assert.equal(out[1].content, 'pulling those now');
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'assistant');
});

test('a turn without `at` has no timestamp field and passes through untouched', () => {
  const out = formatHistory([{ role: 'user', content: 'hey' }], false);
  assert.equal(out[0].timestamp, undefined);
  assert.equal(out[0].content, 'hey');
});

test('group chats: handle marker stays in content, timestamp stays structured', () => {
  const at = dateTimeInZone('2026-07-06', { hour: 9, minute: 14 });
  const out = formatHistory([{ role: 'user', content: 'sold yet?', handle: '+15550001111', at }], true);
  assert.equal(out[0].timestamp, 'Mon, Jul 6, 9:14 AM');
  assert.equal(out[0].content, '[+15550001111]: sold yet?');
});

test('group assistant turns get the timestamp but never a handle marker', () => {
  const at = dateTimeInZone('2026-07-06', { hour: 9, minute: 15 });
  const out = formatHistory([{ role: 'assistant', content: 'not yet', handle: '+15550001111', at }], true);
  assert.equal(out[0].timestamp, 'Mon, Jul 6, 9:15 AM');
  assert.equal(out[0].content, 'not yet');
});

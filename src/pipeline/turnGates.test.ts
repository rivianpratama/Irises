// The two pre-output turn gates: the contact-card decision and the early typing indicator.

process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShareContactCard, shouldStartTypingEarly } from './turnGates.js';

const OFF = { enabled: false, interval: 5 };
const ON = { enabled: true, interval: 5 };

test('contact card: first turn of a chat with no stored history', () => {
  assert.equal(shouldShareContactCard(1, false, OFF), true);
});

test('contact card: a restart does NOT re-introduce Irises to an existing chat', () => {
  // count===1 again after a redeploy, but the chat has messages on disk — they have met.
  assert.equal(shouldShareContactCard(1, true, OFF), false);
});

test('contact card: never mid-conversation with the promo off', () => {
  for (const count of [2, 3, 5, 10, 20]) {
    assert.equal(shouldShareContactCard(count, true, OFF), false, `count ${count}`);
    assert.equal(shouldShareContactCard(count, false, OFF), false, `count ${count}, no history`);
  }
});

test('contact card: the promo re-share fires on the interval regardless of history', () => {
  assert.equal(shouldShareContactCard(5, true, ON), true);
  assert.equal(shouldShareContactCard(10, true, ON), true);
  assert.equal(shouldShareContactCard(6, true, ON), false);
  // A zero/negative interval can't be a modulus — treat it as off, never a divide-by-zero share.
  assert.equal(shouldShareContactCard(6, true, { enabled: true, interval: 0 }), false);
});

test('early typing: certain replies only — a group text waits for the classifier', () => {
  assert.equal(shouldStartTypingEarly(false, false), true, '1:1 text always gets a reply');
  assert.equal(shouldStartTypingEarly(false, true), true);
  assert.equal(shouldStartTypingEarly(true, true), true, 'group media skips the classifier');
  assert.equal(shouldStartTypingEarly(true, false), false, 'group text may be ignored');
});

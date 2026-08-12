process.env.TZ = 'UTC';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/state/outboundLog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSend, countSendsSince, lastSendAt, __resetOutboundLog } from './outboundLog.js';

test('no sends recorded → count is 0 and lastSendAt undefined', () => {
  __resetOutboundLog();
  assert.equal(countSendsSince('chatA', 1000), 0);
  assert.equal(lastSendAt('chatA'), undefined);
});

test('counts only sends STRICTLY after the instant', () => {
  __resetOutboundLog();
  noteSend('chatA', 1000);
  noteSend('chatA', 2000);
  noteSend('chatA', 3000);
  assert.equal(countSendsSince('chatA', 1500), 2); // 2000, 3000
  assert.equal(countSendsSince('chatA', 3000), 0); // strictly after — 3000 itself doesn't count
  assert.equal(countSendsSince('chatA', 999), 3);
});

test('lastSendAt is the most recent send', () => {
  __resetOutboundLog();
  noteSend('chatA', 1000);
  noteSend('chatA', 5000);
  assert.equal(lastSendAt('chatA'), 5000);
});

test('per-chat isolation: one chat\'s sends never leak into another\'s count', () => {
  __resetOutboundLog();
  noteSend('chatA', 2000);
  noteSend('chatA', 3000);
  noteSend('chatB', 4000);
  assert.equal(countSendsSince('chatA', 1000), 2);
  assert.equal(countSendsSince('chatB', 1000), 1);
  assert.equal(lastSendAt('chatB'), 4000);
});

test('the log caps at MAX_ENTRIES, dropping the oldest (count saturates harmlessly)', () => {
  __resetOutboundLog();
  for (let i = 1; i <= 60; i++) noteSend('chatA', i * 100); // 100..6000, 60 entries > cap of 50
  // Oldest 10 (100..1000) dropped; newest 50 kept (1100..6000).
  assert.equal(countSendsSince('chatA', 0), 50);
  assert.equal(lastSendAt('chatA'), 6000);
  // A very old boundary saturates to the kept window, never negative or throwing.
  assert.equal(countSendsSince('chatA', 500), 50);
});

test('__resetOutboundLog clears everything', () => {
  __resetOutboundLog();
  noteSend('chatA', 1000);
  __resetOutboundLog();
  assert.equal(countSendsSince('chatA', 0), 0);
  assert.equal(lastSendAt('chatA'), undefined);
});

process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOpsEta, etaStatus, CROSS_ENTITY_RE } from './etaEstimate.js';

test('the quick kind (draft) returns about a minute', () => {
  assert.equal(estimateOpsEta({ kind: 'draft', request: 'write a thank-you note' }).phrase, 'about a minute');
  assert.equal(estimateOpsEta({ kind: 'draft', request: 'write a thank-you note' }).bucketMs, 60_000);
});

test('standard kinds (web_research, document_read, general) return a couple of minutes', () => {
  assert.equal(estimateOpsEta({ kind: 'web_research', request: 'what did the fed do today' }).phrase, 'a couple of minutes');
  assert.equal(estimateOpsEta({ kind: 'document_read', request: 'open the pdf jamie sent' }).phrase, 'a couple of minutes');
  assert.equal(estimateOpsEta({ kind: 'general', request: 'how did that thing turn out' }).phrase, 'a couple of minutes');
  assert.equal(estimateOpsEta({ kind: 'general', request: 'how did that thing turn out' }).bucketMs, 120_000);
});

test('a cross-entity sweep promotes to a few minutes', () => {
  assert.equal(estimateOpsEta({ kind: 'general', request: 'show me all my subscriptions' }).phrase, 'a few minutes');
  assert.equal(estimateOpsEta({ kind: 'general', request: 'add up the totals across every invoice' }).phrase, 'a few minutes');
  assert.equal(estimateOpsEta({ kind: 'general', request: 'is there anything due this week' }).phrase, 'a few minutes');
  assert.equal(estimateOpsEta({ kind: 'general', request: 'show me all my subscriptions' }).bucketMs, 210_000);
});

test('a cross-entity sweep beats the quick kind (promotion wins over draft)', () => {
  assert.equal(estimateOpsEta({ kind: 'draft', request: 'reply to every unanswered email' }).phrase, 'a few minutes');
});

test('forceGrounding on general promotes to a few minutes', () => {
  assert.equal(estimateOpsEta({ kind: 'general', request: 'how did that thing turn out', forceGrounding: true }).phrase, 'a few minutes');
});

test('forceGrounding only promotes the general kind', () => {
  assert.equal(estimateOpsEta({ kind: 'document_read', request: 'open the pdf jamie sent', forceGrounding: true }).phrase, 'a couple of minutes');
});

test('CROSS_ENTITY_RE matches sweeps and leaves single-target asks alone', () => {
  assert.ok(CROSS_ENTITY_RE.test('all my subscriptions'));
  assert.ok(CROSS_ENTITY_RE.test('across my accounts'));
  assert.ok(CROSS_ENTITY_RE.test('every receipt'));
  assert.ok(CROSS_ENTITY_RE.test('which ones are still open'));
  assert.ok(CROSS_ENTITY_RE.test('is there anything outstanding'));
  assert.ok(!CROSS_ENTITY_RE.test('read the invoice jamie sent me'));
  assert.ok(!CROSS_ENTITY_RE.test('what time is the meeting'));
});

test('etaStatus early state with remaining phrase', () => {
  const est = { bucketMs: 120_000, phrase: 'a couple of minutes' };
  const s = etaStatus(est, 30_000);
  assert.equal(s.state, 'early');
  assert.ok(s.remainingPhrase);
});

test('etaStatus closing state (60-100% of bucket)', () => {
  const est = { bucketMs: 120_000, phrase: 'a couple of minutes' };
  const s = etaStatus(est, 90_000);
  assert.equal(s.state, 'closing');
  assert.equal(s.remainingPhrase, undefined);
});

test('etaStatus overrun state (past bucket)', () => {
  const est = { bucketMs: 120_000, phrase: 'a couple of minutes' };
  const s = etaStatus(est, 150_000);
  assert.equal(s.state, 'overrun');
  assert.equal(s.remainingPhrase, undefined);
});

test('etaStatus never changes the headline phrase, only the remaining hint', () => {
  const est = { bucketMs: 120_000, phrase: 'a couple of minutes' };
  for (const elapsed of [0, 30_000, 90_000, 150_000, 600_000]) {
    assert.equal(etaStatus(est, elapsed).phrase, 'a couple of minutes');
  }
});

test('etaStatus remaining floor is under a minute', () => {
  const est = { bucketMs: 120_000, phrase: 'a couple of minutes' };
  const s = etaStatus(est, 70_000);
  assert.equal(s.state, 'early');
  assert.equal(s.remainingPhrase, 'under a minute');
});

// Run with: npm test   (TZ=UTC tsx --test)
// The absence protocol's pure decision pieces: what counts as a distinct search formulation,
// what reads as a miss, and when the one-shot nudge fires instead of finalizing NO RESULT.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFormulation, looksLikeMiss, shouldNudgeAbsence, stepsForKind } from './client.js';

test('normalizeFormulation is stable across key order and drops empty args', () => {
  const a = normalizeFormulation('search_email', { query: 'invoice', from: 'billing@acme.com', to: '' });
  const b = normalizeFormulation('search_email', { from: 'billing@acme.com', to: undefined, query: 'invoice' });
  assert.equal(a, b);
});

test('normalizeFormulation distinguishes genuinely different searches and different tools', () => {
  const a = normalizeFormulation('search_email', { query: 'invoice' });
  const b = normalizeFormulation('search_email', { query: 'receipt' });
  const c = normalizeFormulation('search_inbox_local', { text: 'invoice' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('looksLikeMiss matches NO RESULT shapes and empty text only', () => {
  assert.ok(looksLikeMiss('NO RESULT: no matching emails for that'));
  assert.ok(looksLikeMiss('ANSWER: NO RESULT — nothing found'));
  assert.ok(looksLikeMiss(''));
  assert.ok(looksLikeMiss(null));
  assert.ok(!looksLikeMiss('ANSWER: Inspection deadline is July 8, 2026.'));
  assert.ok(!looksLikeMiss('The search found no red flags but the contract is attached.')); // not a NO RESULT prefix
});

test('nudge fires only for a miss, with search tools, under the formulation floor, once', () => {
  const base = { text: 'NO RESULT: nothing found', formulations: 1, alreadyNudged: false, hasSearchTools: true };
  assert.ok(shouldNudgeAbsence(base));
  assert.ok(!shouldNudgeAbsence({ ...base, formulations: 3 }));         // floor met
  assert.ok(!shouldNudgeAbsence({ ...base, alreadyNudged: true }));      // one-shot
  assert.ok(!shouldNudgeAbsence({ ...base, hasSearchTools: false }));    // kind carries no search tools
  assert.ok(!shouldNudgeAbsence({ ...base, text: 'ANSWER: found it' })); // real answer
});

test('email-grounded kinds get the larger step budget', () => {
  assert.ok(stepsForKind('document_read') > stepsForKind('web_research'));
  assert.equal(stepsForKind('draft'), stepsForKind('general'));
});

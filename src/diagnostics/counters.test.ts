import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { noteEvent, getCounters, resetCounters } from './counters.js';

beforeEach(() => resetCounters());

test('classifies turn starts, llm calls, errors, and roles', () => {
  noteEvent({ type: 'event', label: 'turn:start' });
  noteEvent({ type: 'llm', role: 'convo', response: 'hi' });
  noteEvent({ type: 'llm', role: 'ops', response: 'ERROR: boom' });
  noteEvent({ type: 'llm', role: 'convo', response: 'again' });
  const c = getCounters();
  assert.equal(c.turnsStarted, 1);
  assert.equal(c.llmCalls, 3);
  assert.equal(c.llmErrors, 1);
  assert.equal(c.byRole.convo, 2);
  assert.equal(c.byRole.ops, 1);
  assert.equal(c.bySource.user, 1);
});

test('counts fallbacks, fallfirm engagements, and fidelity events', () => {
  noteEvent({ type: 'event', label: 'llm:fallback' });
  noteEvent({ type: 'llm', role: 'fallfirm', response: 'holding text' });
  noteEvent({ type: 'event', label: 'ops:fidelity-suppressed' });
  noteEvent({ type: 'event', label: 'ops_escalation:fidelity-flagged' });
  const c = getCounters();
  assert.equal(c.llmFallbacks, 1);
  assert.equal(c.fallfirmEngagements, 1);
  assert.equal(c.fidelitySuppressed, 1);
  assert.equal(c.fidelityFlagged, 1);
});

test('judge and autonome events feed the source buckets', () => {
  noteEvent({ type: 'llm', role: 'judge', label: 'judge', response: 'ok' });
  noteEvent({ type: 'event', label: 'autonome:fire' });
  const c = getCounters();
  assert.equal(c.bySource.email, 1);
  assert.equal(c.bySource.automation, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cannotOpenOutcome, cannotProcessOutcome, mmSnagOutcome } from './orchestrator.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/agents/orchestrator.cannotOpen.test.ts

test('an "expired" reason suffix → expired wording, kind nothing_found, request threaded', () => {
  const o = cannotOpenOutcome('could not open the attachment (the link expired)', 'zoom into that photo');
  assert.equal(o.kind, 'nothing_found');
  assert.match(o.summary, /expired/);
  assert.match(o.nextStep ?? '', /resend/);
  assert.equal(o.originalRequest, 'zoom into that photo');
});

test('an "oversize" reason suffix → too-large wording + smaller-version steer', () => {
  const o = cannotOpenOutcome('could not open the attachment (the file is too large to open)', 'x');
  assert.match(o.summary, /too large/);
  assert.match(o.nextStep ?? '', /smaller/);
});

test('the bare sentinel (no reason) → generic didn\'t-come-through resend wording', () => {
  const o = cannotOpenOutcome('could not open the attachment', 'x');
  assert.match(o.summary, /didn't come through/);
  assert.match(o.nextStep ?? '', /resend/);
  assert.equal(o.kind, 'nothing_found');
});

// ── cannotProcessOutcome (model incapability — never asks to resend) ─────────

test('cannotProcessOutcome: kind is failed, says no resend needed', () => {
  const o = cannotProcessOutcome('cannot process the attachment right now (the voice memo)', 'transcribe this');
  assert.equal(o.kind, 'failed');
  assert.match(o.nextStep ?? '', /don't need to resend/);
  assert.equal(o.originalRequest, 'transcribe this');
});

// ── mmSnagOutcome (all lanes exhausted — says no resend needed) ──────────────

test('mmSnagOutcome: kind is failed, says no resend needed', () => {
  const o = mmSnagOutcome('look at that photo');
  assert.equal(o.kind, 'failed');
  assert.match(o.nextStep ?? '', /don't need to resend/);
  assert.equal(o.originalRequest, 'look at that photo');
});

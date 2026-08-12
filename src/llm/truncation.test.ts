import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTruncatedStop, starvedError, isStarvedError, bumpStarvedBudget } from './truncation.js';

test("both lanes' spellings count as truncation", () => {
  // OpenRouter (OpenAI-compatible) says 'length'; Anthropic says 'max_tokens'. Every guard in the
  // tree used to check only the former, which made Anthropic truncation invisible.
  assert.equal(isTruncatedStop('length'), true);
  assert.equal(isTruncatedStop('max_tokens'), true);
});

test('normal completions are not truncation (and neither is a missing stop reason)', () => {
  assert.equal(isTruncatedStop('end_turn'), false);
  assert.equal(isTruncatedStop('stop'), false);
  assert.equal(isTruncatedStop('tool_use'), false);
  assert.equal(isTruncatedStop(null), false);
  assert.equal(isTruncatedStop(undefined), false);
});

test('bumpStarvedBudget grows only the tiny per-call caps, never past the role ceiling', () => {
  // The hardcoded caps (20 for the group classifier, 100 for fidelity L2, 900 for the dossier) are
  // what starve; they get a real 1024-token floor to retry with.
  assert.equal(bumpStarvedBudget(20, 20), 1024);
  assert.equal(bumpStarvedBudget(100, 20), 1024);
  assert.equal(bumpStarvedBudget(900, 20), 1024);
  // A call already at its role ceiling gets the same number back — doubling past the ceiling is how
  // one starving reasoning model becomes an unbounded bill.
  assert.equal(bumpStarvedBudget(8000, 8000), 8000);
  assert.equal(bumpStarvedBudget(64000, 64000), 64000);
});

test('starvedError carries a marker isStarvedError reads, and names the cap in its message', () => {
  const err = starvedError('anthropic', 'claude-sonnet-4-5', 900);
  assert.equal(isStarvedError(err), true);
  assert.match(err.message, /^anthropic length-starved:/);
  assert.match(err.message, /model=claude-sonnet-4-5/);
  assert.match(err.message, /max_tokens=900/);
  // Statusless, so shouldFallback treats it as transient and the turn salvages on the other lane.
  assert.equal((err as Error & { status?: number }).status, undefined);
});

test('only the marker counts — lookalike errors and non-Error values are not starvation', () => {
  assert.equal(isStarvedError(new Error('openrouter length-starved: model=x max_tokens=20')), false);
  assert.equal(isStarvedError(new Error('boom')), false);
  assert.equal(isStarvedError('length-starved'), false);
  assert.equal(isStarvedError(undefined), false);
  assert.equal(isStarvedError(null), false);
  assert.equal(isStarvedError({}), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envKey, isLaneConfigured, laneEnvVar, laneKey, laneUnconfiguredError, noLaneConfiguredError } from './laneKeys.js';
import { shouldFallback } from './fallbackPolicy.js';

test('a key that is SET BUT BLANK is not a configured lane', () => {
  // The whole point: `ANTHROPIC_API_KEY=` in .env (the single-key setup — one OpenRouter key reused
  // for everything) leaves the variable SET to ''. The SDK builds a client for it and only throws
  // from inside the first request, so a blank key HAS to read as "no lane" up front.
  assert.equal(isLaneConfigured('anthropic', { ANTHROPIC_API_KEY: '' }), false);
  assert.equal(isLaneConfigured('anthropic', { ANTHROPIC_API_KEY: '   ' }), false);
  assert.equal(isLaneConfigured('anthropic', { ANTHROPIC_API_KEY: '\n\t ' }), false);
  assert.equal(isLaneConfigured('anthropic', {}), false);
  assert.equal(isLaneConfigured('openrouter', { OPENROUTER_API_KEY: '' }), false);
  assert.equal(isLaneConfigured('openrouter', { OPENROUTER_API_KEY: ' \t' }), false);
  assert.equal(isLaneConfigured('openrouter', {}), false);
  // …and a real key still configures it.
  assert.equal(isLaneConfigured('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-x' }), true);
  assert.equal(isLaneConfigured('openrouter', { OPENROUTER_API_KEY: 'sk-or-x' }), true);
});

test('envKey trims and treats blank as absent', () => {
  assert.equal(envKey('K', { K: '  sk-x  ' }), 'sk-x');
  assert.equal(envKey('K', { K: '' }), undefined);
  assert.equal(envKey('K', { K: '  ' }), undefined);
  assert.equal(envKey('K', {}), undefined);
});

test('the Anthropic lane accepts either credential the SDK reads from env', () => {
  // The SDK takes apiKey OR authToken (both env-defaulted), so a deploy using ANTHROPIC_AUTH_TOKEN
  // must not be told its lane is unconfigured.
  assert.deepEqual(laneKey('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-x' }), { envVar: 'ANTHROPIC_API_KEY', value: 'sk-ant-x' });
  assert.deepEqual(laneKey('anthropic', { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'tok' }), { envVar: 'ANTHROPIC_AUTH_TOKEN', value: 'tok' });
  assert.equal(isLaneConfigured('anthropic', { ANTHROPIC_AUTH_TOKEN: 'tok' }), true);
  assert.equal(laneKey('anthropic', { ANTHROPIC_API_KEY: ' ', ANTHROPIC_AUTH_TOKEN: ' ' }), undefined);
});

test('the unconfigured-lane error names the lane and stays fallbackable', () => {
  // Statusless and unmarked ON PURPOSE: a keyless PRIMARY lane must still be salvaged by a
  // configured fallback, which shouldFallback only does for retryable-looking errors.
  const err = laneUnconfiguredError('anthropic');
  assert.match(err.message, /ANTHROPIC_API_KEY not configured/);
  assert.match(err.message, /anthropic lane unavailable/);
  assert.equal(shouldFallback(err, 'openrouter'), true);
  assert.match(laneUnconfiguredError('openrouter').message, /OPENROUTER_API_KEY not configured/);
});

test('the no-lane error names the role and BOTH env vars', () => {
  const err = noLaneConfiguredError('classify');
  assert.match(err.message, /^classify:/);
  assert.match(err.message, /ANTHROPIC_API_KEY/);
  assert.match(err.message, /OPENROUTER_API_KEY/);
});

test('laneEnvVar is the var a message should quote', () => {
  assert.equal(laneEnvVar('anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(laneEnvVar('openrouter'), 'OPENROUTER_API_KEY');
});

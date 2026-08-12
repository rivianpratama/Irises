import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFallback, isNonFallbackable } from './fallbackPolicy.js';
import { starvedError } from './truncation.js';

function withStatus(status: number, message?: string): Error {
  const err = new Error(message ?? `http ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

test('5xx and 429 fall back (transient provider trouble)', () => {
  assert.equal(shouldFallback(withStatus(500), 'anthropic'), true);
  assert.equal(shouldFallback(withStatus(503), 'anthropic'), true);
  assert.equal(shouldFallback(withStatus(529), 'anthropic'), true);
  assert.equal(shouldFallback(withStatus(429), 'anthropic'), true);
});

test('other 4xx fail loud (auth/validation errors re-fire identically on the other lane)', () => {
  assert.equal(shouldFallback(withStatus(400), 'anthropic'), false);
  assert.equal(shouldFallback(withStatus(401), 'anthropic'), false);
  assert.equal(shouldFallback(withStatus(403), 'anthropic'), false);
  assert.equal(shouldFallback(withStatus(404), 'anthropic'), false);
  assert.equal(shouldFallback(withStatus(413), 'anthropic'), false);
});

test('402 (out of credits) falls back ONLY toward Anthropic, never toward OpenRouter', () => {
  // OpenRouter returns 402 when the balance is exhausted. It re-fires until credits are topped up
  // (deterministic), so salvaging toward OpenRouter is a silent cost reroute — the July-24 pattern.
  // Toward Anthropic (first-party billing, hand-picked same-tier fallback slug) it keeps Irises
  // replying while the balance is empty.
  assert.equal(shouldFallback(withStatus(402), 'anthropic'), true);
  assert.equal(shouldFallback(withStatus(402), 'openrouter'), false);
});

test('the fallback lane only matters for 402 — every other status is direction-independent', () => {
  for (const lane of ['anthropic', 'openrouter'] as const) {
    assert.equal(shouldFallback(withStatus(500), lane), true);
    assert.equal(shouldFallback(withStatus(429), lane), true);
    assert.equal(shouldFallback(withStatus(401), lane), false);
    assert.equal(shouldFallback(withStatus(400), lane), false);
  }
});

test('a bad-model 400 (unusable slug) falls back ONLY toward Anthropic', () => {
  // 2026-08-01: `deepseek/deepseek-v4-flash-latest` shipped as a model id and OpenRouter 400'd every
  // Convo call with "…is not a valid model ID". A plain 400 fails loud, taking the role fully down;
  // this class re-fires identically forever (like 402), so salvaging toward Anthropic (valid slug,
  // first-party billing) keeps Irises replying instead. Toward OpenRouter it would re-hit the bad model.
  const badModel = withStatus(400, '400 deepseek/deepseek-v4-flash-latest:exacto is not a valid model ID');
  assert.equal(shouldFallback(badModel, 'anthropic'), true);
  assert.equal(shouldFallback(badModel, 'openrouter'), false);
  // Sibling model-unavailable messages (routing/data-policy) are the same class → salvage to Anthropic.
  assert.equal(shouldFallback(withStatus(400, 'No endpoints found that support tool use'), 'anthropic'), true);
  assert.equal(shouldFallback(withStatus(400, 'No allowed providers are available for the selected model'), 'anthropic'), true);
});

test('an ordinary validation 400 still fails loud (the bad-model salvage stays narrow)', () => {
  // A schema/parameter 400 is a real bad request — re-running it on Anthropic would just 400 again
  // (double-billing risk), so it must NOT match the bad-model salvage.
  assert.equal(shouldFallback(withStatus(400, 'invalid_request_error: messages.0.content is required'), 'anthropic'), false);
  assert.equal(shouldFallback(withStatus(400, 'output_config.format schema is invalid'), 'anthropic'), false);
});

test('a nonFallbackable error carrying a retryable status STILL fails loud (ordering guard)', () => {
  // The budget breaker is statusless today, but the isNonFallbackable check must sit BEFORE the
  // numeric-status branch so that if a nonFallbackable error ever gains a 429/5xx it can never be
  // re-billed on the other lane. This locks that ordering in.
  const err = new Error('daily global token cap exhausted') as Error & { status: number; nonFallbackable: boolean };
  err.status = 503;
  err.nonFallbackable = true;
  assert.equal(shouldFallback(err, 'anthropic'), false);
  assert.equal(shouldFallback(err, 'openrouter'), false);
});

test('a starvedError is fallbackable toward BOTH lanes (the starved-retry salvage depends on it)', () => {
  // Both providers can starve now (Anthropic 'max_tokens', OpenRouter 'length'), so the salvage has
  // to work in either direction — and it works ONLY because starvedError is statusless and not
  // marked nonFallbackable. callLLM then retries the other lane on a bumped budget; a status here
  // (or a nonFallbackable marker) would fail the turn loud instead.
  for (const provider of ['anthropic', 'openrouter'] as const) {
    const err = starvedError(provider, 'some/model', 900);
    assert.equal(isNonFallbackable(err), false);
    assert.equal(shouldFallback(err, 'anthropic'), true);
    assert.equal(shouldFallback(err, 'openrouter'), true);
  }
});

test('statusless network errors fall back (the length-starved salvage path depends on this)', () => {
  assert.equal(shouldFallback(new Error('ECONNRESET'), 'anthropic'), true);
  assert.equal(shouldFallback(new Error('openrouter length-starved: model=x max_tokens=64000 spent the completion budget (likely on reasoning) with no content'), 'anthropic'), true);
});

test('the Anthropic non-streaming SDK guard NEVER falls back (deterministic config error)', () => {
  // Verbatim SDK 0.39 message — statusless, thrown client-side before any request is sent. Falling
  // back here is how 100% of Ops traffic silently rerouted to a different-billing model family.
  const guard = new Error(
    'Streaming is strongly recommended for operations that may take longer than 10 minutes. ' +
    'See https://github.com/anthropics/anthropic-sdk-python#streaming-responses for more details',
  );
  assert.equal(shouldFallback(guard, 'openrouter'), false);
});

test('aborted requests never fall back (a cancelled call must not bill twice)', () => {
  const abort = new Error('The user aborted a request.');
  abort.name = 'AbortError';
  assert.equal(shouldFallback(abort, 'anthropic'), false);
  const sdkAbort = new Error('Request was aborted.');
  sdkAbort.name = 'APIUserAbortError';
  assert.equal(shouldFallback(sdkAbort, 'anthropic'), false);
});

test("Anthropic's APIUserAbortError is caught even though it never sets .name", () => {
  // Mirrors @anthropic-ai/sdk 0.39: class APIUserAbortError extends APIError with message
  // 'Request was aborted.' and NO this.name assignment — runtime name stays 'Error'.
  class APIError extends Error {}
  class APIUserAbortError extends APIError {
    constructor() { super('Request was aborted.'); }
  }
  const err = new APIUserAbortError();
  assert.equal(err.name, 'Error', 'precondition: the SDK error really does read as a generic Error');
  assert.equal(shouldFallback(err, 'anthropic'), false);
});

test('nonFallbackable-marked errors fail loud (budget guards)', () => {
  const err = new Error('daily ops token budget exhausted') as Error & { nonFallbackable: boolean };
  err.nonFallbackable = true;
  assert.equal(isNonFallbackable(err), true);
  assert.equal(shouldFallback(err, 'anthropic'), false);
});

test('non-Error values do not crash the policy', () => {
  assert.equal(shouldFallback('boom', 'anthropic'), true);
  assert.equal(shouldFallback(undefined, 'anthropic'), true);
  assert.equal(shouldFallback({ status: 500 }, 'anthropic'), true);
  assert.equal(shouldFallback({ status: 400 }, 'anthropic'), false);
  assert.equal(shouldFallback({ status: 402 }, 'anthropic'), true);
  assert.equal(shouldFallback({ status: 402 }, 'openrouter'), false);
});

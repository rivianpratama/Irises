// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The embeddings client: the config gates that keep it from ever dispatching, the ledger trail
// every call leaves, and the four ways a response is refused. `create` is injected throughout —
// nothing here touches a network, and embed.ts is imported by src/memory/semanticRecall.ts alone,
// which src/index.ts alone imports, so no test can reach a provider even by accident.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
process.env.MEMORY_SEMANTIC_RECALL = 'on';
process.env.OPENROUTER_API_KEY = 'test-key-not-a-real-one';
process.env.EMBEDDINGS_MODEL = 'openai/text-embedding-3-small';
process.env.EMBEDDINGS_DIMENSIONS = '8';
// Daily caps are read at module load — set BEFORE the dynamic import of embed.js (which pulls in
// budget.js). Each test file runs in its own process, so this doesn't leak.
process.env.LLM_DAILY_TOKEN_CAP = '5000';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stmt } from '../db/sqlite.js';
import type { EmbeddingCreateParams, EmbeddingResponse } from './embed.js';

const DIMS = 8;

function response(vectors: number[][], promptTokens = 42): EmbeddingResponse {
  return {
    object: 'list',
    model: 'openai/text-embedding-3-small',
    data: vectors.map((embedding, index) => ({ object: 'embedding' as const, index, embedding })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

/** A distinct, deliberately NOT unit-length vector per input. */
function rawVector(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === seed % DIMS ? 3 : 0) + (i === (seed + 1) % DIMS ? 4 : 0));
}

interface UsageRow {
  role: string; label: string | null; provider: string; model: string;
  input_tokens: number; output_tokens: number; status: string; error: string | null;
  latency_ms: number | null; handle: string | null;
}

function usageRows(): UsageRow[] {
  return stmt('SELECT * FROM token_usage ORDER BY id').all() as unknown as UsageRow[];
}
function clearUsage(): void {
  stmt('DELETE FROM token_usage').run();
}

test('a blank OPENROUTER_API_KEY is no key at all: null, and nothing dispatched', async () => {
  const { embedTexts, embeddingsConfigured } = await import('./embed.js');
  const prev = process.env.OPENROUTER_API_KEY;
  clearUsage();
  process.env.OPENROUTER_API_KEY = '   ';
  try {
    assert.equal(embeddingsConfigured(), false, 'blank is unconfigured, not "a key that 401s"');
    let calls = 0;
    const out = await embedTexts(['anything'], { label: 'archive_recall' }, {
      create: async () => { calls++; throw new Error('should never be reached'); },
    });
    assert.equal(out, null);
    assert.equal(calls, 0, 'no dispatch without a key');
  } finally {
    process.env.OPENROUTER_API_KEY = prev;
  }
});

test('the feature flag off means no client, no call, no ledger row', async () => {
  const { embedTexts, embeddingsConfigured } = await import('./embed.js');
  clearUsage();
  process.env.MEMORY_SEMANTIC_RECALL = 'off';
  try {
    assert.equal(embeddingsConfigured(), false);
    let calls = 0;
    const out = await embedTexts(['anything'], { label: 'archive_recall' }, {
      create: async () => { calls++; throw new Error('should never be reached'); },
    });
    assert.equal(out, null);
    assert.equal(calls, 0);
    assert.equal(usageRows().length, 0, 'a feature that is off costs nothing, not even a row');
  } finally {
    process.env.MEMORY_SEMANTIC_RECALL = 'on';
  }
});

test('a successful call records exactly one token_usage row, role=embed, with its label', async () => {
  const { embedTexts } = await import('./embed.js');
  clearUsage();
  let sent: EmbeddingCreateParams | null = null;
  const out = await embedTexts(['first text', 'second text'], { label: 'archive_backfill', handle: '+15550001111' }, {
    create: async (params) => { sent = params; return response([rawVector(0), rawVector(2)], 137); },
  });
  assert.equal(out?.length, 2);

  const params = sent as unknown as EmbeddingCreateParams;
  assert.equal(params.model, 'openai/text-embedding-3-small');
  assert.deepEqual(params.input, ['first text', 'second text']);
  assert.equal(params.dimensions, DIMS, 'the requested width travels with the request');

  const rows = usageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'embed', 'a plain string role — the LlmRole union is not widened');
  assert.equal(rows[0].label, 'archive_backfill');
  assert.equal(rows[0].provider, 'openrouter');
  assert.equal(rows[0].model, 'openai/text-embedding-3-small');
  assert.equal(rows[0].handle, '+15550001111');
  assert.equal(Number(rows[0].input_tokens), 137);
  assert.equal(Number(rows[0].output_tokens), 0);
  assert.equal(rows[0].status, 'ok');
});

test('an API error is null plus a status=error ledger row — never a throw', async () => {
  const { embedTexts } = await import('./embed.js');
  clearUsage();
  const out = await embedTexts(['boom'], { label: 'archive_recall' }, {
    create: async () => { throw Object.assign(new Error('502 upstream unavailable'), { status: 502 }); },
  });
  assert.equal(out, null);
  const rows = usageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].role, 'embed');
  assert.match(rows[0].error ?? '', /502/);
});

test('a hung provider is abandoned on the timeout: null, an error row, no waiting', async () => {
  const { embedTexts } = await import('./embed.js');
  clearUsage();
  let dispatched = false;
  // The bound's own timer is unref'd (it must never hold the process open), and a test process
  // waiting on a promise that will never settle has nothing else on its loop — so hold it open
  // ourselves for the duration. Production always has the webhook server doing this.
  const keepAlive = setTimeout(() => { /* the loop needs one ref'd handle */ }, 5_000);
  // A call that never comes back — the SDK's own default here would be 10 minutes and two retries,
  // inside a turn the user is waiting through. (The real budget is 3s for recall and 60s for the
  // backfill; the injected one keeps the test instant.)
  const out = await embedTexts(['what did I say about the lake'], { label: 'archive_recall' }, {
    create: () => { dispatched = true; return new Promise<never>(() => { /* never settles */ }); },
    timeoutMs: 20,
  });
  clearTimeout(keepAlive);
  assert.equal(dispatched, true, 'it really was dispatched, then abandoned');
  assert.equal(out, null, 'the recall leg degrades to lexical rather than hanging the turn');
  const rows = usageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].error ?? '', /timeout/);
});

test('a wrong vector count or a wrong width is refused, not stored', async () => {
  const { embedTexts, embeddingsWidthRefusals } = await import('./embed.js');
  const refusalsBefore = embeddingsWidthRefusals();

  clearUsage();
  const short = await embedTexts(['a', 'b'], { label: 'archive_backfill' }, {
    create: async () => response([rawVector(0)]),
  });
  assert.equal(short, null, 'two inputs, one vector');
  assert.equal(usageRows()[0]?.status, 'error');

  clearUsage();
  // The failure mode this guard exists for: a provider that ignores `dimensions` and answers at
  // its native width. Writing those would poison the store with silently-wrong-space vectors.
  const wide = await embedTexts(['a'], { label: 'archive_backfill' }, {
    create: async () => response([Array.from({ length: 1536 }, () => 0.01)]),
  });
  assert.equal(wide, null, 'the dimensions param was ignored');
  assert.match(usageRows()[0]?.error ?? '', /width 1536/);
  // Counted, not just logged: from the caller's side this null looks exactly like a 502, and the
  // backfill's circuit breaker has to know which one it was. The short-response case above must
  // NOT count — a retry can clear that one.
  assert.equal(embeddingsWidthRefusals(), refusalsBefore + 1, 'only the width refusal is counted');
});

test('returned vectors are L2-normalized and in index order', async () => {
  const { embedTexts } = await import('./embed.js');
  clearUsage();
  // Deliberately out of order in the array, and deliberately not unit-length.
  const out = await embedTexts(['a', 'b'], { label: 'archive_recall' }, {
    create: async () => ({
      object: 'list' as const,
      model: 'openai/text-embedding-3-small',
      data: [
        { object: 'embedding' as const, index: 1, embedding: rawVector(4) },
        { object: 'embedding' as const, index: 0, embedding: rawVector(0) },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }),
  });
  assert.ok(out);
  for (const v of out!) {
    const selfDot = v.reduce((s, x) => s + x * x, 0);
    assert.ok(Math.abs(selfDot - 1) < 1e-6, `self-dot ${selfDot}`);
  }
  // rawVector(0) is [3,4,0,…] → [0.6,0.8,0,…] once normalized, and it is FIRST (index 0).
  assert.ok(Math.abs(out![0][0] - 0.6) < 1e-6);
  assert.ok(Math.abs(out![0][1] - 0.8) < 1e-6);
});

// LAST: it plants a day's spend in the ledger, which every earlier test would trip over.
test('a tripped daily cap returns null without dispatching', async () => {
  const { embedTexts } = await import('./embed.js');
  const { resetDailySpendCache } = await import('./budget.js');
  clearUsage();
  try {
    stmt(
      `INSERT INTO token_usage (role, provider, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, created_at)
       VALUES ('convo', 'anthropic', 'm', 999999, 0, 0, 0, ?)`
    ).run(Date.now());
    resetDailySpendCache();

    let calls = 0;
    const out = await embedTexts(['x'], { label: 'archive_backfill' }, {
      create: async () => { calls++; throw new Error('should never be reached'); },
    });
    assert.equal(out, null);
    assert.equal(calls, 0, 'the breaker fires BEFORE any dispatch');
    const errors = usageRows().filter(r => r.status === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].error ?? '', /cap exhausted/);
  } finally {
    clearUsage();
    resetDailySpendCache();
  }
});

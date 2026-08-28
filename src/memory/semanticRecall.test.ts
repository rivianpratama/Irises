// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The backfill's RUN GUARDS — the two ways a background sweep can misbehave that the bound inside
// backfillArchiveEmbeddings does not cover: a run that laps itself, and a run that fails the same
// unfixable way forever.
//
// This file imports semanticRecall.ts directly, which is the module that owns the only production
// registration of a network-capable embedder. It is safe HERE and nowhere else because it never
// calls initSemanticRecall(): every test below registers its own fake through setArchiveEmbedder,
// no key is configured, and nothing in this file can dispatch to a provider.
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// Pin the store's notion of "current" so the fakes below are writing (or refusing) current widths.
process.env.EMBEDDINGS_MODEL = 'test/fake-embed';
process.env.EMBEDDINGS_DIMENSIONS = '64';

import test from 'node:test';
import assert from 'node:assert/strict';
import { runEmbeddingBackfill, __resetBackfillGuardsForTests } from './semanticRecall.js';
import {
  setArchiveEmbedder, l2Normalize, type Embedder,
} from '../db/repositories/memoryArchiveVectors.js';
import { archiveEntries, purgeArchiveFor } from '../db/repositories/memoryArchive.js';
import { getRecentErrors } from '../diagnostics/errorLog.js';
import { stmt } from '../db/sqlite.js';

const DIMS = 64;

let seq = 0;
function freshHandle(): string {
  return `+1555400${(seq++).toString().padStart(4, '0')}`;
}

function vector(width: number): Float32Array {
  const v = new Float32Array(width);
  for (let i = 0; i < width; i++) v[i] = ((i * 37) % 11) + 1;
  return l2Normalize(v);
}

async function seed(handle: string, n: number): Promise<void> {
  await archiveEntries(Array.from({ length: n }, (_, i) => ({
    source: 'message_pruned' as const,
    agentHandle: handle,
    content: `something worth remembering, number ${i}`,
  })));
}

function vectorsFor(handle: string): number {
  return Number((stmt(
    `SELECT count(*) AS n FROM memory_archive_embeddings e
     JOIN memory_archive a ON a.id = e.archive_id WHERE a.agent_handle = ?`
  ).get(handle) as { n: number }).n);
}

function configErrorRows(): number {
  return getRecentErrors(500).filter(e => e.source === 'memory' && e.category === 'embedding_config').length;
}

/** The failure the breaker exists for: a provider that ignores `dimensions` and answers at its
 *  own native width, every time, forever. */
function wrongWidthEmbedder(onCall: () => void): Embedder {
  return async (texts) => {
    onCall();
    return texts.map(() => vector(DIMS / 2));
  };
}

test('two ticks cannot overlap: a run that is still going swallows the next one', async () => {
  __resetBackfillGuardsForTests();
  const h = freshHandle();
  await seed(h, 2);

  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  setArchiveEmbedder(async (texts) => {
    calls++;
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 20));
    inFlight--;
    return texts.map(() => vector(DIMS));
  });
  try {
    // The hourly tick firing while the first sweep is still embedding. Both selected the same
    // pending rows — the anti-join cannot see an embed that has not been written yet — so an
    // unguarded second pass pays the provider twice for one result.
    await Promise.all([runEmbeddingBackfill(), runEmbeddingBackfill()]);
    assert.equal(calls, 1, 'the second tick returned without dispatching');
    assert.equal(peak, 1, 'never two passes at once');
    assert.equal(vectorsFor(h), 2, 'and the first pass still did its work');

    // The flag is released in a finally, so the NEXT tick runs normally.
    await seed(h, 1);
    await runEmbeddingBackfill();
    assert.equal(calls, 2, 'the guard is not sticky');
  } finally {
    setArchiveEmbedder(null);
    await purgeArchiveFor({ handle: h });
  }
});

test('a provider that ignores `dimensions` halts the backfill after 3 runs, reported once', async () => {
  __resetBackfillGuardsForTests();
  const h = freshHandle();
  await seed(h, 3);
  const before = configErrorRows();

  let calls = 0;
  setArchiveEmbedder(wrongWidthEmbedder(() => { calls++; }));
  try {
    // Runs 1 and 2: refused, counted, but still attempted — a bad afternoon is not a
    // misconfiguration, and this must not trip on a single odd response.
    await runEmbeddingBackfill();
    await runEmbeddingBackfill();
    assert.equal(calls, 2, 'still trying');
    assert.equal(configErrorRows(), before, 'nothing reported yet');
    assert.equal(vectorsFor(h), 0, 'and nothing wrong-width was ever stored');

    // Run 3 trips it.
    await runEmbeddingBackfill();
    assert.equal(calls, 3);
    assert.equal(configErrorRows(), before + 1, 'reported once, on the run that concluded it');

    // Every run after this one is free: no dispatch, no spend, no second report. Only a restart
    // (with a fixed EMBEDDINGS_DIMENSIONS) brings it back.
    await runEmbeddingBackfill();
    await runEmbeddingBackfill();
    assert.equal(calls, 3, 'halted — the provider is not asked again');
    assert.equal(configErrorRows(), before + 1, 'and it is not re-reported every hour');
  } finally {
    setArchiveEmbedder(null);
    await purgeArchiveFor({ handle: h });
  }
});

test('one successful embed resets the streak — the breaker counts CONSECUTIVE failures', async () => {
  __resetBackfillGuardsForTests();
  const h = freshHandle();
  const before = configErrorRows();

  let calls = 0;
  const bad = wrongWidthEmbedder(() => { calls++; });
  const good: Embedder = async (texts) => { calls++; return texts.map(() => vector(DIMS)); };
  try {
    for (const run of [bad, bad] as const) {
      await seed(h, 1);
      setArchiveEmbedder(run);
      await runEmbeddingBackfill();
    }
    assert.equal(configErrorRows(), before, 'two is not three');

    // A run that actually stores something: whatever was wrong has stopped being wrong.
    setArchiveEmbedder(good);
    await runEmbeddingBackfill();
    assert.ok(vectorsFor(h) > 0);

    // Two more failures — the fifth and sixth failing-shaped runs overall. Without the reset the
    // breaker would have fired by now; with it, the provider is still being asked.
    setArchiveEmbedder(bad);
    await seed(h, 1);
    await runEmbeddingBackfill();
    await seed(h, 1);
    const beforeLast = calls;
    await runEmbeddingBackfill();
    assert.equal(calls, beforeLast + 1, 'still dispatching: the success reset the count');
    assert.equal(configErrorRows(), before, 'and nothing was ever reported');
  } finally {
    setArchiveEmbedder(null);
    await purgeArchiveFor({ handle: h });
  }
});

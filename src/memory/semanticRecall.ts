// Semantic recall's wiring: the ONE place the real embedder is registered, plus the background
// timer that fills the archive's vector table in.
//
// THE LOAD-BEARING PROPERTY, and the reason this file exists at all rather than the registration
// living in the repository or in embed.ts: the network-capable embedder is registered nowhere but
// initSemanticRecall(), and src/index.ts is this module's only importer. `npm test` never imports
// index.ts, so no test — however deep, however careless — can reach a provider through the memory
// store. Tests register their own fake and the store cannot tell the difference. Keep it that way:
// importing this module from anything on a code path a test can reach would quietly hand every
// suite a live API client.
//
// Timer shape is startRetentionTimers' (src/db/retention.ts): idempotent to arm, a boot delay so
// the first run doesn't collide with startup, an unref'd interval after it, and a body that can
// never take the process down.

import { backfillArchiveEmbeddings, setArchiveEmbedder } from '../db/repositories/memoryArchiveVectors.js';
import { embedTexts, embeddingsConfigured, embeddingsModel, embeddingsDims } from '../llm/embed.js';

const HOUR_MS = 3600_000;
/** Delay before the first backfill: long enough that a restart's own work lands first. Matches
 *  the retention sweeps' boot delay for the same reason. */
const BOOT_DELAY_MS = 60_000;

/** How often the backfill runs (env: MEMORY_EMBED_INTERVAL_MS). */
function intervalMs(): number {
  const n = Number(process.env.MEMORY_EMBED_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HOUR_MS;
}

/**
 * One backfill pass. Exported so it can be driven directly (tests, a manual catch-up) without
 * arming a timer. Bounded inside backfillArchiveEmbeddings by batchSize × maxBatches, so a first
 * run over a full archive is many small runs rather than one unbounded spend.
 */
export async function runEmbeddingBackfill(): Promise<void> {
  try {
    const res = await backfillArchiveEmbeddings();
    if (res.embedded > 0 || res.skipped > 0) {
      console.log(`[semantic-recall] backfill: ${res.embedded} embedded, ${res.skipped} skipped, ${res.remaining} remaining`);
    }
  } catch (error) {
    // Best-effort like every other sweep: a background pass must never take the process down.
    console.warn('[semantic-recall] backfill failed', error);
  }
}

let armed = false;

/** Called once from src/index.ts at boot. A no-op unless MEMORY_SEMANTIC_RECALL is on AND the
 *  OpenRouter lane has a key — with either missing, no embedder is registered and recall_memory
 *  stays exactly the lexical search it has always been. */
export function initSemanticRecall(): void {
  if (armed) return;
  if (!embeddingsConfigured()) return;
  armed = true;

  setArchiveEmbedder((texts, ctx) => embedTexts(texts, ctx));
  console.log(`[semantic-recall] on — ${embeddingsModel()} @ ${embeddingsDims()}d, backfill every ${Math.round(intervalMs() / 60_000)}m`);

  const boot = setTimeout(() => { void runEmbeddingBackfill(); }, BOOT_DELAY_MS);
  (boot as { unref?: () => void }).unref?.();

  const periodic = setInterval(() => { void runEmbeddingBackfill(); }, intervalMs());
  (periodic as { unref?: () => void }).unref?.();
}

// Semantic recall's wiring: the ONE place the real embedder is registered, plus the background
// timer that fills the archive's vector table in.
//
// THE LOAD-BEARING PROPERTY, and the reason this file exists at all rather than the registration
// living in the repository or in embed.ts: the network-capable embedder is registered nowhere but
// initSemanticRecall(), and src/index.ts is the only PRODUCTION importer of this module. `npm test`
// never imports index.ts, so no test — however deep, however careless — can reach a provider
// through the memory store. Tests register their own fake and the store cannot tell the difference.
// Keep it that way: importing this module from anything on a production code path a test can reach
// would quietly hand every suite a live API client. (semanticRecall.test.ts imports this file
// directly to drive the run guards below; it never calls initSemanticRecall, so nothing registers
// but its own fake.)
//
// Timer shape is startRetentionTimers' (src/db/retention.ts): idempotent to arm, a boot delay so
// the first run doesn't collide with startup, an unref'd interval after it, and a body that can
// never take the process down.

import { backfillArchiveEmbeddings, setArchiveEmbedder } from '../db/repositories/memoryArchiveVectors.js';
import { reportError } from '../diagnostics/errorLog.js';
import {
  embedTexts, embeddingsConfigured, embeddingsModel, embeddingsDims, embeddingsWidthRefusals,
} from '../llm/embed.js';

const HOUR_MS = 3600_000;
/** Delay before the first backfill: long enough that a restart's own work lands first. Matches
 *  the retention sweeps' boot delay for the same reason. */
const BOOT_DELAY_MS = 60_000;

/** How often the backfill runs (env: MEMORY_EMBED_INTERVAL_MS). */
function intervalMs(): number {
  const n = Number(process.env.MEMORY_EMBED_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : HOUR_MS;
}

// ── Run guards ──────────────────────────────────────────────────────────────

/** True while a pass is in flight. The interval does not know how long a run takes: a first sweep
 *  over a full archive can outlive its hour, and two concurrent passes would select the SAME
 *  pending rows (the anti-join can't see an in-flight embed) and pay twice for one result. */
let running = false;

/** Consecutive runs that embedded nothing AND had at least one batch refused for width. */
let widthFailStreak = 0;
/** How many such runs it takes to conclude the provider is ignoring `dimensions` rather than
 *  having a bad afternoon. Three hours of evidence, at the default interval. */
const WIDTH_FAIL_LIMIT = 3;
/** Set once the streak is reached; cleared only by a process restart, because the thing it is
 *  waiting for (an env fix, a model change) IS a restart. */
let halted = false;

/**
 * One backfill pass. Exported so it can be driven directly (tests, a manual catch-up) without
 * arming a timer. Bounded inside backfillArchiveEmbeddings by batchSize × maxBatches, so a first
 * run over a full archive is many small runs rather than one unbounded spend.
 *
 * Two guards on top of that bound: no two passes at once, and no passes at all once the provider
 * has proven it will not answer at the width the store needs.
 */
export async function runEmbeddingBackfill(): Promise<void> {
  // A provider ignoring `dimensions` fails the same way every hour, forever, and every one of
  // those runs bills a full batch for vectors that are then thrown away. Nothing but a config
  // change fixes it, so stop asking.
  if (halted) return;
  if (running) return;
  running = true;
  const refusalsBefore = embeddingsWidthRefusals();
  try {
    const res = await backfillArchiveEmbeddings();
    // Two places a width refusal can surface, and the breaker needs both. The REAL embedder
    // refuses inside embedTexts and hands the store a plain null (indistinguishable from a 502
    // from there), so that count is sampled around the run; a wrong-width vector that gets past
    // an embedder into the store is refused by the backfill itself.
    const widthRefused = res.widthRefused > 0 || embeddingsWidthRefusals() > refusalsBefore;
    if (res.embedded > 0) {
      widthFailStreak = 0;   // it CAN answer at this width — whatever else failed is transient
    } else if (widthRefused) {
      widthFailStreak++;
      if (widthFailStreak >= WIDTH_FAIL_LIMIT) {
        halted = true;
        // ONCE, on the run that trips it: this is a misconfiguration to be read and fixed, not a
        // recurring incident. Warn, not error — recall still works, it is just lexical.
        reportError({
          source: 'memory', category: 'embedding_config', severity: 'warn',
          message: `embeddings backfill halted: ${WIDTH_FAIL_LIMIT} consecutive runs embedded nothing because the provider answered at a width other than ${embeddingsDims()} — it is ignoring the \`dimensions\` param. Set EMBEDDINGS_DIMENSIONS to the model's native width (or blank to accept it) and restart.`,
          detail: { model: embeddingsModel(), dims: embeddingsDims(), runs: widthFailStreak },
        });
      }
    }
    if (res.embedded > 0 || res.skipped > 0) {
      console.log(`[semantic-recall] backfill: ${res.embedded} embedded, ${res.skipped} skipped, ${res.remaining} remaining`);
    }
  } catch (error) {
    // Best-effort like every other sweep: a background pass must never take the process down.
    console.warn('[semantic-recall] backfill failed', error);
  } finally {
    // In a finally, always: a run that threw must not wedge the flag on and end the sweeps.
    running = false;
  }
}

/** Test seam: drop the in-flight flag, the width streak, and the halt. Production clears the halt
 *  by restarting — which is exactly what a fresh test process is. */
export function __resetBackfillGuardsForTests(): void {
  running = false;
  widthFailStreak = 0;
  halted = false;
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

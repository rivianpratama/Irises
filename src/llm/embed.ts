import OpenAI from 'openai';
import { reportError } from '../diagnostics/errorLog.js';
import { recordTokenUsage } from '../db/repositories/tokenUsage.js';
import { checkDailyBudget } from './budget.js';
import { laneKey } from './laneKeys.js';
import {
  embeddingsModel, embeddingsDims, embeddingsDimsParam, l2Normalize, semanticRecallEnabled,
} from '../db/repositories/memoryArchiveVectors.js';

// Text → vectors, through OpenRouter's OpenAI-shaped /embeddings endpoint on the key the rest of
// the app already has. Same client shape as transcribe.ts (a raw SDK call outside callLLM — there
// is no second lane to fall back to: Anthropic ships no embeddings API), and the same failure
// contract as everything else on the recall path: NEVER throws, returns null, and the caller
// degrades to the lexical search that has always been there.
//
// The `dimensions` param is only honoured by text-embedding-3 and later. A provider that ignores
// it answers with 1536 floats where we asked for 512 — which is why every returned vector's width
// is checked against what we asked for. Writing a silently-wrong-width vector would poison the
// store far more expensively than one skipped backfill batch.
//
// Ref: https://openrouter.ai/docs/api-reference/embeddings

export type EmbeddingCreateParams = OpenAI.Embeddings.EmbeddingCreateParams;
export type EmbeddingResponse = OpenAI.Embeddings.CreateEmbeddingResponse;

/** Which model/width vectors are written under, and whether the feature is on at all (env:
 *  MEMORY_SEMANTIC_RECALL, default OFF — unset, no client is ever built and recall behaves exactly
 *  as it did before this feature existed). All three are defined in the storage layer (it owns the
 *  "is this vector current" and "is the semantic leg on" questions and cannot import this file);
 *  re-exported here so the LLM side reads as one API. */
export { embeddingsModel, embeddingsDims, semanticRecallEnabled };

/** Flag on AND the lane has a usable key. Blank counts as unset (see laneKeys.ts): the single-key
 *  setup leaves `OPENROUTER_API_KEY=` in .env, and a client built on that only fails from deep
 *  inside the first request. */
export function embeddingsConfigured(): boolean {
  return semanticRecallEnabled() && laneKey('openrouter') !== undefined;
}

// Lazily built, rebuilt when the key changes — the callLLM lane pattern, keyed at CALL time so a
// .env edit between runs is honoured.
//
// maxRetries: 0 — the SDK's own default (2 retries with backoff, on a 10-minute per-request
// timeout) is the wrong policy for BOTH callers. The recall leg is optional and inside a turn the
// user is waiting through: a retried failure just costs more of their wait for the same lexical
// answer. The backfill runs hourly, so a failed batch is retried in an hour by the next sweep,
// which is a better backoff than any the SDK can do. The bound below is the only budget.
let lane: { key: string; client: OpenAI } | null = null;
function embeddingsClient(): OpenAI | null {
  const key = laneKey('openrouter');
  if (!key) return null;
  if (lane?.key !== key.value) {
    lane = {
      key: key.value,
      client: new OpenAI({ apiKey: key.value, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 }),
    };
  }
  return lane.client;
}

/** How long a call gets, by what it is for. Recall sits INSIDE a user-facing turn: past ~3s the
 *  semantic leg has already cost more than the paraphrase it might have found is worth, and the
 *  lexical answer is sitting there ready. The backfill is a background sweep with nobody waiting,
 *  and a batch of 96 texts legitimately takes tens of seconds. */
const TIMEOUT_MS: Record<'archive_recall' | 'archive_backfill', number> = {
  archive_recall: 3_000,
  archive_backfill: 60_000,
};

/** Reject `work` after `ms`. Same shape as Ops triage's and the note groomer's own bounds
 *  (agents/ops/triage.ts, memory/noteGroomer.ts) — unref'd so a hung provider can never hold the
 *  process open. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`embeddings timeout after ${ms}ms (${label})`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

// Batches refused because the provider answered at a width we did not ask for. Monotonic for the
// life of the process.
let widthRefusals = 0;

/** How many batches have been refused for width so far. The ONE failure here that no retry can
 *  clear (a provider that ignores `dimensions` will answer the next call identically), and the
 *  only way a caller can distinguish it: every failure returns the same `null`. The backfill's
 *  circuit breaker samples this around a run — see src/memory/semanticRecall.ts. */
export function embeddingsWidthRefusals(): number {
  return widthRefusals;
}

/** Both durable trails a failed embedding leaves: the cross-agent error log, and a status='error'
 *  row in the call ledger so a lane that keeps failing shows up as spend-shaped, not just noise. */
function recordEmbedFailure(
  ctx: { label: string; handle?: string },
  model: string,
  err: unknown,
  start: number,
): void {
  reportError({
    source: 'memory', category: 'embedding_error', err,
    handle: ctx.handle,
    detail: { provider: 'openrouter', model, label: ctx.label },
  });
  void recordTokenUsage({
    handle: ctx.handle,
    role: 'embed', label: ctx.label,
    provider: 'openrouter', model,
    latencyMs: Date.now() - start,
    status: 'error', error: String((err as Error)?.message ?? err),
  }).catch(() => { /* swallow: never surface analytics failures */ });
}

/**
 * Embed a batch of texts. Returns unit-length vectors in input order, or null on ANY problem —
 * unconfigured, budget tripped, HTTP error, a short response, a wrong-width vector. Null is not
 * an error condition for callers: it means "no semantic leg this time".
 *
 * Every call is BOUNDED (see TIMEOUT_MS): a hung provider must not hold a user-facing turn open,
 * and a timeout is just another way to arrive at null — same ledger row, same degrade to lexical.
 * The bound lives here rather than at the call site so no caller can forget it.
 *
 * `deps.create` (and `deps.timeoutMs`) are injectable for unit tests ONLY (the repo's DI
 * convention) — production callers pass nothing and get the OpenRouter client above.
 */
export async function embedTexts(
  texts: string[],
  ctx: { label: 'archive_backfill' | 'archive_recall'; handle?: string },
  deps?: {
    create?: (params: EmbeddingCreateParams) => Promise<EmbeddingResponse>;
    timeoutMs?: number;
  },
): Promise<Float32Array[] | null> {
  if (!texts.length) return [];
  if (!semanticRecallEnabled()) return null;
  if (!laneKey('openrouter')) {
    // Flag on, no key: a misconfiguration rather than a decision, and otherwise invisible —
    // recall would just quietly stay lexical forever. Folded by fingerprint, so it costs one row.
    reportError({
      source: 'memory', category: 'embedding_error', severity: 'warn',
      message: 'MEMORY_SEMANTIC_RECALL is on but OPENROUTER_API_KEY is unset or blank — recall stays lexical',
      detail: { label: ctx.label },
    });
    return null;
  }

  const model = embeddingsModel();
  const dims = embeddingsDims();
  const start = Date.now();

  // Before any dispatch, like callLLM: a tripped breaker must not bill a background sweep.
  try {
    await checkDailyBudget('embed');
  } catch (err) {
    recordEmbedFailure(ctx, model, err, start);
    return null;
  }

  const dimensions = embeddingsDimsParam();
  const params: EmbeddingCreateParams = {
    model,
    input: texts,
    encoding_format: 'float',
    // Sent only when set: 0/blank means "take whatever the model's native width is".
    ...(dimensions !== null ? { dimensions } : {}),
  };

  let resp: EmbeddingResponse;
  try {
    const create = deps?.create ?? (async (p: EmbeddingCreateParams) => {
      const client = embeddingsClient();
      if (!client) throw new Error('OPENROUTER_API_KEY not configured (embeddings lane unavailable)');
      return client.embeddings.create(p);
    });
    resp = await withTimeout(create(params), deps?.timeoutMs ?? TIMEOUT_MS[ctx.label], ctx.label);
  } catch (err) {
    recordEmbedFailure(ctx, model, err, start);
    return null;
  }

  const data = resp?.data ?? [];
  if (data.length !== texts.length) {
    recordEmbedFailure(ctx, model, new Error(`embeddings returned ${data.length} vectors for ${texts.length} inputs`), start);
    return null;
  }
  // By `index`, not by array position: the contract is index-keyed, and a caller lines these up
  // with archive row ids — a silently permuted batch would attach every vector to the wrong row.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: Float32Array[] = [];
  for (const item of ordered) {
    const values = item?.embedding;
    if (!Array.isArray(values) || values.length !== dims) {
      // Counted as well as reported: the caller only ever sees `null` here, which is the same
      // thing a 502 looks like — and the backfill's circuit breaker has to be able to tell the
      // unfixable failure from the transient one. See embeddingsWidthRefusals().
      widthRefusals++;
      recordEmbedFailure(
        ctx, model,
        new Error(`embedding width ${Array.isArray(values) ? values.length : 'none'} ≠ requested ${dims} — dimensions param ignored?`),
        start,
      );
      return null;
    }
    // Normalized here, once, so every vector that reaches the store is unit-length and cosine
    // is a plain dot product in the scan.
    out.push(l2Normalize(Float32Array.from(values)));
  }

  void recordTokenUsage({
    handle: ctx.handle,
    role: 'embed', label: ctx.label,
    provider: 'openrouter', model,
    usage: {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    latencyMs: Date.now() - start,
    status: 'ok',
  }).catch(() => { /* swallow: never surface analytics failures */ });
  return out;
}

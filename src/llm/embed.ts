import OpenAI from 'openai';
import { reportError } from '../diagnostics/errorLog.js';
import { recordTokenUsage } from '../db/repositories/tokenUsage.js';
import { checkDailyBudget } from './budget.js';
import { laneKey } from './laneKeys.js';
import {
  embeddingsModel, embeddingsDims, embeddingsDimsParam, l2Normalize,
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

/** Which model/width vectors are written under. Defined in the storage layer (it owns the
 *  "is this vector current" question and cannot import this file); re-exported here so the LLM
 *  side reads as one API. */
export { embeddingsModel, embeddingsDims };

/** The feature gate (env: MEMORY_SEMANTIC_RECALL). Default OFF — unset, no client is ever built
 *  and recall behaves exactly as it did before this feature existed. */
export function semanticRecallEnabled(): boolean {
  const v = (process.env.MEMORY_SEMANTIC_RECALL || '').trim().toLowerCase();
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Flag on AND the lane has a usable key. Blank counts as unset (see laneKeys.ts): the single-key
 *  setup leaves `OPENROUTER_API_KEY=` in .env, and a client built on that only fails from deep
 *  inside the first request. */
export function embeddingsConfigured(): boolean {
  return semanticRecallEnabled() && laneKey('openrouter') !== undefined;
}

// Lazily built, rebuilt when the key changes — the callLLM lane pattern, keyed at CALL time so a
// .env edit between runs is honoured.
let lane: { key: string; client: OpenAI } | null = null;
function embeddingsClient(): OpenAI | null {
  const key = laneKey('openrouter');
  if (!key) return null;
  if (lane?.key !== key.value) {
    lane = { key: key.value, client: new OpenAI({ apiKey: key.value, baseURL: 'https://openrouter.ai/api/v1' }) };
  }
  return lane.client;
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
 * `deps.create` is injectable for unit tests ONLY (the repo's DI convention) — production callers
 * pass nothing and get the OpenRouter client above.
 */
export async function embedTexts(
  texts: string[],
  ctx: { label: 'archive_backfill' | 'archive_recall'; handle?: string },
  deps?: { create?: (params: EmbeddingCreateParams) => Promise<EmbeddingResponse> },
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
    resp = await create(params);
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

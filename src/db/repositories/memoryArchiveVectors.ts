// The cold archive's companion vectors — the SEMANTIC leg of recall_memory, beside the lexical
// one in memoryArchive.ts. Rows live in memory_archive_embeddings, keyed by archive id with
// ON DELETE CASCADE: a vector that outlived its archive row would be a forgotten memory still
// semantically reachable, so the store never holds a vector the archive doesn't.
//
// PURE STORAGE. This module imports nothing from src/llm — it holds vectors, compares them, and
// asks whoever registered an Embedder for the numbers. The real embedder is registered exactly
// once, from src/memory/semanticRecall.ts (imported only by src/index.ts), so a test that never
// imports index.ts cannot reach the network through here no matter what it calls.
//
// Failure policy: same as memoryArchive.ts — best-effort, logDbError, never throw to callers.
// A missing/failed embedding must degrade recall to today's lexical behavior, never break a turn.
//
// Vectors are L2-NORMALIZED at write time, which is what makes cosine similarity a plain dot
// product in the scan below.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';

/** Turns text into vectors. Returns null when embeddings are unavailable or the call failed —
 *  every caller degrades to the lexical path rather than waiting or throwing. */
export type Embedder = (
  texts: string[],
  ctx: { label: 'archive_backfill' | 'archive_recall'; handle?: string },
) => Promise<Float32Array[] | null>;

let embedder: Embedder | null = null;

/** Register the process's embedder (production: once, from initSemanticRecall). null clears it,
 *  which is also how the tests put the store back to lexical-only in a finally block. */
export function setArchiveEmbedder(fn: Embedder | null): void {
  embedder = fn;
}

/** The registered embedder, or null when semantic recall is off / unconfigured. */
export function archiveEmbedder(): Embedder | null {
  return embedder;
}

// ── Embedding config ────────────────────────────────────────────────────────
// Read at CALL time (.env edits between runs are honoured), and defined HERE rather than in
// src/llm/embed.ts because the storage layer cannot import the LLM layer: the backfill's
// anti-join and the scan's filter both need to know which model's vectors count as current.
// src/llm/embed.ts re-exports these so the LLM-side API still reads as its own.

/** Dimensionality when EMBEDDINGS_DIMENSIONS is unset — 512 is a 3x storage saving over the
 *  provider default at ~no measured recall cost for archive-sized corpora. */
export const EMBEDDINGS_DIMS_DEFAULT = 512;
/** What text-embedding-3-* returns when no `dimensions` param is sent. */
export const EMBEDDINGS_PROVIDER_DIMS = 1536;

/** The feature gate (env: MEMORY_SEMANTIC_RECALL). Default OFF. Lives HERE, beside the model and
 *  width, for the same reason they do: the storage layer must be able to answer "is the semantic
 *  leg on?" at call time without importing src/llm. src/llm/embed.ts re-exports it, and reads the
 *  SAME function — a runtime flip cannot leave the two disagreeing about whether to embed. */
export function semanticRecallEnabled(): boolean {
  const v = (process.env.MEMORY_SEMANTIC_RECALL || '').trim().toLowerCase();
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The embedding model vectors are written under (env: EMBEDDINGS_MODEL). */
export function embeddingsModel(): string {
  return process.env.EMBEDDINGS_MODEL?.trim() || 'openai/text-embedding-3-small';
}

// The dims typo is a boot-time misconfiguration, and this function is called on EVERY embed and
// every scan — warning each time would bury the log it is trying to be. Once per process is
// enough to find it, and there is nothing new to learn on the second occurrence.
let warnedDimsTypo = false;

/** The `dimensions` value to SEND, or null to send none (0/blank = take the provider default).
 *  Blank-vs-unset matters here the same way it does for keys: `EMBEDDINGS_DIMENSIONS=` is a
 *  deliberate "let the provider decide", not "use the default 512". */
export function embeddingsDimsParam(): number | null {
  const raw = process.env.EMBEDDINGS_DIMENSIONS;
  if (raw === undefined) return EMBEDDINGS_DIMS_DEFAULT;
  const v = raw.trim();
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    if (!warnedDimsTypo) {
      warnedDimsTypo = true;
      console.warn(`[memory-vectors] EMBEDDINGS_DIMENSIONS="${raw}" is not a number — using ${EMBEDDINGS_DIMS_DEFAULT} (warned once)`);
    }
    return EMBEDDINGS_DIMS_DEFAULT;
  }
  if (n <= 0) return null;
  return Math.floor(n);
}

/** How many floats a current vector must have — the width the store validates against. */
export function embeddingsDims(): number {
  return embeddingsDimsParam() ?? EMBEDDINGS_PROVIDER_DIMS;
}

// ── Vector codec + math ─────────────────────────────────────────────────────

/** float32 little-endian, copied out of the view's buffer (a Float32Array can be a window onto
 *  a larger one — binding that raw would store its neighbours too). */
export function encodeVector(v: Float32Array): Buffer {
  return Buffer.copyBytesFrom(v);
}

/**
 * Read a stored vector back. Returns null — never throws — on a truncated blob or a width that
 * disagrees with `dims`: a half-written vector must be ignored, not compared against.
 */
export function decodeVector(blob: Uint8Array, dims: number): Float32Array | null {
  try {
    if (!blob || dims <= 0 || blob.byteLength !== dims * 4) return null;
    // node:sqlite hands back byteOffset 0 today, but the typed-array view over a BLOB is an
    // experimental API: a misaligned offset would make the Float32Array constructor throw, so
    // copy into a fresh buffer instead.
    if (blob.byteOffset % 4 !== 0) return new Float32Array(blob.slice().buffer);
    return new Float32Array(blob.buffer, blob.byteOffset, dims);
  } catch {
    return null;
  }
}

/** Unit-length copy. A zero (or non-finite) vector is returned as-is — there is no direction to
 *  normalize toward, and it scores 0 against everything, which is the right answer. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  if (!Number.isFinite(norm) || norm === 0) {
    out.set(v);
    return out;
  }
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Dot product — cosine similarity, given both sides are normalized. Mismatched widths score 0
 *  rather than comparing the overlap of two different embedding spaces. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Store (or replace) one archive row's vector. Guarded by an EXISTS subquery rather than left to
 * the foreign key: `INSERT OR IGNORE` does NOT swallow an FK violation, so a /forget that landed
 * while this vector was in flight would throw instead of being the no-op it is. Returns whether
 * a row was written — false means the archive row is already gone.
 */
export function upsertArchiveVector(archiveId: number, vec: Float32Array, model: string, dims: number): boolean {
  try {
    if (vec.length !== dims) {
      // Logged, not silent: the OTHER false below is a /forget landing mid-flight, which is
      // routine. A width refusal is a dims misconfiguration (a provider ignoring `dimensions`),
      // and reading it as that routine race is how a store that never fills in looks normal.
      logDbError('upsertArchiveVector (width)', new Error(`vector width ${vec.length} ≠ configured ${dims} — vector not stored`));
      return false;
    }
    const normalized = l2Normalize(vec);
    const res = stmt(
      `INSERT OR REPLACE INTO memory_archive_embeddings (archive_id, vector, dims, model, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM memory_archive WHERE id = ?)`
    ).run(archiveId, encodeVector(normalized), dims, model, Date.now(), archiveId);
    return Number(res.changes) > 0;
  } catch (error) {
    logDbError('upsertArchiveVector', error);
    return false;
  }
}

/** Drop a handle's and/or a chat's vectors. Belt-and-braces beside the cascade — /forget must not
 *  rest on a pragma alone (see purgeArchiveFor). Returns rows removed. */
export function deleteVectorsForScope(scope: { handle?: string; chatId?: string }): number {
  try {
    let removed = 0;
    if (scope.handle) {
      removed += Number(stmt(
        `DELETE FROM memory_archive_embeddings WHERE archive_id IN
           (SELECT id FROM memory_archive WHERE agent_handle = ?)`
      ).run(scope.handle).changes);
    }
    if (scope.chatId) {
      removed += Number(stmt(
        `DELETE FROM memory_archive_embeddings WHERE archive_id IN
           (SELECT id FROM memory_archive WHERE chat_id = ?)`
      ).run(scope.chatId).changes);
    }
    return removed;
  } catch (error) {
    logDbError('deleteVectorsForScope', error);
    return 0;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

interface VectorRow {
  id: number;
  vector: Uint8Array;
}

/**
 * The semantic leg: brute-force cosine over the scoped slice of the archive. `scopeSql`/`scopeParams`
 * are the caller's own scope clause (aliased `a.`), reused verbatim so the vector leg can never be
 * scoped differently from the lexical one.
 *
 * Brute force is deliberate: a single-user archive is capped at 10k rows/handle, and `candidates`
 * bounds the scan below that anyway. Only ids and vectors are materialized — the content and meta
 * of a row that loses the ranking are never read.
 */
export function vectorCandidates(
  queryVec: Float32Array,
  scopeSql: string,
  scopeParams: string[],
  opts: { candidates: number; topK: number; minScore: number; model: string; dims: number },
): Array<{ id: number; score: number }> {
  try {
    const rows = stmt(
      `SELECT e.archive_id AS id, e.vector AS vector
       FROM memory_archive_embeddings e
       JOIN memory_archive a ON a.id = e.archive_id
       WHERE ${scopeSql} AND e.model = ? AND e.dims = ?
       ORDER BY a.archived_at DESC, a.id DESC
       LIMIT ?`
    ).all(...scopeParams, opts.model, opts.dims, opts.candidates) as unknown as VectorRow[];

    const scored: Array<{ id: number; score: number }> = [];
    for (const r of rows) {
      const vec = decodeVector(r.vector, opts.dims);
      if (!vec) continue;   // truncated row: ignored, never mis-compared
      const score = dot(queryVec, vec);
      if (score < opts.minScore) continue;
      scored.push({ id: Number(r.id), score });
    }
    // Stable sort over an already recency-ordered list, so equal scores keep newest-first.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topK);
  } catch (error) {
    logDbError('vectorCandidates', error);
    return [];
  }
}

/**
 * Does the caller's scoped slice hold even ONE vector under the current model/width? Asked before
 * the query is embedded, because a scan over zero rows cannot answer anything — and paying a
 * provider round trip (and its latency, on a user-facing turn) for a leg that is structurally
 * empty is the one avoidable cost on this path. True during the backfill window is the normal
 * state of a fresh install: recall stays lexical-fast until there is something to search.
 *
 * `scopeSql`/`scopeParams` are the caller's own clause, verbatim — same scope as the real scan.
 */
export function hasVectorsInScope(
  scopeSql: string,
  scopeParams: string[],
  opts: { model: string; dims: number },
): boolean {
  try {
    const row = stmt(
      `SELECT 1 AS present FROM memory_archive_embeddings e
       JOIN memory_archive a ON a.id = e.archive_id
       WHERE ${scopeSql} AND e.model = ? AND e.dims = ?
       LIMIT 1`
    ).get(...scopeParams, opts.model, opts.dims) as { present: number } | undefined;
    return row !== undefined;
  } catch (error) {
    logDbError('hasVectorsInScope', error);
    // On a broken read, claim vectors exist: the scan below is the thing that decides, and it
    // already degrades to [] on failure. Skipping the leg on a read error would silently downgrade
    // recall for a reason that has nothing to do with whether vectors are there.
    return true;
  }
}

/** Archive rows that have no current vector — the backfill's remaining work. */
export function countMissingVectors(): number {
  try {
    const row = stmt(
      `SELECT count(*) AS n FROM memory_archive a
       LEFT JOIN memory_archive_embeddings e ON e.archive_id = a.id
       WHERE e.archive_id IS NULL OR e.model <> ? OR e.dims <> ?`
    ).get(embeddingsModel(), embeddingsDims()) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  } catch (error) {
    logDbError('countMissingVectors', error);
    return 0;
  }
}

// ── Backfill ────────────────────────────────────────────────────────────────

/** Rows embedded per provider call (env: MEMORY_EMBED_BATCH_SIZE). */
function batchSizeFromEnv(): number {
  const n = Number(process.env.MEMORY_EMBED_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 96;
}

/** Batches one backfill run may spend (env: MEMORY_EMBED_MAX_BATCHES_PER_RUN). The bound that
 *  keeps a first run over a full 10k-row archive from becoming one unbounded spend. */
function maxBatchesFromEnv(): number {
  const n = Number(process.env.MEMORY_EMBED_MAX_BATCHES_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

interface PendingRow {
  id: number;
  handle: string | null;
  content: string;
  archived_at: number;
}

/** One page of the anti-join, newest-first, continuing strictly after `cursor`. The cursor is what
 *  makes a run always progress: rows the batch declined to write (a moved forget epoch, a null
 *  embedder result) are left for the NEXT run instead of being re-selected forever in this one. */
function pendingRows(model: string, dims: number, limit: number, cursor: { archivedAt: number; id: number } | null): PendingRow[] {
  const antiJoin = `FROM memory_archive a
       LEFT JOIN memory_archive_embeddings e ON e.archive_id = a.id
       WHERE (e.archive_id IS NULL OR e.model <> ? OR e.dims <> ?)`;
  const order = 'ORDER BY a.archived_at DESC, a.id DESC LIMIT ?';
  if (!cursor) {
    return stmt(
      `SELECT a.id AS id, a.agent_handle AS handle, a.content AS content, a.archived_at AS archived_at
       ${antiJoin} ${order}`
    ).all(model, dims, limit) as unknown as PendingRow[];
  }
  return stmt(
    `SELECT a.id AS id, a.agent_handle AS handle, a.content AS content, a.archived_at AS archived_at
     ${antiJoin} AND (a.archived_at < ? OR (a.archived_at = ? AND a.id < ?)) ${order}`
  ).all(model, dims, cursor.archivedAt, cursor.archivedAt, cursor.id, limit) as unknown as PendingRow[];
}

export interface BackfillResult {
  embedded: number;
  batches: number;
  skipped: number;
  /** Groups whose vectors came back at a width the store cannot use. Reported (rather than folded
   *  into `skipped`) because it is the ONE failure a retry can never clear: a provider that ignores
   *  `dimensions` will answer the next run the same way. The caller's circuit breaker reads this. */
  widthRefused: number;
  remaining: number;
}

/**
 * Embed the archive rows that have no current vector, newest-first and bounded by
 * batchSize × maxBatches. Runs on a background timer, NEVER on the per-turn path: archiveEntries
 * sits under addMessage, and an embedding call there would put a provider round-trip inside every
 * message prune.
 *
 * Each handle's rows are embedded as their own call, fenced by the forget epoch the same way the
 * dossier rewrite is: read before the (slow, awaited) embedding call and re-read before writing,
 * so a /forget that lands mid-flight cannot have its wipe undone by vectors written from the
 * content it just deleted.
 */
export async function backfillArchiveEmbeddings(
  opts?: { batchSize?: number; maxBatches?: number; now?: () => number },
): Promise<BackfillResult> {
  const embed = archiveEmbedder();
  if (!embed) return { embedded: 0, batches: 0, skipped: 0, widthRefused: 0, remaining: countMissingVectors() };

  const model = embeddingsModel();
  const dims = embeddingsDims();
  const batchSize = Math.max(1, opts?.batchSize ?? batchSizeFromEnv());
  const maxBatches = Math.max(1, opts?.maxBatches ?? maxBatchesFromEnv());
  let embedded = 0;
  let batches = 0;
  let skipped = 0;
  let widthRefused = 0;
  let cursor: { archivedAt: number; id: number } | null = null;

  for (let b = 0; b < maxBatches; b++) {
    let rows: PendingRow[];
    try {
      rows = pendingRows(model, dims, batchSize, cursor);
    } catch (error) {
      logDbError('backfillArchiveEmbeddings (select)', error);
      break;
    }
    if (!rows.length) break;
    batches++;
    const last = rows[rows.length - 1];
    cursor = { archivedAt: Number(last.archived_at), id: Number(last.id) };

    // Group by handle so the epoch fence has a handle to read. Chat-scoped rows with no handle
    // share the '' group: there is no per-handle forget to race with them.
    const groups = new Map<string, PendingRow[]>();
    for (const r of rows) {
      if (!r.content) { skipped++; continue; }
      const key = r.handle ?? '';
      const g = groups.get(key);
      if (g) g.push(r); else groups.set(key, [r]);
    }

    for (const [handle, group] of groups) {
      const epoch0 = handle ? getForgetEpoch(handle) : 0;
      let vectors: Float32Array[] | null;
      try {
        vectors = await embed(group.map(r => r.content), { label: 'archive_backfill', handle: handle || undefined });
      } catch (error) {
        // An Embedder is contracted to return null rather than throw; a broken one must still not
        // take the sweep down.
        logDbError('backfillArchiveEmbeddings (embed)', error);
        vectors = null;
      }
      if (!vectors || vectors.length !== group.length) {
        skipped += group.length;
        continue;
      }
      // A width the store cannot use — the `dimensions`-ignoring provider. Refused as ONE group
      // rather than as `group.length` identical upsert warnings, and counted separately so a run
      // that only ever hits this can be told apart from a run that merely found nothing.
      if (vectors.some(v => v.length !== dims)) {
        widthRefused++;
        skipped += group.length;
        continue;
      }
      // Re-read AFTER the await: this is the window a /forget lands in.
      if (handle && getForgetEpoch(handle) !== epoch0) {
        skipped += group.length;
        continue;
      }
      for (let i = 0; i < group.length; i++) {
        if (upsertArchiveVector(group[i].id, vectors[i], model, dims)) embedded++;
        else skipped++;
      }
    }
  }

  // `now` is accepted (and read) so a caller can pin the clock; the write timestamps come from
  // upsertArchiveVector, so it only shapes the log line.
  const at = opts?.now?.() ?? Date.now();
  const remaining = countMissingVectors();
  if (embedded > 0) {
    console.log(`[memory-vectors] backfill: ${embedded} embedded, ${skipped} skipped, ${remaining} remaining (${new Date(at).toISOString()})`);
  }
  return { embedded, batches, skipped, widthRefused, remaining };
}

// TIER 0: the cold archive under every other tier. Nothing Irises ever knew is thrown away
// silently — when a row is retired anywhere upstream (a superseded medium entry, a short row
// past its grace, a pruned message, an evicted profile fact) a copy lands here, searchable by
// the recall_memory tool so "you said something about the lake cabin months ago" has an answer.
//
// Failure policy: BEST-EFFORT, and stricter than the short tier — archiveEntries NEVER throws.
// It rides retire/sweep paths whose real job (rotating a medium entry, deleting an expired row)
// must not break because the lineage copy failed. Searches degrade to [] the same way.
//
// Search backend: FTS5 when the SQLite build has it (bm25 ranking + native snippets), a LIKE
// scan with JS ranking otherwise (see sqlite.ts ftsAvailable). Both paths take the SAME token
// list, so a query behaves the same either way — only the ranking quality differs.
//
// When an embedder is registered (semantic recall on — see src/memory/semanticRecall.ts) the
// search becomes HYBRID: the lexical leg above plus a vector leg over the same rows, fused by
// reciprocal rank. Lexical alone misses a paraphrase that shares no tokens with what was written
// down; vectors alone drift onto the merely-adjacent. Off, or with no embedder, this file
// behaves exactly as it did before — byte for byte.
//
// The one thing that is NOT archived is a user's explicit wipe: /forget purges this table for
// the handle (purgeArchiveFor), and /clear hard-deletes. A forget that left cold copies behind
// would be a forget leak.

import { logDbError } from '../client.js';
import { stmt, ftsAvailable } from '../sqlite.js';
import {
  archiveEmbedder, vectorCandidates, deleteVectorsForScope, l2Normalize,
  embeddingsModel, embeddingsDims, hasVectorsInScope, semanticRecallEnabled,
} from './memoryArchiveVectors.js';

/** Where an archived row came from. Validated here (the column has no CHECK) so a typo'd
 *  feed shows up as a rejected insert instead of an unsearchable mystery source. */
export type ArchiveSource =
  | 'medium_superseded'
  | 'medium_retracted'
  | 'medium_cap_evicted'
  | 'medium_merged'
  | 'short_expired'
  | 'message_pruned'
  | 'profile_fact_evicted'
  | 'long_evicted';

const ARCHIVE_SOURCES: ReadonlySet<string> = new Set<ArchiveSource>([
  'medium_superseded', 'medium_retracted', 'medium_cap_evicted', 'medium_merged',
  'short_expired', 'message_pruned', 'profile_fact_evicted', 'long_evicted',
]);

/** 'long_evicted' is the long tier's feed: one row per dossier LINE that left the document —
 *  pushed out by the size cap, or carried off a section that is no longer written. The dossier
 *  is the one tier a model rewrites, so a line leaving it is the easiest place in the system to
 *  lose something quietly; a cold copy makes it recallable instead. Written as:
 *
 *    { source: 'long_evicted', agentHandle, kind: 'dossier_line',
 *      request: <section heading, e.g. '## Their world'>,
 *      content: <the line's text, stamp-free>,
 *      meta: { section, since: <'YYYY-MM-DD' | null>, reason: 'cap' | 'relocated' },
 *      createdAt: <the (since …) date at noon UTC, or now when the line was never stamped> }
 *
 *  Noon UTC, not midnight: the stamp is a day in the user's zone, and noon is the only hour that
 *  lands on that same day in every zone. `since: null` means the line predates stamping, so the
 *  archive time is the closest honest answer for when it was known. */

export interface ArchiveEntry {
  id: number;
  agentHandle?: string;
  chatId?: string;
  source: ArchiveSource;
  kind?: string;
  request?: string;
  content: string;
  meta: Record<string, unknown>;
  createdAt: number;  // epoch ms — when the memory was originally made
  archivedAt: number; // epoch ms — when it was retired into here
}

/** What archiveEntries accepts: an ArchiveEntry minus the columns the store assigns. */
export interface ArchiveInput {
  agentHandle?: string;
  chatId?: string;
  source: ArchiveSource;
  kind?: string;
  request?: string;
  content: string;
  meta?: Record<string, unknown>;
  createdAt?: number;
}

export interface ArchiveHit {
  entry: ArchiveEntry;
  /** Higher is better, but the SCALE differs by backend and is only ever meaningful WITHIN one
   *  result set. FTS: -bm25 (bm25 is negative-better). LIKE: distinct-term hit weight. Hybrid:
   *  the reciprocal-rank fusion sum, so at most 2/(60+1) ≈ 0.033 — never compare across runs. */
  score: number;
  snippet: string;
}

/** Per-handle row cap. Generous — an archive that forgets defeats the point — but bounded:
 *  message_pruned feeds it every day and a small VM's disk is finite. */
export const ARCHIVE_MAX_ROWS_PER_HANDLE = 10_000;
/** Archived content is a searchable trace, not the full artifact (the short tier already caps
 *  at 8k and renderers slice far smaller). */
export const ARCHIVE_CONTENT_MAX_CHARS = 4_000;
const SNIPPET_CHARS = 300;
/** LIKE-path candidate window: ranked in JS, so the SQL scan stays bounded. */
const LIKE_CANDIDATES = 200;
const MAX_QUERY_TOKENS = 8;
/** RRF's damping constant, the standard 60: it flattens the head of each list so a rank-1 hit
 *  can't win on its own, which is the whole point of fusing two rankings that disagree. */
const RRF_K = 60;
/** Vector hits considered for fusion. Deeper than `limit` (the fusion re-ranks them) but shallow
 *  enough that semantic near-misses can't crowd out the lexical leg. */
const VECTOR_TOP_K = 24;

/** Vectors scanned per query (env: MEMORY_VECTOR_CANDIDATES). The scan is brute-force, so this is
 *  the ceiling on its cost — 10k × 512 floats is 10-25ms. Defaulted to ARCHIVE_MAX_ROWS_PER_HANDLE
 *  DELIBERATELY: the scan takes candidates newest-first, so anything lower silently truncates the
 *  semantic leg by recency, and "you said something months ago" is the case this feature exists
 *  for. Lower it only to buy latency back, knowing that is what you are selling. */
function vectorCandidateLimit(): number {
  const n = Number(process.env.MEMORY_VECTOR_CANDIDATES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ARCHIVE_MAX_ROWS_PER_HANDLE;
}

/** Cosine floor a vector hit must clear to enter the fusion at all (env: MEMORY_SEMANTIC_MIN_SCORE).
 *  Applied BEFORE fusion on purpose: below it, "semantically nearest" means nothing more than
 *  "least unrelated", and such a hit must never displace a real lexical match. */
function semanticMinScore(): number {
  const n = Number(process.env.MEMORY_SEMANTIC_MIN_SCORE);
  return Number.isFinite(n) ? n : 0.25;
}

interface ArchiveRow {
  id: number;
  agent_handle: string | null;
  chat_id: string | null;
  source: string;
  kind: string | null;
  request: string | null;
  content: string;
  meta_json: string;
  created_at: number;
  archived_at: number;
}

function fromRow(r: ArchiveRow): ArchiveEntry {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(r.meta_json) as Record<string, unknown>; } catch { /* unparseable → {} */ }
  return {
    id: r.id,
    agentHandle: r.agent_handle ?? undefined,
    chatId: r.chat_id ?? undefined,
    source: r.source as ArchiveSource,
    kind: r.kind ?? undefined,
    request: r.request ?? undefined,
    content: r.content,
    meta,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

/** 'vector' is HYBRID — the vector leg plus whichever lexical backend this build has, never
 *  vectors alone. The two lexical values name a build capability; 'vector' names a feature. */
export type ArchiveSearchBackend = 'fts5' | 'like' | 'vector';

let backendOverride: ArchiveSearchBackend | null = null;

/** Whichever lexical backend this build actually has — the leg that runs under every mode. */
function lexicalBackend(): 'fts5' | 'like' {
  try {
    return ftsAvailable() ? 'fts5' : 'like';
  } catch {
    return 'like';
  }
}

/** Which backend searchArchive will use (diagnostics + the backend-parity tests). Resolves to
 *  'vector' only when the flag is on AND an embedder is registered: with the feature off there is
 *  nothing to fuse, and the answer must be the pre-hybrid one.
 *
 *  Both halves are read at CALL time, and the flag is read from the same function embedTexts
 *  consults. A registered embedder outlives a runtime `MEMORY_SEMANTIC_RECALL=off` (nothing
 *  un-registers it), and without the flag here this would keep reporting 'vector' while every
 *  embed call refused — diagnostics describing a hybrid search that isn't happening. */
export function archiveSearchBackend(): ArchiveSearchBackend {
  if (backendOverride === 'fts5' || backendOverride === 'like') return backendOverride;
  return semanticRecallEnabled() && archiveEmbedder() ? 'vector' : lexicalBackend();
}

/** Test seam: pin the search backend so EVERY path is exercised on one build (the lexical two
 *  must answer the same query the same way — only ranking quality may differ). Pinning a lexical
 *  backend also suppresses the vector leg, which is how a test compares hybrid against lexical
 *  with one embedder registered. null = auto. */
export function __setArchiveBackendForTests(backend: ArchiveSearchBackend | null): void {
  backendOverride = backend;
}

let insertDelayForTests: number | null = null;

/** Test seam: make archiveEntries actually SUSPEND before it inserts. The body below is async in
 *  signature but synchronous in fact, so a caller that drops its archive promise on the floor still
 *  sees the rows — which makes an "it was awaited" assertion vacuous. With a delay set, the rows
 *  only exist once the promise resolves, so the regression tests bite. null = off (production
 *  shape: unset, nothing is awaited, not one timer is created). */
export function __setArchiveEntriesDelayForTests(ms: number | null): void {
  insertDelayForTests = ms;
}

/**
 * Archive retired rows. NEVER throws and never rejects: every caller is a retire/sweep path
 * whose real work must land regardless (a lineage copy is strictly a bonus). Content is sliced
 * to the cap, unknown sources are dropped with a log, and the per-handle cap is enforced
 * opportunistically as part of the write, so no separate sweep is needed to bound a hot handle.
 */
export async function archiveEntries(entries: ArchiveInput[]): Promise<void> {
  if (!entries.length) return;
  const delay = insertDelayForTests;
  if (delay != null) await new Promise(r => setTimeout(r, delay));
  const now = Date.now();
  const touched = new Set<string>();
  for (const e of entries) {
    try {
      if (!ARCHIVE_SOURCES.has(e.source)) {
        console.warn(`[memory-archive] unknown source "${e.source}" — entry not archived`);
        continue;
      }
      if (!e.content) continue;
      stmt(
        `INSERT INTO memory_archive
           (agent_handle, chat_id, source, kind, request, content, meta_json, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        e.agentHandle ?? null,
        e.chatId ?? null,
        e.source,
        e.kind ?? null,
        e.request ?? null,
        e.content.slice(0, ARCHIVE_CONTENT_MAX_CHARS),
        JSON.stringify(e.meta ?? {}),
        e.createdAt ?? now,
        now,
      );
      if (e.agentHandle) touched.add(e.agentHandle);
    } catch (error) {
      // Logged, not thrown: the caller already retired the row upstream.
      logDbError('archiveEntries', error);
    }
  }
  // Cap enforcement once per handle per BATCH, not per row: the COUNT scans a handle's whole
  // index range, and a daily message prune can archive hundreds of rows in one call — per-row it
  // would be quadratic, on a path addMessage sits on. One pass lands on the same final state
  // (the eviction deletes all the excess at once).
  for (const handle of touched) {
    try {
      enforceHandleCap(handle);
    } catch (error) {
      logDbError('archiveEntries cap', error);
    }
  }
}

/** Drop the oldest rows for a handle once it passes the cap. Runs as part of every write (a COUNT
 *  on an indexed column) so growth is capped continuously rather than in a nightly cliff. */
function enforceHandleCap(handle: string): void {
  const row = stmt('SELECT count(*) AS n FROM memory_archive WHERE agent_handle = ?').get(handle) as { n: number } | undefined;
  const excess = (row?.n ?? 0) - ARCHIVE_MAX_ROWS_PER_HANDLE;
  if (excess <= 0) return;
  stmt(
    `DELETE FROM memory_archive WHERE id IN (
       SELECT id FROM memory_archive WHERE agent_handle = ? ORDER BY archived_at ASC, id ASC LIMIT ?
     )`
  ).run(handle, excess);
}

/** Sweep every over-cap handle (the daily retention pass — a safety net under the per-insert
 *  enforcement above, which only sees handles that are still being written to). */
export async function sweepArchiveCaps(): Promise<number> {
  try {
    const rows = stmt(
      `SELECT agent_handle AS handle, count(*) AS n FROM memory_archive
       WHERE agent_handle IS NOT NULL GROUP BY agent_handle HAVING n > ?`
    ).all(ARCHIVE_MAX_ROWS_PER_HANDLE) as unknown as Array<{ handle: string; n: number }>;
    let removed = 0;
    for (const r of rows) {
      const excess = r.n - ARCHIVE_MAX_ROWS_PER_HANDLE;
      const res = stmt(
        `DELETE FROM memory_archive WHERE id IN (
           SELECT id FROM memory_archive WHERE agent_handle = ? ORDER BY archived_at ASC, id ASC LIMIT ?
         )`
      ).run(r.handle, excess);
      removed += Number(res.changes);
    }
    return removed;
  } catch (error) {
    logDbError('sweepArchiveCaps', error);
    return 0;
  }
}

/** Hard-delete a handle's and/or a chat's archive (the /forget path). Returns rows removed. */
export async function purgeArchiveFor(scope: { handle?: string; chatId?: string }): Promise<number> {
  try {
    // Vectors FIRST, explicitly, even though ON DELETE CASCADE would take them: a forget must not
    // rest on a pragma staying on. Belt and braces — the failure it guards against (a vector
    // outliving its wiped row, still semantically recallable) is the worst bug this feature has.
    deleteVectorsForScope(scope);
    let removed = 0;
    if (scope.handle) {
      removed += Number(stmt('DELETE FROM memory_archive WHERE agent_handle = ?').run(scope.handle).changes);
    }
    if (scope.chatId) {
      removed += Number(stmt('DELETE FROM memory_archive WHERE chat_id = ?').run(scope.chatId).changes);
    }
    return removed;
  } catch (error) {
    logDbError('purgeArchiveFor', error);
    return 0;
  }
}

/**
 * Split a natural-language query into search tokens. Unicode-aware and punctuation-stripping,
 * which is also what NEUTRALIZES FTS5's own operator syntax: every token is re-quoted before it
 * reaches MATCH, so a user query containing `OR`, `NEAR`, `*`, or a stray `"` can only ever be
 * a phrase, never an operator.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_QUERY_TOKENS);
}

/** ±150 chars around the first token hit, ellipsized (the LIKE path's snippet). */
function makeSnippet(content: string, tokens: string[]): string {
  const lower = content.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at === -1 || i < at)) at = i;
  }
  if (content.length <= SNIPPET_CHARS) return content;
  const half = Math.floor(SNIPPET_CHARS / 2);
  const start = at < 0 ? 0 : Math.max(0, at - half);
  const end = Math.min(content.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '… ' : ''}${content.slice(start, end)}${end < content.length ? ' …' : ''}`;
}

/** Scope: the handle's own rows OR this chat's rows. An unscoped call (null) returns nothing
 *  rather than reaching into another user's memories. Built in ONE place so every leg — and the
 *  readiness probe below — is scoped by the same clause and the same bindings. */
function scopeClause(opts: { handle?: string; chatId?: string }): { sql: string; params: string[] } | null {
  const parts: string[] = [];
  const params: string[] = [];
  if (opts.handle) { parts.push('a.agent_handle = ?'); params.push(opts.handle); }
  if (opts.chatId) { parts.push('a.chat_id = ?'); params.push(opts.chatId); }
  if (!parts.length) return null;
  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * Does the slice of the archive a search over this scope would read hold even ONE vector at the
 * current model/width? The same question searchHybrid asks itself before paying for a query
 * embedding, exposed for callers that must decide something BEFORE the search runs — the recall
 * site's expansion gate (agents/convo/shared.ts), which would otherwise skip the lexical
 * paraphrase fallback all through the backfill window, when the vector leg is structurally empty
 * and can contribute exactly nothing.
 *
 * Says nothing about whether the backend is even hybrid — ask archiveSearchBackend() for that.
 */
export function archiveScopeHasVectors(opts: { handle?: string; chatId?: string }): boolean {
  const scope = scopeClause(opts);
  if (!scope) return false;
  return hasVectorsInScope(scope.sql, scope.params, { model: embeddingsModel(), dims: embeddingsDims() });
}

/**
 * Search the archive, scoped to a handle and/or a chat. `limit` is small by design — the hits
 * go into a prompt, and six archived snippets is already a lot of possibly-stale context.
 * Degrades to [] on any failure (a search hiccup must never kill a turn).
 */
export async function searchArchive(opts: {
  query: string;
  handle?: string;
  chatId?: string;
  limit?: number;
}): Promise<ArchiveHit[]> {
  const tokens = tokenize(opts.query);
  const limit = opts.limit ?? 6;
  if (!tokens.length) return [];
  const scope = scopeClause(opts);
  if (!scope) return [];
  const { sql: scopeSql, params: scopeParams } = scope;

  const backend = archiveSearchBackend();
  if (backend !== 'vector') return searchLexical(backend, tokens, scopeSql, scopeParams, limit);
  return searchHybrid(opts.query, tokens, scopeSql, scopeParams, limit, opts.handle);
}

/** The lexical leg, whichever backend this build has. FTS5 first when asked for; a malformed
 *  MATCH or a half-built index falls through to LIKE rather than losing the search. */
function searchLexical(
  backend: 'fts5' | 'like',
  tokens: string[],
  scopeSql: string,
  scopeParams: string[],
  limit: number,
): ArchiveHit[] {
  if (backend === 'fts5') {
    try {
      return searchFts(tokens, scopeSql, scopeParams, limit);
    } catch (error) {
      logDbError('searchArchive (fts5)', error);
    }
  }
  try {
    return searchLike(tokens, scopeSql, scopeParams, limit);
  } catch (error) {
    logDbError('searchArchive (like)', error);
    return [];
  }
}

/**
 * Hybrid: the lexical leg run DEEPER than the caller asked for, plus a vector leg over the same
 * rows, fused by reciprocal rank (1/(60+rank), summed). RRF rather than a weighted score blend
 * because the two legs' scores are on incomparable scales (bm25 vs cosine) — ranks are the only
 * thing they share.
 *
 * Everything that can go missing degrades to the lexical result unchanged: no embedder, a null
 * embedder result, a failed scan, nothing above the score floor.
 */
async function searchHybrid(
  query: string,
  tokens: string[],
  scopeSql: string,
  scopeParams: string[],
  limit: number,
  handle: string | undefined,
): Promise<ArchiveHit[]> {
  // Deeper than `limit`: the fusion re-ranks, so a row the lexical leg put 10th can still make
  // the final six once the vector leg agrees with it.
  const lexical = searchLexical(lexicalBackend(), tokens, scopeSql, scopeParams, Math.max(limit * 4, 24));

  const model = embeddingsModel();
  const dims = embeddingsDims();
  const embed = archiveEmbedder();
  // Nothing to scan ⇒ nothing to embed. During the backfill window (a fresh install, a model
  // change, a handle whose rows are all newer than the last sweep) the vector table for this scope
  // is empty, and a scan over it cannot return a hit no matter what the query means. One indexed
  // EXISTS is cheaper than the provider round trip it saves — and that round trip is latency on a
  // turn the user is waiting through.
  let vectors: Array<{ id: number; score: number }> = [];
  if (embed && hasVectorsInScope(scopeSql, scopeParams, { model, dims })) {
    let queryVec: Float32Array | null = null;
    try {
      // The RAW query, not the tokens: the paraphrase this leg exists to catch lives in the
      // phrasing, and stopwords carry meaning to an embedding model that they don't to bm25.
      const embedded = await embed([query], { label: 'archive_recall', handle });
      queryVec = embedded?.[0] ?? null;
    } catch (error) {
      logDbError('searchArchive (embed)', error);
    }
    if (queryVec) {
      // INVARIANT: the vector leg is handed the SAME scopeSql and the SAME params the lexical
      // legs were built with — one clause, one binding, so the two legs are structurally
      // incapable of being scoped differently. A semantic leg that scoped even slightly wider
      // would be a cross-user memory leak that no lexical test could catch.
      vectors = vectorCandidates(l2Normalize(queryVec), scopeSql, scopeParams, {
        candidates: vectorCandidateLimit(),
        topK: VECTOR_TOP_K,
        minScore: semanticMinScore(),
        model,
        dims,
      });
    }
  }
  // Nothing semantic to add: this must be EXACTLY the pre-hybrid answer, so return the lexical
  // hits untouched rather than round-tripping them through the fusion.
  if (!vectors.length) return lexical.slice(0, limit);

  const fused = new Map<number, { entry: ArchiveEntry; snippet: string; score: number }>();
  lexical.forEach((hit, i) => {
    fused.set(hit.entry.id, { entry: hit.entry, snippet: hit.snippet, score: 1 / (RRF_K + i + 1) });
  });
  // Vector-only hits need their rows read; one query for all of them.
  const missing = vectors.filter(v => !fused.has(v.id)).map(v => v.id);
  const entries = loadArchiveEntries(missing);
  vectors.forEach((v, i) => {
    const term = 1 / (RRF_K + i + 1);
    const seen = fused.get(v.id);
    if (seen) { seen.score += term; return; }
    const entry = entries.get(v.id);
    if (!entry) return;   // deleted between the scan and the read — a forget, most likely
    fused.set(v.id, { entry, snippet: makeSnippet(entry.content, tokens), score: term });
  });

  // Deterministic to the last field: the tests (and a user asking twice) must get the same order.
  const ranked = [...fused.values()].sort((a, b) =>
    b.score - a.score
    || b.entry.archivedAt - a.entry.archivedAt
    || b.entry.id - a.entry.id);
  return ranked.slice(0, limit).map(f => ({
    entry: f.entry,
    score: f.score,
    snippet: f.snippet.slice(0, SNIPPET_CHARS),
  }));
}

/** Archive rows by id, for the vector-only side of a fusion. */
function loadArchiveEntries(ids: number[]): Map<number, ArchiveEntry> {
  const out = new Map<number, ArchiveEntry>();
  if (!ids.length) return out;
  try {
    // json_each keeps one statement shape regardless of how many ids arrive.
    const rows = stmt(
      'SELECT * FROM memory_archive WHERE id IN (SELECT value FROM json_each(?))'
    ).all(JSON.stringify(ids)) as unknown as ArchiveRow[];
    for (const r of rows) out.set(r.id, fromRow(r));
  } catch (error) {
    logDbError('searchArchive (vector rows)', error);
  }
  return out;
}

function searchFts(tokens: string[], scopeSql: string, scopeParams: string[], limit: number): ArchiveHit[] {
  // Each token double-quoted (a phrase) and OR-joined: any-term matching, operators neutralized.
  // The order is bm25 first, then newest-first with the id as the final discriminator: two rows on
  // the same rank (two archived copies of one message, say) must not swap places between runs —
  // the LIKE leg and the fusion are both deterministic to the last field, and this leg is too.
  const match = tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const rows = stmt(
    `SELECT a.*, bm25(memory_archive_fts) AS rank,
            snippet(memory_archive_fts, 0, '', '', ' … ', 16) AS snip
     FROM memory_archive a
     JOIN memory_archive_fts f ON a.id = f.rowid
     WHERE memory_archive_fts MATCH ? AND ${scopeSql}
     ORDER BY rank, a.archived_at DESC, a.id DESC
     LIMIT ?`
  ).all(match, ...scopeParams, limit) as unknown as Array<ArchiveRow & { rank: number; snip: string }>;
  return rows.map(r => ({
    entry: fromRow(r),
    score: -r.rank, // bm25 is negative-better; flip so higher = better everywhere
    snippet: (r.snip || r.content).slice(0, SNIPPET_CHARS),
  }));
}

function searchLike(tokens: string[], scopeSql: string, scopeParams: string[], limit: number): ArchiveHit[] {
  // LIKE wildcards in the user's own words must not widen the match.
  const escaped = tokens.map(t => t.replace(/[%_\\]/g, m => `\\${m}`));
  const anyToken = escaped
    .map(() => "(lower(a.content) LIKE ? ESCAPE '\\' OR lower(a.request) LIKE ? ESCAPE '\\')")
    .join(' OR ');
  const likeParams: string[] = [];
  for (const t of escaped) likeParams.push(`%${t}%`, `%${t}%`);
  const rows = stmt(
    `SELECT a.* FROM memory_archive a
     WHERE ${scopeSql} AND (${anyToken})
     ORDER BY a.archived_at DESC, a.id DESC
     LIMIT ${LIKE_CANDIDATES}`
  ).all(...scopeParams, ...likeParams) as unknown as ArchiveRow[];

  // Rank in JS: distinct terms matched, content hits worth more than request hits. Recency
  // (the SQL order) is the tie-break, so this is a stable sort over an already-ordered list.
  const scored = rows.map(r => {
    const content = r.content.toLowerCase();
    const request = (r.request ?? '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (content.includes(t)) score += 2;
      else if (request.includes(t)) score += 1;
    }
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => ({
    entry: fromRow(s.row),
    score: s.score,
    snippet: makeSnippet(s.row.content, tokens),
  }));
}

/** Recent archive rows for a handle (dashboard/debug view — nothing on the reply path). */
export async function listArchiveFor(handle: string, limit = 50): Promise<ArchiveEntry[]> {
  try {
    const rows = stmt(
      'SELECT * FROM memory_archive WHERE agent_handle = ? ORDER BY archived_at DESC, id DESC LIMIT ?'
    ).all(handle, limit) as unknown as ArchiveRow[];
    return rows.map(fromRow);
  } catch (error) {
    logDbError('listArchiveFor', error);
    return [];
  }
}

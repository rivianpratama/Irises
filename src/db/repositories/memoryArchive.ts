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
// The one thing that is NOT archived is a user's explicit wipe: /forget purges this table for
// the handle (purgeArchiveFor), and /clear hard-deletes. A forget that left cold copies behind
// would be a forget leak.

import { logDbError } from '../client.js';
import { stmt, ftsAvailable } from '../sqlite.js';

/** Where an archived row came from. Validated here (the column has no CHECK) so a typo'd
 *  feed shows up as a rejected insert instead of an unsearchable mystery source. */
export type ArchiveSource =
  | 'medium_superseded'
  | 'medium_retracted'
  | 'medium_cap_evicted'
  | 'medium_merged'
  | 'short_expired'
  | 'message_pruned'
  | 'profile_fact_evicted';

const ARCHIVE_SOURCES: ReadonlySet<string> = new Set<ArchiveSource>([
  'medium_superseded', 'medium_retracted', 'medium_cap_evicted', 'medium_merged',
  'short_expired', 'message_pruned', 'profile_fact_evicted',
]);

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
  /** Higher is better. FTS: -bm25 (bm25 is negative-better). LIKE: distinct-term hit weight. */
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

let backendOverride: 'fts5' | 'like' | null = null;

/** Which backend searchArchive will use (diagnostics + the backend-parity tests). */
export function archiveSearchBackend(): 'fts5' | 'like' {
  if (backendOverride) return backendOverride;
  try {
    return ftsAvailable() ? 'fts5' : 'like';
  } catch {
    return 'like';
  }
}

/** Test seam: pin the search backend so BOTH paths are exercised on one build (they must
 *  answer the same query the same way — only ranking quality may differ). null = auto. */
export function __setArchiveBackendForTests(backend: 'fts5' | 'like' | null): void {
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
  // Scope: the handle's own rows OR this chat's rows. An unscoped call returns nothing rather
  // than reaching into another user's memories.
  const scopeParts: string[] = [];
  const scopeParams: string[] = [];
  if (opts.handle) { scopeParts.push('a.agent_handle = ?'); scopeParams.push(opts.handle); }
  if (opts.chatId) { scopeParts.push('a.chat_id = ?'); scopeParams.push(opts.chatId); }
  if (!scopeParts.length) return [];
  const scopeSql = `(${scopeParts.join(' OR ')})`;

  if (archiveSearchBackend() === 'fts5') {
    try {
      return searchFts(tokens, scopeSql, scopeParams, limit);
    } catch (error) {
      // A malformed MATCH or a half-built index shouldn't lose the search — fall through to LIKE.
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

function searchFts(tokens: string[], scopeSql: string, scopeParams: string[], limit: number): ArchiveHit[] {
  // Each token double-quoted (a phrase) and OR-joined: any-term matching, operators neutralized.
  const match = tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  const rows = stmt(
    `SELECT a.*, bm25(memory_archive_fts) AS rank,
            snippet(memory_archive_fts, 0, '', '', ' … ', 16) AS snip
     FROM memory_archive a
     JOIN memory_archive_fts f ON a.id = f.rowid
     WHERE memory_archive_fts MATCH ? AND ${scopeSql}
     ORDER BY rank
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

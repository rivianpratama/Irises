import { Router, Request, Response } from 'express';
import {
  listErrors, getErrorStats, getTopErrors,
  type StoredErrorRow, type ErrorStatRow, type TopErrorRow,
} from '../../../db/repositories/errorLog.js';
import { getRecentErrors } from '../../errorLog.js';
import { driver } from '../../../db/client.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Errors tab data: the durable error_log on Supabase, or the writer's in-process ring when
// Supabase isn't configured. The memory path re-implements the same WHERE/GROUP BY semantics in
// Node so the view behaves identically on both backends (and so the demo harness has data).
//
// Read-only by design: nothing in this file writes to the error log. A failure here must not
// manufacture the rows it is reporting on.

const WINDOWS: Record<string, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '30d': 30 * 86400_000,
};
const DEFAULT_WINDOW = '24h';
const MAX_LIMIT = 200;
const TOP_LIMIT = 15;
const Q_CAP = 200;
const SEVERITIES = new Set(['warn', 'error', 'fatal']);
// source/category are taxonomy identifiers (see migration 0014). Rejecting anything else keeps
// junk out of the cache key as much as out of the query.
const NAME_RE = /^[a-z_]{1,32}$/;

export interface MemoryErrorFilter {
  source?: string;
  category?: string;
  severity?: string;
  handle?: string;
  q?: string;                   // substring of `message`, case-insensitive (ILIKE parity)
  since?: number;               // window start, inclusive
  before?: number;              // cursor: strictly older than this (listErrors' .lt parity)
  limit?: number;
}

/**
 * Memory-backend equivalent of listErrors: newest-first rows matching the filter bar. Pure —
 * the ring is passed in — so the filter semantics are unit-testable without a backend.
 */
export function filterMemoryErrors(rows: StoredErrorRow[], p: MemoryErrorFilter): StoredErrorRow[] {
  const q = p.q ? p.q.trim().toLowerCase() : '';
  const out = rows.filter(r => {
    if (p.source && r.source !== p.source) return false;
    if (p.category && r.category !== p.category) return false;
    if (p.severity && r.severity !== p.severity) return false;
    if (p.handle && r.handle !== p.handle) return false;
    if (p.since != null && r.createdAt < p.since) return false;
    if (p.before != null && r.createdAt >= p.before) return false;
    if (q && !r.message.toLowerCase().includes(q)) return false;
    return true;
  });
  // Don't trust the input order (getRecentErrors is already newest-first; a test may not be).
  out.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return out.slice(0, Math.min(Math.max(p.limit ?? 100, 1), MAX_LIMIT));
}

/** Memory-backend error_log_stats: one bucket per (dimension, value), events = sum(count). */
export function memoryErrorStats(rows: StoredErrorRow[], since?: number): ErrorStatRow[] {
  const acc = new Map<string, ErrorStatRow>();
  for (const r of rows) {
    if (since != null && r.createdAt < since) continue;
    const dims: Array<[string, string]> = [['source', r.source], ['category', r.category], ['severity', r.severity]];
    for (const [dimension, value] of dims) {
      const key = `${dimension}|${value}`;
      const cur = acc.get(key) ?? { dimension, value, events: 0, rows: 0 };
      cur.events += r.count;
      cur.rows += 1;
      acc.set(key, cur);
    }
  }
  return [...acc.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || b.events - a.events);
}

/** Memory-backend error_log_top: recurring fingerprints, hottest first, newest sample message. */
export function memoryTopErrors(rows: StoredErrorRow[], since?: number, limit = TOP_LIMIT): TopErrorRow[] {
  const acc = new Map<string, TopErrorRow>();
  for (const r of rows) {
    if (since != null && r.createdAt < since) continue;
    const cur = acc.get(r.fingerprint);
    if (!cur) {
      acc.set(r.fingerprint, {
        fingerprint: r.fingerprint,
        severity: r.severity,
        source: r.source,
        category: r.category,
        message: r.message,
        events: r.count,
        lastAt: r.lastAt,
      });
      continue;
    }
    cur.events += r.count;
    if (r.lastAt >= cur.lastAt) { cur.lastAt = r.lastAt; cur.message = r.message; cur.severity = r.severity; }
  }
  return [...acc.values()]
    .sort((a, b) => b.events - a.events || b.lastAt - a.lastAt)
    .slice(0, Math.min(Math.max(limit, 1), 50));
}

const windowOf = (v: unknown): string => (WINDOWS[String(v ?? '')] ? String(v) : DEFAULT_WINDOW);
const nameOf = (v: unknown): string | undefined => {
  const s = String(v ?? '');
  return NAME_RE.test(s) ? s : undefined;
};
const severityOf = (v: unknown): string | undefined => {
  const s = String(v ?? '');
  return SEVERITIES.has(s) ? s : undefined;
};
const textOf = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim().slice(0, Q_CAP);
  return s || undefined;
};
const beforeOf = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function registerErrorRoutes(router: Router): void {
  router.get('/dashboard/api/errors', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const windowKey = windowOf(req.query.since);
      const source = nameOf(req.query.source);
      const category = nameOf(req.query.category);
      const severity = severityOf(req.query.severity);
      const handle = req.query.handle ? String(req.query.handle).slice(0, 64) : undefined;
      const q = textOf(req.query.q);
      const before = beforeOf(req.query.before);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LIMIT);
      // Every filter is in the key — a cached payload must never answer a different question.
      const key = ['errors', windowKey, source ?? '', category ?? '', severity ?? '', handle ?? '', q ?? '', before ?? '', limit].join('|');
      const errors = await cached(key, 5000, async () => {
        const since = Date.now() - WINDOWS[windowKey];
        const params = { source, category, severity, handle, q, since, before, limit };
        if (driver === 'memory') return filterMemoryErrors(getRecentErrors(300), params);
        return listErrors(params);
      });
      res.json({ now: Date.now(), driver, errors });
    } catch (err) {
      console.error('[dashboard] /api/errors failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/dashboard/api/errors/summary', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const windowKey = windowOf(req.query.since);
      const payload = await cached(`errors:summary|${windowKey}`, 10_000, async () => {
        const since = Date.now() - WINDOWS[windowKey];
        if (driver === 'memory') {
          const ring = getRecentErrors(300);
          return { stats: memoryErrorStats(ring, since), top: memoryTopErrors(ring, since, TOP_LIMIT) };
        }
        // Both degrade to [] when migration 0014 hasn't been pushed yet — the view then shows
        // the table without the summary strip instead of failing.
        const [stats, top] = await Promise.all([getErrorStats(since), getTopErrors(since, TOP_LIMIT)]);
        return { stats, top };
      });
      res.json({ now: Date.now(), driver, since: windowKey, ...payload });
    } catch (err) {
      console.error('[dashboard] /api/errors/summary failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

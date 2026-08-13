import { Router, Request, Response } from 'express';
import { listErrors, getErrorStats, getTopErrors } from '../../../db/repositories/errorLog.js';
import { driver } from '../../../db/client.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Errors tab data, read straight from the durable error_log (one SQL path on both
// drivers — the memory driver is the same schema on an ephemeral ':memory:' database).
//
// Read-only by design: nothing in this file writes to the error log. A failure here must
// not manufacture the rows it is reporting on.

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
// source/category are taxonomy identifiers (see src/diagnostics/errorLog.ts). Rejecting
// anything else keeps junk out of the cache key as much as out of the query.
const NAME_RE = /^[a-z_]{1,32}$/;

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
        return listErrors({ source, category, severity, handle, q, since, before, limit });
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
        // Both degrade to [] on a read hiccup — the view then shows the table without
        // the summary strip instead of failing.
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

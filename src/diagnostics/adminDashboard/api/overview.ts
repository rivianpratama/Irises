import { Router, Request, Response } from 'express';
import { getTraces, diagnosticsEnabled } from '../../trace.js';
import { getTurnKeys } from '../../turns.js';
import { getCounters } from '../../counters.js';
import { driver } from '../../../db/client.js';
import { getLlmRoleStats } from '../../../db/repositories/tokenUsage.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';
import { getVersion } from '../../../update/version.js';
import { getUpdateStatus } from '../../../update/checker.js';

// System-health landing view: process state, since-boot counters, 24h LLM
// totals, and the global events that never reach the turn store.

export function registerOverviewRoutes(router: Router): void {
  router.get('/dashboard/api/overview', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const counters = getCounters();
      const payload = await cached('overview', 5_000, async () => {
        const dayAgo = Date.now() - 24 * 3600_000;
        const roleStats = await getLlmRoleStats(dayAgo);
        const llm24h = roleStats.reduce((acc, s) => ({
          calls: acc.calls + s.calls,
          errors: acc.errors + s.errors,
          fallbacks: acc.fallbacks + s.fallbacks,
          totalTokens: acc.totalTokens + s.totalTokens,
        }), { calls: 0, errors: 0, fallbacks: 0, totalTokens: 0 });
        return { llm24h };
      });
      // Events with neither chatId nor handle never enter the turn store — the
      // overview is the one place they're visible outside /debug.
      const globalEvents = getTraces()
        .filter(ev => !ev.chatId && !ev.handle)
        .slice(-20)
        .map(ev => ({ id: ev.id, ts: ev.ts, type: ev.type, label: ev.label ?? null, role: ev.role ?? null, detail: ev.detail ?? null }));
      const u = getUpdateStatus();
      res.json({
        now: Date.now(),
        startedAt: counters.startedAt,
        uptimeS: Math.floor((Date.now() - counters.startedAt) / 1000),
        driver,
        version: getVersion(),
        update: { available: u.updateAvailable, remoteSha: u.remoteSha, lastCheckAt: u.lastCheckAt, lastCheckOk: u.lastCheckOk },
        diagnostics: {
          enabled: diagnosticsEnabled,
          bufferEvents: getTraces().length,
          liveKeys: getTurnKeys().length,
        },
        counters,
        ...payload,
        globalEvents,
      });
    } catch (err) {
      console.error('[dashboard] /api/overview failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

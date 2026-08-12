import { Router, Request, Response } from 'express';
import { getTurns, getTurn, getLatestTurns, type Turn, type TurnMeta } from '../../turns.js';
import { diagnosticsEnabled } from '../../trace.js';
import { listPersistedTurns } from '../../../db/repositories/diagnosticTurns.js';
import {
  listHistoryKeys, listTurnHistory, getHistoricalTurn, searchHistory,
  type HistoryTurnMeta,
} from '../../../db/repositories/diagnosticTurnHistory.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Turn-centric endpoints: the orchestration view's state/turns/turn trio plus the
// full-history list + search that the History view drives.

// Strip events for list endpoints (metas are small; full payloads load per turn).
function toMeta(t: Turn): TurnMeta {
  const { events: _events, ...meta } = t;
  return meta;
}

/** History meta → the TurnMeta shape the client renders (persisted rows are closed turns). */
function historyToMeta(h: HistoryTurnMeta): TurnMeta & { persisted: boolean; errorCount: number } {
  return {
    id: h.turnId,
    key: h.key,
    chatId: h.chatId ?? undefined,
    handle: h.handle ?? undefined,
    source: h.source as TurnMeta['source'],
    trigger: h.trigger ?? undefined,
    startedAt: h.startedAt,
    lastAt: h.lastAt,
    eventCount: h.eventCount,
    agents: h.agents,
    open: false,
    persisted: true,
    errorCount: h.errorCount,
  };
}

const guard = (req: Request, res: Response): boolean => {
  if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
};

export function registerTurnRoutes(router: Router): void {
  router.get('/dashboard/api/state', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const live = getLatestTurns();
      const liveKeys = new Set(live.map(t => t.key));
      // Sidebar seed: history keys carry REAL per-key turn counts; fall back to the
      // latest-per-key table when the history RPC isn't available yet (pre-migration).
      const seed = await cached('state:seed', 10_000, async () => {
        const keys = await listHistoryKeys();
        if (keys.length) return { kind: 'history' as const, keys };
        return { kind: 'legacy' as const, rows: await listPersistedTurns() };
      });

      const countsByKey = new Map<string, number>();
      // Per-key count of user-sourced turns — lets the Turn cost picker keep a chat the
      // user has messaged even when its NEWEST (representative) turn is an automation or
      // system sweep. The Orchestration view ignores this field.
      const userCountsByKey = new Map<string, number>();
      const chats: Array<TurnMeta & { live: boolean; turnCount: number; userTurnCount: number }> = [];
      if (seed.kind === 'history') {
        for (const k of seed.keys) { countsByKey.set(k.key, k.turnCount); userCountsByKey.set(k.key, k.userTurnCount); }
        for (const k of seed.keys) {
          if (liveKeys.has(k.key)) continue;
          chats.push({ ...historyToMeta(k), live: false, turnCount: k.turnCount, userTurnCount: k.userTurnCount });
        }
      } else {
        for (const row of seed.rows) {
          if (liveKeys.has(row.key)) continue;
          if (!row.turn || typeof row.turn !== 'object') continue;
          const meta = toMeta(row.turn);
          // Legacy seed carries only the latest turn — best-effort user gate off its source.
          chats.push({ ...meta, live: false, turnCount: 1, userTurnCount: meta.source === 'user' ? 1 : 0 });
        }
      }
      for (const t of live) {
        const liveTurns = getTurns(t.key);
        const liveUserCount = liveTurns.reduce((n, x) => n + (x.source === 'user' ? 1 : 0), 0);
        chats.push({
          ...toMeta(t),
          live: true,
          turnCount: Math.max(liveTurns.length, countsByKey.get(t.key) ?? 0),
          userTurnCount: Math.max(liveUserCount, userCountsByKey.get(t.key) ?? 0),
        });
      }
      chats.sort((a, b) => b.lastAt - a.lastAt);
      res.json({ enabled: diagnosticsEnabled, now: Date.now(), chats });
    } catch (err) {
      console.error('[dashboard] /api/state failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/dashboard/api/turns', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const key = String(req.query.key ?? '');
      if (!key) { res.status(400).json({ error: 'key required' }); return; }
      const live = getTurns(key);
      const liveIds = new Set(live.map(t => t.id));
      const history = await cached(`turns:${key}`, 10_000, () => listTurnHistory({ key, limit: 30 }));
      // Oldest → newest, live turns last (the client's turn bar reverses to newest-first).
      const merged: Array<TurnMeta & { persisted?: boolean }> = history
        .filter(h => !liveIds.has(h.turnId))
        .map(historyToMeta)
        .sort((a, b) => a.lastAt - b.lastAt);
      merged.push(...live.map(toMeta));
      res.json({ live: live.length > 0, turns: merged });
    } catch (err) {
      console.error('[dashboard] /api/turns failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/dashboard/api/turn', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const key = String(req.query.key ?? '');
      const id = String(req.query.id ?? 'latest');
      if (!key) { res.status(400).json({ error: 'key required' }); return; }
      const live = getTurns(key);
      if (live.length && (id === 'latest' || live.some(t => t.id === id))) {
        const turn = id === 'latest' ? live[live.length - 1] : getTurn(key, id);
        if (turn) { res.json({ live: true, turn }); return; }
      }
      if (id !== 'latest') {
        const hist = await getHistoricalTurn(key, id);
        if (hist) { res.json({ live: false, turn: hist, rawStripped: process.env.DIAGNOSTICS_PERSIST_RAW !== 'true' }); return; }
      }
      // Legacy fallback: the latest-per-key row (also covers id === 'latest' post-restart).
      const row = (await listPersistedTurns()).find(r => r.key === key);
      if (!row?.turn || (id !== 'latest' && row.turn.id !== id)) { res.status(404).json({ error: 'turn not found' }); return; }
      res.json({ live: false, turn: row.turn });
    } catch (err) {
      console.error('[dashboard] /api/turn failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/dashboard/api/history', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const key = String(req.query.key ?? '');
      if (!key) { res.status(400).json({ error: 'key required' }); return; }
      const before = req.query.before ? Number(req.query.before) : undefined;
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const rows = await listTurnHistory({ key, before, limit });
      const metas = rows.map(historyToMeta);
      // First page: overlay live turns (not yet persisted or fresher than their row).
      if (!before) {
        const seen = new Set(metas.map(m => m.id));
        for (const t of getTurns(key)) {
          if (!seen.has(t.id)) metas.push({ ...toMeta(t), persisted: false, errorCount: 0 });
        }
      }
      metas.sort((a, b) => b.lastAt - a.lastAt);
      const nextBefore = rows.length === limit ? rows[rows.length - 1].lastAt : null;
      res.json({ key, turns: metas, nextBefore });
    } catch (err) {
      console.error('[dashboard] /api/history failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/dashboard/api/search', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const q = (req.query.q ? String(req.query.q) : '').trim() || undefined;
      const results = await searchHistory({
        q,
        handle: req.query.handle ? String(req.query.handle) : undefined,
        source: req.query.source ? String(req.query.source) : undefined,
        agent: req.query.agent ? String(req.query.agent) : undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
        deep: req.query.deep === '1' || req.query.deep === 'true',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ results: results.map(historyToMeta), deep: req.query.deep === '1' || req.query.deep === 'true' });
    } catch (err) {
      console.error('[dashboard] /api/search failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

import { Router, Request, Response } from 'express';
import { getLatestTurns } from '../../turns.js';
import { listConnectedHandles } from '../../../db/repositories/tokens.js';
import { getPrefsBulk } from '../../../db/repositories/memory.js';
import { listUserProfiles } from '../../../db/repositories/profiles.js';
import { listHistoryKeys } from '../../../db/repositories/diagnosticTurnHistory.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// User roster: every known handle (profiles ∪ gmail-connected ∪ live activity),
// resolved to names, with gmail watch health, live activity, and turn counts —
// the drill-in hub that links each user to orchestration / memory / history / llm.

interface RosterUser {
  handle: string;
  name: string | null;
  factCount: number;
  firstSeen: number | null;   // epoch ms
  lastSeen: number | null;    // epoch ms
  gmailConnected: boolean;
  gmailAddress: string | null;
  watchExpiresAt: number | null;
  watchOk: boolean;
  lastPushAt: number | null;
  liveActivity: { key: string; lastAt: number; source: string; trigger: string | null } | null;
  turnCount: number;
}

export function registerUserRoutes(router: Router): void {
  router.get('/dashboard/api/users', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const base = await cached('users:base', 30_000, async () => {
        const [profiles, connected, historyKeys] = await Promise.all([
          listUserProfiles(),
          listConnectedHandles(),
          listHistoryKeys(1000),
        ]);
        const prefs = await getPrefsBulk([...new Set([...profiles.map(p => p.handle), ...connected])]);
        return { profiles, connected, historyKeys, prefs: [...prefs.entries()] };
      });
      const prefsByHandle = new Map(base.prefs);
      const connectedSet = new Set(base.connected);

      const turnCounts = new Map<string, number>();
      for (const k of base.historyKeys) {
        if (!k.handle) continue;
        turnCounts.set(k.handle, (turnCounts.get(k.handle) ?? 0) + k.turnCount);
      }
      const liveByHandle = new Map<string, { key: string; lastAt: number; source: string; trigger: string | null }>();
      for (const t of getLatestTurns()) {
        if (!t.handle) continue;
        const cur = liveByHandle.get(t.handle);
        if (!cur || t.lastAt > cur.lastAt) {
          liveByHandle.set(t.handle, { key: t.key, lastAt: t.lastAt, source: t.source, trigger: t.trigger ?? null });
        }
      }

      const handles = new Set<string>([
        ...base.profiles.map(p => p.handle),
        ...base.connected,
        ...liveByHandle.keys(),
      ]);
      const profByHandle = new Map(base.profiles.map(p => [p.handle, p]));
      const users: RosterUser[] = [...handles].map(handle => {
        const prof = profByHandle.get(handle);
        const p = prefsByHandle.get(handle) ?? {};
        const exp = p.gmail_watch_expiration != null ? Number(p.gmail_watch_expiration) : null;
        return {
          handle,
          name: prof?.name ?? null,
          factCount: prof?.facts.length ?? 0,
          firstSeen: prof ? prof.firstSeen * 1000 : null,
          lastSeen: prof ? prof.lastSeen * 1000 : null,
          gmailConnected: connectedSet.has(handle),
          gmailAddress: (p.gmail_address as string | null) ?? null,
          watchExpiresAt: exp,
          watchOk: exp != null && exp > Date.now(),
          lastPushAt: p.gmail_last_push_at != null ? Number(p.gmail_last_push_at) : null,
          liveActivity: liveByHandle.get(handle) ?? null,
          turnCount: turnCounts.get(handle) ?? 0,
        };
      });
      users.sort((a, b) => (b.liveActivity?.lastAt ?? b.lastSeen ?? 0) - (a.liveActivity?.lastAt ?? a.lastSeen ?? 0));
      res.json({ now: Date.now(), users });
    } catch (err) {
      console.error('[dashboard] /api/users failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

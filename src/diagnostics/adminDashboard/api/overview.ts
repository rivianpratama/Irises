import { Router, Request, Response } from 'express';
import { getTraces, diagnosticsEnabled } from '../../trace.js';
import { getTurnKeys } from '../../turns.js';
import { getCounters } from '../../counters.js';
import { driver, getSupabase } from '../../../db/client.js';
import { listConnectedHandles } from '../../../db/repositories/tokens.js';
import { getPrefsBulk } from '../../../db/repositories/memory.js';
import { listUserProfiles } from '../../../db/repositories/profiles.js';
import { getLlmRoleStats } from '../../../db/repositories/tokenUsage.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// System-health landing view: process state, since-boot counters, Gmail watch
// health, 24h LLM totals, and the global events that never reach the turn store.

interface WatchStatus {
  handle: string;
  name: string | null;
  gmailAddress: string | null;
  watchExpiresAt: number | null;
  lastPushAt: number | null;
  watchOk: boolean;
}

async function gmailStatus(): Promise<{ connected: number; watches: WatchStatus[] }> {
  const handles = await listConnectedHandles();
  if (!handles.length) return { connected: 0, watches: [] };
  const [prefs, profiles] = await Promise.all([getPrefsBulk(handles), listUserProfiles()]);
  const names = new Map(profiles.map(p => [p.handle, p.name]));
  const watches = handles.map(handle => {
    const p = prefs.get(handle) ?? {};
    const exp = p.gmail_watch_expiration != null ? Number(p.gmail_watch_expiration) : null;
    const lastPush = p.gmail_last_push_at != null ? Number(p.gmail_last_push_at) : null;
    return {
      handle,
      name: names.get(handle) ?? null,
      gmailAddress: (p.gmail_address as string | null) ?? null,
      watchExpiresAt: exp,
      lastPushAt: lastPush,
      watchOk: exp != null && exp > Date.now(),
    };
  });
  return { connected: handles.length, watches };
}

async function automationsStatus(): Promise<{ active: number; nextRunAt: number | null } | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { count, error } = await supabase
    .from('automations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  if (error) throw error;
  const { data, error: err2 } = await supabase
    .from('automations')
    .select('next_run_at')
    .eq('status', 'active')
    .order('next_run_at', { ascending: true })
    .limit(1);
  if (err2) throw err2;
  const next = data?.[0]?.next_run_at as string | undefined;
  return { active: count ?? 0, nextRunAt: next ? Date.parse(next) : null };
}

export function registerOverviewRoutes(router: Router): void {
  router.get('/dashboard/api/overview', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const counters = getCounters();
      const payload = await cached('overview', 5_000, async () => {
        const dayAgo = Date.now() - 24 * 3600_000;
        const [gmail, roleStats, automations] = await Promise.all([
          gmailStatus().catch(() => ({ connected: 0, watches: [] })),
          getLlmRoleStats(dayAgo),
          automationsStatus().catch(() => null),
        ]);
        const llm24h = roleStats.reduce((acc, s) => ({
          calls: acc.calls + s.calls,
          errors: acc.errors + s.errors,
          fallbacks: acc.fallbacks + s.fallbacks,
          totalTokens: acc.totalTokens + s.totalTokens,
        }), { calls: 0, errors: 0, fallbacks: 0, totalTokens: 0 });
        return { gmail, llm24h, automations };
      });
      // Events with neither chatId nor handle never enter the turn store — the
      // overview is the one place they're visible outside /debug.
      const globalEvents = getTraces()
        .filter(ev => !ev.chatId && !ev.handle)
        .slice(-20)
        .map(ev => ({ id: ev.id, ts: ev.ts, type: ev.type, label: ev.label ?? null, role: ev.role ?? null, detail: ev.detail ?? null }));
      res.json({
        now: Date.now(),
        startedAt: counters.startedAt,
        uptimeS: Math.floor((Date.now() - counters.startedAt) / 1000),
        driver,
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

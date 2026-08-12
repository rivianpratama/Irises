import { Router, Request, Response } from 'express';
import { getTurns, type Turn } from '../../turns.js';
import { listFullTurnHistory } from '../../../db/repositories/diagnosticTurnHistory.js';
import { listUsageInWindow, listUsageForTasks, type UsageRowLite } from '../../../db/repositories/tokenUsage.js';
import { driver } from '../../../db/client.js';
import { assembleTurnCards, type AssembledCards } from './turncostAssembly.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Turn cost: one chat's turns rendered as phone bubbles with per-turn token/$ cost.
// Same turn source the Orchestration view uses (live store + persisted history);
// cost comes from the token_usage ledger via task_id + padded-time-window claiming
// (see turncostAssembly.ts — the ledger has no turn_id by design, nothing is written).

/** App clock (turn timestamps) vs Postgres now() (ledger created_at) skew allowance. */
const CLOCK_PAD_MS = 90_000;

interface TurncostPayload extends AssembledCards {
  key: string;
  now: number;
  live: boolean;
  usageAvailable: boolean;
}

async function assemble(key: string, limit: number): Promise<TurncostPayload> {
  // Live turns win over their own persisted copies (fresher events).
  const live = getTurns(key);
  const liveIds = new Set(live.map(t => t.id));
  const history = await listFullTurnHistory(key, limit);
  const turns: Turn[] = history.filter(h => !liveIds.has(h.id)).concat(live)
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-limit);

  const usageAvailable = driver !== 'memory';
  let rows: UsageRowLite[] = [];
  if (usageAvailable && turns.length) {
    const chatId = turns.find(t => t.chatId)?.chatId;
    const scope = key.startsWith('handle:')
      ? { handle: key.slice('handle:'.length) }
      : { chatId: chatId ?? key };
    const sinceMs = Math.min(...turns.map(t => t.startedAt)) - CLOCK_PAD_MS;
    const untilMs = turns.some(t => t.open)
      ? Date.now() + CLOCK_PAD_MS
      : Math.max(...turns.map(t => t.lastAt)) + CLOCK_PAD_MS;
    const taskIds = new Set<string>();
    for (const t of turns) for (const ev of t.events ?? []) if (ev.taskId) taskIds.add(ev.taskId);
    // Two legs: the chat window (live convo/classify calls) + delegated task rows
    // that bill outside any window. Overlap is deduped by PK in claimUsageRows.
    const [windowRows, taskRows] = await Promise.all([
      listUsageInWindow(scope, sinceMs, untilMs),
      listUsageForTasks([...taskIds]),
    ]);
    rows = windowRows.concat(taskRows);
  }

  const { cards, unattributed } = assembleTurnCards(turns, rows, CLOCK_PAD_MS);
  return { key, now: Date.now(), live: live.length > 0, usageAvailable, cards, unattributed };
}

export function registerTurncostRoutes(router: Router): void {
  router.get('/dashboard/api/turncost', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const key = String(req.query.key ?? '');
      if (!key) { res.status(400).json({ error: 'key required' }); return; }
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const payload = await cached(`turncost:${key}:${limit}`, 10_000, () => assemble(key, limit));
      res.json(payload);
    } catch (err) {
      console.error('[dashboard] /api/turncost failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

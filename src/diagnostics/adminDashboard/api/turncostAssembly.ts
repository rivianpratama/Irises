import type { Turn } from '../../turns.js';
import type { TraceEvent } from '../../trace.js';
import type { UsageRowLite } from '../../../db/repositories/tokenUsage.js';
import { estimateCostUsd } from '../../../llm/budget.js';

// Pure assembly logic for the "Turn cost" view: turn events → chat bubbles, and
// token_usage rows → per-turn cost, with NO turn_id column in the ledger. Kept
// free of Express and the data layer so the claiming/parsing rules are unit-testable.
//
// Attribution model (read-only, derived on every request):
//   1. task_id (exact) — delegated Ops/MM/Composer work carries the taskId of the
//      turn that delegated it, even when it bills minutes after the reply went out.
//   2. chat time window (approximate) — the live convo/classify/judge leg has no
//      task_id, so those rows claim to the turn whose [startedAt, lastAt] window
//      contains them. Turn timestamps are app clock while token_usage.created_at
//      is Postgres now(), so windows are padded and pad-zone claims are flagged.

/** Mirrors TRIGGER_CAP in diagnostics/turns.ts — turn.trigger is sliced to this. */
const TRIGGER_CAP = 400;

export interface BubbleGroup {
  agent: string;      // label ?? role of the voicing event (convo, composer, judge, …)
  ts: number;
  texts: string[];
}

export interface ClaimedRow {
  row: UsageRowLite;
  kind: 'exact' | 'window';
  /** Window claim that landed in the clock-skew pad, outside the turn's unpadded span. */
  approx: boolean;
}

export interface AgentCost {
  agent: string;      // label ?? role (composer rows are role=convo, label=composer)
  role: string;
  model: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  exact: boolean;     // every row in this group claimed via task_id
}

export interface TurnCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  calls: number;
  errors: number;
  attribution: 'exact' | 'window' | 'mixed' | 'none';
  approx: boolean;
  byAgent: AgentCost[];
}

export interface TurnCard {
  id: string;
  source: string;
  startedAt: number;
  lastAt: number;
  open: boolean;
  handle: string | null;
  userText: string | null;
  userTextTruncated: boolean;
  bubbles: BubbleGroup[];
  errorCount: number;
  cost: TurnCost;
}

// ── user text ────────────────────────────────────────────────────────────────

/** Prefer the turn:start event's detail.text (stored verbatim) over the capped trigger. */
export function extractUserText(turn: Turn): { text: string | null; truncated: boolean } {
  for (const ev of turn.events ?? []) {
    if (ev.label === 'turn:start' && typeof ev.detail?.text === 'string' && ev.detail.text) {
      return { text: ev.detail.text, truncated: false };
    }
  }
  if (turn.trigger) return { text: turn.trigger, truncated: turn.trigger.length >= TRIGGER_CAP };
  return { text: null, truncated: false };
}

// ── reply bubbles ────────────────────────────────────────────────────────────

/** Events whose response goes to the user's phone (mirrors the orchestration graph's →user edges). */
function isUserFacing(ev: TraceEvent): boolean {
  if (ev.type !== 'llm' || ev.response == null) return false;
  const l = ev.label ?? ev.role ?? '';
  return l === 'convo' || l.startsWith('convo:')
    || l === 'composer' || l === 'judge' || l === 'autonome'
    || l === 'mm:direct-voice' || l.startsWith('fallfirm') || l === 'voiceInstant';
}

/** Parse one voicing response: bubble envelope → texts; plain text → one bubble;
 *  something that LOOKS like a broken envelope (starts with '{') → nothing, so a
 *  malformed JSON attempt never renders as a raw-JSON bubble. */
function parseBubbleTexts(response: string): string[] {
  const trimmed = response.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { bubbles?: Array<{ text?: unknown }> };
      if (parsed && Array.isArray(parsed.bubbles)) {
        return parsed.bubbles
          .map(b => (typeof b?.text === 'string' ? b.text.trim() : ''))
          .filter(t => t.length > 0);
      }
    } catch { /* malformed envelope — fall through to the guard below */ }
    return [];
  }
  return [trimmed];
}

/** All user-facing reply bubbles of a turn, grouped per voicing event, in time order. */
export function extractBubbles(turn: Turn): BubbleGroup[] {
  const out: BubbleGroup[] = [];
  const events = [...(turn.events ?? [])].sort((a, b) => a.ts - b.ts);
  for (const ev of events) {
    if (!isUserFacing(ev)) continue;
    const response = ev.response as string;
    if (response.startsWith('ERROR:')) continue;
    const texts = parseBubbleTexts(response);
    if (!texts.length) continue;
    out.push({ agent: ev.label || ev.role || 'convo', ts: ev.ts, texts });
  }
  return out;
}

// ── cost attribution ─────────────────────────────────────────────────────────

export interface ClaimResult {
  /** turn.id → rows claimed by that turn. */
  claims: Map<string, ClaimedRow[]>;
  unattributed: UsageRowLite[];
}

/**
 * Assign each ledger row to AT MOST one turn. task_id rows go to the turn that
 * delegated the task (first-owner, mirroring the turn store's taskIndex); the
 * rest partition by padded time window, scanning newest→oldest so a boundary row
 * lands on the turn it most plausibly triggered — exactly once, never twice.
 */
export function claimUsageRows(turns: Turn[], rows: UsageRowLite[], padMs: number): ClaimResult {
  const ordered = [...turns].sort((a, b) => a.startedAt - b.startedAt);
  const lastId = ordered.length ? ordered[ordered.length - 1].id : null;

  const taskOwner = new Map<string, string>();
  for (const turn of ordered) {
    for (const ev of turn.events ?? []) {
      if (ev.taskId && !taskOwner.has(ev.taskId)) taskOwner.set(ev.taskId, turn.id);
    }
  }

  const claims = new Map<string, ClaimedRow[]>();
  const unattributed: UsageRowLite[] = [];
  const claim = (turnId: string, entry: ClaimedRow) => {
    const list = claims.get(turnId);
    if (list) list.push(entry); else claims.set(turnId, [entry]);
  };

  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;   // window + task queries overlap; PK dedup
    seen.add(row.id);

    if (row.taskId && taskOwner.has(row.taskId)) {
      claim(taskOwner.get(row.taskId)!, { row, kind: 'exact', approx: false });
      continue;
    }

    // Pass 1: unpadded containment — a row inside a turn's own span is never
    // stolen by a neighbour's clock-skew pad.
    let placed = false;
    for (let i = ordered.length - 1; i >= 0 && !placed; i--) {
      const t = ordered[i];
      const openEnded = t.open && t.id === lastId;
      const end = openEnded ? Number.POSITIVE_INFINITY : t.lastAt;
      if (row.createdAt >= t.startedAt && row.createdAt <= end) {
        claim(t.id, { row, kind: 'window', approx: false });
        placed = true;
      }
    }
    // Pass 2: padded windows for rows in the skew zone around a boundary — claimed
    // (newest plausible turn wins) but flagged approx.
    for (let i = ordered.length - 1; i >= 0 && !placed; i--) {
      const t = ordered[i];
      const openEnded = t.open && t.id === lastId;
      const end = openEnded ? Number.POSITIVE_INFINITY : t.lastAt + padMs;
      if (row.createdAt >= t.startedAt - padMs && row.createdAt <= end) {
        claim(t.id, { row, kind: 'window', approx: true });
        placed = true;
      }
    }
    if (!placed) unattributed.push(row);
  }
  return { claims, unattributed };
}

// ── aggregation ──────────────────────────────────────────────────────────────

export function aggregateTurnCost(claimed: ClaimedRow[]): TurnCost {
  const groups = new Map<string, AgentCost & { _exactRows: number; _rows: number }>();
  let anyApprox = false, anyExact = false, anyWindow = false;

  for (const { row, kind, approx } of claimed) {
    if (approx) anyApprox = true;
    if (kind === 'exact') anyExact = true; else anyWindow = true;
    const agent = row.label || row.role;
    const key = agent + '|' + row.model;
    let g = groups.get(key);
    if (!g) {
      g = {
        agent, role: row.role, model: row.model,
        calls: 0, errors: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsd: 0, exact: true, _exactRows: 0, _rows: 0,
      };
      groups.set(key, g);
    }
    g._rows++;
    if (kind === 'exact') g._exactRows++;
    if (row.status === 'error') g.errors++; else g.calls++;
    g.inputTokens += row.inputTokens;
    g.outputTokens += row.outputTokens;
    g.cacheReadTokens += row.cacheReadTokens;
    g.cacheCreationTokens += row.cacheCreationTokens;
  }

  const byAgent: AgentCost[] = [];
  const total: TurnCost = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, calls: 0, errors: 0,
    attribution: 'none', approx: false, byAgent,
  };
  for (const g of groups.values()) {
    g.exact = g._exactRows === g._rows;
    g.costUsd = estimateCostUsd(g.model, {
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cacheReadTokens: g.cacheReadTokens,
    });
    const { _exactRows: _e, _rows: _r, ...pub } = g;
    byAgent.push(pub);
    total.inputTokens += g.inputTokens;
    total.outputTokens += g.outputTokens;
    total.cacheReadTokens += g.cacheReadTokens;
    total.cacheCreationTokens += g.cacheCreationTokens;
    total.costUsd += g.costUsd;
    total.calls += g.calls;
    total.errors += g.errors;
  }
  byAgent.sort((a, b) => b.costUsd - a.costUsd);
  total.approx = anyApprox;
  total.attribution = !claimed.length ? 'none'
    : anyExact && anyWindow ? 'mixed'
    : anyExact ? 'exact' : 'window';
  return total;
}

// ── full card assembly ───────────────────────────────────────────────────────

/** Events whose response is an ERROR record (same rule countTurnErrors uses). */
function countErrors(turn: Turn): number {
  let n = 0;
  for (const ev of turn.events ?? []) {
    if (typeof ev.response === 'string' && ev.response.startsWith('ERROR:')) n++;
    else if (ev.label?.endsWith(':fidelity-suppressed')) n++;
  }
  return n;
}

export interface AssembledCards {
  cards: TurnCard[];
  unattributed: { calls: number; totalTokens: number; costUsd: number };
}

/** Turns (oldest-first) + ledger rows → renderable chat cards with per-turn cost. */
export function assembleTurnCards(turns: Turn[], usageRows: UsageRowLite[], padMs: number): AssembledCards {
  const ordered = [...turns].sort((a, b) => a.startedAt - b.startedAt);
  const { claims, unattributed } = claimUsageRows(ordered, usageRows, padMs);

  const cards: TurnCard[] = ordered.map(turn => {
    const user = extractUserText(turn);
    return {
      id: turn.id,
      source: turn.source,
      startedAt: turn.startedAt,
      lastAt: turn.lastAt,
      open: !!turn.open,
      handle: turn.handle ?? null,
      userText: user.text,
      userTextTruncated: user.truncated,
      bubbles: extractBubbles(turn),
      errorCount: countErrors(turn),
      cost: aggregateTurnCost(claims.get(turn.id) ?? []),
    };
  });

  const un = { calls: 0, totalTokens: 0, costUsd: 0 };
  for (const row of unattributed) {
    if (row.status !== 'error') un.calls++;
    un.totalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    un.costUsd += estimateCostUsd(row.model, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
    });
  }
  return { cards, unattributed: un };
}

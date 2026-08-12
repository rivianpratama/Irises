// Since-boot activity counters for the dashboard's health overview. Purely
// in-memory and synchronous (uptime is process-scoped, so "since boot" is the
// honest frame for live health; durable rates come from the token_usage table).
// Zero imports so trace.ts can call noteEvent() with no module-cycle risk.

import type { TraceEvent } from './trace.js';

export interface Counters {
  startedAt: number;
  turnsStarted: number;
  llmCalls: number;
  llmErrors: number;
  llmFallbacks: number;
  fallfirmEngagements: number;
  fidelitySuppressed: number;
  fidelityFlagged: number;
  /** llm calls per role (convo, ops, judge, …) */
  byRole: Record<string, number>;
  /** trigger events by source family: user (turn:start), email (judge*), automation (autonome*) */
  bySource: Record<string, number>;
}

function fresh(): Counters {
  return {
    startedAt: Date.now(),
    turnsStarted: 0,
    llmCalls: 0,
    llmErrors: 0,
    llmFallbacks: 0,
    fallfirmEngagements: 0,
    fidelitySuppressed: 0,
    fidelityFlagged: 0,
    byRole: {},
    bySource: {},
  };
}

let counters = fresh();

export function noteEvent(ev: Pick<TraceEvent, 'type' | 'label' | 'role' | 'response'>): void {
  const l = ev.label ?? '';
  if (l === 'turn:start') {
    counters.turnsStarted++;
    counters.bySource.user = (counters.bySource.user ?? 0) + 1;
  } else if (l === 'judge' || l.startsWith('judge')) {
    counters.bySource.email = (counters.bySource.email ?? 0) + 1;
  } else if (l.startsWith('autonome')) {
    counters.bySource.automation = (counters.bySource.automation ?? 0) + 1;
  }

  if (ev.type === 'llm') {
    counters.llmCalls++;
    const role = ev.role ?? 'unknown';
    counters.byRole[role] = (counters.byRole[role] ?? 0) + 1;
    if (typeof ev.response === 'string' && ev.response.startsWith('ERROR:')) counters.llmErrors++;
    if (ev.role === 'fallfirm') counters.fallfirmEngagements++;
  }
  if (l === 'llm:fallback') counters.llmFallbacks++;
  if (l.endsWith(':fidelity-suppressed')) counters.fidelitySuppressed++;
  if (l.endsWith(':fidelity-flagged')) counters.fidelityFlagged++;
}

export function getCounters(): Counters {
  return { ...counters, byRole: { ...counters.byRole }, bySource: { ...counters.bySource } };
}

/** Test hook — resets every counter (startedAt included). */
export function resetCounters(): void {
  counters = fresh();
}

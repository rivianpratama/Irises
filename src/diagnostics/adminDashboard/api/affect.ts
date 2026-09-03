import { Router, Request, Response } from 'express';
import { getPreference } from '../../../db/repositories/memory.js';
import { getAffectState } from '../../../db/repositories/affectState.js';
import { getRelationshipClimate } from '../../../db/repositories/relationshipClimate.js';
import { getThreadInventory } from '../../../db/repositories/threadInventory.js';
import { listFullTurnHistory } from '../../../db/repositories/diagnosticTurnHistory.js';
import { getTurns, type Turn } from '../../turns.js';
import { TURN_TRACE_LABEL } from '../../traceLabels.js';
import { MOOD_HISTORY_CAP, type AffectState, type MoodShift } from '../../../persona/status.js';
import {
  DIALS, CLIMATE_WINDOW_CAP, spentInWindow, type DialKey, type RelationshipClimate,
} from '../../../persona/climate.js';
import type { ThreadInventory } from '../../../persona/threads.js';
import { MIN_TRANSCRIPT_SHARE } from '../../../agents/convo/promptPolicy.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Inner state: read-only per-user view of the state that colours a reply without ever being said —
// the affect trail, the climate dials, the thread inventory, and the last twenty `turn:trace`
// receipts. Four stores, no writes, no LLM call, and nothing computed that the turn did not already
// decide: everything below is the persisted record re-shaped for reading.
//
// The trace rows come out of the persisted turn payloads (diagnostic_turn_history, 30 days) merged
// with whatever is still live in the ring, which is the same two-source read the Turn cost view
// does. `turn:trace` carries NAMES AND NUMBERS ONLY by design (diagnostics/turnTrace.ts), so this
// endpoint can hand the whole receipt to the client without a leak guard of its own — and the thread
// summary below keeps that property for the one store that does hold model-authored prose, by
// counting statuses and passing labels rather than notes.
//
// Every shaper is pure with its clock injected; affect.test.ts covers them. The route is the usual
// auth + cache wrapper around four reads.

/** How many receipts the panel shows. Twenty is what the persisted history keeps per key anyway. */
export const TRACE_ROWS = 20;

// ── the affect trail ─────────────────────────────────────────────────────────

/**
 * One point of the stored mood trail, as the panel reads it.
 *
 * `shift` is the honest gap in this record: `MoodPoint` (persona/status.ts) stores level, core,
 * label and the four felt gauges, but NOT `mood_shift` — the direction lives on the emitted status,
 * and only the newest point is that status. So the newest row can name a shift and the older ones
 * say `null` rather than guessing one from the levels either side. The per-turn direction for older
 * turns is on the trace rows below, where it was actually recorded.
 */
export interface TrailPoint {
  at: number;
  label: string;
  core: string;
  level: number;
  shift: MoodShift | null;
  /** The four gauges the trail carries. `null` on a point written before they were stored. */
  warmth: number | null;
  anxiety: number | null;
  social_battery: number | null;
  rapport: number | null;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The stored trail, newest first and bounded by the store's own cap. Pure. */
export function affectTrail(state: AffectState): TrailPoint[] {
  const history = Array.isArray(state.moodHistory) ? state.moodHistory : [];
  const lastAt = state.last?.at;
  return history
    .slice(-MOOD_HISTORY_CAP)
    .map(p => ({
      at: p.at,
      label: p.label,
      core: p.core,
      level: p.level,
      shift: lastAt !== undefined && p.at === lastAt ? state.last?.mood_shift ?? null : null,
      warmth: numOrNull(p.warmth),
      anxiety: numOrNull(p.anxiety),
      social_battery: numOrNull(p.social_battery),
      rapport: numOrNull(p.rapport),
    }))
    .reverse();
}

// ── the climate dials ────────────────────────────────────────────────────────

/** One dial with everything needed to read it: where it sits, where it started, the code-owned
 *  bounds it can never leave, and how much of its rolling weekly budget is already spent. A number
 *  on its own says nothing here — 42 is a moved dial for `ease` and an unreachable one for
 *  `playfulness`. */
export interface DialRow {
  key: DialKey;
  value: number;
  dflt: number;
  floor: number;
  ceiling: number;
  /** |movement| billed inside the rolling window ending at `now` (persona/climate.ts). */
  spent: number;
  cap: number;
  moved: boolean;
}

/** The three dials in table order, each with its bounds and spent budget. Pure. */
export function climateDialRows(climate: RelationshipClimate, nowMs: number): DialRow[] {
  const moves = Array.isArray(climate.moves) ? climate.moves : [];
  return DIALS.map(spec => {
    const value = climate.dials?.[spec.key] ?? spec.dflt;
    return {
      key: spec.key,
      value,
      dflt: spec.dflt,
      floor: spec.floor,
      ceiling: spec.ceiling,
      spent: spentInWindow(moves, spec.key, nowMs),
      cap: CLIMATE_WINDOW_CAP,
      moved: value !== spec.dflt,
    };
  });
}

// ── the thread inventory ─────────────────────────────────────────────────────

/** A theme or loop as the panel lists it: what it is CALLED and where it stands, never its note.
 *  The note is the model-authored paraphrase of something the user said, and an inventory summary is
 *  not the place it gets re-published — the Memory view is where stored prose is read. */
export interface ThreadLabelRow {
  material: 'theme' | 'loop';
  label: string;
  status: string;
  kind: string | null;
  evidenceCount: number | null;
  lastSeenAt: number;
}

export interface ThreadSummary {
  themes: { total: number; byStatus: Record<string, number> };
  loops: { total: number; byStatus: Record<string, number> };
  /** The shared no-offer counter — the 70-80%-of-turns-say-nothing law as arithmetic. */
  turnsSinceOffer: number;
  harvestCount: number;
  lastHarvestAt: number;
  lastPingAt: number;
  /** The offer still waiting on an outcome, if any — which material it was made of and where it is
   *  (`offered` → she was handed it, `awaiting` → she used it and the answer is due). */
  pending: { material: string; phase: string; at: number } | null;
  labels: ThreadLabelRow[];
}

/** Counted by the status each row carries rather than against a copy of the status union, so a new
 *  status in persona/threads.ts appears here without this file being edited. */
function countByStatus(rows: ReadonlyArray<{ status?: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = typeof r.status === 'string' ? r.status : 'unknown';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The inventory, summarized: counts, the two budget clocks, and the labels. Pure. */
export function threadSummary(inv: ThreadInventory): ThreadSummary {
  const themes = Array.isArray(inv.themes) ? inv.themes : [];
  const loops = Array.isArray(inv.loops) ? inv.loops : [];
  return {
    themes: { total: themes.length, byStatus: countByStatus(themes) },
    loops: { total: loops.length, byStatus: countByStatus(loops) },
    turnsSinceOffer: inv.turnsSinceOffer ?? 0,
    harvestCount: inv.harvestCount ?? 0,
    lastHarvestAt: inv.lastHarvestAt ?? 0,
    lastPingAt: inv.lastPingAt ?? 0,
    pending: inv.pending
      ? { material: inv.pending.material, phase: inv.pending.phase, at: inv.pending.at }
      : null,
    labels: [
      ...themes.map(t => ({
        material: 'theme' as const,
        label: t.label,
        status: t.status,
        kind: t.kind ?? null,
        evidenceCount: numOrNull(t.evidenceCount),
        lastSeenAt: t.lastSeenAt,
      })),
      ...loops.map(l => ({
        material: 'loop' as const,
        label: l.label,
        status: l.status,
        kind: null,
        evidenceCount: null,
        lastSeenAt: l.lastSeenAt,
      })),
    ],
  };
}

// ── the turn:trace rows ──────────────────────────────────────────────────────

/** One receipt, flattened for a table row. Every field is read off the recorded detail; nothing is
 *  re-derived, so a row can never disagree with the turn it describes. */
export interface TraceRow {
  turnId: string;
  at: number;
  systemChars: number;
  messagesChars: number;
  personaChars: number;
  dynChars: number;
  transcriptShare: number;
  transcriptRows: number;
  cacheBreakpoints: number;
  sections: Array<{ name: string; chars: number }>;
  /** What threading decided, by its own reason bucket, or null on a turn where it never ran. */
  threads: string | null;
  memory: Array<{ block: string; verdict: string; reason: string; dropped: number | null }>;
  hits: string[];
  routingGate: string | null;
  affectSource: string | null;
  shift: string | null;
  coercions: number;
  drift: {
    changed: string[];
    capped: string[];
    atBound: string[];
    applied: Record<string, number>;
    brokeDowngraded: boolean;
  } | null;
  bubbles: { count: number | null; overLaw: number | null; maxWords: number | null; hardCapped: boolean | null };
  silent: boolean;
  wasEnvelope: boolean;
}

/** Persisted JSON, read defensively: a 30-day store holds receipts written by older builds. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const asNum = (v: unknown, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asStrs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function sectionsOf(v: unknown): Array<{ name: string; chars: number }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ name: string; chars: number }> = [];
  for (const s of v) {
    const r = asRecord(s);
    const name = r && asStr(r.name);
    if (name) out.push({ name, chars: asNum(r?.chars) });
  }
  return out;
}

function memoryOf(gates: Record<string, unknown> | null): TraceRow['memory'] {
  const blocks = asRecord(asRecord(gates?.memory)?.blocks);
  if (!blocks) return [];
  const out: TraceRow['memory'] = [];
  for (const [block, raw] of Object.entries(blocks)) {
    const r = asRecord(raw);
    if (!r) continue;
    out.push({
      block,
      verdict: asStr(r.verdict) ?? 'unknown',
      reason: asStr(r.reason) ?? 'unknown',
      dropped: typeof r.dropped === 'number' ? r.dropped : null,
    });
  }
  return out;
}

function driftOf(affect: Record<string, unknown> | null): TraceRow['drift'] {
  const d = asRecord(affect?.drift);
  if (!d) return null;   // null is a FACT about the turn (no arithmetic ran), not a missing field
  const applied: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(d.applied) ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) applied[k] = v;
  }
  return {
    changed: asStrs(d.changed),
    capped: asStrs(d.capped),
    atBound: asStrs(d.atBound),
    applied,
    brokeDowngraded: asBool(d.brokeDowngraded) ?? false,
  };
}

/** One `turn:trace` detail as a row, or null when the payload is not one (a receipt from a build
 *  that shaped it differently, or a corrupt row — either way the panel skips it rather than
 *  rendering a table of zeros). */
function rowFor(turnId: string, at: number, detail: unknown): TraceRow | null {
  const d = asRecord(detail);
  const prompt = asRecord(d?.prompt);
  if (!prompt) return null;
  const gates = asRecord(d?.gates);
  const affect = asRecord(d?.affect);
  const outcome = asRecord(d?.outcome);
  const bubbles = asRecord(d?.bubbles);
  const threads = asRecord(asRecord(gates?.threads));
  return {
    turnId,
    at,
    systemChars: asNum(prompt.systemChars),
    messagesChars: asNum(prompt.messagesChars),
    personaChars: asNum(prompt.personaChars),
    dynChars: asNum(prompt.dynChars),
    transcriptShare: asNum(prompt.transcriptShare),
    transcriptRows: asNum(prompt.transcriptRows),
    cacheBreakpoints: asNum(prompt.cacheBreakpoints),
    sections: sectionsOf(prompt.sections),
    threads: threads ? asStr(threads.reason) : null,
    memory: memoryOf(gates),
    hits: asStrs(d?.hits),
    routingGate: outcome ? asStr(outcome.routingGate) : null,
    affectSource: affect ? asStr(affect.source) : null,
    shift: asStr(asRecord(affect?.coerced)?.mood_shift),
    coercions: Array.isArray(affect?.coercions) ? affect.coercions.length : 0,
    drift: driftOf(affect),
    bubbles: {
      count: typeof bubbles?.count === 'number' ? bubbles.count : null,
      overLaw: typeof bubbles?.overLaw === 'number' ? bubbles.overLaw : null,
      maxWords: typeof bubbles?.maxWords === 'number' ? bubbles.maxWords : null,
      hardCapped: asBool(bubbles?.hardCapped),
    },
    silent: asBool(outcome?.silent) ?? false,
    wasEnvelope: asBool(outcome?.wasEnvelope) ?? false,
  };
}

/** The newest `limit` receipts across these turns, newest first. A turn carries at most one (the
 *  record fires once per delivered reply), and a turn that never filed one contributes no row —
 *  which is itself readable beside the History view's turn list. Pure. */
export function traceRows(turns: readonly Turn[], limit: number): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const t of turns) {
    for (const ev of t.events ?? []) {
      if (ev.label !== TURN_TRACE_LABEL) continue;
      const row = rowFor(t.id, ev.ts, ev.detail);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

// ── the route ────────────────────────────────────────────────────────────────

/** Live turns win over their own persisted copies (fresher events) — the Turn cost view's read. */
async function turnsFor(key: string): Promise<Turn[]> {
  const live = getTurns(key);
  const liveIds = new Set(live.map(t => t.id));
  const history = await listFullTurnHistory(key, TRACE_ROWS);
  return history.filter(h => !liveIds.has(h.id)).concat(live);
}

export function registerAffectRoutes(router: Router): void {
  router.get('/dashboard/api/affect', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const handle = String(req.query.handle ?? '');
      if (!handle) { res.status(400).json({ error: 'handle required' }); return; }
      const payload = await cached(`affect:${handle}`, 5_000, async () => {
        // Affect is keyed by CHAT (her felt state with this person in this room); climate and the
        // thread inventory are keyed by HANDLE. `chat_id` is the person's primary chat, the same
        // door the thread pings reach them through (db/repositories/memory.ts ensureChatId).
        const chatId = (await getPreference<string>(handle, 'chat_id'))?.trim() || '';
        const key = chatId || `handle:${handle}`;
        const [state, climate, inventory, turns] = await Promise.all([
          chatId ? getAffectState(chatId) : Promise.resolve({ moodHistory: [] } as AffectState),
          getRelationshipClimate(handle),
          getThreadInventory(handle),
          turnsFor(key),
        ]);
        const now = Date.now();
        return {
          handle,
          chatId: chatId || null,
          now,
          mood: state.last
            ? {
                label: state.last.mood_label, core: state.last.mood_core, level: state.last.mood_level,
                shift: state.last.mood_shift, intent: state.last.intent_mode,
                metaPrompt: state.last.meta_prompt, at: state.last.at,
                gauges: {
                  warmth: state.last.warmth, patience: state.last.patience,
                  social_battery: state.last.social_battery, anxiety: state.last.anxiety,
                  rapport: state.last.rapport,
                },
              }
            : null,
          trail: affectTrail(state),
          dials: climateDialRows(climate, now),
          climate: { lastEvalAt: climate.lastEvalAt, evalCount: climate.evalCount },
          threads: threadSummary(inventory),
          traces: traceRows(turns, TRACE_ROWS),
          // The floor the budget test holds the branch to, IMPORTED rather than retyped in the
          // client (agents/convo/promptPolicy.ts): a receipt under it is a turn where the
          // scaffolding outgrew the conversation, and the panel marks it.
          floors: { transcriptShare: MIN_TRANSCRIPT_SHARE },
        };
      });
      res.json(payload);
    } catch (err) {
      console.error('[dashboard] /api/affect failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

import { Router, Request, Response } from 'express';
import { getPreference } from '../../../db/repositories/memory.js';
import { getAffectState } from '../../../db/repositories/affectState.js';
import { getRelationshipClimate } from '../../../db/repositories/relationshipClimate.js';
import { getThreadInventory } from '../../../db/repositories/threadInventory.js';
import { readThesisHead, listThesisRevisions, type ThesisRead, type ThesisRevision } from '../../../db/repositories/thesis.js';
import { readMoments, type MomentsFile } from '../../../db/repositories/moments.js';
import { getHookState } from '../../../db/repositories/hookState.js';
import { listPendingApprovals, type OpsTaskRow } from '../../../db/repositories/opsTasks.js';
import { listFullTurnHistory } from '../../../db/repositories/diagnosticTurnHistory.js';
import { getTurns, type Turn } from '../../turns.js';
import { TURN_TRACE_LABEL } from '../../traceLabels.js';
import { MOOD_HISTORY_CAP, type AffectState, type MoodShift } from '../../../persona/status.js';
import {
  DIALS, CLIMATE_WINDOW_CAP, spentInWindow, type DialKey, type RelationshipClimate,
} from '../../../persona/climate.js';
import type { ThreadInventory } from '../../../persona/threads.js';
import type { MomentEntry, MomentTag } from '../../../persona/moments.js';
import { defaultHookState, type HookKind, type HookState } from '../../../persona/hooks.js';
import { MIN_TRANSCRIPT_SHARE } from '../../../agents/convo/promptPolicy.js';
import { PENDING_ASK_TTL_MS } from '../../../memory/dossier.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Inner state: read-only per-user view of the state that colours a reply without ever being said —
// the affect trail, the climate dials, the thread inventory, her one read on this person and the
// moments and hook rhythm that read is made of, and the last twenty `turn:trace` receipts. Seven
// stores, no writes, no LLM call, and nothing computed that the turn did not already decide:
// everything below is the persisted record re-shaped for reading.
//
// The trace rows come out of the persisted turn payloads (diagnostic_turn_history, 30 days) merged
// with whatever is still live in the ring, which is the same two-source read the Turn cost view
// does. `turn:trace` carries NAMES AND NUMBERS ONLY by design (diagnostics/turnTrace.ts), so this
// endpoint can hand the whole receipt to the client without a leak guard of its own — and the thread
// summary below keeps that property for the one store that does hold model-authored prose, by
// counting statuses and passing labels rather than notes. The moment rows keep it too, for the store
// where it matters most (see `MomentRow`). The THESIS text is the one deliberate exception among the
// stored documents, and the reason is in `ThesisSummary`: a read the operator cannot read is a read
// nobody can check. (`mood.metaPrompt` below is model-authored prose too, and has been on this
// payload since the affect panel landed — it is a self-note about ONE turn rather than a document,
// and the mood block is where the operator reads it.)
//
// Both file-backed stores can also fail to READ, and both say so on this payload — `thesis.degraded`
// and `momentsFile` — because this is the surface that exists to diagnose them: an unreadable file
// is not an empty one, and it is also what makes a background pass skip without stamping its clock
// forever. `api/memory.ts` ships `mediumPreserved` for the same reason on the same grammar.
//
// Every shaper is pure with its clock injected; affect.test.ts covers them. The route is the usual
// auth + cache wrapper around eight reads of seven stores (the thesis takes two: the head and its
// revision list).

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

// ── her read on them ─────────────────────────────────────────────────────────

/** One accepted version of THESIS.md, as the panel lists it: WHEN and BY WHICH WRITER, never the
 *  text it carried. The head document's text is below and is the read that is live; ten superseded
 *  copies of it on one payload would be a diary of everything she has ever thought about somebody,
 *  which is not what "the operator can check her read" needs. `db/repositories/thesis.ts` still has
 *  the bytes for anyone who wants a specific version. */
export interface ThesisRevisionRow {
  version: number;
  /** `'weekly'` (the read itself was rewritten), `'evidence'` (a nightly note appended), `'forget'`
   *  (a wipe) — the answer to why the document moved, without opening it. */
  writtenBy: string;
  createdAt: number;
}

/**
 * Her one read on this person, as the operator reads it.
 *
 * The TEXT is here, and it is the one place in this codebase that is true of: the thesis is rendered
 * into her prompt under an INTERNAL heading she may never recite, and the dashboard is the operator
 * surface for exactly the material the user is not shown. An unreadable read is a read nobody can
 * check, and a read nobody can check is the failure this panel exists to prevent — so `text` is the
 * document verbatim, evidence tail and all.
 *
 * `updatedAt` is the head's own `updated=` stamp and `version` its own version; neither is derived
 * from the revision list, so a missing revision file cannot make this panel disagree with the
 * document it is describing.
 *
 * `degraded` is why the route reads `readThesisHead` rather than `getThesis`. The reply path's read
 * folds "no file yet" and "the file will not parse" into one null on purpose; this panel is the one
 * reader that is an OPERATOR, and the two nulls are opposite instructions — the first says wait a
 * week, the second says go and look at the file, because every writer refuses an unreadable head and
 * the weekly pass will keep refusing until somebody does.
 */
export interface ThesisSummary {
  /** The document verbatim (the read plus its `## evidence` tail), or `''` for a person she has no
   *  read on yet — which is the normal state of somebody she met this week. */
  text: string;
  version: number;
  updatedAt: number;
  /** THESIS.md exists and did not parse. Everything above is a fallback, not the document. */
  degraded: boolean;
  revisions: ThesisRevisionRow[];
}

/** How many revisions the panel lists. The same ten the Memory view lists for the long tier. */
export const THESIS_REVISION_ROWS = 10;

/** The head read and its revision list, shaped for reading. Pure. */
export function thesisSummary(
  read: ThesisRead,
  revisions: readonly ThesisRevision[],
): ThesisSummary {
  return {
    text: read.doc?.docMd ?? '',
    version: read.doc?.version ?? 0,
    updatedAt: read.doc?.updatedAt ?? 0,
    degraded: read.degraded,
    revisions: revisions.map(r => ({
      version: r.version,
      writtenBy: r.writtenBy,
      createdAt: r.createdAt,
    })),
  };
}

// ── the moments ──────────────────────────────────────────────────────────────

/** One kept episode as the panel lists it: its TAG and its clocks, never her line about it.
 *
 *  The prose is deliberately absent, and this is the one store where that is more than the thread
 *  summary's tidiness rule. A moment is something the person would rather she had not noticed
 *  (`persona/moments.ts`), it is written in her voice about them, and it archives nothing — so an
 *  operator page that printed forty of them would be a roast diary rendered on a dashboard. What
 *  this panel answers is whether the machinery is alive and fair: how many she is holding, how old
 *  they are, which ones have folded, and which are being reached for. The text is on disk in
 *  `memories/<handle>/MOMENTS.md` for anyone who needs to read one. */
export interface MomentRow {
  tag: MomentTag;
  /** Whole days since the episode (its `at`, which a fold resets to the fold). Days, not a stamp:
   *  the prune reads sixty of them, so days are the unit the row is judged in. */
  ageDays: number;
  /** How many episodes have folded into this one. One means it has happened once. */
  count: number;
  /** How many turns it has been handed to. */
  offers: number;
  /** When it was last handed to a turn, or `0` for never — the stamp the prune actually reads. */
  lastOfferedAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The kept moments, newest episode first, as tags and clocks. Pure. */
export function momentRows(entries: readonly MomentEntry[], nowMs: number): MomentRow[] {
  return entries
    .map(e => ({
      tag: e.tag,
      ageDays: Math.max(0, Math.floor((nowMs - e.at) / DAY_MS)),
      count: e.count,
      offers: e.offered,
      lastOfferedAt: e.lastOfferedAt,
      at: e.at,
    }))
    .sort((a, b) => b.at - a.at)
    .map(({ at: _at, ...row }) => row);
}

/**
 * The state of the FILE the rows came out of, which the rows themselves cannot say.
 *
 * Two facts, and both of them are invisible everywhere else in the product. `degraded` means
 * MOMENTS.md is there and did not parse: the rows above are then a fallback rather than the file, the
 * nightly pass is skipping without stamping its clock (`MomentsFile.degraded` documents why it must),
 * and an empty table would otherwise read as "nothing kept about them yet" — confident, and exactly
 * inverted. `preserved` counts the segments with no valid annotation, a hand edit or a mangled
 * comment: they survive every rewrite and are never rendered into a prompt, so a corrupted moment is
 * otherwise invisible. That is `api/memory.ts`'s `mediumPreserved` argument, one store over, on the
 * same grammar and the same hand-edit rule — and it stops at a COUNT here, because the segment text
 * is the one thing this panel has decided not to re-publish.
 */
export interface MomentsFileState {
  degraded: boolean;
  preserved: number;
}

/** Whether the moments file read, and how many segments of it did not. Pure. */
export function momentsFileState(file: MomentsFile): MomentsFileState {
  return { degraded: file.degraded, preserved: file.preserved.length };
}

// ── the hook rhythm ──────────────────────────────────────────────────────────

/**
 * The rhythm ledger for this chat (`persona/hooks.ts`), as the panel reads it.
 *
 * The same four fields the store holds, copied rather than passed through, and that copy is the
 * whole job: `HookState` is read before every turn and written after it, so it is the field most
 * likely to grow — and a stored ledger that grew a fifth field would otherwise appear on an
 * operator payload the day it was added, unlabelled and undocumented. This interface is the list of
 * what an operator is shown, exactly as `ThreadSummary` is the list of what a thread inventory
 * shows.
 *
 * Nothing is re-derived. The kill switch is not a field here because it is not a stored fact: it is
 * `lastKinds` being a full window with no `none` in it, which is what the panel prints.
 */
export interface RhythmSummary {
  /** The last kinds she carried, oldest first — the window the kill switch reads. */
  lastKinds: HookKind[];
  idleStreak: number;
  idleSinceMoment: number;
  /** When the ledger last moved, or `0` for a chat that has never taken a turn. */
  updatedAt: number;
}

/** The stored ledger, shaped for reading. Pure. */
export function rhythmSummary(state: HookState): RhythmSummary {
  return {
    lastKinds: [...state.lastKinds],
    idleStreak: state.idleStreak,
    idleSinceMoment: state.idleSinceMoment,
    updatedAt: state.updatedAt,
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
  /**
   * The one extra beat the reply reported carrying (`persona/status.ts`'s envelope field, recorded
   * on the trace as `outcome.hook.emitted`): a hook word, or `'none'` for a reply that carried
   * nothing.
   *
   * `null` is the THIRD reading and the one worth having: the rhythm engine never ran on this turn
   * — the flag is off, or the caller was not Convo — which is not the same fact as a flat reply. The
   * negative control in the plan's Verification section is exactly this distinction, and a row that
   * printed `none` for both would make it unreadable.
   */
  hook_kind: string | null;
  /**
   * The contract that beat was taken under (`outcome.hook.mode`): `task` and `share` are the turn
   * gate's own answers, and an idle turn splits into `hook` (budget left) or `quiet` (the kill
   * switch spent it). `null` on exactly the turns `hook_kind` is null on — the selector never ran —
   * because the receipt writes the two as one fact (diagnostics/turnTrace.ts `outcome.hook`).
   *
   * It is a column and not a footnote because the kind stopped describing itself the day a third
   * turn shape landed: the same `judgment` is a beat AFTER an answer under `hook` and the whole
   * reply under `share`, and a `question` is the share's own move under `share` and a slip
   * anywhere else. Read beside the kind, the pair says which law the reply was written to.
   */
  hook_mode: string | null;
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
  const hook = asRecord(outcome?.hook);
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
    hook_kind: hook ? asStr(hook.emitted) : null,
    hook_mode: hook ? asStr(hook.mode) : null,
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

// ── the pending approvals ────────────────────────────────────────────────────

/**
 * One action this chat has been asked about and has not answered yet, as the panel reads it.
 *
 * READ-ONLY, and that is the whole design: an approval can only be settled by the user saying yes
 * or no in the chat (agents/convo/shared.ts), never from here — a dashboard button that started
 * someone's email would be exactly the thing the handshake exists to prevent.
 */
export interface PendingApprovalRow {
  id: string;
  kind: string;
  request: string;
  /** When she asked. For a parked row this IS the row's clock (opsTasks.ts startedAt). */
  askedAt: number;
  ageMs: number;
  state: string;
  /** True when this row is the second ask about the same action (the first one expired). */
  reconfirm: boolean;
  /** Past the shared 30-minute ask TTL: the next turn will settle it 'expired' rather than run it. */
  expired: boolean;
}

/** The parked rows, oldest first (the repository's own order), shaped for reading. Pure. */
export function pendingApprovalRows(rows: readonly OpsTaskRow[], nowMs: number): PendingApprovalRow[] {
  return rows.map(r => {
    const task = asRecord(r.meta?.task);
    const approval = asRecord(task?.approval);
    return {
      id: r.id,
      kind: r.kind,
      request: r.request,
      askedAt: r.startedAt,
      ageMs: Math.max(0, nowMs - r.startedAt),
      state: r.status,
      reconfirm: approval?.reconfirm === true,
      expired: nowMs - r.startedAt > PENDING_ASK_TTL_MS,
    };
  });
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
        // The rhythm ledger is keyed by CHAT like affect (a run of three hooked replies is a fact
        // about one room); the thesis and the moments file are keyed by HANDLE like climate. No read
        // here is gated on its feature flag: a flag removes the machinery that WRITES, and what is
        // already on disk is exactly what an operator turning a flag off wants to look at.
        const [state, climate, inventory, turns, thesisRead, thesisRevs, momentsFile, hookState] =
          await Promise.all([
            chatId ? getAffectState(chatId) : Promise.resolve({ moodHistory: [] } as AffectState),
            getRelationshipClimate(handle),
            getThreadInventory(handle),
            turnsFor(key),
            // `readThesisHead`, not `getThesis`: an operator is the one reader that has to tell an
            // absent read apart from an unreadable one (see `ThesisSummary.degraded`).
            readThesisHead(handle),
            listThesisRevisions(handle, THESIS_REVISION_ROWS),
            readMoments(handle),
            chatId ? getHookState(chatId) : Promise.resolve(defaultHookState()),
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
          // The three earned-material stores, in the order a reply builds on them: the read, the
          // moments a callback is sampled from, and the rhythm that decides whether either is
          // reached for at all. Both file-backed stores carry their read state beside their content
          // (`ThesisSummary.degraded`, `MomentsFileState`) — an empty panel over an unreadable file
          // would be the one wrong answer this page must not give.
          thesis: thesisSummary(thesisRead, thesisRevs),
          moments: momentRows(momentsFile.entries, now),
          momentsFile: momentsFileState(momentsFile),
          rhythm: rhythmSummary(hookState),
          threads: threadSummary(inventory),
          // The actions waiting on this person's yes. A synchronous read of the durable half of the
          // registry (the same rows the resolution promotes), and the only place outside the chat
          // where an open ask is visible at all.
          approvals: pendingApprovalRows(chatId ? listPendingApprovals(chatId) : [], now),
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

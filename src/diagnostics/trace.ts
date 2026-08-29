// In-memory diagnostics ring buffer. Records prompts/responses flowing between
// agents so the /debug dashboard can show exactly what was sent/received.
// No-op when DIAGNOSTICS_ENABLED=false. Payloads are stored VERBATIM by default
// (DIAGNOSTICS_STR_CAP=0); set a positive cap only if memory becomes a concern.
//
// Every event ALSO flows into the turn store (./turns.js), which groups the stream
// into per-chat / per-user turns for the /dashboard orchestration graph, and the
// LATEST turn per chat is persisted (debounced) so it survives restarts.

import { addEvent, setOnTurnChange, getTurns, type Turn } from './turns.js';
import { saveLatestTurn } from '../db/repositories/diagnosticTurns.js';
import { saveTurnToHistory, startHistoryPruneTimer } from '../db/repositories/diagnosticTurnHistory.js';
import { noteEvent } from './counters.js';

const ENABLED = process.env.DIAGNOSTICS_ENABLED !== 'false';
const CAP = Number(process.env.DIAGNOSTICS_BUFFER || 500);
// Per-string cap on recorded payloads (system prompts, messages, responses, raw wire bodies).
// 0 (the default) = UNLIMITED — the dashboard shows every payload verbatim, byte for byte.
// This only ever affected the diagnostics COPY: the API always receives the full prompt.
// Set a positive value only if the ring buffer's memory footprint becomes a concern.
const STR_CAP = Number(process.env.DIAGNOSTICS_STR_CAP || 0);

export type TraceType = 'llm' | 'delegation' | 'tool' | 'followup' | 'event';

export interface TraceEvent {
  id: number;
  ts: number;
  type: TraceType;
  chatId?: string;
  handle?: string;
  taskId?: string;
  role?: string;        // convo | ops | classify
  label?: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  system?: string;
  messages?: unknown;
  response?: string | null;
  toolCalls?: Array<{ name: string; input: unknown }>;
  detail?: Record<string, unknown>;
  /** The provider's UNPARSED wire response (Anthropic Message / OpenRouter completion object),
   *  before any text extraction or bubble parsing. Strings inside are capped like everything else. */
  raw?: unknown;
}

let seq = 0;
const buffer: TraceEvent[] = [];

function trunc(v: unknown): unknown {
  if (typeof v === 'string') return STR_CAP > 0 && v.length > STR_CAP ? v.slice(0, STR_CAP) + `…[+${v.length - STR_CAP}]` : v;
  if (Array.isArray(v)) return v.map(trunc);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = trunc(val);
    return out;
  }
  return v;
}

// Raw wire responses come straight from SDK objects: JSON-round-trip first so class
// instances/circular refs can never blow up a reply path, THEN cap the strings.
function safeRaw(v: unknown): unknown {
  if (v == null) return undefined;
  try {
    return trunc(JSON.parse(JSON.stringify(v)));
  } catch {
    return '[unserializable raw response]';
  }
}

export function record(ev: Omit<TraceEvent, 'id' | 'ts'>): void {
  if (!ENABLED) return;
  const event: TraceEvent = {
    ...ev,
    id: ++seq,
    ts: Date.now(),
    system: ev.system ? (trunc(ev.system) as string) : undefined,
    messages: ev.messages ? trunc(ev.messages) : undefined,
    response: ev.response != null ? (trunc(ev.response) as string) : ev.response,
    detail: ev.detail ? (trunc(ev.detail) as Record<string, unknown>) : undefined,
    raw: safeRaw(ev.raw),
  };
  buffer.push(event);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
  try { noteEvent(event); } catch (err) { console.error('[diagnostics] counters noteEvent failed', err); }
  try { addEvent(event); } catch (err) { console.error('[diagnostics] turn store addEvent failed', err); }
}

/**
 * Mark the start of a new orchestration turn for a chat — called when a user message
 * batch begins processing. Everything recorded after this (until the next beginTurn)
 * groups under one turn in the /dashboard graph; late Ops work still routes back via
 * taskId even after a newer turn opens.
 */
export function beginTurn(chatId: string, handle: string, triggerText: string, replyToId?: string): void {
  record({
    type: 'event',
    label: 'turn:start',
    chatId,
    handle,
    detail: { text: triggerText, ...(replyToId ? { replyToId } : {}) },
  });
}

/** Kind of the earlier message a tapped reply resolved to (see state/replyResolution.ts). */
export type ReplyKind = 'assistant' | 'own-thread' | 'quoted' | 'unresolved';

/**
 * Record how this turn's tapped reply resolved — surfaced on the dashboard turn so a
 * misattribution is visible instead of silent. Emitted from resolveTappedReply, after
 * beginTurn opened the turn, so it lands on the same open turn.
 */
export function noteTurnReply(chatId: string, reply: { targetId: string; kind: ReplyKind; snippet?: string }): void {
  record({ type: 'event', label: 'turn:reply', chatId, detail: reply });
}

// Persist every CHANGED turn, debounced per (key, turn) so a burst of events inside
// one turn becomes a single upsert. Two durable copies: diagnostic_turn_history gets
// the changed turn itself (one row per turn — a late Ops event landing on an OLDER
// turn persists that turn, not the newest), and diagnostic_turns keeps the key's
// newest turn (fast sidebar seed, retains raw payloads). Fire-and-forget:
// diagnostics must never break a reply.
const PERSIST_DEBOUNCE_MS = 2500;
const persistTimers = new Map<string, NodeJS.Timeout>();
setOnTurnChange((turn: Turn) => {
  const timerKey = `${turn.key}\u0000${turn.id}`;
  const existing = persistTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistTimers.delete(timerKey);
    void saveTurnToHistory(turn).catch(() => { /* repository already logs */ });
    const list = getTurns(turn.key);
    if (!list.length || list[list.length - 1].id === turn.id) {
      void saveLatestTurn(turn).catch(() => { /* repository already logs */ });
    }
  }, PERSIST_DEBOUNCE_MS);
  (timer as { unref?: () => void }).unref?.();
  persistTimers.set(timerKey, timer);
});

if (ENABLED) startHistoryPruneTimer();

export function getTraces(limit = CAP): TraceEvent[] {
  return buffer.slice(-limit);
}

export function clearTraces(): void {
  buffer.length = 0;
}

export const diagnosticsEnabled = ENABLED;

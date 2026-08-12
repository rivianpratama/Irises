// Groups the flat trace-event stream into TURNS — one turn per triggering moment
// (a user message batch, an inbound email judged, an automation firing). The admin
// dashboard renders a turn as an orchestration graph (who prompted whom, with what).
//
// Pure in-memory store, no imports from trace.ts at runtime (type-only), so there is
// no module cycle: trace.record() pushes every event here via addEvent().
//
// Keying: a turn belongs to a chat (chatId) or, for chat-less flows like the email
// Judge, to a user handle ("handle:<phone>"). Late async work (Ops running after the
// live reply went out) is routed back to the turn that DELEGATED it via taskId.

import type { TraceEvent, ReplyKind } from './trace.js';

export type TurnSource = 'user' | 'email' | 'automation' | 'system';

export interface TurnMeta {
  id: string;
  key: string;              // chatId, or "handle:<handle>" when no chat is involved
  chatId?: string;
  handle?: string;
  source: TurnSource;
  trigger?: string;         // what kicked it off (user text / instruction), truncated
  startedAt: number;
  lastAt: number;
  eventCount: number;
  agents: string[];         // distinct labels/roles seen, in first-seen order
  open: boolean;            // false once a newer turn opened on the same key
  // If this turn's user message tapped reply on an earlier one, how it resolved (from turn:reply).
  // Lets the dashboard flag a tapped reply — and any misattribution — instead of it being invisible.
  reply?: { targetId: string; kind: ReplyKind; snippet?: string };
}

export interface Turn extends TurnMeta {
  events: TraceEvent[];
}

const TURNS_PER_KEY = Number(process.env.DIAGNOSTICS_TURNS_PER_CHAT || 10);
const EVENTS_PER_TURN = Number(process.env.DIAGNOSTICS_EVENTS_PER_TURN || 300);
const TRIGGER_CAP = 400;
// A chat-keyed event with no open turn and no taskId link joins the current turn only
// while it's still warm; after this idle gap it starts a fresh (system-sourced) turn.
const IDLE_SPLIT_MS = Number(process.env.DIAGNOSTICS_TURN_IDLE_MS || 10 * 60_000);
const TASK_INDEX_CAP = 500;

let turnSeq = 0;
// Turn ids must be unique ACROSS restarts: they are the upsert key for the persisted
// turn history (key, turn_id), and a bare counter restarts at t1 on every boot.
const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const turnsByKey = new Map<string, Turn[]>();
// taskId -> the turn that delegated it, so late Ops/Composer events land on the right turn.
const taskIndex = new Map<string, Turn>();

type OnTurnChange = (turn: Turn) => void;
let onChange: OnTurnChange | null = null;

/** trace.ts registers the persistence hook here (debounced Supabase upsert). */
export function setOnTurnChange(fn: OnTurnChange | null): void {
  onChange = fn;
}

function keyFor(ev: Pick<TraceEvent, 'chatId' | 'handle'>): string | null {
  if (ev.chatId) return ev.chatId;
  if (ev.handle) return `handle:${ev.handle}`;
  return null;
}

function inferSource(ev: TraceEvent): TurnSource {
  const l = ev.label ?? '';
  if (l === 'turn:start') return 'user';
  if (l === 'judge' || l.startsWith('judge')) return 'email';
  if (l.startsWith('autonome')) return 'automation';
  return 'system';
}

function newTurn(key: string, ev: TraceEvent, source: TurnSource, trigger?: string): Turn {
  const turn: Turn = {
    id: `t${++turnSeq}.${BOOT_ID}`,
    key,
    chatId: ev.chatId,
    handle: ev.handle,
    source,
    trigger: trigger ? trigger.slice(0, TRIGGER_CAP) : undefined,
    startedAt: ev.ts,
    lastAt: ev.ts,
    eventCount: 0,
    agents: [],
    open: true,
    events: [],
  };
  let list = turnsByKey.get(key);
  if (!list) { list = []; turnsByKey.set(key, list); }
  for (const t of list) t.open = false;
  list.push(turn);
  if (list.length > TURNS_PER_KEY) list.splice(0, list.length - TURNS_PER_KEY);
  return turn;
}

function append(turn: Turn, ev: TraceEvent): void {
  turn.events.push(ev);
  if (turn.events.length > EVENTS_PER_TURN) turn.events.splice(0, turn.events.length - EVENTS_PER_TURN);
  turn.eventCount++;
  turn.lastAt = Math.max(turn.lastAt, ev.ts);
  if (!turn.handle && ev.handle) turn.handle = ev.handle;
  if (!turn.chatId && ev.chatId) turn.chatId = ev.chatId;
  const agent = ev.label || ev.role || ev.type;
  if (agent && !turn.agents.includes(agent)) turn.agents.push(agent);
  // Reply-resolution outcome for this turn (latest wins — a late-drain re-resolution overwrites).
  if (ev.label === 'turn:reply' && ev.detail) turn.reply = ev.detail as TurnMeta['reply'];
  if (ev.type === 'delegation' && ev.taskId) {
    taskIndex.set(ev.taskId, turn);
    if (taskIndex.size > TASK_INDEX_CAP) {
      const oldest = taskIndex.keys().next().value;
      if (oldest !== undefined) taskIndex.delete(oldest);
    }
  }
  onChange?.(turn);
}

/**
 * Route one trace event into the turn store. Called by trace.record() for EVERY event.
 * - label 'turn:start' always opens a new turn (the explicit boundary from beginTurn).
 * - an event carrying a known taskId joins the turn that delegated that task, even if
 *   a newer turn has since opened (late Ops answers land where they belong).
 * - otherwise it joins the key's open turn, or starts a fresh one if none/stale.
 */
export function addEvent(ev: TraceEvent): void {
  const key = keyFor(ev);
  if (!key) return; // global events (no chat, no user) stay in the ring buffer only

  if (ev.label === 'turn:start') {
    const trigger = typeof ev.detail?.text === 'string' ? ev.detail.text : undefined;
    append(newTurn(key, ev, 'user', trigger), ev);
    return;
  }

  if (ev.taskId) {
    const owner = taskIndex.get(ev.taskId);
    if (owner) { append(owner, ev); return; }
  }

  const list = turnsByKey.get(key);
  const current = list?.length ? list[list.length - 1] : undefined;
  if (current && current.open && ev.ts - current.lastAt < IDLE_SPLIT_MS) {
    append(current, ev);
    return;
  }

  const source = inferSource(ev);
  const trigger = typeof ev.detail?.instruction === 'string' ? ev.detail.instruction
    : typeof ev.detail?.request === 'string' ? ev.detail.request
    : undefined;
  append(newTurn(key, ev, source, trigger), ev);
}

export function getTurnKeys(): string[] {
  return [...turnsByKey.keys()];
}

export function getTurns(key: string): Turn[] {
  return turnsByKey.get(key) ?? [];
}

export function getTurn(key: string, id: string): Turn | undefined {
  return turnsByKey.get(key)?.find(t => t.id === id);
}

/** Latest turn per key — what gets persisted / listed in the dashboard sidebar. */
export function getLatestTurns(): Turn[] {
  const out: Turn[] = [];
  for (const list of turnsByKey.values()) {
    if (list.length) out.push(list[list.length - 1]);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

export function clearTurns(): void {
  turnsByKey.clear();
  taskIndex.clear();
}

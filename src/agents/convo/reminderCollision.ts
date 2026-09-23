// Reminder collisions — would a new reminder double one the user already has?
//
// Observed live (2026-09-23, local instance). "Change my 7am brief to govt news" came back as a
// cancel that missed plus a schedule that landed, four turns running, and the engine ended the day
// with five enabled 7am jobs. The user's standing rule since then is "hold, then revise": a create
// that lands on a slot or a purpose an existing reminder already covers is HELD, never made, and
// Irises revises the existing one unless the chat shows a clearly different purpose.
//
// Two ways to collide, either one enough:
//   • the SLOT — same kind (a one-shot against a one-shot, a repeat against a repeat) with at least
//     one pair of fire times within COLLISION_TOLERANCE_MS of each other. A one-shot against a
//     repeat is never a slot collision: "ping me at 9 tomorrow" beside a daily 9am is two asks.
//   • the PURPOSE — the two reminders' words (title + instruction) contained in each other at
//     CONTENT_CONTAINMENT or more (memory/textSim.ts), whatever their times.
// Identical words on the same slot is the one reminder asked for twice: `identical`, which the
// caller answers as already set, with no override.
//
// Zones: a new cron is written in the USER's wall clock, and an existing job's `expr` in the
// ENGINE's (hermesBackend shifts a cron into the engine's zone when it creates the job). Comparing
// the two as strings would miss "0 7 * * *" in Jakarta against "0 0 * * *" in UTC, the same instant.
// So both are expanded to real instants with cron-parser and compared there, over a bounded window
// with a bounded number of iterations per side.
//
// PURE, like toolOrder.ts beside it: the caller (convo/shared.ts, the schedule handler) owns the
// per-turn ledger this is read against and decides what a collision does to the call.

import parser from 'cron-parser';
import { simScore, tokenSet } from '../../memory/textSim.js';
import type { ReminderRef } from '../ops/engineBackend.js';

/** How close two fire times must be to share a slot. */
export const COLLISION_TOLERANCE_MS = 15 * 60_000;
/** How far ahead two repeating schedules are compared: a week, plus a day so a weekly one at the
 *  window's edge is still seen. */
export const COLLISION_WINDOW_MS = 8 * 24 * 60 * 60_000;
/** The most fire times expanded per schedule. */
const MAX_OCCURRENCES = 50;
/** The words-contained-in-words score at which two reminders are about the same thing. */
export const CONTENT_CONTAINMENT = 0.8;

/** A reminder as the collision check reads it. `exprZone` is the zone its `expr` is written in when
 *  that is NOT the engine's own: a reminder this very turn created or rescheduled is known only by
 *  the cron the user's zone gave it. */
export type LedgerReminder = ReminderRef & { exprZone?: string };

/** The reminder a schedule call is about to create. */
export interface NewReminder {
  kind: 'cron' | 'once';
  /** Present for `cron`, in the user's zone. */
  cron?: string;
  /** Present for `once`, epoch ms. */
  fireAt?: number;
  title?: string;
  instruction: string;
}

export interface CollisionOptions {
  /** The zone the new cron is written in. */
  userTz: string;
  /** The zone an existing job's `expr` is written in, unless the job says otherwise. */
  engineTz: string;
  nowMs: number;
}

export type Collision =
  | { kind: 'none' }
  /** The same words on the same slot: this reminder already exists. */
  | { kind: 'identical'; with: LedgerReminder }
  /** The same slot or the same purpose: held, and these are what it collides with. */
  | { kind: 'similar'; with: LedgerReminder[] };

function existingKind(r: LedgerReminder): 'cron' | 'once' | undefined {
  return r.kind ?? (r.expr ? 'cron' : r.runAt ? 'once' : undefined);
}

/** A schedule's fire times inside [from, to], at most MAX_OCCURRENCES of them. Empty on a cron the
 *  parser rejects: an unreadable schedule is no evidence of a collision. */
function occurrences(expr: string, tz: string, from: number, to: number): number[] {
  const out: number[] = [];
  try {
    const it = parser.parseExpression(expr, { tz, currentDate: new Date(from), endDate: new Date(to) });
    while (out.length < MAX_OCCURRENCES && it.hasNext()) out.push(it.next().getTime());
  } catch {
    return out;
  }
  return out;
}

/** Does the schedule fire anywhere within the tolerance of `t`? Asked of the schedule itself rather
 *  than of a capped list, so a schedule that fires every few minutes is still judged exactly. */
function firesNear(expr: string, tz: string, t: number): boolean {
  try {
    const it = parser.parseExpression(expr, { tz, currentDate: new Date(t - COLLISION_TOLERANCE_MS - 1000) });
    return it.next().getTime() <= t + COLLISION_TOLERANCE_MS;
  } catch {
    return false;
  }
}

/** Two repeating schedules share a slot when either one fires within the tolerance of one of the
 *  other's fire times in the window. Both directions are asked, because a capped list of a frequent
 *  schedule covers only the start of the window, while the sparser side's list covers all of it. */
function cronsMeet(a: string, aTz: string, b: string, bTz: string, nowMs: number): boolean {
  const end = nowMs + COLLISION_WINDOW_MS;
  return occurrences(a, aTz, nowMs, end).some(t => firesNear(b, bTz, t))
    || occurrences(b, bTz, nowMs, end).some(t => firesNear(a, aTz, t));
}

function sameSlot(next: NewReminder, r: LedgerReminder, opts: CollisionOptions): boolean {
  if (existingKind(r) !== next.kind) return false;
  if (next.kind === 'once') {
    const at = r.runAt ? Date.parse(r.runAt) : NaN;
    return next.fireAt != null && Number.isFinite(at) && Math.abs(next.fireAt - at) <= COLLISION_TOLERANCE_MS;
  }
  if (!next.cron || !r.expr) return false;
  return cronsMeet(next.cron, opts.userTz, r.expr, r.exprZone ?? opts.engineTz, opts.nowMs);
}

function sameWords(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every(t => b.has(t));
}

/**
 * Read a reminder about to be created against the ones that already exist. `identical` wins over
 * `similar` when both are present: asking for exactly what already stands is answered as already
 * set, whatever else the new one also resembles.
 */
export function detectCollision(next: NewReminder, existing: readonly LedgerReminder[], opts: CollisionOptions): Collision {
  const nextWords = tokenSet(`${next.title ?? ''} ${next.instruction}`);
  const nextInstruction = tokenSet(next.instruction);
  const similar: LedgerReminder[] = [];
  for (const r of existing) {
    const slot = sameSlot(next, r, opts);
    if (slot && sameWords(nextInstruction, tokenSet(r.instruction ?? r.title))) return { kind: 'identical', with: r };
    const purpose = simScore(nextWords, tokenSet(`${r.title} ${r.instruction ?? ''}`)).containment >= CONTENT_CONTAINMENT;
    if (slot || purpose) similar.push(r);
  }
  return similar.length ? { kind: 'similar', with: similar } : { kind: 'none' };
}

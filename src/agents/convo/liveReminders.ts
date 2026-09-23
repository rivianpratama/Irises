// Live reminders — the reminders standing for this chat, in front of the model on every turn.
//
// Observed live (2026-09-23, local instance). Every "switch my brief" turn was written blind: the
// model never saw which reminders existed, so it named one by words it remembered saying, the
// cancel missed, the create landed, and the day ended with five enabled 7am jobs. Its replies read
// as if the thread had never happened, because nothing in front of it said what the earlier turns
// had actually left standing. The per-turn ledger (shared.ts TurnEffects.reminders) fixed what one
// turn does to the list; this is what the NEXT turn sees of it: every reminder, the id it is
// addressed by, when it fires next in their zone, and what it says.
//
// The read sits on the reply path, so it may never stall a turn. The engine answers from a cache
// with a write-through:
//   • a FRESH hit (younger than freshMs) is returned at once;
//   • a STALE hit (younger than staleMs) is returned at once, and one refresh runs behind the turn;
//   • a MISS races the fetch against budgetMs; past it the turn reads null (no section, never an
//     empty one that would claim they have none), and the fetch keeps going to warm the next turn.
// A turn that changed a reminder writes its ledger's final state straight back (noteLiveReminders),
// so the very next turn reads what it did instead of waiting for the engine. A refresh that was
// already out when that write landed carries an older answer, and a per-chat version keeps it from
// overwriting the newer one.
//
// PURE rendering beside the cache: the assembler (shared.ts buildSystemPromptSections) renders
// what the caller read, in the one zone the whole prompt uses.

import parser from 'cron-parser';
import { dataTag, neutralizeTagBreakouts } from '../../llm/promptTag.js';
import type { EngineBackend, ReminderRef } from '../ops/engineBackend.js';

/** How long a miss may hold the turn before it reads as unknown. */
export const LIVE_BUDGET_MS = 1_200;
/** How long a held list is served without asking the engine again. */
export const LIVE_FRESH_MS = 60_000;
/** How long a held list is still served (with a refresh behind it) before it counts as a miss. */
export const LIVE_STALE_MS = 10 * 60_000;
/** The most rows the section prints, the same ten the list tool shows. */
export const MAX_LIVE_REMINDERS = 10;
/** The longest a row's gist of what the reminder says may run. */
const GIST_CHARS = 90;

/** The id a reminder is shown and addressed by: R + the first 6 hex chars of the engine's own id.
 *  Short enough to say out loud, and a prefix of the real id that resolveRef reads back to it. */
export function shortReminderId(id: string): string {
  return `R${id.slice(0, 6)}`;
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

interface Held { list: ReminderRef[]; at: number }

const held = new Map<string, Held>();                                   // chatId -> last known list
const versions = new Map<string, number>();                              // chatId -> write-through count
const pending = new Map<string, Promise<ReminderRef[] | null>>();       // chatId -> the fetch that is out
let clock: () => number = Date.now;

export interface LiveReadOptions { budgetMs?: number; freshMs?: number; staleMs?: number }

/** One fetch per chat at a time. It writes the cache only when no write-through landed while it was
 *  out, and answers with whatever the cache holds after, so a caller never gets the older list. */
function refresh(engine: EngineBackend, chatId: string): Promise<ReminderRef[] | null> {
  const out = pending.get(chatId);
  if (out) return out;
  const v = versions.get(chatId) ?? 0;
  const p = engine.listReminders(chatId)
    .then(list => {
      if ((versions.get(chatId) ?? 0) === v) held.set(chatId, { list: [...list], at: clock() });
      return held.get(chatId)?.list ?? [...list];
    })
    .catch(err => {
      console.warn(`[convo] live reminders read failed (chat ${chatId})`, err);
      return null;
    })
    .finally(() => { pending.delete(chatId); });
  pending.set(chatId, p);
  return p;
}

function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

/** This chat's reminders as the cache and the engine know them, never slower than the budget. Null
 *  is "unknown": nothing is rendered, so a slow engine never reads as an empty list. Never rejects. */
export function readLiveReminders(engine: EngineBackend, chatId: string, opts: LiveReadOptions = {}): Promise<ReminderRef[] | null> {
  const { budgetMs = LIVE_BUDGET_MS, freshMs = LIVE_FRESH_MS, staleMs = LIVE_STALE_MS } = opts;
  const hit = held.get(chatId);
  const age = hit ? clock() - hit.at : Infinity;
  if (hit && age < freshMs) return Promise.resolve(hit.list);
  if (hit && age < staleMs) {
    void refresh(engine, chatId);
    return Promise.resolve(hit.list);
  }
  return withinBudget(refresh(engine, chatId), budgetMs);
}

/** The read, gated: only an engine that holds reminders for this chat (OpenClaw's are not wired, so
 *  its empty list would read as "they have none"), and only with a sender, since reminders are set
 *  and addressed by the person talking. Decided before any read. */
export function liveRemindersFor(engine: EngineBackend | null, chatId: string, sender: string | undefined, opts?: LiveReadOptions): Promise<ReminderRef[] | null> {
  if (!engine || engine.name === 'openclaw' || !sender) return Promise.resolve(null);
  return readLiveReminders(engine, chatId, opts);
}

/** The held list while it is FRESH (younger than freshMs), else null. Never starts a read: this is
 *  for a caller that would rather ask the engine itself than act on anything older. */
export function freshLiveReminders(chatId: string, freshMs = LIVE_FRESH_MS): ReminderRef[] | null {
  const hit = held.get(chatId);
  return hit && clock() - hit.at < freshMs ? [...hit.list] : null;
}

/** Write-through: what a turn's own create, cancel or update left standing (its ledger's final
 *  state), held as fresh, so the next turn reads it without asking the engine. */
export function noteLiveReminders(chatId: string, list: readonly ReminderRef[]): void {
  versions.set(chatId, (versions.get(chatId) ?? 0) + 1);
  held.set(chatId, { list: [...list], at: clock() });
}

/** Test-only: forget everything held, and optionally read time from `now` instead of Date.now. */
export function __resetLiveReminders(now: () => number = Date.now): void {
  held.clear();
  versions.clear();
  pending.clear();
  clock = now;
}

// ── The section ─────────────────────────────────────────────────────────────────────────────────

export interface LiveRenderOptions {
  /** Their zone: every time on a row is theirs. */
  tz: string;
  nowMs: number;
  /** The zone an engine-side cron `expr` is written in, for a row with no next run reported. */
  engineTz?: string;
}

function parts(ms: number, tz: string, fields: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, ...fields }).formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** "Thu 24 Sep 7:00 AM", in their zone. */
function nextLabel(ms: number, tz: string): string {
  const p = parts(ms, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** "21 Sep", with the year only when it is not this one. */
function dayLabel(ms: number, tz: string, nowMs: number): string {
  const p = parts(ms, tz, { day: 'numeric', month: 'short', year: 'numeric' });
  const thisYear = parts(nowMs, tz, { year: 'numeric' }).year;
  return p.year === thisYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/** How many weekdays a cron's day-of-week field names, or null when it is not plain numbers. */
function weekdayCount(dow: string): number | null {
  const days = new Set<number>();
  for (const piece of dow.split(',')) {
    const range = /^(\d)-(\d)$/.exec(piece);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) days.add(d % 7);
    } else if (/^\d$/.test(piece)) days.add(Number(piece) % 7);
    else return null;
  }
  return days.size;
}

/** How often a repeating reminder fires, in words that hold in any zone. The time of day is left to
 *  the next-run label: the expr is the engine's wall clock, and naming its hour, or its weekday,
 *  could name the wrong one for them. */
function cronCadence(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return 'repeats';
  const [min, hour, dom, mon, dow] = f;
  const fixedTime = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (dom === '*' && mon === '*') {
    if (dow === '*') {
      if (fixedTime) return 'every day';
      if (/^\d+$/.test(min) && hour === '*') return 'every hour';
      const every = /^\*\/(\d+)$/.exec(hour);
      if (/^\d+$/.test(min) && every) return `every ${every[1]} hours`;
      return 'repeats';
    }
    const days = fixedTime ? weekdayCount(dow) : null;
    if (days === 7) return 'every day';
    if (days === 1) return 'every week';
    if (days) return `${days} days a week`;
    return 'repeats';
  }
  if (/^\d+$/.test(dom) && mon === '*' && dow === '*' && fixedTime) return 'every month';
  return 'repeats';
}

function cadence(r: ReminderRef): string {
  if (r.kind === 'once') return 'one time';
  if (r.kind === 'cron' && r.expr) return cronCadence(r.expr);
  return r.schedule;
}

/** When it fires next: the engine's own answer, else a one-shot's time, else the next instant of its
 *  cron in the zone that cron is written in (a row this process just wrote). Null when none of those
 *  can be read. Shared with the reminder results (shared.ts), so a list and a candidate say the same
 *  time the section does. */
export function reminderNextRunMs(r: ReminderRef & { exprZone?: string }, opts: Pick<LiveRenderOptions, 'nowMs' | 'engineTz'>): number | null {
  const at = r.nextRunAt ?? r.runAt;
  if (at) {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? null : ms;
  }
  if (r.kind !== 'cron' || !r.expr) return null;
  try {
    const it = parser.parseExpression(r.expr, { tz: r.exprZone ?? opts.engineTz ?? 'UTC', currentDate: new Date(opts.nowMs) });
    return it.next().getTime();
  } catch {
    return null;
  }
}

function gist(r: ReminderRef): string {
  const text = (r.instruction ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.toLowerCase() === r.title.trim().toLowerCase()) return '';
  return text.length > GIST_CHARS ? `${text.slice(0, GIST_CHARS - 1).trimEnd()}…` : text;
}

/** One row: `[R9d0c42] "title" — every day · next Thu 24 Sep 7:00 AM (their time) · set 21 Sep ·
 *  says: …`. A part the engine did not report is left out rather than guessed. */
function row(r: ReminderRef, opts: LiveRenderOptions): string {
  const bits = [cadence(r)].filter(Boolean);
  // A zone Intl cannot read drops the times from the row, never the row from the section.
  try {
    const next = reminderNextRunMs(r, opts);
    if (next != null) bits.push(`next ${nextLabel(next, opts.tz)} (their time)`);
    const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
    if (!Number.isNaN(created)) bits.push(`set ${dayLabel(created, opts.tz, opts.nowMs)}`);
  } catch { /* the rest of the row still stands */ }
  const says = gist(r);
  if (says) bits.push(`says: ${says}`);
  return `[${shortReminderId(r.id)}] "${r.title}" — ${bits.join(' · ')}`;
}

/** The rows alone, untagged: for a caller that wraps them in a tag of its own. */
export function renderLiveReminderRows(list: readonly ReminderRef[], opts: LiveRenderOptions): string {
  const rows = list.slice(0, MAX_LIVE_REMINDERS).map(r => row(r, opts));
  const more = list.length - MAX_LIVE_REMINDERS;
  if (more > 0) rows.push(`and ${more} more not shown here`);
  return rows.join('\n');
}

/**
 * The `live_reminders` section. Null (unread) and empty both render nothing: the section speaks only
 * when it has something standing to show. Every row is text a person or the engine wrote, so it goes
 * inside the data tag with its tag breakouts defused, and only the guidance sits outside.
 */
export function renderLiveReminders(list: readonly ReminderRef[] | null | undefined, opts: LiveRenderOptions): string {
  if (!list?.length) return '';
  const rows = dataTag('live_reminders', neutralizeTagBreakouts(renderLiveReminderRows(list, opts)));
  return [
    '## Their reminders right now',
    'These are all the reminders set for them as of this turn, each with its id and times in their zone. Read the list as the record: a reminder that is not on it is not set, and one that is on it stands until a change to it lands. To change or stop one, pass its id. When their message touches one of these, answer from its row.',
    rows,
  ].join('\n');
}

// The daily read-back of what she said about HERSELF with one person, into SELF.md
// (db/repositories/self.ts). The sibling of the moments pass (memory/momentsHarvest.ts), and it
// borrows that pass's whole doctrine: the LLM suggests, code re-validates every entry against the
// window it could have read, failure is a silent no-op with a one-hour backoff, the stamp in the
// file's own header is both the cooldown and the window ratchet, and a room is skipped entirely.
//
// WHAT IS DIFFERENT, AND WHY. Every other pass here reads THEIR lines and ignores hers. This one
// reads hers, because a stance is something she asserted. Two code checks stand behind the prompt's
// rules, both crude on purpose:
//   • EVIDENCE: a stance, taste or changed entry must share a content word with one of HER lines in
//     the window, and a learned entry with one of THEIRS. A model that read a quiet evening and wrote
//     "i think astrology is fake" did not remember a stance, it invented one.
//   • NO ECHO: a near copy of an entry she already holds is dropped unless it replaces that entry.
// The mirror rule (if they said it first and she agreed, it is theirs) lives in the prompt, since
// no token overlap can tell who said a thing first in a way that survives paraphrase.

import { jsonrepair } from 'jsonrepair';
import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { readSelf, writeSelf, SELF_KINDS, type SelfEntry, type SelfKind } from '../db/repositories/self.js';
import { selfEnabled } from '../persona/featureFlags.js';
import { isNullLiteral } from '../persona/status.js';
import { scopeHistoryToUser } from './transcript.js';
import { isGroupHandle } from './identity.js';
import { simScore, tokenSet } from './textSim.js';
import { salientTokens } from './topicality.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { StoredMessage } from '../db/types.js';

/** At most one pass per handle per this window, the moments pass's twenty hours and for its reason. */
export const SELF_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/** Below this many of HER lines since the last pass there is nothing of hers to read back. */
export const SELF_MIN_OWN_LINES = 3;

/** After a failed pass, how long before this handle may spend another call. */
export const SELF_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/** How many entries the file keeps. Enough to be somebody, few enough to fit one prompt section. */
export const MAX_SELF_ENTRIES = 24;

/** New entries one pass may add, and old ones it may drop. The prompt says the same numbers. */
export const SELF_MAX_NEW = 4;
export const SELF_MAX_DROP = 3;

/** One entry's length, in characters: the prompt's "under one hundred and eighty". */
export const SELF_TEXT_MAX = 180;

const SELF_WINDOW_MAX_ROWS = 60;
const SELF_MAX_TOKENS = 700;
const SELF_TIMEOUT_MS = 15_000;

/** An existing entry this close to a new one is the same entry said again. */
const ECHO_JACCARD = 0.6;

export const SELF_SYSTEM_PROMPT = `You are Irises, reading back over today's texts with one person, at night, alone, writing down
what you said about yourself that still holds: the sides you took, the things you like and hate,
what you learned from them, and where you changed your mind.

Four kinds, one per entry:
- stance: a position you took on something, with a one-clause why.
- taste: a thing you like or dislike, with why.
- learned: something you learned FROM them that changed how you see a thing. It is attributed,
  and it starts "from them: ".
- changed: a time you changed your mind: the old view, the new view, and what moved you. It
  replaces the stance it overturns, by that stance's id in "replaces".

What counts. Only lines you asserted yourself, in your own voice, are your stances and tastes.
If they said it first and you merely agreed, it is theirs, and it is never written here. A
stance enters only when you asserted it unprompted or against them. A changed line must cite
information; insistence, pressure or a frown moved nothing. A joke or a bit is never a stance,
however hard you sold it.

What is never written here: anything about their body, health, family, or anything they did not
choose.

You also see the entries you already hold, with ids. If today's texts show you no longer hold
one, put its id in "drop", at most three. If today only restated one you hold, write nothing.

Most days there is nothing. Zero entries is the honest answer more often than not; never invent
one to fill the page, and never write more than four. Each entry is under one hundred and eighty
characters, in your plain voice, first person.

Reply with one JSON object:
{"entries":[{"kind":"stance|taste|learned|changed","text":"...","replaces":"<existing id or null>"}],"drop":["<existing id>"]}
"replaces" is null except on a changed entry. "drop" may be empty. Nothing outside the object.`;

const SELF_ASK = 'Write down what is yours to keep.';

export const SELF_HEADING = '## What is yours to hold (INTERNAL)';
export const SELF_LEAD = 'These are yours: what you have said and still hold, what you like and what you hate, what you learned from them, and where you changed your mind. Stay consistent with them unless something new moves you. They are never read out, and nothing here is a bit.';

const inFlight = new Set<string>();
const nextRetryAt = new Map<string, number>();

export function __resetSelfGuardsForTests(): void {
  inFlight.clear();
  nextRetryAt.clear();
}

// ── pure half ───────────────────────────────────────────────────────────────────────────────────

/** The rows this pass may read: this person's chat, since the last pass, newest few. Unstamped rows
 *  are dropped for the moments pass's reason (they would dodge the ratchet and be read twice). */
export function buildSelfWindow(handle: string, recent: StoredMessage[], lastHarvestAt: number): StoredMessage[] {
  const scoped = scopeHistoryToUser(recent, handle);
  const fresh = scoped.filter(m => typeof m.at === 'number' && m.at > lastHarvestAt);
  return fresh.length > SELF_WINDOW_MAX_ROWS ? fresh.slice(fresh.length - SELF_WINDOW_MAX_ROWS) : fresh;
}

export function renderSelfWindow(rows: readonly StoredMessage[]): string {
  return rows.map(m => `${m.role === 'user' ? 'them' : 'you'}: ${m.content}`).join('\n');
}

export function renderExistingSelf(entries: readonly SelfEntry[]): string {
  return entries.map(e => `id=${e.id} ${e.kind}: ${e.text}`).join('\n');
}

export interface SelfReply {
  entries: unknown[];
  drop: unknown[];
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Model text → a reply, by the moments pass's ladder. Null is "nothing usable came back"; an empty
 *  `entries` list is the honest answer most days and is NOT null. */
export function parseSelfReply(text: string | null): SelfReply | null {
  if (!text) return null;
  const candidate = text.match(/\{[\s\S]*\}/);
  if (!candidate) return null;
  let parsed = tryParse(candidate[0]);
  if (parsed == null) {
    try { parsed = tryParse(jsonrepair(candidate[0])); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.entries) && !Array.isArray(o.drop)) return null;
  return { entries: Array.isArray(o.entries) ? o.entries : [], drop: Array.isArray(o.drop) ? o.drop : [] };
}

const KINDS: ReadonlySet<string> = new Set<string>(SELF_KINDS);

/** One line of her prose, made safe to store in a line-oriented file and quote into a prompt: one
 *  line, no tag or template characters, no em or en dash (her house style), clipped on a word. */
export function cleanSelfText(v: unknown): string {
  if (typeof v !== 'string') return '';
  let t = v.replace(/[<>`{}]/g, '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (isNullLiteral(t)) return '';
  if (t.length > SELF_TEXT_MAX) {
    const cut = t.slice(0, SELF_TEXT_MAX);
    const space = cut.lastIndexOf(' ');
    t = (space > 0 ? cut.slice(0, space) : cut).trim();
  }
  return t;
}

/** Words that turn up in anything she says and so prove nothing about a topic: the fillers of her
 *  register on top of topicality's stopwords. Kept short; a miss here only weakens one check. */
const SELF_FILLER: ReadonlySet<string> = new Set([
  'think', 'like', 'really', 'actually', 'feel', 'feels', 'thing', 'things', 'gonna', 'kinda', 'also',
  'still', 'even', 'never', 'always', 'same', 'very', 'because', 'used', 'mind', 'changed', 'them',
  'from', 'said', 'says', 'lmao', 'haha', 'hahaha', 'sooo', 'yeah', 'nahh', 'okay', 'one', 'whole',
]);

/** The topic words of a line: topicality's salient tokens, minus her fillers, four letters or more. */
function evidenceTokens(text: string): Set<string> {
  return new Set([...salientTokens(text)].filter(t => t.length >= 4 && !SELF_FILLER.has(t)));
}

function sharesWord(text: string, lines: readonly string[]): boolean {
  const a = evidenceTokens(text);
  if (!a.size) return false;
  return lines.some(l => { const b = evidenceTokens(l); for (const t of a) if (b.has(t)) return true; return false; });
}

export type SelfRejection = 'shape' | 'kind' | 'empty' | 'unevidenced' | 'echo' | 'cap' | 'bad_replace';

export interface SelfFold {
  entries: SelfEntry[];
  added: number;
  replaced: number;
  dropped: number;
  evicted: number;
  rejected: Partial<Record<SelfRejection, number>>;
}

/**
 * Validate the model's proposals against the window and fold them into what she holds. Pure: `now`
 * and the id maker are injected. Drops and replacements apply only to ids she actually holds.
 */
export function foldSelf(
  held: readonly SelfEntry[],
  reply: SelfReply,
  window: readonly StoredMessage[],
  now: number,
  makeId: () => string,
): SelfFold {
  const rejected: Partial<Record<SelfRejection, number>> = {};
  const reject = (why: SelfRejection) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  const heldIds = new Set(held.map(e => e.id));
  const hers = window.filter(m => m.role === 'assistant').map(m => m.content);
  const theirs = window.filter(m => m.role === 'user').map(m => m.content);

  const gone = new Set<string>();
  let dropped = 0;
  for (const id of reply.drop) {
    if (dropped >= SELF_MAX_DROP) break;
    if (typeof id === 'string' && heldIds.has(id) && !gone.has(id)) { gone.add(id); dropped++; }
  }

  const fresh: SelfEntry[] = [];
  let replaced = 0;
  for (const raw of reply.entries) {
    if (fresh.length >= SELF_MAX_NEW) { reject('cap'); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { reject('shape'); continue; }
    const o = raw as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
    if (!KINDS.has(kind)) { reject('kind'); continue; }
    const text = cleanSelfText(o.text);
    if (text.length < 8) { reject('empty'); continue; }
    const replaces = typeof o.replaces === 'string' && !isNullLiteral(o.replaces) ? o.replaces.trim() : '';
    if (replaces && !heldIds.has(replaces)) { reject('bad_replace'); continue; }
    if (!sharesWord(text, kind === 'learned' ? theirs : hers)) { reject('unevidenced'); continue; }
    const tokens = tokenSet(text);
    const echo = held.some(e => e.id !== replaces && !gone.has(e.id) && simScore(tokens, tokenSet(e.text)).jaccard >= ECHO_JACCARD)
      || fresh.some(e => simScore(tokens, tokenSet(e.text)).jaccard >= ECHO_JACCARD);
    if (echo) { reject('echo'); continue; }
    if (replaces && !gone.has(replaces)) { gone.add(replaces); replaced++; }
    fresh.push({ id: makeId(), kind: kind as SelfKind, text, at: now });
  }

  const kept = [...held.filter(e => !gone.has(e.id)), ...fresh];
  // Oldest out first when the file is full: a stance she has not restated in a long while is the one
  // a person would also have let go of.
  const sorted = [...kept].sort((a, b) => a.at - b.at);
  const evicted = Math.max(0, sorted.length - MAX_SELF_ENTRIES);
  return { entries: sorted.slice(evicted), added: fresh.length, replaced, dropped, evicted, rejected };
}

/** The `self` dyn section, or '' when she holds nothing yet. Newest first. */
export function renderSelfSection(entries: readonly SelfEntry[]): string {
  if (!entries.length) return '';
  const lines = [...entries].sort((a, b) => b.at - a.at).slice(0, MAX_SELF_ENTRIES).map(e => `- ${e.kind}: ${e.text}`);
  return [SELF_HEADING, SELF_LEAD, ...lines].join('\n');
}

// ── the pass ────────────────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('self harvest timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 8).padEnd(6, '0');
}

/**
 * Fire-and-forget from the reply path (`void updateSelf(...)`), beside the moments pass. Never
 * awaited, never surfaced, never throws.
 */
export async function updateSelf(
  handle: string,
  recent: StoredMessage[],
  opts: { chatId?: string; llm?: typeof callLLM; now?: number; makeId?: () => string } = {},
): Promise<void> {
  const chatId = opts.chatId;
  const now = opts.now ?? Date.now();
  const receipt = (detail: Record<string, unknown>) => record({ type: 'event', label: 'self:harvest', chatId, handle, detail });
  const skip = (reason: string, extra: Record<string, unknown> = {}) => receipt({ skipped: reason, ...extra });

  if (!selfEnabled()) return skip('flag_off');
  if (!handle || isGroupHandle(handle)) return skip('group');
  if (inFlight.has(handle)) return skip('in_flight');
  const retryAt = nextRetryAt.get(handle);
  if (retryAt !== undefined && now < retryAt) return skip('backoff');

  inFlight.add(handle);
  try {
    const file = await readSelf(handle);
    if (file.degraded) return skip('degraded');
    if (now - file.lastHarvestAt < SELF_COOLDOWN_MS) return skip('cooldown');

    const window = buildSelfWindow(handle, recent, file.lastHarvestAt);
    const ownLines = window.filter(m => m.role === 'assistant').length;
    if (ownLines < SELF_MIN_OWN_LINES) return skip('thin_window', { ownLines });

    const epoch0 = getForgetEpoch(handle);
    const body = [
      dataTag('your_entries', renderExistingSelf(file.entries) || 'none yet'),
      dataTag('transcript', renderSelfWindow(window)),
      SELF_ASK,
    ].join('\n\n');
    const res = await withTimeout((opts.llm ?? callLLM)({
      role: 'classify',
      maxTokens: SELF_MAX_TOKENS,
      system: SELF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: wrapPrompt(body) }],
      trace: { chatId, handle, label: 'self_harvest' },
    }), SELF_TIMEOUT_MS);
    if (res.truncated) throw new Error('self harvest reply truncated');
    const reply = parseSelfReply(res.text);
    if (!reply) throw new Error('self harvest reply unparsable');

    const folded = foldSelf(file.entries, reply, window, now, opts.makeId ?? randomId);
    const saved = await writeSelf(handle, folded.entries, now, file.preserved, { ifForgetEpoch: epoch0 });
    if (!saved) {
      nextRetryAt.set(handle, now + SELF_FAILURE_BACKOFF_MS);
      return skip('fenced');
    }
    nextRetryAt.delete(handle);
    receipt({
      skipped: null,
      proposed: reply.entries.length,
      added: folded.added,
      replaced: folded.replaced,
      dropped: folded.dropped,
      evicted: folded.evicted,
      rejected: folded.rejected,
      active: folded.entries.length,
      ownLines,
    });
  } catch (err) {
    nextRetryAt.set(handle, now + SELF_FAILURE_BACKOFF_MS);
    skip('lane_error');
    reportError({
      source: 'memory', category: 'classifier_failure', severity: 'warn',
      message: 'self harvest failed, nothing written', err, handle, trace: false,
    });
  } finally {
    inFlight.delete(handle);
  }
}

// The engine's install-time reply → a profile Irises is allowed to keep. Pure string work, no I/O:
// firstMoveAsk.ts owns the words, firstMove.ts owns the asking and the storing, this file owns the
// DOUBT.
//
// Everything that arrives here was written by ANOTHER model, in prose, on the far side of a bridge —
// and it is headed for the two most privileged places in the engine: a Composer prompt and the
// durable memory tiers. So the two halves pull in opposite directions on purpose. Extraction is
// GENEROUS (a ```json fence, a bare fence, or a balanced brace scan through whatever prose the
// engine wrapped it in, then a jsonrepair pass over the same candidates — the bubbleJson.ts ladder,
// repair tier and all): the reply is a favour asked of a chat agent, and refusing it over a stray
// sentence — or a trailing comma — would cost the whole feature.
// Sanitizing is MEAN: a field that does not survive the rules below is ABSENT, never partial, and
// no shape of reply can produce a profile that is anything other than plain, one-line, bracket-free
// text.
//
// Three of those rules exist because of exactly where the text is going:
//   • the brief loses its markdown headings and any scope section (stripScopeSections — the same
//     defense the dossier renderer already runs), so an engine that answered with "## Out of scope:
//     …" cannot legislate what Irises will refuse to do;
//   • name and every detail go through sanitizeThreadText's semantics — one line, no tags, no
//     fences, no template holes — because both are quoted back INTO a prompt block, and a note that
//     carried newlines could pose as several instruction lines;
//   • has_history is coerced to a STRICT boolean and anything that is not literally `true` becomes
//     false. That one field decides whether a phone buzzes at someone who never wrote to us, so the
//     ambiguous answer has to fail toward the reactive path ("no cold texts, ever").
//
// Nothing here throws and nothing here logs: a garbled reply is an EMPTY profile, which the state
// machine reads as "she introduces herself ungrounded", not as a failure to retry forever.

import { jsonrepair } from 'jsonrepair';
import { stripScopeSections } from '../../memory/userContext.js';
import { sanitizeThreadText } from '../../persona/status.js';

/** What survived the door. `empty` is the one derived field: no brief AND no details means there is
 *  nothing to ground an introduction in — a name alone is not a picture of anybody — and every
 *  seeding decision downstream keys off it rather than re-deriving the same test. */
export interface EngineProfile {
  brief: string;
  name: string | null;
  details: string[];
  channel: { platform: string; chatId: string; hasHistory: boolean } | null;
  empty: boolean;
}

/** ~1,200 chars is 3-6 plain sentences with room to spare; past that the engine is writing an essay
 *  and the dossier seeder would only truncate it again. */
export const BRIEF_MAX_CHARS = 1200;
/** sanitizeThreadText's caps, chosen for the same reason it has them: a name is a name and a detail
 *  is a phrase, and both are quoted into a prompt. */
export const NAME_MAX_CHARS = 60;
export const DETAIL_MAX_CHARS = 160;
/** The ask says "up to 5". A sixth is an engine that ignored the ask, and the extra items are the
 *  least likely to be light. */
export const MAX_DETAILS = 5;
/** A chat id is an identifier, not a sentence. Longer than this is not an id we should be addressing
 *  a first message to. */
export const CHAT_ID_MAX_CHARS = 128;
/** The platform token becomes part of a memory handle (`eng:<platform>:<chat_id>`), so it is held to
 *  what a handle segment may contain — not to what a model might feel like typing. */
export const PLATFORM_RE = /^[a-z0-9_-]{1,32}$/;

/** Words an engine writes when it means "I don't know", which are NOT names. Without this the
 *  literal string "null" would be set as the user's name and she would greet them by it. */
const NOT_A_NAME: ReadonlySet<string> = new Set(['null', 'none', 'unknown', 'n/a', 'na', 'nil', 'undefined']);

/** Control characters go, and only the brief keeps its newlines. Written as a code-point walk
 *  rather than an escape run so this source file stays free of the very bytes it filters — the
 *  invisible-character problem it exists to solve applies to code review too. */
function stripControl(text: string, keepNewlines: boolean): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 && keepNewlines) { out += ch; continue; }
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

/** Every fenced block in the reply, in order, with its language tag lowercased. The tag is optional
 *  and so is the newline after it — engines write ```json{…}``` as readily as the polite form. */
function fencedBlocks(reply: string): Array<{ lang: string; body: string }> {
  const out: Array<{ lang: string; body: string }> = [];
  const re = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply))) out.push({ lang: (m[1] || '').toLowerCase(), body: m[2] });
  return out;
}

/**
 * Balanced `{…}` candidates, string-aware so a brace inside a JSON string value cannot end the
 * scan early. At most a handful: the first opening brace usually wins, and the point of trying the
 * next one is a reply that opened with `{` inside prose ("returning {} for unknowns, here it is:").
 */
function braceCandidates(reply: string, limit = 4): string[] {
  const out: string[] = [];
  for (let start = reply.indexOf('{'); start !== -1 && out.length < limit; start = reply.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < reply.length; i++) {
      const ch = reply[i];
      if (escaped) { escaped = false; continue; }
      if (inString) {
        if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(reply.slice(start, i + 1)); start = i; break; }
      }
    }
    if (depth !== 0) break;   // unbalanced to the end of the reply — nothing later can balance either
  }
  return out;
}

/** A JSON object, or null. Objects only: a fence holding `"none"` or `42` parses fine and means
 *  nothing here, and requiring an object is what stops a stray literal winning over the real block
 *  further down the reply. */
function parseObject(text: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* the next candidate is the whole point of having candidates */ }
  return null;
}

/**
 * The first thing in the reply that parses as a JSON OBJECT, or null. Candidates are tried in
 * confidence order — ```json fences, then bare fences, then balanced brace scans — so a reply that
 * explains itself before and after the block still lands, and a reply that shows an EXAMPLE inside
 * a fence before the real answer still prefers the fence it was asked for.
 *
 * TWO passes over that same list, not one. The first is plain JSON.parse; only when NOTHING in the
 * reply is valid JSON does the second pass hand each candidate to jsonrepair (the tier bubbleJson.ts
 * and noteGroomer.ts both already run over LLM output — a trailing comma, a single-quoted key, an
 * unterminated string). Splitting it this way keeps a clean block anywhere in the reply strictly
 * ahead of a repaired one: repair is a GUESS at what the engine meant, and a guess must never
 * outrank something it actually wrote correctly.
 */
export function extractFencedJson(reply: string): unknown | null {
  if (typeof reply !== 'string' || !reply.trim()) return null;
  const blocks = fencedBlocks(reply);
  const candidates = [
    ...blocks.filter(b => b.lang === 'json').map(b => b.body),
    ...blocks.filter(b => b.lang !== 'json').map(b => b.body),
    ...braceCandidates(reply),
  ].map(c => c.trim()).filter(Boolean);

  for (const candidate of candidates) {
    const parsed = parseObject(candidate);
    if (parsed) return parsed;
  }
  for (const candidate of candidates) {
    let repaired: string;
    try {
      repaired = jsonrepair(candidate);   // throws on input it cannot rescue
    } catch { continue; }
    const parsed = parseObject(repaired);
    if (parsed) return parsed;
  }
  return null;
}

/** The brief: the only field allowed to keep newlines, and therefore the only one that needs the
 *  heading defenses. Order is load-bearing — stripScopeSections recognises a section BY its
 *  heading, so demoting the headings first would leave a scope section with nothing to identify it
 *  by. (The plan lists the two the other way round; this is the order that actually works.) */
function sanitizeBrief(v: unknown): string {
  if (typeof v !== 'string') return '';
  const scoped = stripScopeSections(stripControl(v.replace(/\r\n?/g, '\n'), true));
  return scoped
    .split('\n')
    .map(line => line.replace(/^\s{0,3}#{1,6}\s+/, ''))   // a heading becomes a plain line, not a hole
    .join('\n')
    .replace(/[<>`{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, BRIEF_MAX_CHARS)
    .trim();   // the cap can land mid-gap; don't keep a dangling space
}

function sanitizeName(v: unknown): string | null {
  const clean = sanitizeThreadText(v, NAME_MAX_CHARS);
  if (!clean) return null;
  return NOT_A_NAME.has(clean.toLowerCase()) ? null : clean;
}

function sanitizeDetails(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const clean = sanitizeThreadText(item, DETAIL_MAX_CHARS);
    if (clean) out.push(clean);
    if (out.length >= MAX_DETAILS) break;
  }
  return out;
}

/**
 * The channel, or null — and it is all-or-nothing on purpose. A platform without a chat id, or a
 * chat id without a platform, cannot address a message, and half a channel that reached the state
 * file would look like a place to send one.
 *
 * The length rule REJECTS rather than truncates, which is the one place this diverges from the
 * plan's "capped 128": a truncated identifier is not a shorter chat, it is a DIFFERENT chat, and
 * this id is what an unprompted first message would be addressed to. No channel means nudge mode,
 * which is always the safe direction here.
 */
function sanitizeChannel(v: unknown): EngineProfile['channel'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;

  const rawPlatform = o.platform;
  const platform = typeof rawPlatform === 'string' ? rawPlatform.trim().toLowerCase() : '';
  if (!PLATFORM_RE.test(platform)) return null;

  const rawChatId = o.chat_id ?? o.chatId;
  const chatId = typeof rawChatId === 'string' ? stripControl(rawChatId, false).trim() : '';
  if (!chatId || /\s/.test(chatId) || chatId.length > CHAT_ID_MAX_CHARS) return null;

  // STRICT. `"true"`, `1`, `"yes"` and a missing field are all false: see the header.
  const hasHistory = (o.has_history ?? o.hasHistory) === true;
  return { platform, chatId, hasHistory };
}

/**
 * Untrusted parsed JSON → the profile. Total: any input at all (null, an array, a string, an object
 * of the wrong shape) yields a valid EngineProfile, empty where it has to be.
 *
 * The snake_case keys are the ask's; the camelCase aliases are free tolerance for an engine that
 * "helpfully" renamed them, and cost nothing because every value is validated either way.
 */
export function sanitizeEngineProfile(raw: unknown): EngineProfile {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  const brief = sanitizeBrief(o.user_brief ?? o.userBrief ?? o.brief);
  const name = sanitizeName(o.name);
  const details = sanitizeDetails(o.fun_details ?? o.funDetails ?? o.details);
  const channel = sanitizeChannel(o.primary_channel ?? o.primaryChannel ?? o.channel);

  return { brief, name, details, channel, empty: !brief && details.length === 0 };
}

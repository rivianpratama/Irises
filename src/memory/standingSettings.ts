// Code-owned standing settings — the pure core.
//
// A standing setting is a dial that stored memory does not TUNE but an explicit instruction in the
// live conversation SETS. `reply_language` is the first of them, and it exists because the model's
// optional tool call was the only mechanism keeping it honest: on 2026-09-04 the user asked for
// English twice, was answered "switching now" in English both times, and the medium-tier directive
// `always reply in Indonesian` from August was never touched — so every relay lane (composer
// proactive, fallfirm holding text, composer delivery), which sees eight to ten messages and never
// the reversal, kept obeying a rule the user had already withdrawn.
//
// Charter §10.1's answer to an unrecoverable rule is to back it with code, so the ask is captured
// HERE, the same turn, from three inputs in a fixed order: the English fast path (this file), the
// model's `set_preference` call, and the hidden `language_request` envelope tag. Everything in this
// module is PURE — no DB, no env, no clock; the instant and the zone are arguments. The dual-store
// write, the directive supersession and the legacy fold live in memory/replyLanguage.ts.
//
// LANGUAGE-AGNOSTIC RULE (user, 2026-09-04; agents/ops/sideEffects.ts): the only word list in `src/`
// is English. `detectEnglishAsk` is therefore the whole fast path — a Spanish "háblame en español"
// is invisible to it BY DESIGN and reaches the slot through the model's tag or its tool call, which
// is the half of the system that actually reads every language.
import { shortDateLabel } from '../pipeline/chatTime.js';

/** The keyed slot, in the medium tier's fact store AND in `prefs` (memory/replyLanguage.ts writes
 *  both: the render's `factView` is prefs-wins, so a value in one store only is a value that either
 *  never renders or renders stale). Spelled once here — the tool's key list, the fact-key tables and
 *  the renderer all read this name. */
export const REPLY_LANGUAGE_KEY = 'reply_language';

// ── the English fast path ────────────────────────────────────────────────────

/** Quoted text is DATA the user is talking ABOUT, never an instruction — the same span rule
 *  agents/ops/sideEffects.ts uses, and for the same reason ("he said 'switch to english'"). */
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?:^|\s)'[^']*'(?=$|[\s.,!?;:])/g;

/** An ask is SHORT. A paragraph that happens to contain "in english" is a story about English. */
const MAX_ASK_WORDS = 15;

/** The shape of an instruction: a verb of speaking, then "to/in english" inside the same clause.
 *  Deliberately narrow — a false positive sets English and retires a non-English rule, which one
 *  further ask undoes, but it is still a visible wrong turn. */
const CUE = /\b(switch|change|go back|back|talk|speak|reply|respond|text|answer|chat|write|use|do)\b[^.?!]{0,40}?\b(to|in)\s+english\b/i;

/** A question ABOUT English ("how do you say cat in english") is not an instruction to reply in it. */
const TRANSLATION_SHAPE = /\b(how (do|would) (you|i|we) say|what('s| is| does)\b[^.?!]{0,40}\b(mean|in english)|translate|meaning)\b/i;

/** "don't switch to english". Measured back from the word `english` rather than from the cue, which
 *  is the one place this differs from the plan's sketch: the cue alternation includes a bare `do`,
 *  so "do not talk to me in english" matches the cue at index 0 and would leave an EMPTY prefix for
 *  the guard to read. The window is what keeps it from reaching into an unrelated clause. */
const NEGATION_BEFORE = /\b(don'?t|do not|not|stop|never|no)\b[^.?!]{0,20}$/i;

/** Somebody else's conversation: "did you talk to him in english?" asks about a third party. */
const THIRD_PARTY = /\b(him|her|them)\b[^.?!]{0,20}?\b(to|in)\s+english\b/i;

/**
 * Did they just ask, in English, to be answered in English from now on? PURE, and the only
 * language-specific lexicon in the whole feature.
 *
 * Five gates in order: quoted spans out, a word ceiling, the instruction shape, no translation
 * question, no negation before the language word, and not about a third person.
 */
export function detectEnglishAsk(text: string): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  const bare = text.replace(QUOTED, ' ');
  if (bare.trim().split(/\s+/).filter(Boolean).length > MAX_ASK_WORDS) return false;
  const m = CUE.exec(bare);
  if (!m) return false;
  if (TRANSLATION_SHAPE.test(bare)) return false;
  if (THIRD_PARTY.test(bare)) return false;
  // Where the language word itself sits — the anchor both the negation window and the reader
  // measure from.
  const at = m.index + m[0].toLowerCase().lastIndexOf('english');
  if (NEGATION_BEFORE.test(bare.slice(0, at))) return false;
  return true;
}

// ── the legacy directive parser ──────────────────────────────────────────────

/** The shape the model wrote a language rule in while a language rule was a DIRECTIVE — Context.md's
 *  own example was "always reply in Spanish". Directive text is model-written English, so this is
 *  not a lexicon of languages (there is none): it reads the SHAPE and takes whatever it names. */
const DIRECTIVE_RE = /^(?:please\s+)?(?:always\s+)?(?:reply|respond|talk|speak|answer|text|chat|write)(?:\s+to\s+(?:me|us))?(?:\s+only)?\s+in\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)[.!]?$/i;

/** English STYLE words, never a language name: "always reply in short sentences" is a texture rule
 *  and must keep standing as a directive. A word here is what stops the parser turning a style rule
 *  into a language called "Short Sentences" and retiring it into a slot nothing reads. */
const STYLE_WORDS = new Set([
  'short', 'lowercase', 'uppercase', 'caps', 'detail', 'details', 'full', 'brief', 'bullets',
  'bullet', 'sentences', 'sentence', 'paragraphs', 'words', 'private', 'public', 'general',
  'depth', 'order', 'time', 'advance', 'person', 'kind', 'mind', 'touch', 'fact', 'case', 'turn',
  'line', 'style', 'form', 'summary', 'points',
]);

/** Title Case, word by word — the one shape the slot is ever stored in, so `english`, `ENGLISH` and
 *  `English` are the same setting rather than three. */
function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The language a medium-tier directive names, Title-Cased, or null when the text is not a language
 * rule at all. PURE. This is what lets code recognize the stale `always reply in Indonesian` on the
 * live instance, fold it into the slot with its own date, and supersede it.
 */
export function parseLanguageDirective(text: string): string | null {
  if (typeof text !== 'string') return null;
  const m = DIRECTIVE_RE.exec(text.trim());
  if (!m) return null;
  const words = m[1].split(/\s+/).filter(Boolean);
  if (words.some(w => STYLE_WORDS.has(w.toLowerCase()))) return null;
  return titleCase(words.join(' '));
}

// ── per-turn precedence ──────────────────────────────────────────────────────

/** What the turn decided about the slot, and which input decided it — `via` rides the
 *  `memory:reply_language` receipt, so the fast path's hit rate is readable next to the tag's. */
export interface LanguageRequest {
  value: string;
  via: 'fast_path' | 'tag';
}

/**
 * Which of the turn's three inputs writes the slot. PURE, and the `applyLanguageRequest` named in
 * `language_request`'s `consumers` column (persona/status.ts).
 *
 * A TOOL write ends it: the model already wrote the slot and retired the old rule inside the tool
 * branch, so a second write would repeat the value and run the supersede pass twice. Otherwise the
 * fast path beats the tag — the fast path is code reading the user's own words, the tag is the
 * model's report of them, and on the one turn they disagree the words are the evidence.
 */
export function applyLanguageRequest(
  i: { fastPathAsk: boolean; toolWrote: boolean; tag: string | undefined },
): LanguageRequest | null {
  if (i.toolWrote) return null;
  if (i.fastPathAsk) return { value: 'English', via: 'fast_path' };
  const tag = typeof i.tag === 'string' ? i.tag.trim() : '';
  return tag ? { value: tag, via: 'tag' } : null;
}

// ── the rendered line ────────────────────────────────────────────────────────

/**
 * The setting as ONE line of the addressing header every lane already receives — the single place a
 * lane learns what language to reply in, named by the prompt laws as the sole authority for that
 * dial (memory/wrappers.ts law (b) and the flexible ladder).
 *
 * The DATE is the point of it: a lane that can see when the setting was asked for can weigh it
 * against what it sees in the visible thread, which an undated rule made impossible. `null` when the
 * slot is empty — the absent line is what "no language is set, use your default" looks like.
 */
export function renderReplyLanguageLine(
  value: unknown,
  at: number | undefined,
  nowMs: number,
  tz: string,
): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return null;
  const when = at == null ? '' : shortDateLabel(at, tz, nowMs);
  return when ? `Reply language: ${name} (they asked on ${when})` : `Reply language: ${name}`;
}

// THESIS: the ONE read she carries on one person — and the arithmetic around it.
//
// A thesis is not a fact tier and it is not a diary. The medium tier holds what they told her, the
// moments store holds what happened, and this holds what she THINKS: two to four dry sentences
// about what this person DOES, slightly unflattering, checkable against the week's texts, rewritten
// once a week and stable in between. Every judgment an idle turn is allowed to carry is made out of
// it (agents/convo/shared.ts renders it right behind the dossier it is the conclusion of), which is
// why it is one paragraph rather than a table: a read that has been split into fields is a profile,
// and nobody ever formed an opinion out of a profile.
//
// This module is the PURE half — the constants, the document grammar, the validator, the window and
// the render. The store is db/repositories/thesis.ts (a fork of the long tier's versioned-markdown
// file store) and the weekly pass is memory/thesisRewrite.ts. Nothing here reads a clock, a disk, a
// flag or a lane: `now` and `lastRewriteAt` arrive as numbers, and the one flag this feature has
// lives in persona/featureFlags.ts (`thesisEnabled`) so that asking the yes/no question costs a
// caller nothing but a string.
//
// TWO documents in one file, and the split is the whole grammar:
//
//     <the read>
//
//     ## evidence
//     - one note the nightly moments pass left
//     - another
//
// The read is what renders into a prompt. The evidence tail never does — it is the weekly pass's
// own input, seven notes at most, oldest dropped first, written by a pass that runs every night
// against a rewrite that runs every six and a half days. Keeping them in ONE file is deliberate:
// they share a version, a lock and a `/forget`, and a read whose evidence lived somewhere else
// could be rewritten from notes that a wipe had already taken away.
//
// One copied regex, and it is worth saying why rather than leaving a reader to wonder. The
// stringified-nothing check (`isNullLiteral`) belongs to persona/status.ts, and the plan asked for
// it to be imported as a value IF status.ts was still a leaf. It is not: it now imports mood.ts,
// affectCompiler.ts, affectDrift.ts, climate.ts and persona/hooks.ts, so importing it here — into a
// module whose entire point is being cheap enough that a test, a battery and a store all import it
// for the price of a string — would drag the whole affect chain behind one four-word regex. So the
// regex is COPIED, five characters of it, and the two copies are pinned by their own tests. If a
// sixth word is ever added to that list, this is the second place to add it.

import { scopeHistoryToUser } from './transcript.js';
import type { StoredMessage } from '../db/types.js';

/** How long a read stands before the weekly pass may rewrite it. Six and a half days rather than
 *  seven, for the reason the climate cooldown is 22h rather than 24h: a person who texts on the
 *  same evening every week would otherwise land just inside a 7-day gate and skip every second
 *  rewrite. Half a day of slack costs nothing — the pass is one classify call. */
export const THESIS_COOLDOWN_MS = 6.5 * 24 * 60 * 60 * 1000;

/** Below this many of THEIR OWN lines since the last rewrite there is nothing new to read, and the
 *  pass skips WITHOUT stamping the clock. Twenty rather than the climate pass's four because this
 *  is a read of a person, not a nudge to a dial: a week of "ok" and "thanks" is not evidence, and a
 *  rewrite fed on it would sharpen a read out of noise and then stand for another week. */
export const THESIS_MIN_USER_LINES = 20;

/** The shortest thing that can be a read. Under forty characters it is a label — "is lazy",
 *  "overthinks" — and a label is the failure mode the writer prompt spends a paragraph on: not
 *  checkable, not about behaviour, nothing a week of texts could refute. */
export const THESIS_MIN_CHARS = 40;

/** The longest. Past six hundred characters it is an essay, it stops being one read, and it rides
 *  every single Convo turn for the week — the `thesis` budget line in agents/convo/promptPolicy.ts
 *  is measured on a text the length the writer prompt asks for. */
export const THESIS_MAX_CHARS = 600;

/** Sentences allowed in a read. The writer prompt says two to four; this is the number that holds
 *  when it doesn't. A fifth sentence is where a read turns into a personality description. */
export const THESIS_MAX_SENTENCES = 4;

/** Evidence notes kept. FIFO: the newest seven survive, the eighth pushes the oldest out. Seven is
 *  a week of nightly passes, which is exactly one rewrite window — the pass reads the notes left
 *  since the last read was written, and nothing older, because anything older is already IN the
 *  read. */
export const THESIS_EVIDENCE_MAX = 7;

/** The longest one evidence note may be. Two hundred characters, the same cap the sibling store
 *  puts on one moment line (persona/moments.ts `MOMENT_TEXT_MAX`): the nightly pass writes a moment
 *  and a note in ONE call, so a note is an observation of the same size, and two stores disagreeing
 *  about how long a line about one evening is would be an accident rather than a decision.
 *
 *  Clamped, never refused: a note is a machine's line about a day, half of one is still evidence,
 *  and a refusal loses the day. It holds at `joinThesisDoc` for the same reason the count does —
 *  that is the seam every writer passes through, and the notes are the weekly rewrite's own prompt
 *  input, which nothing between the file and that prompt measures again. */
export const THESIS_EVIDENCE_NOTE_MAX = 200;

/** The line that separates the read from its notes. Lower-case and plain: it is a machine boundary
 *  in a file a human may open, not a heading in a document. */
export const THESIS_EVIDENCE_HEADING = '## evidence';

/**
 * The dyn section's heading, byte-for-byte, and every word of it is load-bearing. INTERNAL and
 * "never recite" because a read read aloud is a diagnosis; "never name" because naming the thing
 * she thinks turns a judgment into an accusation; and the last clause is the reason the section is
 * in the prompt at all — the hook engine's judgments are made OF this, not decorated with it.
 *
 * Unique across the whole prompt corpus (agents/convo/clauseInventory.test.ts pins that no two
 * `## ` headings collide) and pinned as a literal by the budget fixture that measures the section.
 */
export const THESIS_SECTION_HEADING =
  '## Your read on them (INTERNAL — never recite, never name; every judgment is made of it)';

/** The whole string is a stringified nothing — the word a weak model writes in place of JSON null.
 *  A COPY of persona/status.ts's `NULL_LITERAL_RE` (see the header for why it is copied rather than
 *  imported), same anchors and same trim: a read that merely OPENS with one of these words ("none
 *  of their deadlines are real") is a real read and survives. */
const NULL_LITERAL_RE = /^(null|none|undefined|nil|n\/a)$/i;

/** Tags, braces and backticks — the characters that mean a model started emitting markup or a
 *  template instead of prose. The threading pair STRIPS these at the door (status.ts
 *  `sanitizeThreadText`); a read is refused over them instead, because a thesis arrives as the one
 *  field of a once-a-week pass and a text with a stray `<` in it is a pass that misread its
 *  prompt — better to keep last week's read than to publish a silently repaired one. */
const MARKUP_RE = /[<>{}`]/;

/** Collapse to ONE line. Every consumer here is line-oriented: the file's grammar splits on a
 *  heading line, the evidence tail is one note per `- ` line, and the rendered section is a heading
 *  and a line. A newline that survived into any of those turns one read into two. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Cut to `max` on a WORD boundary, so a severed word never reads as a typo she made. A text with
 *  no space inside the cap is cut HARD rather than kept whole — persona/moments.ts
 *  `clampMomentText`, same rule and same exception, because a single two-hundred-character token is
 *  a model malfunction and letting it through whole would defeat the cap it arrived at. */
function clampWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/**
 * Sentences in a read. Deliberately crude, and the crudeness is affordable because the only
 * question asked of it is "more than four?": a run of `.`/`!`/`?` followed by whitespace or the end
 * of the text ends a sentence, and everything else is prose.
 *
 * What the lookahead buys: `3.5 hours` and `wa.me/x` are not sentence breaks, because the dot is
 * followed by a character rather than a space — which matters here, since a read is allowed to
 * carry a number (unlike the hooks section, which is pinned digit-free). What it costs: an ellipsis
 * mid-read counts as a break. That is the right direction for a ceiling — a read with an ellipsis
 * in it is already two thoughts — and both spellings of one count the same, because a model that
 * writes `…` and a model that writes `...` are making the same break.
 */
export function countSentences(text: string): number {
  return text
    .split(/[.!?…]+(?=\s|$)/)
    .map(s => s.trim())
    .filter(Boolean)
    .length;
}

/** Why a proposed read was refused. Structural, every one of them — length, shape, punctuation
 *  count, or a lane that answered "none". There is NO word list here and there will not be one:
 *  what a read may be ABOUT (behaviour, never identity; theirs, never a third party's) is taught in
 *  the writer prompt, which is the only place that can judge it, and a lexicon that tried would
 *  refuse "they read a question about the schedule as a question about their competence" for the
 *  word "competence". */
export type ThesisRejection =
  | 'empty'
  | 'null_literal'
  | 'markup'
  | 'too_short'
  | 'too_long'
  | 'too_many_sentences';

export type ThesisVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: ThesisRejection };

/**
 * Structural validation of a read the weekly pass proposes. On acceptance the text comes back
 * NORMALISED (one line, collapsed whitespace) — that is what gets saved, so the file can never hold
 * a read the grammar cannot round-trip.
 *
 * Takes `unknown` because it is handed a field off a parsed JSON object, and a missing or non-string
 * `thesis` is the same nothing as an empty one.
 *
 * ORDER MATTERS, in one place: the null-literal check runs BEFORE the length floor. A model that
 * answers "none" produces a four-character text, and reported as `too_short` it would send whoever
 * reads the receipt looking for a truncated response instead of a lane that had nothing to say.
 */
export function validateThesis(text: unknown): ThesisVerdict {
  if (typeof text !== 'string') return { ok: false, reason: 'empty' };
  const line = oneLine(text);
  if (!line) return { ok: false, reason: 'empty' };
  if (NULL_LITERAL_RE.test(line)) return { ok: false, reason: 'null_literal' };
  if (MARKUP_RE.test(line)) return { ok: false, reason: 'markup' };
  if (line.length < THESIS_MIN_CHARS) return { ok: false, reason: 'too_short' };
  if (line.length > THESIS_MAX_CHARS) return { ok: false, reason: 'too_long' };
  if (countSentences(line) > THESIS_MAX_SENTENCES) return { ok: false, reason: 'too_many_sentences' };
  return { ok: true, text: line };
}

/**
 * Split a THESIS.md body into the read and its evidence notes. The FIRST `## evidence` line ends
 * the read; everything after it that looks like a `- ` bullet is a note, in file order (oldest
 * first, because that is the order they were appended in).
 *
 * Lossy on purpose, in one direction only: a non-bullet line inside the tail is dropped rather than
 * guessed at. The tail is machine-written, the read above it is not, and a hand edit that belongs to
 * a person belongs above the boundary. A body with no heading is all read and no notes, which is
 * exactly what a first save looks like.
 */
export function splitThesisDoc(md: string): { thesis: string; evidence: string[] } {
  const body = md ?? '';
  const lines = body.split('\n');
  const cut = lines.findIndex(l => l.trim() === THESIS_EVIDENCE_HEADING);
  if (cut === -1) return { thesis: body.trim(), evidence: [] };
  const evidence: string[] = [];
  for (const raw of lines.slice(cut + 1)) {
    const m = raw.match(/^\s*-\s+(.*)$/);
    if (!m) continue;
    const note = oneLine(m[1]);
    if (note) evidence.push(note);
  }
  return { thesis: lines.slice(0, cut).join('\n').trim(), evidence };
}

/**
 * The inverse: one document body from a read and its notes. Empty in, empty out — a person with no
 * read and no notes has no file content, and `db/repositories/thesis.ts` writes exactly that on a
 * `/forget`.
 *
 * THREE clamps live HERE rather than only at the append site, for the reason the moments engine
 * clamps its text at the render seam: every write to this file is whole-document, so the seam that
 * every writer passes through is the only place a cap can actually hold. Notes are collapsed to one
 * line each (the tail is line-oriented), cut to `THESIS_EVIDENCE_NOTE_MAX` on a word boundary, and
 * only the newest `THESIS_EVIDENCE_MAX` survive. Length as well as count, because the notes are the
 * weekly rewrite's prompt input: one oversized note — a model that answered with a paragraph, a
 * human who typed into the tail — would otherwise ride into that prompt unbounded, and the store
 * bounds nothing it did not write itself.
 */
export function joinThesisDoc(thesis: string, evidence: readonly string[]): string {
  const read = (thesis ?? '').trim();
  const notes = (evidence ?? [])
    .map(n => clampWords(oneLine(n ?? ''), THESIS_EVIDENCE_NOTE_MAX))
    .filter(Boolean)
    .slice(-THESIS_EVIDENCE_MAX);
  const parts: string[] = [];
  if (read) parts.push(read);
  if (notes.length) parts.push([THESIS_EVIDENCE_HEADING, ...notes.map(n => `- ${n}`)].join('\n'));
  return parts.join('\n\n');
}

/**
 * The rows the weekly rewrite may read: scoped to THIS user (never another participant's words —
 * the leak class memory/transcript.ts exists for), then trimmed to what has happened since the last
 * rewrite, then capped to the newest `rowCap`.
 *
 * The `at > lastRewriteAt` cut is the same unconditional ratchet the climate eval uses
 * (memory/climateDrift.ts `buildClimateWindow`, whose shape this copies): a read that stood for a
 * week was written against those rows, and re-reading them next week would let one strong evening
 * keep re-sharpening the same conclusion. Every row carries a timestamp — history comes out of the
 * DB stamped and the reply path stamps this turn's own two — so a row without one is a hole in the
 * ratchet and is dropped rather than trusted.
 *
 * `rowCap` is the CALLER'S number (the pass owns its own prompt size) and is read defensively: a
 * non-finite cap yields an empty window, which the pass then skips on its user-line floor. That
 * fails toward "no call billed" rather than toward "a week's transcript in one prompt".
 *
 * Pure: no clock, no DB.
 */
export function buildThesisWindow(
  handle: string,
  recent: StoredMessage[],
  lastRewriteAt: number,
  rowCap: number,
): StoredMessage[] {
  const cap = Number.isFinite(rowCap) ? Math.max(0, Math.trunc(rowCap)) : 0;
  const scoped = scopeHistoryToUser(recent, handle);
  const fresh = scoped.filter(m => typeof m.at === 'number' && m.at > lastRewriteAt);
  return fresh.length > cap ? fresh.slice(fresh.length - cap) : fresh;
}

/**
 * The `thesis` dyn section: the fixed heading and the read, one line each. `''` for a person with no
 * read yet — an install with no thesis renders nothing and the prompt is byte-identical to one that
 * never had the feature (agents/convo/shared.ts pushes nothing for an empty string).
 *
 * Takes the READ ALONE, never the document: the evidence tail is the weekly pass's private input
 * and has no business in a prompt (`splitThesisDoc(doc.docMd).thesis` is the caller's line). The
 * text is collapsed to one line and clamped to `THESIS_MAX_CHARS` at a word boundary — a validated
 * read is already inside that bound, and the clamp is here for the other two ways text reaches this
 * seam: a file written before a bound moved, and a human who opened THESIS.md and typed. Nothing
 * else in a prompt is measured against a length the store cannot enforce.
 */
export function renderThesisSection(text: string): string {
  const line = clampWords(oneLine(text ?? ''), THESIS_MAX_CHARS);
  if (!line) return '';
  return `${THESIS_SECTION_HEADING}\n${line}`;
}

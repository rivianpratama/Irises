// The dossier LINE-EDIT engine — pure, and the whole reason the long-term document can move again.
//
// WHAT WAS WRONG. The dossier used to be maintained by handing a cheap model the entire document
// plus a transcript and asking for the whole thing back, merged. Two failures followed from that
// shape and neither was fixable inside it:
//
//   • A reply that stops early is not a shorter dossier, it is a MUTILATED one — the canonical
//     order means the tail (## Their world, ## Running jokes) is simply gone — so the only safe
//     response to a truncated reply is to throw it away. On the VPS that happened 37 times in a
//     week: LONG.md froze at 581 words / 3,608 chars against a 900-token reply budget, and every
//     pass after 2026-09-04 17:59 was discarded.
//   • Nothing could RESOLVE a contradiction. "Comfortable switching between English and Indonesian"
//     and "Prefers English conversation" sat one under the other, both undated, under a heading the
//     prompt authorises as style guidance — and "more recent wins" cannot be applied to lines that
//     never recorded when they were written.
//
// WHAT THIS IS. The same move a coding agent makes on a file it does not want to rewrite: the model
// is shown the document as numbered lines and returns a small list of add / replace / delete ops,
// each carrying a `match` copied out of the line it claims — the Edit-tool contract. Code verifies
// every op against the line the model was actually shown, applies the survivors, and owns the date
// stamp so a line can never lie about its own age. A wrong line number costs one deferred fact
// instead of a corrupted document, and the reply is a few dozen tokens instead of a few hundred.
//
// EVERYTHING HERE IS PURE. No DB, no env, no clock: `today` is an argument. The wiring — throttle,
// the two LLM calls, the /forget epoch check, the archive writes and the receipts — is in
// memory/dossier.ts, which is where the effects belong.
//
// THE PROTECTED LINES, in one place because they are the safety property: a heading, a blank line
// and `PROVENANCE_LINE` are not editable (the model may not restructure the document or delete the
// caveat that keeps a seeded picture from being cited as testimony), and "## Who they are" is never
// evicted for space (the identity anchor rides into every turn — relevance.ts clips it, never drops
// it, so losing it here would lose it everywhere).
import { PROVENANCE_LINE } from './provenance.js';
import { SCOPE_HEADING } from './userContext.js';
import { jsonrepair } from 'jsonrepair';

/** The five sections the capture prompt has always named, in the order it names them — "later
 *  sections are dropped first when space runs out", which is also the eviction order below. An
 *  `add` to anything else is discarded rather than filed somewhere plausible: a model inventing a
 *  sixth heading is a model that has stopped following the schema. */
export const CANONICAL_HEADINGS = [
  '## Who they are',
  '## How they work',
  '## How to text them',
  '## Their world',
  '## Running jokes',
] as const;
export type CanonicalHeading = (typeof CANONICAL_HEADINGS)[number];

/** How much of a line an op must copy to prove it means THAT line. Twelve characters is long enough
 *  that a paraphrase misses and short enough that a real quote is cheap; a line shorter than this
 *  may be matched whole. */
export const EDIT_MATCH_MIN_CHARS = 12;
/** One durable fact, one line. Anything longer is a paragraph the model is trying to smuggle in. */
export const EDIT_TEXT_MAX_CHARS = 240;
/** A turn produces a handful of durable facts at most; a list this long is a model rewriting the
 *  document one op at a time, which is the failure mode this protocol exists to replace. */
export const EDIT_MAX_OPS = 12;

/** The document's own budget — the number the compaction call and the eviction pass work to. Both
 *  sit well under `MEMORY_LONG_MAX_CHARS` (6,000, wrappers.ts), so a dossier at its budget always
 *  renders WHOLE: the render cap is a tripwire for a bug, never a routine trim. Words are the
 *  binding limit for Latin scripts, characters for unspaced ones (`/\S+/` undercounts those). */
export const LONG_DOC_MAX_WORDS = 450;
export const LONG_DOC_MAX_CHARS = 4000;

/** The date grammar, and the only thing on a dossier line that code writes rather than the model.
 *  Anchored at end-of-line so it can be split off and re-appended around any rewrite of the body —
 *  which is what `splitStamp` exists for, and what keeps the keyed-fact guard's `$`-anchored rules
 *  from capturing a stamp as part of a name. */
export const STAMP_RE = /\s\(since (\d{4}-\d{2}-\d{2})\)$/;

/** The op vocabulary. `line` numbers refer to the snapshot the model was shown — never to the
 *  document mid-batch (see `applyEditOps`). */
export type EditOp =
  | { op: 'add'; section: CanonicalHeading; text: string }
  | { op: 'replace'; line: number; match: string; text: string }
  | { op: 'delete'; line: number; match: string };

/** Why an op was thrown away. Every rejection is REPORTED (the `memory:dossier_edit` receipt), never
 *  swallowed: a cheap model that starts paraphrasing its matches shows up as a run of
 *  `match_mismatch` on the Errors tab instead of as a dossier that quietly stopped updating. */
export type RejectReason =
  | 'bad_shape' | 'unknown_section' | 'line_out_of_range' | 'line_not_editable'
  | 'match_too_short' | 'match_mismatch' | 'empty_text' | 'text_too_long'
  | 'duplicate' | 'line_already_edited' | 'too_many_ops';

export interface RejectedOp { op: unknown; reason: RejectReason }

// ── the line grammar ────────────────────────────────────────────────────────

const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line);

/** A heading line → its bare title, hashes and bold markers off. Used for canonical matching AND
 *  for the scope screen, so both read a heading the same way. */
function headingTitle(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, '').replace(/^\*+/, '').replace(/\*+$/, '').trim();
}

/** Which canonical section is this — by title, so `## Their world`, `Their world` and `#### their
 *  world` all land on the same bucket. Null for anything else. */
function canonicalOf(line: string): CanonicalHeading | null {
  const title = headingTitle(line).toLowerCase();
  return CANONICAL_HEADINGS.find(h => headingTitle(h).toLowerCase() === title) ?? null;
}

/** The compare form for a `match`: case-folded, whitespace-collapsed. A model that re-wraps or
 *  re-cases a line it copied is still quoting it; a model that reworded it is not. */
const foldText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** The compare form for DEDUPE: `foldText` plus the bullet marker, which is punctuation code owns. */
const foldBody = (s: string): string => foldText(s.replace(/^\s*[-*+]\s+/, ''));

/**
 * Split a line's body from its date stamp. `since: null` means the line predates stamping (or
 * predates this protocol), which the prompt tells the model to read as "older than any stamped
 * line" — and which the eviction order below acts on.
 */
export function splitStamp(line: string): { body: string; since: string | null } {
  const trimmed = line.replace(/\s+$/, '');
  const m = STAMP_RE.exec(trimmed);
  if (!m) return { body: line, since: null };
  return { body: trimmed.slice(0, m.index), since: m[1] };
}

/**
 * Every stamp off, for the READ paths. The stamps are storage-side bookkeeping the model that wrote
 * the document needs and nobody downstream does: the renderer would spend prompt budget on them, the
 * turn-relevance router would harvest `since` and `2026` as topic tokens out of every single line,
 * and the keyed-fact guard's end-anchored rules would read one as part of a name.
 *
 * Idempotent, and byte-for-byte identity on a document written before stamps existed.
 */
export function stripEditStamps(md: string): string {
  if (!md) return md;
  return md.split('\n').map(line => splitStamp(line).body).join('\n');
}

/** Model text → the line code actually writes. The model supplies a fact; the bullet, the single
 *  line and the date are ours (a model-written stamp is dropped, not trusted — otherwise a line can
 *  claim to be newer than it is, and the whole date order stops meaning anything). */
function cleanOpText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/\s+/g, ' ').trim().replace(/^[-*+]\s+/, '');
  return splitStamp(flat).body.trim();
}

const stampLine = (text: string, today: string): string => `- ${text} (since ${today})`;

// ── the numbered snapshot ───────────────────────────────────────────────────

/**
 * The document as the model sees it: `N| text`, every line numbered including the blanks and the
 * headings. Blanks burn a number on purpose — the model counts what it is shown, and a numbering
 * that skipped them would put every op one or two lines off.
 */
export function numberDoc(doc: string): { snapshot: string; lines: string[] } {
  if (!doc.trim()) return { snapshot: '', lines: [] };
  const lines = doc.split('\n');
  return { snapshot: lines.map((line, i) => `${i + 1}| ${line}`).join('\n'), lines };
}

// ── parsing the reply ───────────────────────────────────────────────────────

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Model text → an op list. The same ladder noteGroomer.ts and the bubble parser use (outermost
 * brace-delimited candidate → parse → jsonrepair → parse), because a cheap model's JSON arrives
 * fenced, prefaced, or one trailing comma short.
 *
 * `null` means nothing usable came back at all — no `{"ops":[…]}` object anywhere — which the caller
 * reports as `unparsable` and a classifier failure. An empty `ops` array is the opposite: a
 * deliberate "nothing durable happened", and a no-op. Shape is checked here; CONTENT is verified
 * against the real document in `applyEditOps`, which is the only place that knows what line 7 says.
 */
export function parseEditOps(text: string | null): { ops: EditOp[]; rejected: RejectedOp[] } | null {
  if (!text) return null;
  const candidate = text.match(/\{[\s\S]*\}/);
  if (!candidate) return null;
  let parsed = tryParse(candidate[0]);
  if (parsed == null) {
    try {
      parsed = tryParse(jsonrepair(candidate[0]));
    } catch {
      return null; // jsonrepair throws on input it cannot rescue
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(raw)) return null;

  const ops: EditOp[] = [];
  const rejected: RejectedOp[] = [];
  for (const item of raw) {
    if (ops.length >= EDIT_MAX_OPS) { rejected.push({ op: item, reason: 'too_many_ops' }); continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) { rejected.push({ op: item, reason: 'bad_shape' }); continue; }
    const o = item as { op?: unknown; section?: unknown; line?: unknown; match?: unknown; text?: unknown };
    if (o.op === 'add') {
      const section = typeof o.section === 'string' ? canonicalOf(o.section) : null;
      if (!section) { rejected.push({ op: item, reason: 'unknown_section' }); continue; }
      const text = cleanOpText(o.text);
      if (!text) { rejected.push({ op: item, reason: 'empty_text' }); continue; }
      if (text.length > EDIT_TEXT_MAX_CHARS) { rejected.push({ op: item, reason: 'text_too_long' }); continue; }
      ops.push({ op: 'add', section, text });
      continue;
    }
    if (o.op !== 'replace' && o.op !== 'delete') { rejected.push({ op: item, reason: 'bad_shape' }); continue; }
    if (!Number.isInteger(o.line) || (o.line as number) < 1 || typeof o.match !== 'string') {
      rejected.push({ op: item, reason: 'bad_shape' });
      continue;
    }
    if (o.op === 'delete') {
      ops.push({ op: 'delete', line: o.line as number, match: o.match });
      continue;
    }
    const text = cleanOpText(o.text);
    if (!text) { rejected.push({ op: item, reason: 'empty_text' }); continue; }
    if (text.length > EDIT_TEXT_MAX_CHARS) { rejected.push({ op: item, reason: 'text_too_long' }); continue; }
    ops.push({ op: 'replace', line: o.line as number, match: o.match, text });
  }
  return { ops, rejected };
}

// ── applying the ops ────────────────────────────────────────────────────────

/**
 * Verify each op against the document the model was SHOWN, then apply the survivors.
 *
 * The one invariant everything else hangs off: every `line` resolves against the ORIGINAL line
 * array, so numbers never shift mid-batch — a delete above line 7 does not renumber line 7 — and one
 * line may be touched by one op only (a second op on it is `line_already_edited`, because the model
 * wrote it against a line that no longer says what it said).
 *
 * A rejected op is dropped ALONE. One bad line number must not cost the two good ops beside it, and
 * a batch where everything is rejected leaves the document byte-identical rather than half-written.
 */
export function applyEditOps(
  doc: string,
  ops: readonly EditOp[],
  today: string,
): { doc: string; applied: EditOp[]; rejected: RejectedOp[] } {
  const lines = doc.split('\n');
  const applied: EditOp[] = [];
  const rejected: RejectedOp[] = [];
  const reject = (op: unknown, reason: RejectReason) => { rejected.push({ op, reason }); };

  const replacement = new Map<number, string>();
  const removed = new Set<number>();
  const touched = new Set<number>();
  const adds = new Map<CanonicalHeading, string[]>();

  // Every body the document already holds, folded — so a fact it already records is not added a
  // second time in different words' clothing, and two identical adds in one batch collapse to one.
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim() || isHeading(line)) continue;
    seen.add(foldBody(splitStamp(line).body));
  }

  const editable = (raw: string): boolean =>
    Boolean(raw.trim()) && !isHeading(raw) && raw.trim() !== PROVENANCE_LINE;

  for (const op of ops) {
    if (applied.length >= EDIT_MAX_OPS) { reject(op, 'too_many_ops'); continue; }
    if (!op || typeof op !== 'object') { reject(op, 'bad_shape'); continue; }
    const o = op as { op?: unknown; section?: unknown; line?: unknown; match?: unknown; text?: unknown };

    if (o.op === 'add') {
      const section = typeof o.section === 'string' ? canonicalOf(o.section) : null;
      if (!section) { reject(op, 'unknown_section'); continue; }
      const text = cleanOpText(o.text);
      if (!text) { reject(op, 'empty_text'); continue; }
      if (text.length > EDIT_TEXT_MAX_CHARS) { reject(op, 'text_too_long'); continue; }
      const folded = foldBody(text);
      if (seen.has(folded)) { reject(op, 'duplicate'); continue; }
      seen.add(folded);
      adds.set(section, [...(adds.get(section) ?? []), stampLine(text, today)]);
      applied.push({ op: 'add', section, text });
      continue;
    }

    if (o.op !== 'replace' && o.op !== 'delete') { reject(op, 'bad_shape'); continue; }
    if (!Number.isInteger(o.line) || typeof o.match !== 'string') { reject(op, 'bad_shape'); continue; }
    const line = o.line as number;
    if (line < 1 || line > lines.length) { reject(op, 'line_out_of_range'); continue; }
    if (touched.has(line)) { reject(op, 'line_already_edited'); continue; }
    const raw = lines[line - 1];
    if (!editable(raw)) { reject(op, 'line_not_editable'); continue; }

    // The match is the proof. Case-folded and whitespace-collapsed so a re-wrapped copy still
    // counts; long enough that a paraphrase cannot pass — unless the whole line is shorter than the
    // floor, in which case quoting all of it is the most proof there is.
    const body = splitStamp(raw).body;
    const foldedBody = foldText(body);
    const foldedMatch = foldText(o.match);
    if (foldedMatch.length < EDIT_MATCH_MIN_CHARS && foldedMatch !== foldedBody) { reject(op, 'match_too_short'); continue; }
    if (!foldedBody.includes(foldedMatch)) { reject(op, 'match_mismatch'); continue; }

    if (o.op === 'delete') {
      removed.add(line);
      touched.add(line);
      seen.delete(foldBody(body));
      applied.push({ op: 'delete', line, match: o.match });
      continue;
    }

    const text = cleanOpText(o.text);
    if (!text) { reject(op, 'empty_text'); continue; }
    if (text.length > EDIT_TEXT_MAX_CHARS) { reject(op, 'text_too_long'); continue; }
    const folded = foldBody(text);
    const own = foldBody(body);
    if (folded !== own && seen.has(folded)) { reject(op, 'duplicate'); continue; }
    seen.delete(own);
    seen.add(folded);
    replacement.set(line, stampLine(text, today));
    touched.add(line);
    applied.push({ op: 'replace', line, match: o.match, text });
  }

  if (!applied.length) return { doc, applied, rejected };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i + 1)) continue;
    out.push(replacement.get(i + 1) ?? lines[i]);
  }

  // Adds go in AFTER the in-place edits, canonical section by canonical section, so a heading this
  // batch creates is already in place when the next section looks for its neighbours.
  for (const heading of CANONICAL_HEADINGS) {
    const bucket = adds.get(heading);
    if (!bucket?.length) continue;
    const at = out.findIndex(line => isHeading(line) && canonicalOf(line) === heading);
    if (at >= 0) {
      // Append below the last line that is actually in this section (blank tail lines excluded).
      let end = at;
      for (let i = at + 1; i < out.length && !isHeading(out[i]); i++) {
        if (out[i].trim()) end = i;
      }
      out.splice(end + 1, 0, ...bucket);
      continue;
    }
    // A missing heading is created in CANONICAL position — before the first section that belongs
    // after it, or at the bottom when there is none.
    const later = CANONICAL_HEADINGS.slice(CANONICAL_HEADINGS.indexOf(heading) + 1) as readonly string[];
    let before = out.length;
    for (let i = 0; i < out.length; i++) {
      const c = isHeading(out[i]) ? canonicalOf(out[i]) : null;
      if (c && later.includes(c)) { before = i; break; }
    }
    out.splice(before, 0, '', heading, ...bucket, '');
  }

  return { doc: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), applied, rejected };
}

// ── sections: order, scope, relocation ──────────────────────────────────────

interface DocSection { heading: string | null; canonical: CanonicalHeading | null; lines: string[] }

/** The document as sections. Blank lines are dropped here (they are separators, and `renderSections`
 *  puts them back exactly one per boundary) and the pre-heading preamble is its own headless
 *  section, the same granularity `splitSections` (wrappers.ts) screens at. */
function parseSections(doc: string): DocSection[] {
  const out: DocSection[] = [];
  let current: DocSection = { heading: null, canonical: null, lines: [] };
  for (const line of doc.split('\n')) {
    if (isHeading(line)) {
      out.push(current);
      current = { heading: line.trim(), canonical: canonicalOf(line), lines: [] };
    } else if (line.trim()) {
      current.lines.push(line);
    }
  }
  out.push(current);
  return out;
}

/** Sections → markdown. A headed section with nothing under it is dropped: "create a heading only
 *  when it has content" is the capture prompt's own rule, and an empty heading costs prompt budget
 *  while teaching the next pass that the section exists. */
function renderSections(sections: readonly DocSection[]): string {
  return sections
    .filter(s => s.lines.length > 0)
    .map(s => (s.heading ? [s.heading, ...s.lines] : s.lines).join('\n'))
    .join('\n\n')
    .trim();
}

/**
 * Put the document back in shape before it is shown to the model, so the line numbers it edits
 * against are the numbers of a document in canonical order.
 *
 * Three things happen, and only the first is silent:
 *   • canonical sections are ordered and merged (two `## Their world` headings become one);
 *   • a scope/capability section is DROPPED — the poisoned-dossier precedent (`stripScopeSections`),
 *     the one case where content is deliberately destroyed, and reported so it shows on a receipt;
 *   • any OTHER heading has its lines RELOCATED under `## Their world` rather than deleted. A
 *     heading the model invented is a schema slip, not a reason to lose the fact underneath it.
 */
export function normalizeDoc(doc: string): { doc: string; relocated: string[]; droppedScope: string[] } {
  const relocated: string[] = [];
  const droppedScope: string[] = [];
  if (!doc.trim()) return { doc: '', relocated, droppedScope };

  const preamble: string[] = [];
  const buckets = new Map<CanonicalHeading, string[]>();
  for (const section of parseSections(doc)) {
    if (section.heading === null) { preamble.push(...section.lines); continue; }
    if (SCOPE_HEADING.test(headingTitle(section.heading))) { droppedScope.push(section.heading); continue; }
    if (!section.canonical) relocated.push(...section.lines);
    const key = section.canonical ?? '## Their world';
    buckets.set(key, [...(buckets.get(key) ?? []), ...section.lines]);
  }

  const sections: DocSection[] = [];
  if (preamble.length) sections.push({ heading: null, canonical: null, lines: preamble });
  for (const heading of CANONICAL_HEADINGS) {
    const lines = buckets.get(heading);
    if (lines?.length) sections.push({ heading, canonical: heading, lines });
  }
  return { doc: renderSections(sections), relocated, droppedScope };
}

// ── size and eviction ───────────────────────────────────────────────────────

/** Words the way every word budget in this repo counts them (`/\S+/`), plus raw characters. */
export function docStats(doc: string): { words: number; chars: number } {
  return { words: (doc.match(/\S+/g) ?? []).length, chars: doc.length };
}

/** Which budget broke, or null. Words first: it is the binding one for Latin scripts, and naming the
 *  budget rather than returning a boolean is what lets the receipt say why a compaction ran. */
export function overCap(doc: string): 'words' | 'chars' | null {
  const { words, chars } = docStats(doc);
  if (words > LONG_DOC_MAX_WORDS) return 'words';
  if (chars > LONG_DOC_MAX_CHARS) return 'chars';
  return null;
}

/** Eviction rank: higher goes first. Reverse canonical order ("later sections are dropped first"),
 *  with a non-canonical section and the headless preamble ahead of all of them, and "## Who they
 *  are" out of the running entirely — the identity anchor rides into every turn, so losing a line of
 *  it here loses it everywhere. */
function evictionRank(section: DocSection): number {
  if (section.heading === null) return CANONICAL_HEADINGS.length + 1;
  if (section.canonical === '## Who they are') return -1;
  if (!section.canonical) return CANONICAL_HEADINGS.length;
  return CANONICAL_HEADINGS.indexOf(section.canonical);
}

const evictableLine = (line: string): boolean => Boolean(line.trim()) && line.trim() !== PROVENANCE_LINE;

/** The next line to go: the highest-ranked section that still has one, and inside it the oldest line
 *  — undated first (an unstamped line predates every stamp), then ascending date, document order
 *  breaking ties. */
function nextEviction(sections: readonly DocSection[]): { section: DocSection; index: number } | null {
  const candidates = sections
    .map((section, i) => ({ section, i, rank: evictionRank(section) }))
    .filter(c => c.rank >= 0 && c.section.lines.some(evictableLine))
    .sort((a, b) => (b.rank - a.rank) || (b.i - a.i));
  const target = candidates[0];
  if (!target) return null;

  let index = -1;
  let oldest = '';
  target.section.lines.forEach((line, i) => {
    if (!evictableLine(line)) return;
    const since = splitStamp(line).since ?? '';
    if (index < 0 || since < oldest) { index = i; oldest = since; }
  });
  return index < 0 ? null : { section: target.section, index };
}

/**
 * Last resort when compaction did not get the document under budget: drop whole lines, oldest and
 * least durable first, one at a time until it fits. The caller ARCHIVES what comes back (source
 * `long_evicted`) — after the save is confirmed, so a /forget racing the write cannot leave the
 * user's evicted lines sitting in an archive.
 *
 * Gives up rather than break its guarantees: if the only lines left are the identity section and the
 * provenance line, the document stays over budget and nothing is evicted. Over budget still renders
 * (the budget is well under `MEMORY_LONG_MAX_CHARS`); a missing identity does not recover.
 */
export function evictOldest(doc: string): {
  doc: string;
  evicted: Array<{ section: string; text: string; since: string | null }>;
} {
  const evicted: Array<{ section: string; text: string; since: string | null }> = [];
  if (!doc.trim() || overCap(doc) === null) return { doc, evicted };

  const sections = parseSections(doc);
  while (overCap(renderSections(sections)) !== null) {
    const next = nextEviction(sections);
    if (!next) break;
    const { body, since } = splitStamp(next.section.lines[next.index]);
    evicted.push({
      section: next.section.heading ?? '',
      text: body.replace(/^\s*[-*+]\s+/, '').trim(),
      since,
    });
    next.section.lines.splice(next.index, 1);
  }
  if (!evicted.length) return { doc, evicted };
  return { doc: renderSections(sections), evicted };
}

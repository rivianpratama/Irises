// The turn relevance router — ONE verdict per turn, read by every memory gate and by the block that
// says what the turn is about.
//
// Before this, "does what they just said touch this?" was asked in exactly one place in the memory
// stack (the short tier's hot-look gate, wrappers.ts) and nowhere else: notes, facts, directives,
// email flags and the long doc all rendered in full on every turn regardless of the message. The
// gates that P2 adds all need the same answer, and the turn-focus block needs the answer WITH the
// evidence attached ("here is what touches this, and nothing else does"). Computing it once, in one
// pure place, is what stops a gate per block drifting apart on what "about the same thing" means.
//
// Two answers, deliberately pulling opposite ways on the same edge case:
//
//   • `touches(...)` is the GATE. It delegates to `touchesTurn` (topicality.ts) and takes the
//     caller's `whenEmpty` — so a turn the router could not read (a caption-less media turn, a bare
//     "ok thanks") fails OPEN for the memory stack and never loses a held entry over an ack.
//   • `hits` is the EVIDENCE. It requires a real shared salient token, always. A turn with no
//     tokens produces NO hits, because naming a held thing the router cannot show touches anything
//     is exactly the memory dump the turn-focus block exists to counter.
//
// PURE by construction: no clock, no DB, no I/O, no LLM, no env read on the build path. The one env
// read is the feature flag at the bottom, which gates whether callers BUILD a router at all. It
// reuses the repo's existing primitives rather than inventing a second notion of similarity:
// `salientTokens`/`touchesTurn` (topicality.ts) for the yes/no, `tokenSet`/`simScore` (textSim.ts)
// for the tie-break, `classifyTurnShape` (convo/turnFocus.ts) for the shape.

import { salientTokens, touchesTurn } from './topicality.js';
import { simScore, tokenSet } from './textSim.js';
import { classifyTurnShape, TURN_FOCUS_LABEL_CHARS, type TurnShape } from '../agents/convo/turnFocus.js';
import type { ShortTermEntry } from '../db/repositories/memoryShort.js';
import type { MediumBundle } from './mediumTerm.js';

/**
 * Which held channel a hit came off. Single-sourced array → type (the THEME_KINDS pattern), and the
 * ORDER is load-bearing: it is the last tie-break between two hits that share the same score and
 * the same overlap, best evidence first. A look already delivered this session beats a durable fact
 * about their world, which beats a section of narrative profile.
 *
 * `thread` is produced by `threadHit` rather than by the router's own pass — see there.
 */
export const RELEVANCE_HIT_KINDS = ['thread', 'research', 'email', 'note', 'fact', 'directive', 'long'] as const;
export type RelevanceHitKind = typeof RELEVANCE_HIT_KINDS[number];

/** One held thing that touches this turn. */
export interface RelevanceHit {
  kind: RelevanceHitKind;
  /** What to CALL it, the way a person would: their own words for the thing. Rendered by the
   *  turn-focus block, which clips and flattens it, and carried into the turn receipt. */
  label: string;
  /** How many of the turn's salient tokens this candidate shares. Always ≥1 for a real hit. */
  score: number;
  /** Which held item this is, within its channel: the short-tier row id, the fact key, the
   *  directive id, the long section's heading, `note:<index>` for a note (notes are stored as bare
   *  strings and have no id). Stable enough to dedupe by and to trace a hit back to its row. */
  source: string;
}

/** What the memory loaders already fetched, as they fetched it — nothing here is re-read. The long
 *  doc arrives already split on its headings (`splitSections`, wrappers.ts) because that is the
 *  granularity Task 11's gate keeps or collapses. Every field is optional: a caller with no medium
 *  bundle passes none rather than a fake empty one. */
export interface HeldItems {
  short?: readonly ShortTermEntry[];
  medium?: MediumBundle | null;
  longSections?: readonly string[];
}

/** The turn, as everything downstream reads it. */
export interface TurnRelevance {
  /** The turn's salient tokens (topicality.ts). Empty means "nothing to compare" — see the header. */
  tokens: Set<string>;
  /** What the message IS, classified in code (convo/turnFocus.ts). */
  shape: TurnShape;
  /** Held things that touch it, best first, capped at RELEVANCE_HITS_MAX. */
  hits: RelevanceHit[];
  /** The gate. `whenEmpty` decides the answer when the turn has no salient tokens. */
  touches(candidateText: string, whenEmpty: 'touch' | 'no_touch'): boolean;
}

/**
 * How many hits survive. The turn-focus block prints only TURN_FOCUS_MAX_HITS of them; this larger
 * number is what the turn receipt carries, and it exists because that receipt persists for 30 days
 * (diagnostics/turnTrace.ts) — an unbounded list of labels off a 40-note bundle is a storage leak,
 * not a diagnostic.
 */
export const RELEVANCE_HITS_MAX = 8;

// ── naming and matching a short-tier row ─────────────────────────────────────
// These two live here, beside the router that needs them, and wrappers.ts imports them back (its
// `topicallyRelated` is the original of this logic and the historical home of the label). One
// implementation, so the hot-look GATE and the research HIT can never disagree about what a look is
// about or what to call it.

/** The entry's stored topic key, when it has a readable one. */
function entryTopicKey(entry: ShortTermEntry): string {
  const raw = (entry.meta as { topicKey?: unknown } | undefined)?.topicKey;
  return typeof raw === 'string' ? raw : '';
}

/** What to CALL a short-tier row in one line: what they asked for, which is how a person would name
 *  it, falling back to the stored topic key and then to nothing at all. '' means "no name", and a
 *  hit with no name is dropped rather than rendered blank. */
export function shortEntryLabel(entry: ShortTermEntry): string {
  return (entry.request ?? '').trim() || entryTopicKey(entry).trim();
}

/** The text a short-tier row is MATCHED by: the ASK (what they wanted) plus the stored topic key —
 *  never the result body. A delivered answer shares tokens with half the language, so matching on it
 *  would make every held look touch every turn, which is the re-recitation hazard the short tier is
 *  already structured to avoid. */
export function shortEntryAsk(entry: ShortTermEntry): string {
  return `${entry.request ?? ''} ${entryTopicKey(entry)}`;
}

// ── the candidates ───────────────────────────────────────────────────────────

/** A held thing, ready to be scored: what to call it, what to match it by, and where it came from. */
interface Candidate {
  kind: RelevanceHitKind;
  label: string;
  text: string;
  source: string;
}

const KIND_RANK: Record<RelevanceHitKind, number> = Object.fromEntries(
  RELEVANCE_HIT_KINDS.map((k, i) => [k, i]),
) as Record<RelevanceHitKind, number>;

/** A markdown section's own name: its heading, stripped of the `#`s and any trailing colon. Falls
 *  back to the section's first line, because `splitSections` keeps the pre-heading preamble as a
 *  section of its own. */
function sectionHeading(section: string): string {
  const first = (section.split('\n').find(l => l.trim()) ?? '').trim();
  return first.replace(/^#{1,6}\s*/, '').replace(/:$/, '').trim();
}

/** Every held thing this turn could touch, in the vocabulary's own order. */
function collect(held: HeldItems): Candidate[] {
  const out: Candidate[] = [];

  for (const e of held.short ?? []) {
    if (e.kind === 'email_flag') {
      // Matched by the ask too — subject and sender, not the judge's summary body (same reasoning
      // as shortEntryAsk). Task 11 owns whether an email flag RENDERS; this only names it.
      const meta = (e.meta ?? {}) as { from?: unknown; subject?: unknown };
      const subject = typeof meta.subject === 'string' ? meta.subject : '';
      const from = typeof meta.from === 'string' ? meta.from : '';
      out.push({ kind: 'email', label: shortEntryLabel(e) || subject.trim(), text: `${shortEntryAsk(e)} ${subject} ${from}`, source: e.id });
    } else {
      // Named whether the row rendered in full or collapsed to its digest line — the digest carries
      // the ask ("they asked X → …"), so she can see the thing the hit names either way.
      out.push({ kind: 'research', label: shortEntryLabel(e), text: shortEntryAsk(e), source: e.id });
    }
  }

  const notes = held.medium?.notes ?? [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (typeof note !== 'string') continue;
    out.push({ kind: 'note', label: note, text: note, source: `note:${i}` });
  }

  for (const [key, value] of Object.entries(held.medium?.facts ?? {})) {
    if (!value) continue;
    // The key is humanized the way renderFactsBlock renders it, so a hit names the line the model
    // can actually see rather than a slot name only the code uses.
    const human = key.replace(/_/g, ' ');
    out.push({ kind: 'fact', label: `${human}: ${value}`, text: `${human} ${value}`, source: key });
  }

  for (const d of held.medium?.directives ?? []) {
    if (!d || typeof d.text !== 'string') continue;
    out.push({ kind: 'directive', label: d.text, text: d.text, source: d.id });
  }

  const sections = held.longSections ?? [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (typeof section !== 'string') continue;
    const heading = sectionHeading(section);
    out.push({ kind: 'long', label: heading, text: section, source: heading || `long:${i}` });
  }

  return out;
}

// ── the router ───────────────────────────────────────────────────────────────

/**
 * A label, as it will be seen: flattened to one line and clipped to exactly what the turn-focus
 * block renders (TURN_FOCUS_LABEL_CHARS, and the same clip shape, so the block's own clip is a
 * no-op on it). Two reasons it happens HERE rather than only at the render:
 *   • a note, a fact or a directive is the user's own stored text with no length contract, and the
 *     receipt these hits travel on persists for 30 days (diagnostics/turnTrace.ts) — a 40-note
 *     bundle must not be able to put 40 note bodies into that store;
 *   • so the receipt says exactly what the model was shown, not a longer version of it.
 */
function displayLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= TURN_FOCUS_LABEL_CHARS ? flat : `${flat.slice(0, TURN_FOCUS_LABEL_CHARS - 1)}…`;
}

/** How many of the turn's tokens a candidate shares. */
function sharedTokens(turnTokens: Set<string>, candidateText: string): number {
  const candidate = salientTokens(candidateText);
  let n = 0;
  for (const t of turnTokens) if (candidate.has(t)) n++;
  return n;
}

/**
 * The turn's one relevance verdict. PURE: it reads the text and the held items it is given, mutates
 * neither, reads no clock and no store.
 *
 * Ranking, in order: shared-token count, then overlap (`simScore`'s jaccard with containment
 * breaking ties — the same arithmetic the thread engine's own matcher ranks by, reached through the
 * shared primitive because that matcher is private to persona/threads.ts and gated on a threshold
 * this does not want), then the channel's position in RELEVANCE_HIT_KINDS. Deterministic, and
 * independent of the order the loaders happened to return rows in.
 */
export function buildTurnRelevance(turnText: string | undefined, held: HeldItems): TurnRelevance {
  const tokens = salientTokens(turnText ?? '');
  const shape = classifyTurnShape(turnText ?? '');

  const scored: Array<{ hit: RelevanceHit; overlap: number; rank: number }> = [];
  if (tokens.size) {
    const probe = tokenSet(turnText ?? '');
    for (const c of collect(held)) {
      const label = displayLabel(c.label);
      if (!label) continue;                        // a hit with no name is not evidence
      const score = sharedTokens(tokens, c.text);
      if (!score) continue;                        // evidence needs a real shared token
      const { jaccard, containment } = simScore(probe, tokenSet(c.text));
      scored.push({
        hit: { kind: c.kind, label, score, source: c.source },
        overlap: jaccard * 1000 + containment,
        rank: KIND_RANK[c.kind],
      });
    }
    scored.sort((a, b) => b.hit.score - a.hit.score || b.overlap - a.overlap || a.rank - b.rank);
  }

  return {
    tokens,
    shape,
    hits: scored.slice(0, RELEVANCE_HITS_MAX).map(s => s.hit),
    // The raw text, not a normalized copy: this has to answer exactly what `topicallyRelated`
    // answers for the same turn, or the gate it replaces would shift under it.
    touches: (candidateText, whenEmpty) => touchesTurn(turnText, candidateText, { whenEmpty }),
  };
}

/**
 * The standing thread this turn offered, as a hit.
 *
 * It arrives through its own door because of the turn's verified sequencing (convo/client.ts): the
 * memory reads — and therefore the router — run inside a `Promise.all` BEFORE the thread engine
 * picks an offer, so the offer cannot ride in the router's own pass. It is scored against the same
 * tokens so it sits beside the memory hits comparably, and it is never score-GATED: a loop is
 * offered precisely when it is NOT the current topic (persona/threads.ts inverts the check there on
 * purpose), and what she was handed has to be shown as what she was handed.
 */
export function threadHit(turn: TurnRelevance, label: string): RelevanceHit {
  const clean = displayLabel(label);
  return { kind: 'thread', label: clean, score: sharedTokens(turn.tokens, clean), source: clean };
}

/**
 * The feature gate (env: CONVO_MEMORY_RELEVANCE). Default ON, read at CALL time so flipping it
 * needs no restart — the same parse shape as every sibling flag (threadingEnabled,
 * themeTopicGateEnabled, turnFocusBlockEnabled, turnTraceEnabled).
 *
 * Off means the router is never BUILT: the memory stack runs its pre-P2 path (the short tier's own
 * `topicallyRelated` gate and nothing else), the turn-focus block falls back to its two-source stub,
 * and the assembled prompt is byte-identical to an install that never had this. The same switch
 * carries P2's later parts (the gate table, the identity card), so one flip reverts the phase.
 */
export function memoryRelevanceEnabled(): boolean {
  const v = (process.env.CONVO_MEMORY_RELEVANCE || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

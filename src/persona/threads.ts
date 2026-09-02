// Conversational THREADING: the two materials a conversation is woven out of, and — from phase C —
// the pure engine that decides what, if anything, is worth offering back on this turn.
//
// Two materials, deliberately not one, because they fail in opposite directions:
//   • an OPEN LOOP is a pending outcome in their life with a how-did-it-go attached (an interview,
//     a surgery, a launch, a dreaded talk). It buys CONTINUITY, it is cheap to be wrong about — the
//     worst case is a plainly-asked question about something already settled — and so ONE mention
//     mints it. The failure mode of loops is never asking, not asking at a slightly wrong moment.
//   • a THEME is something that recurs in them (a value, a tension, a goal, a phrase they coined).
//     It buys INTIMACY, it is expensive to be wrong about — a mis-tagged pattern is a stranger
//     telling you who you are — and so it takes evidence on two distinct days before it may ever
//     be named out loud, and a single pushback puts it away.
// Only themes and she reads as a mind-reader; only facts and she reads as a filing system.
//
// Doctrine, inherited whole from the affect/climate stack next door: the model suggests inside the
// envelope it already emits; code owns every count, transition, and budget; the prompt receives a
// numberless block that is byte-inert at default. Nothing in this feature costs a new LLM call —
// capture rides the hidden `status` envelope the convo model already emits, and everything below
// is arithmetic over a stored row.
//
// THIS FILE holds types, defaults, caps, and the whole ENGINE — `applyThreadHarvest`,
// `selectThreadCandidate`, `renderThreadForPrompt` — and the engine is PURE the same way
// climate.ts's `applyDrift` is: `now` injected, inputs never mutated, every candidate that vanished
// accounted for by exactly one disjoint report value. No clock read, no DB, no LLM, anywhere below.

// How a delivered thread landed, straight from the emitted envelope — ONE union, declared where the
// schema declares it (status.ts's `thread_outcome`) and re-exported here so the store and the engine
// import it from the module they already depend on. Never redeclared: a new outcome word must not be
// able to mean one thing to the schema and another to the row it is written into.
import type { AffectStatus, ThreadOutcome } from './status.js';
import { sanitizeThreadText } from './status.js';
import { simScore, tokenSet } from '../memory/textSim.js';
import { touchesTurn } from '../memory/topicality.js';
export type { ThreadOutcome };

/** How a theme was tagged by the model. `pattern` is the unprefixed fallback — she noticed a shape
 *  she can't name more precisely, which is a perfectly ordinary thing to notice. */
export type ThemeKind = 'value' | 'tension' | 'goal' | 'phrase' | 'pattern';

/** The same union at runtime, and the ONE source of truth for it: the note grammar below builds its
 *  prefix alternation out of this array, and the store validates rows against it. A sixth kind added
 *  to the type would otherwise be a kind the model may emit, the store may accept, and the grammar
 *  would silently route to `pattern`. (status.ts's INTENT_MODES / THREAD_OUTCOMES precedent: the
 *  runtime list lives beside the type it describes.) */
export const THEME_KINDS: readonly ThemeKind[] = ['value', 'tension', 'goal', 'phrase', 'pattern'];

/**
 * A theme's life, and it is COMPOUND rather than terminal — a theme can come back:
 *   • `open`      — minted, seen once, never surfaceable. Most themes live and die here.
 *   • `taggable`  — evidence on ≥2 distinct UTC days. Only now may it ever be said out loud.
 *   • `shorthand` — they picked it up enough times that the label is shared language; it can ride
 *                   bare, in a couple of words.
 *   • `sore`      — they pushed back. Put away, not deleted; the only exit is fresh evidence at
 *                   least 14 days later, which is them reopening it, not her retrying.
 *   • `retired`   — pushed back twice. A tombstone: it is kept precisely so the same bad guess is
 *                   never made a third time.
 */
export type ThemeStatus = 'open' | 'taggable' | 'shorthand' | 'sore' | 'retired';

/** A recurring thing about this person. `label`/`note` are model-authored and sanitized upstream;
 *  `note` holds the NEWEST paraphrase, which is where a pushback's correction lands. */
export interface ThreadTheme {
  id: string;
  label: string;
  kind: ThemeKind;
  note: string;
  /** The distinct UTC day stamps this was evidenced on. A CLOCK, not a counter — this is what makes
   *  the second-mention rule un-gameable by repeating yourself inside one conversation. */
  evidenceDays: number[];
  evidenceCount: number;
  status: ThemeStatus;
  /** 0-100. Ranks candidates; never printed, never shown to the model. */
  confidence: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** When it was last put in front of the model — the cooldown clock. Billed on the OFFER, not on
   *  her using it, so a model that ignores every suggestion still spends the budget. */
  lastOfferedAt: number;
  /** When an offer was actually consumed (an outcome came back for it). */
  lastTaggedAt: number;
  lastOutcome: ThreadOutcome | null;
  soreAt: number;
  uptakes: number;
  passes: number;
  pushbacks: number;
  /** Minted while they were distressed. Permanently pins the theme to the lowest rung: a pattern
   *  first noticed in someone's worst hour is the last one to earn being named. */
  mintedDistressed: boolean;
}

/** A loop's life, and it is TERMINAL — a loop resolves or expires, and is then pruned. Nothing
 *  brings a closed loop back; the next mention is simply a new loop. */
export type LoopStatus = 'open' | 'asked' | 'resolved' | 'expired';

/** Something pending in their life. No confidence anywhere in this class on purpose: there is
 *  nothing to be uncertain ABOUT — either they mentioned a thing with an outcome coming, or they
 *  didn't. Certainty is a theme's problem. */
export interface OpenLoop {
  id: string;
  label: string;
  note: string;
  status: LoopStatus;
  capturedAt: number;
  lastSeenAt: number;
  offeredAt: number;
  askedAt: number;
  resolvedAt: number;
  /** Waved off this many times. Twice is an answer: stop asking. */
  passes: number;
}

/** Which of the two materials an offer was made out of. The budgets are split by it, so a chatty
 *  week of themes can never eat the two loop questions a person actually wanted asked. */
export type ThreadMaterial = 'loop' | 'theme';

/** One billed surfacing, kept only long enough to enforce the rolling day caps (pruned past 7d).
 *  `themeId` carries a loop id when `material` is `'loop'` — one ledger, both materials. */
export interface ThreadOffer {
  at: number;
  themeId: string;
  material: ThreadMaterial;
}

/**
 * The anti-inflation core: what code OFFERED and is still waiting to hear about. At most one thing
 * is ever in flight, globally, across both materials.
 *   • `offered`  — put in front of the model this turn. An outcome arriving now is `premature`:
 *                  she cannot yet know how something landed that she has not said.
 *   • `awaiting` — the turn after, when the outcome-ask block is rendered and an outcome may be
 *                  consumed exactly once.
 * An outcome with no pending offer is `orphaned` and dropped — the model does not get to report on
 * a tag code never asked it to make.
 */
export interface PendingOffer {
  themeId: string;
  at: number;
  phase: 'offered' | 'awaiting';
  material: ThreadMaterial;
}

/** Everything held about one memory identity's threads — the whole persisted row, parsed. */
export interface ThreadInventory {
  themes: ThreadTheme[];
  loops: OpenLoop[];
  offers: ThreadOffer[];
  pending: PendingOffer | null;
  /** One shared counter across both materials; ANY offer resets it. This is the 70-80%-of-turns-say-
   *  nothing law written as arithmetic instead of as a request in a prompt. */
  turnsSinceOffer: number;
  lastHarvestAt: number;
  /** Turns harvested for this handle, ever. The TENURE proxy the rung ceiling reads — deliberately
   *  NOT climate's evalCount, which would couple two features that must stay independently
   *  flaggable. */
  harvestCount: number;
  lastPingAt: number;
}

/** Nothing held yet: the state every unknown handle reads back as, and the one that renders not a
 *  single byte into the prompt. */
export function defaultThreadInventory(): ThreadInventory {
  return {
    themes: [],
    loops: [],
    offers: [],
    pending: null,
    turnsSinceOffer: 0,
    lastHarvestAt: 0,
    harvestCount: 0,
    lastPingAt: 0,
  };
}

// ── Caps ─────────────────────────────────────────────────────────────────────────────
// Charter §10.1 ("back unrecoverable rules with code"): these are the hard bounds on how much of a
// person the inventory may ever hold. They are enforced by the engine (phase C), never by the
// store, because the EVICTION ORDER is itself load-bearing — see below.

/** Live themes. Past this, the engine evicts retired → open → taggable, oldest first, and NEVER a
 *  shorthand or a sore one: shorthand is shared language she would be dropping mid-sentence, and a
 *  sore theme's row IS the tombstone that stops the same bad guess being made twice. Sixteen is
 *  more standing patterns than a person has; a bigger number would only buy noise to rank. */
export const MAX_THEMES = 16;

/** Live loops. Eight is already more pending things than most people have in flight at once, and
 *  the engine evicts resolved/expired first, so a real backlog costs nothing. */
export const MAX_LOOPS = 8;

/** New themes minted per UTC day. The insistence guard: one dense, feelings-heavy conversation
 *  cannot repopulate the inventory with a dozen guesses that then compete for airtime for weeks. */
export const NEW_THEMES_DAY_CAP = 3;

/** New loops minted per UTC day. Same reasoning, and loops mint on ONE mention, so the day cap is
 *  the only thing standing between a plan-heavy conversation and eight fresh questions to ask. */
export const NEW_LOOPS_DAY_CAP = 3;

// ── Clocks, budgets, and steps ───────────────────────────────────────────────────────
// Every number the engine reads is here, exported, with the reason it is that number. Nothing below
// consults the wall clock: durations are compared against the `now` the caller injects.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One UTC day stamp. The second-mention rule is a CLOCK, not a counter, and this is the clock: two
 *  mentions inside one long night are one day's worth of evidence, however insistent the night. */
export function utcDay(at: number): number {
  return Math.floor(at / DAY);
}

/** Turns of silence a THEME offer costs. The 70-80%-of-turns-say-nothing law written as arithmetic
 *  instead of as a request in a prompt — and one shared counter across both materials, so a loop
 *  question also buys the quiet that follows it. */
export const THREAD_MIN_TURNS_BETWEEN_OFFERS = 4;

/** The same gate for LOOPS, and deliberately shorter. A pending-outcome question is the cheap,
 *  plainly-asked move whose failure mode is never asking at all; it does not need a theme's runway. */
export const LOOP_MIN_TURNS_BETWEEN_OFFERS = 2;

/** Theme offers billed per rolling 24h. Six is generous as a CEILING and unreachable in practice
 *  (the turn gate alone needs 24 turns to spend it) — it exists to bound a marathon day, not to pace
 *  a normal one. */
export const THREAD_OFFER_DAY_CAP = 6;

/** Loop offers per rolling 24h. Two, because a third "how did X go?" in a day stops reading as care
 *  and starts reading as a checklist being worked. */
export const LOOP_OFFER_DAY_CAP = 2;

/** The rolling window both day caps are measured over. */
export const OFFER_WINDOW_MS = 24 * HOUR;

/** How long an offer stays in the ledger. The day caps only ever look back 24h; the extra days are
 *  kept for the receipts, and pruned so the row cannot grow without bound. */
export const THREAD_OFFER_PRUNE_MS = 7 * DAY;

/** Defensive ceiling on the ledger array, exactly CLIMATE_MOVES_CAP's reasoning: the prune already
 *  bounds it, this bounds a clock that jumped backwards or a row hand-edited into nonsense. */
export const THREAD_OFFERS_CAP = 64;

/** Past this, the last affect record is not evidence about THIS turn. An `intent_mode` from
 *  yesterday morning must not close the theme gate on tonight's conversation — and a stale gauge
 *  reading is exactly the kind of thing that would quietly disable a feature forever. */
export const AFFECT_FRESH_MS = 6 * HOUR;

/** The opening slot a loop question needs: this much silence before the incoming message. A loop
 *  callback is the persona's ONE sanctioned reopening move ("Time is real"), and mid-conversation it
 *  reads as list-working — she is answering something and then produces a stored question. */
export const LOOP_OPENING_GAP_MS = 4 * HOUR;

/** A loop must have been quiet this long — since BOTH its capture and its last mention — before it
 *  may be asked about. Asking how something went while they are still telling you about it is the
 *  one way the cheap question stops being cheap. */
export const LOOP_QUIET_MS = 36 * HOUR;

/** Per-loop offer cooldown. Offered and not taken up? Three days before it may be put forward again. */
export const LOOP_OFFER_COOLDOWN_MS = 72 * HOUR;

/** Quiet this long and a loop is over, whatever happened. Three weeks without a single mention means
 *  either it resolved without her or it never mattered; both make the question stale rather than warm. */
export const LOOP_EXPIRY_MS = 21 * DAY;

/** After she asked and they took it, a week with nothing further settles the loop `resolved` — the
 *  conversation happened. There is no outcome recorded because there is nothing left to ask. */
export const LOOP_ASKED_SETTLE_MS = 7 * DAY;

/** How long a terminal (resolved/expired) loop lingers before it is pruned out of the row. Long
 *  enough for the receipts to explain the last week, short enough that the row stays small. */
export const LOOP_PRUNE_MS = 7 * DAY;

/** Waved off this many times and a loop is done. Twice IS an answer. */
export const LOOP_MAX_PASSES = 2;

/** A theme unseen this long is not offered. Selection-time only — no stored decay anywhere, because
 *  a theme that goes quiet for two months and comes back is the same theme, at the same confidence. */
export const THEME_RECENCY_MS = 45 * DAY;

/** Shorthand gets twice the runway: shared language does not go stale the way a guessed pattern
 *  does, and a coinage they still use after two months is worth exactly as much as it was. */
export const SHORTHAND_RECENCY_MS = 90 * DAY;

/** Per-theme offer cooldowns, by how the LAST offer of that theme landed. `took` is short (it
 *  worked), `passed` is long (they let it lie — asking again in two days is not letting it lie),
 *  `none` sits between (offered, never actually said), and shorthand is shortest of all because it
 *  is a couple of words of shared language rather than a claim about them. */
export const THEME_COOLDOWN_SHORTHAND_MS = 24 * HOUR;
export const THEME_COOLDOWN_TOOK_MS = 72 * HOUR;
export const THEME_COOLDOWN_PASSED_MS = 10 * DAY;
export const THEME_COOLDOWN_NONE_MS = 48 * HOUR;

/** A minted theme's confidence: one mention is a guess. */
export const THEME_MINT_CONFIDENCE = 25;
/** A consumed `took`. The only thing that earns real confidence, and the only route to shorthand. */
export const THEME_CONF_TOOK = 15;
export const THEME_CONF_CEILING = 95;
/** A `passed` costs almost nothing — letting a tag lie is the NORMAL response to one, not a verdict. */
export const THEME_CONF_PASSED = 5;
export const THEME_CONF_PASSED_FLOOR = 20;
/** A `pushed_back` costs six times a pass. Being told "that's not me" is real evidence; being met
 *  with silence is not. */
export const THEME_CONF_PUSHED_BACK = 30;
export const THEME_CONF_PUSHED_BACK_FLOOR = 5;
/** What a fresh day of evidence adds, and the ceiling it may never push past. Evidence alone can
 *  make a theme rankable; only a consumed `took` can make it CONFIDENT. */
export const THEME_CONF_EVIDENCE = 10;
export const THEME_CONF_EVIDENCE_CEILING = 60;
/** Graduation to shorthand: three separate times they picked it up, at high confidence. */
export const THEME_SHORTHAND_UPTAKES = 3;
export const THEME_SHORTHAND_CONFIDENCE = 75;
/** Two pushbacks retire a theme permanently. The row stays as the tombstone. */
export const THEME_RETIRE_PUSHBACKS = 2;
/** The only exit from `sore`: fresh evidence at least this long after the pushback, which is THEM
 *  reopening it rather than her retrying. */
export const THEME_SORE_REOPEN_MS = 14 * DAY;
/** Ranking bonus for shared language over a guessed pattern. */
export const THEME_SHORTHAND_RANK_BONUS = 15;
/** Turns harvested before the `pattern` rung unlocks at all — the TENURE proxy. Deliberately not
 *  climate's evalCount, which would couple two features that must stay independently flaggable. */
export const THREAD_TENURE_TURNS = 60;

/** Distinct evidence days kept per theme. The flip reads `evidenceCount`, the same-day guard only
 *  ever needs today, so a decade of stamps buys nothing but row size. */
export const THEME_EVIDENCE_DAYS_CAP = 32;

/** Label cap, and the note cap the sanitizer is handed. A thread is a phrase, not a paragraph. */
export const THREAD_LABEL_MAX = 60;
export const THREAD_NOTE_MAX = 200;

/** Match thresholds for "is this the thing I already hold?" — jaccard OR containment, either alone
 *  is enough (see textSim.ts for why each is blind without the other). These are the ENGINE's own
 *  constants, deliberately set to the same values the note groomer uses and deliberately not shared
 *  with it: the groomer's thresholds decide whether to spend an LLM call on a merge, these decide
 *  whether a person's new sentence is the old one. Same number today, free to diverge tomorrow. */
export const THREAD_SIM_MIN = 0.34;
export const THREAD_CONTAINMENT_MIN = 0.6;

// ── The note grammar ─────────────────────────────────────────────────────────────────

/** Which of the three things a `thread_note` was: a pending thing, a pending thing CLOSING, or a
 *  recurring theme. Prefix-routed, because the model picks the route by typing one word. */
export type ThreadNoteRoute = 'loop' | 'resolved' | 'theme';

export interface ParsedThreadNote {
  route: ThreadNoteRoute;
  /** Only meaningful when `route === 'theme'`. Loop/resolved notes carry `pattern` as an inert
   *  filler — a loop has no kind, and inventing a nullable field for it would spread the null. */
  kind: ThemeKind;
  label: string;
  body: string;
}

/** The grammar, built from THEME_KINDS so the two can never disagree about what `goal:` means.
 *  `pattern` is excluded as a PREFIX on purpose: it is the unprefixed fallback, and offering it as a
 *  word to type would invite "pattern: <thing they claim about themselves>". */
export const THREAD_NOTE_PREFIX_RE = new RegExp(
  `^(loop|resolved|${THEME_KINDS.filter(k => k !== 'pattern').join('|')})\\s*:\\s*(.+)$`,
  'i',
);

/**
 * Body → label. Two rules, in this order:
 *   • a ` — ` separator ends the label early. The model writes "speed vs craft — ships fast then
 *     hates the seams"; the label is the name of the thing, the rest is the note.
 *   • otherwise truncate at THREAD_LABEL_MAX on a WORD boundary, so a label never ends mid-word
 *     (it is quoted back inside a prompt block, and a severed word reads as a typo she made).
 */
function labelFrom(body: string): string {
  const dash = body.indexOf(' — ');
  const head = dash > 0 ? body.slice(0, dash) : body;
  if (head.length <= THREAD_LABEL_MAX) return head.trim();
  const cut = head.slice(0, THREAD_LABEL_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/**
 * One emitted `thread_note` → its route, its kind, its label, and its body. Pure string work; the
 * caller sanitizes first (this never sees a newline or a brace by the time it runs in anger).
 *
 * An unprefixed note is a `pattern` theme: she noticed a shape she cannot name more precisely, which
 * is an ordinary thing to notice and must not be lost just because she skipped the prefix.
 */
export function parseThreadNote(note: string): ParsedThreadNote {
  const m = THREAD_NOTE_PREFIX_RE.exec(note.trim());
  if (!m) {
    const body = note.trim();
    return { route: 'theme', kind: 'pattern', label: labelFrom(body), body };
  }
  const prefix = m[1].toLowerCase();
  const body = m[2].trim();
  const label = labelFrom(body);
  if (prefix === 'loop') return { route: 'loop', kind: 'pattern', label, body };
  if (prefix === 'resolved') return { route: 'resolved', kind: 'pattern', label, body };
  return { route: 'theme', kind: prefix as ThemeKind, label, body };
}

// ── Shared arithmetic ────────────────────────────────────────────────────────────────

/** Clamp-first steps, the applyDrift discipline: a value already past its floor is never LIFTED by a
 *  subtraction, and one already past its ceiling is never lowered by an addition. A theme sitting at
 *  confidence 12 that gets passed on stays at 12 — the floor is a floor, not a magnet. */
function stepUp(v: number, step: number, ceiling: number): number {
  return Math.min(Math.max(v, ceiling), v + step);
}
function stepDown(v: number, step: number, floor: number): number {
  return Math.max(Math.min(v, floor), v - step);
}

/** The one similarity verdict this engine ever makes: either measure clearing its own threshold is a
 *  match (see THREAD_SIM_MIN). Returns the score used for RANKING candidates, or null for no match. */
function matchScore(a: Set<string>, b: Set<string>): number | null {
  const { jaccard, containment } = simScore(a, b);
  if (jaccard >= THREAD_SIM_MIN || containment >= THREAD_CONTAINMENT_MIN) {
    // Ranked by jaccard with containment breaking ties: of two things that both "are" the note, the
    // one that overlaps it symmetrically is the better home for it.
    return jaccard * 1000 + containment;
  }
  return null;
}

/** The text a stored thread is matched BY: its label plus its note. The label alone is too short to
 *  score reliably, the note alone drifts as it is repeatedly overwritten with newer paraphrases. */
function matchText(t: { label: string; note: string }): string {
  return `${t.label} ${t.note}`;
}

/** Best match among `items`, or null. First index wins a perfect tie, so the result never depends on
 *  array order beyond "the one already there". */
function bestMatch<T extends { label: string; note: string }>(items: T[], body: string): T | null {
  const probe = tokenSet(body);
  let best: T | null = null;
  let bestScore = -1;
  for (const item of items) {
    const score = matchScore(probe, tokenSet(matchText(item)));
    if (score != null && score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

/** Offers inside the rolling 24h window, optionally for one material only. */
function offersInWindow(offers: ThreadOffer[], now: number, material?: ThreadMaterial): number {
  const from = now - OFFER_WINDOW_MS;
  let n = 0;
  for (const o of offers) if (o.at > from && (!material || o.material === material)) n++;
  return n;
}

/** Prune the ledger to the retention window and cap it. Both ends do this, so a select that never
 *  reaches a harvest (an offer on a turn whose harvest is fenced out) still leaves a bounded row. */
function pruneOffers(offers: ThreadOffer[], now: number): ThreadOffer[] {
  const kept = offers.filter(o => o.at > now - THREAD_OFFER_PRUNE_MS);
  return kept.length > THREAD_OFFERS_CAP ? kept.slice(kept.length - THREAD_OFFERS_CAP) : kept;
}

/** Deterministic ids. A pure function may not reach for randomUUID: the same (current, note, now)
 *  has to produce the same inventory, in tests and in a replay alike. `now` is unique per turn in
 *  practice; the suffix loop covers two harvests landing on the same millisecond. */
function mintId(prefix: string, now: number, taken: Set<string>): string {
  const base = `${prefix}-${now.toString(36)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── Harvest ──────────────────────────────────────────────────────────────────────────

/** Where the turn's note landed. Exactly one value per harvest, and every way a note can vanish has
 *  its own: a note that produced nothing must never be indistinguishable from no note at all. */
export type ThreadNoteResult =
  | 'none' | 'minted' | 'evidence' | 'same_day'
  | 'dropped_sanitize' | 'dropped_day_cap' | 'dropped_full'
  | 'loop_minted' | 'loop_refreshed' | 'loop_resolved' | 'resolve_unmatched'
  | 'dropped_loop_day_cap' | 'dropped_loops_full';

/** What became of the turn's `thread_outcome`. `premature`/`orphaned`/`expired_unused` are the three
 *  ways the pending machine refuses one; they are reported, never silently swallowed. */
export type ThreadOutcomeResult =
  | 'none' | 'took' | 'passed' | 'pushed_back'
  | 'orphaned' | 'premature' | 'expired_unused';

export interface ThreadHarvestReport {
  note: ThreadNoteResult;
  outcome: ThreadOutcomeResult;
  /** Every state change this harvest made, as short human strings for the receipt. */
  transitions: string[];
  /** The theme or loop the NOTE landed on (minted, evidenced, refreshed, resolved). */
  themeId?: string;
  label?: string;
  themeCount: number;
  taggableCount: number;
  shorthandCount: number;
  loopCount: number;
}

/**
 * Fold one turn's emitted material into the inventory. PURE: `current` is never mutated, and the
 * same (current, note, outcome, now, ctx) always yields the same result.
 *
 * The order below is load-bearing and runs exactly once per turn:
 *   1. TICK — the counters and the wall-clock transitions that happen whether or not the model said
 *      anything. A loop expires, settles, or is pruned on the clock alone.
 *   2. PENDING MACHINE — `offered` becomes `awaiting` (so an outcome arriving on the SAME turn as
 *      the offer is `premature`: she cannot know how something landed that she has not said yet);
 *      `awaiting` either consumes an outcome or clears as `expired_unused`.
 *   3. OUTCOME — fixed code steps, sign-only doctrine. The model reports which of three words; the
 *      magnitudes, floors, ceilings, and every status transition are here.
 *   4. NOTE — routed by grammar, matched against what is already held, minted under the day caps and
 *      the size caps.
 * Steps 3 and 4 are deliberately in that order: an outcome is feedback about the LAST turn, and a
 * pushback's correction should land on a theme that then receives this turn's note as its newest
 * paraphrase — not the other way round.
 */
export function applyThreadHarvest(
  current: ThreadInventory,
  note: string | null | undefined,
  outcome: ThreadOutcome | null | undefined,
  now: number,
  ctx?: { distressed?: boolean },
): { next: ThreadInventory; report: ThreadHarvestReport } {
  // One defensive copy, deep enough that nothing below can reach the caller's arrays.
  const themes: ThreadTheme[] = current.themes.map(t => ({ ...t, evidenceDays: [...t.evidenceDays] }));
  const loops: OpenLoop[] = current.loops.map(l => ({ ...l }));
  const offers = pruneOffers([...current.offers], now);
  let pending: PendingOffer | null = current.pending ? { ...current.pending } : null;
  const transitions: string[] = [];

  let noteResult: ThreadNoteResult = 'none';
  let outcomeResult: ThreadOutcomeResult = 'none';
  let touchedId: string | undefined;
  let touchedLabel: string | undefined;

  // ── 1. Tick ────────────────────────────────────────────────────────────────────────
  for (let i = loops.length - 1; i >= 0; i--) {
    const l = loops[i];
    if (l.status === 'resolved' || l.status === 'expired') {
      // `resolvedAt` doubles as the terminal stamp for both endings — the moment the loop left the
      // live set, whichever way it left it.
      if (l.resolvedAt > 0 && now - l.resolvedAt > LOOP_PRUNE_MS) {
        loops.splice(i, 1);
        transitions.push(`loop ${l.id} pruned`);
      }
      continue;
    }
    // The settle check runs BEFORE the quiet check: an asked loop that goes silent did not go stale,
    // it got its answer in the conversation she asked it in. `resolved` says that; `expired` doesn't.
    if (l.status === 'asked' && l.askedAt > 0 && now - l.askedAt > LOOP_ASKED_SETTLE_MS) {
      l.status = 'resolved';
      l.resolvedAt = now;
      transitions.push(`loop ${l.id} asked→resolved (settled)`);
      continue;
    }
    // Quiet is measured from the last thing that HAPPENED to the loop — being asked about counts,
    // or a loop asked about on its twentieth quiet day would expire two days later still unanswered.
    const lastTouch = Math.max(l.lastSeenAt, l.askedAt, l.capturedAt);
    if (now - lastTouch > LOOP_EXPIRY_MS) {
      const was = l.status;
      l.status = 'expired';
      l.resolvedAt = now;
      transitions.push(`loop ${l.id} ${was}→expired (quiet)`);
    }
  }

  // ── 2. Pending machine ─────────────────────────────────────────────────────────────
  let consume: PendingOffer | null = null;
  if (pending?.phase === 'offered') {
    pending = { ...pending, phase: 'awaiting' };
    transitions.push('pending offered→awaiting');
    if (outcome) outcomeResult = 'premature';
  } else if (pending?.phase === 'awaiting') {
    if (outcome) {
      consume = pending;
    } else {
      outcomeResult = 'expired_unused';
      transitions.push('pending awaiting→cleared (unused)');
    }
    pending = null;
  } else if (outcome) {
    // No offer was ever made, so there is nothing this could be feedback ABOUT. The model does not
    // get to report on a tag code never asked it to make.
    outcomeResult = 'orphaned';
  }

  // ── 3. Outcome consumption ─────────────────────────────────────────────────────────
  if (consume && outcome) {
    if (consume.material === 'theme') {
      const t = themes.find(x => x.id === consume!.themeId);
      if (!t) {
        // The theme was evicted while its offer was in flight. Nothing to apply it to.
        outcomeResult = 'orphaned';
      } else {
        outcomeResult = outcome;
        t.lastTaggedAt = now;
        t.lastOutcome = outcome;
        if (outcome === 'took') {
          t.confidence = stepUp(t.confidence, THEME_CONF_TOOK, THEME_CONF_CEILING);
          t.uptakes++;
          if (t.status === 'taggable'
            && t.uptakes >= THEME_SHORTHAND_UPTAKES
            && t.confidence >= THEME_SHORTHAND_CONFIDENCE) {
            t.status = 'shorthand';
            transitions.push(`theme ${t.id} taggable→shorthand`);
          }
        } else if (outcome === 'passed') {
          t.confidence = stepDown(t.confidence, THEME_CONF_PASSED, THEME_CONF_PASSED_FLOOR);
          t.passes++;
        } else {
          t.confidence = stepDown(t.confidence, THEME_CONF_PUSHED_BACK, THEME_CONF_PUSHED_BACK_FLOOR);
          t.pushbacks++;
          const was = t.status;
          if (t.pushbacks >= THEME_RETIRE_PUSHBACKS) {
            t.status = 'retired';
            transitions.push(`theme ${t.id} ${was}→retired (pushed back twice)`);
          } else {
            t.status = 'sore';
            t.soreAt = now;
            transitions.push(`theme ${t.id} ${was}→sore`);
          }
        }
      }
    } else {
      const l = loops.find(x => x.id === consume!.themeId);
      if (!l) {
        outcomeResult = 'orphaned';
      } else {
        outcomeResult = outcome;
        // No confidence arithmetic anywhere in the loop class: there is nothing to be uncertain
        // about. Either the question got an answer or it did not.
        if (outcome === 'took') {
          l.status = 'asked';
          l.askedAt = now;
          transitions.push(`loop ${l.id} open→asked`);
        } else if (outcome === 'passed') {
          l.passes++;
          if (l.passes >= LOOP_MAX_PASSES) {
            l.status = 'expired';
            l.resolvedAt = now;
            transitions.push(`loop ${l.id} open→expired (waved off twice)`);
          }
        } else {
          // Dropping it IS the repair. There is no sore state for a loop and no second try.
          l.status = 'expired';
          l.resolvedAt = now;
          transitions.push(`loop ${l.id} open→expired (pushed back)`);
        }
      }
    }
  }

  // ── 4. Note routing ────────────────────────────────────────────────────────────────
  const clean = note == null ? undefined : sanitizeThreadText(note, THREAD_NOTE_MAX);
  if (note != null && !clean) noteResult = 'dropped_sanitize';
  if (clean) {
    const parsed = parseThreadNote(clean);
    const today = utcDay(now);
    const takenIds = new Set<string>([...themes.map(t => t.id), ...loops.map(l => l.id)]);

    if (parsed.route === 'loop') {
      const live = loops.filter(l => l.status === 'open' || l.status === 'asked');
      const hit = bestMatch(live, parsed.body);
      if (hit) {
        hit.lastSeenAt = now;
        hit.note = parsed.body; // newest paraphrase — "moved to friday" is the truth now
        if (hit.status === 'asked') {
          hit.status = 'open';
          // askedAt is cleared with it: both the settle clock and the ping gate read that stamp, and
          // a loop they brought back up is a fresh open question, not one still waiting to settle.
          hit.askedAt = 0;
          transitions.push(`loop ${hit.id} asked→open (revived)`);
        }
        noteResult = 'loop_refreshed';
        touchedId = hit.id;
        touchedLabel = hit.label;
      } else if (loops.filter(l => utcDay(l.capturedAt) === today).length >= NEW_LOOPS_DAY_CAP) {
        noteResult = 'dropped_loop_day_cap';
      } else {
        const evicted = evictLoop(loops);
        if (!evicted && loops.length >= MAX_LOOPS) {
          noteResult = 'dropped_loops_full';
        } else {
          if (evicted) transitions.push(`loop ${evicted} evicted`);
          const id = mintId('lp', now, takenIds);
          loops.push({
            id, label: parsed.label, note: parsed.body, status: 'open',
            capturedAt: now, lastSeenAt: now, offeredAt: 0, askedAt: 0, resolvedAt: 0, passes: 0,
          });
          transitions.push(`loop ${id} minted`);
          noteResult = 'loop_minted';
          touchedId = id;
          touchedLabel = parsed.label;
        }
      }
    } else if (parsed.route === 'resolved') {
      const live = loops.filter(l => l.status === 'open' || l.status === 'asked');
      const hit = bestMatch(live, parsed.body);
      if (hit) {
        hit.status = 'resolved';
        hit.resolvedAt = now;
        hit.lastSeenAt = now;
        transitions.push(`loop ${hit.id} →resolved (note)`);
        noteResult = 'loop_resolved';
        touchedId = hit.id;
        touchedLabel = hit.label;
      } else {
        // A receipt-logged no-op, never a mutation: a resolution she cannot place must not invent
        // the thing it resolves, and must not be minted as a fresh loop either.
        noteResult = 'resolve_unmatched';
      }
    } else {
      // Themes match against everything except the tombstones — including `sore`, because fresh
      // evidence on a sore theme is the ONE thing that reopens it.
      const matchable = themes.filter(t => t.status !== 'retired');
      const hit = bestMatch(matchable, parsed.body);
      if (hit) {
        touchedId = hit.id;
        touchedLabel = hit.label;
        if (hit.evidenceDays.includes(today)) {
          // Insistence buys nothing — not a day, not a point of confidence, and not even a refreshed
          // recency stamp, which would be exactly the lever repetition is trying to pull.
          noteResult = 'same_day';
        } else {
          noteResult = 'evidence';
          hit.lastSeenAt = now;
          hit.note = parsed.body; // newest paraphrase: this is where a pushback's correction lands
          hit.evidenceDays = [...hit.evidenceDays, today].slice(-THEME_EVIDENCE_DAYS_CAP);
          hit.evidenceCount++;
          // Evidence lifts confidence only while nothing has ever been taken up: once outcomes are
          // scoring a theme, repetition must not top it back up underneath them.
          if (hit.uptakes === 0) {
            hit.confidence = stepUp(hit.confidence, THEME_CONF_EVIDENCE, THEME_CONF_EVIDENCE_CEILING);
          }
          if (hit.status === 'open' && hit.evidenceCount >= 2) {
            hit.status = 'taggable';
            transitions.push(`theme ${hit.id} open→taggable`);
          } else if (hit.status === 'sore' && now - hit.soreAt >= THEME_SORE_REOPEN_MS) {
            hit.status = 'taggable';
            transitions.push(`theme ${hit.id} sore→taggable (reopened)`);
          }
        }
      } else if (themes.filter(t => utcDay(t.firstSeenAt) === today).length >= NEW_THEMES_DAY_CAP) {
        noteResult = 'dropped_day_cap';
      } else {
        const evicted = evictTheme(themes);
        if (!evicted && themes.length >= MAX_THEMES) {
          noteResult = 'dropped_full';
        } else {
          if (evicted) transitions.push(`theme ${evicted} evicted`);
          const id = mintId('th', now, takenIds);
          themes.push({
            id, label: parsed.label, kind: parsed.kind, note: parsed.body,
            evidenceDays: [today], evidenceCount: 1, status: 'open',
            confidence: THEME_MINT_CONFIDENCE,
            firstSeenAt: now, lastSeenAt: now, lastOfferedAt: 0, lastTaggedAt: 0,
            lastOutcome: null, soreAt: 0, uptakes: 0, passes: 0, pushbacks: 0,
            mintedDistressed: ctx?.distressed === true,
          });
          transitions.push(`theme ${id} minted`);
          noteResult = 'minted';
          touchedId = id;
          touchedLabel = parsed.label;
        }
      }
    }
  }

  const next: ThreadInventory = {
    themes,
    loops,
    offers,
    pending,
    turnsSinceOffer: current.turnsSinceOffer + 1,
    lastHarvestAt: now,
    harvestCount: current.harvestCount + 1,
    lastPingAt: current.lastPingAt,
  };
  return {
    next,
    report: {
      note: noteResult,
      outcome: outcomeResult,
      transitions,
      ...(touchedId ? { themeId: touchedId } : {}),
      ...(touchedLabel ? { label: touchedLabel } : {}),
      themeCount: themes.length,
      taggableCount: themes.filter(t => t.status === 'taggable').length,
      shorthandCount: themes.filter(t => t.status === 'shorthand').length,
      loopCount: loops.length,
    },
  };
}

/**
 * Make room for one more theme, IN PLACE, returning the id evicted (or null when there was room, or
 * when nothing may be evicted). The order is the whole point:
 *   retired → open (lowest confidence, then oldest) → taggable (oldest)
 * and never a `shorthand` or a `sore` one. Shorthand is shared language she would be dropping
 * mid-sentence; a sore theme's row IS the tombstone that stops the same bad guess being made twice.
 * An inventory of sixteen shorthand-and-sore themes therefore evicts NOTHING and drops the new note.
 */
function evictTheme(themes: ThreadTheme[]): string | null {
  if (themes.length < MAX_THEMES) return null;
  const oldest = (pool: ThreadTheme[]) =>
    pool.reduce((a, b) => (b.lastSeenAt < a.lastSeenAt ? b : a));
  const retired = themes.filter(t => t.status === 'retired');
  const open = themes.filter(t => t.status === 'open');
  const taggable = themes.filter(t => t.status === 'taggable');
  let victim: ThreadTheme | null = null;
  if (retired.length) victim = oldest(retired);
  else if (open.length) {
    // Lowest confidence first among the open ones: they are all one-mention guesses, so the least
    // confident is the one whose loss costs least.
    victim = open.reduce((a, b) =>
      b.confidence < a.confidence || (b.confidence === a.confidence && b.lastSeenAt < a.lastSeenAt) ? b : a);
  } else if (taggable.length) victim = oldest(taggable);
  if (!victim) return null;
  themes.splice(themes.indexOf(victim), 1);
  return victim.id;
}

/**
 * Make room for one more loop, IN PLACE. Terminal loops go first (they are already over), then the
 * oldest OPEN one. An `asked` loop is never evicted: her question is out there and the answer needs
 * somewhere to land — eight loops all asked and none settled therefore drops the new note rather
 * than orphaning one of them.
 */
function evictLoop(loops: OpenLoop[]): string | null {
  if (loops.length < MAX_LOOPS) return null;
  const dead = loops.filter(l => l.status === 'resolved' || l.status === 'expired');
  const open = loops.filter(l => l.status === 'open');
  const pool = dead.length ? dead : open;
  if (!pool.length) return null;
  const victim = pool.reduce((a, b) => (b.capturedAt < a.capturedAt ? b : a));
  loops.splice(loops.indexOf(victim), 1);
  return victim.id;
}

// ── Selection ────────────────────────────────────────────────────────────────────────

/** How far up the ladder the winner may be delivered. Code only ever DROPS rungs — it can forbid a
 *  named pattern, never demand one. */
export type ThreadRung = 'fact' | 'pattern' | 'shorthand';

export interface ThreadCandidate {
  material: ThreadMaterial;
  rungCeiling: ThreadRung;
  label: string;
  note: string;
  /** Themes only. */
  kind?: ThemeKind;
  id: string;
}

/** The subset of the last-turn affect record selection reads. Deliberately narrow and structural:
 *  an AffectStatus satisfies it, and a test fixture does not have to invent twenty gauges to say
 *  "they were venting an hour ago". */
export type ThreadAffect = Pick<AffectStatus, 'intent_mode' | 'mood_level' | 'terminal_closure' | 'at'>;

/** The intent modes that close the theme gate. All four are states where a tag would land as being
 *  told who you are while you are busy being someone — and all four are checked against status.ts's
 *  INTENT_MODES, which is where they are declared. */
export const THREAD_BLOCKING_MODES: readonly AffectStatus['intent_mode'][] = [
  'venting', 'overwhelmed', 'confused', 'deflecting',
];

/** The mood floor. Below this the theme gate is closed regardless of mode: a low enough valence is
 *  its own answer about whether now is the time to notice a pattern in someone. */
export const THREAD_MOOD_FLOOR = 35;

export interface ThreadSelectReport {
  reason:
    | 'awaiting_outcome' | 'empty' | 'mode' | 'mood' | 'turn_gate' | 'day_cap'
    | 'no_eligible' | 'offered_loop' | 'offered_theme';
  /** Every candidate that vanished, in exactly one bucket. The healthy no-op IS the receipt, so a
   *  quiet turn has to be able to say WHY it was quiet. */
  filtered: {
    loops: { quiet: number; cooldown: number; present_topic: number; no_opening: number; asked: number; budget: number };
    /** `off_topic` is the theme stage's mirror of `loops.present_topic`, and it points the OTHER
     *  way on purpose — see the topic gate in `selectThreadCandidate`. */
    themes: { open: number; sore: number; retired: number; stale: number; cooldown: number; off_topic: number };
  };
  turnsSinceOffer: number;
  offersLast24h: number;
}

function emptyFiltered(): ThreadSelectReport['filtered'] {
  return {
    loops: { quiet: 0, cooldown: 0, present_topic: 0, no_opening: 0, asked: 0, budget: 0 },
    themes: { open: 0, sore: 0, retired: 0, stale: 0, cooldown: 0, off_topic: 0 },
  };
}

/** The per-theme cooldown, by status and by how its last offer landed. */
function themeCooldownMs(t: ThreadTheme): number {
  if (t.status === 'shorthand') return THEME_COOLDOWN_SHORTHAND_MS;
  if (t.lastOutcome === 'took') return THEME_COOLDOWN_TOOK_MS;
  // `pushed_back` shares `passed`'s long cooldown as a defensive branch — a pushed-back theme is
  // sore and never reaches here, and if a hand-edited row makes one, the longest wait is right.
  if (t.lastOutcome === 'passed' || t.lastOutcome === 'pushed_back') return THEME_COOLDOWN_PASSED_MS;
  return THEME_COOLDOWN_NONE_MS;
}

/**
 * Choose at most one thing to put in front of the model this turn, and bill it. PURE: when nothing
 * is offered, `next` is the inventory that came in, unchanged and unbilled.
 *
 * The gate order is the user's combined decision rule, and the ORDER is the design:
 *   1. `awaiting_outcome` — one thing in flight, globally, across both materials.
 *   2. LOOP STAGE, which wins outright. Loops SKIP the mode and mood gates entirely: asking how the
 *      surgery went is care, not analysis, and a venting turn is often exactly when it belongs. What
 *      loops need instead is an OPENING (a real gap before the message) and the thing not already
 *      being the topic — both read from this turn, not from a stale gauge.
 *   3. THEME STAGE — the mode/mood gates, the turn gate, the day cap, then per-theme eligibility,
 *      whose LAST check is the topic gate: a theme has to touch the message in hand.
 *   4. The rung ceiling on whoever won.
 *
 * The two stages read the incoming text in OPPOSITE directions, and that inversion is the design:
 * a theme must TOUCH this turn (a pattern named out of nowhere is drift), while a loop must NOT
 * already be the topic (asking how it went while they are telling you how it went is a stored
 * question read off a list). Neither is a bug in need of the other's shape.
 *
 * `opts.topicGate` is the CONVO_THEME_TOPIC_GATE flag, read by the caller
 * (`themeTopicGateEnabled()`, beside the store) and injected rather than read here: this module is
 * pure — `now` in, no clock, no DB, no env — and the store it would import from imports this file.
 * Omitted means ON, matching the flag's default. Off is byte-identical to the pre-gate engine.
 */
export function selectThreadCandidate(
  inventory: ThreadInventory,
  affect: ThreadAffect | null | undefined,
  incomingText: string,
  gapMs: number,
  now: number,
  opts: { topicGate?: boolean } = {},
): { candidate: ThreadCandidate | null; next: ThreadInventory; report: ThreadSelectReport } {
  const topicGate = opts.topicGate ?? true;
  const filtered = emptyFiltered();
  const offersLast24h = offersInWindow(inventory.offers, now);
  const base = {
    filtered,
    turnsSinceOffer: inventory.turnsSinceOffer,
    offersLast24h,
  };
  const nothing = (reason: ThreadSelectReport['reason']) =>
    ({ candidate: null, next: inventory, report: { reason, ...base } });

  if (inventory.pending) return nothing('awaiting_outcome');
  if (!inventory.themes.length && !inventory.loops.length) return nothing('empty');

  const fresh = !!affect && now - affect.at <= AFFECT_FRESH_MS && now >= affect.at;
  const closing = fresh && affect!.terminal_closure;

  // ── Loop stage ─────────────────────────────────────────────────────────────────────
  const loopBudgetOk = inventory.turnsSinceOffer >= LOOP_MIN_TURNS_BETWEEN_OFFERS
    && offersInWindow(inventory.offers, now, 'loop') < LOOP_OFFER_DAY_CAP;
  const probe = tokenSet(incomingText);
  const eligibleLoops: OpenLoop[] = [];
  for (const l of inventory.loops) {
    // First failing check owns the loop — that is what makes these counts disjoint.
    if (l.status !== 'open') { filtered.loops.asked++; continue; }
    if (l.passes >= LOOP_MAX_PASSES) { filtered.loops.budget++; continue; }
    if (now - l.capturedAt < LOOP_QUIET_MS || now - l.lastSeenAt < LOOP_QUIET_MS) { filtered.loops.quiet++; continue; }
    if (l.offeredAt > 0 && now - l.offeredAt < LOOP_OFFER_COOLDOWN_MS) { filtered.loops.cooldown++; continue; }
    // Present-topic, from the CURRENT text rather than a stale intent: covers both "it is already
    // what we are talking about" and "they are venting about exactly this".
    if (matchScore(probe, tokenSet(matchText(l))) != null) { filtered.loops.present_topic++; continue; }
    // A conversation being wrapped up is the absence of an opening, so it lands in the same bucket
    // as too-small a gap: there is no room for a question either way.
    if (closing || gapMs < LOOP_OPENING_GAP_MS) { filtered.loops.no_opening++; continue; }
    if (!loopBudgetOk) { filtered.loops.budget++; continue; }
    eligibleLoops.push(l);
  }
  if (eligibleLoops.length) {
    // Oldest last mention first: the thing longest unasked about is the thing most worth asking.
    const winner = eligibleLoops.reduce((a, b) => (b.lastSeenAt < a.lastSeenAt ? b : a));
    const candidate: ThreadCandidate = {
      material: 'loop',
      // A loop is always the plain question; there is no ladder to climb on a pending fact.
      rungCeiling: 'fact',
      label: winner.label,
      note: winner.note,
      id: winner.id,
    };
    return { candidate, next: bill(inventory, winner.id, 'loop', now), report: { reason: 'offered_loop', ...base } };
  }

  // ── Theme stage ────────────────────────────────────────────────────────────────────
  if (fresh && (THREAD_BLOCKING_MODES.includes(affect!.intent_mode) || affect!.terminal_closure)) {
    return nothing('mode');
  }
  if (fresh && affect!.mood_level < THREAD_MOOD_FLOOR) return nothing('mood');
  if (inventory.turnsSinceOffer < THREAD_MIN_TURNS_BETWEEN_OFFERS) return nothing('turn_gate');
  if (offersInWindow(inventory.offers, now, 'theme') >= THREAD_OFFER_DAY_CAP) return nothing('day_cap');

  const eligibleThemes: ThreadTheme[] = [];
  for (const t of inventory.themes) {
    if (t.status === 'open') { filtered.themes.open++; continue; }
    if (t.status === 'sore') { filtered.themes.sore++; continue; }
    if (t.status === 'retired') { filtered.themes.retired++; continue; }
    const recency = t.status === 'shorthand' ? SHORTHAND_RECENCY_MS : THEME_RECENCY_MS;
    if (now - t.lastSeenAt > recency) { filtered.themes.stale++; continue; }
    if (t.lastOfferedAt > 0 && now - t.lastOfferedAt < themeCooldownMs(t)) { filtered.themes.cooldown++; continue; }
    // THE TOPIC GATE, last so the buckets above keep their pre-gate counts. Whether a theme is worth
    // saying is everything above; whether it has anything to do with what they just said is this.
    // A token-less turn (media only, a bare ack) closes it — `whenEmpty: 'no_touch'` — because a turn
    // that said nothing topical is not the turn to name a pattern in someone.
    // SHORTHAND is matched on its LABEL alone: it is their own two words, and its note is a
    // paraphrase of how the label was earned rather than of what it is about.
    if (topicGate) {
      const against = t.status === 'shorthand' ? t.label : matchText(t);
      if (!touchesTurn(incomingText, against, { whenEmpty: 'no_touch' })) { filtered.themes.off_topic++; continue; }
    }
    eligibleThemes.push(t);
  }
  if (!eligibleThemes.length) return nothing('no_eligible');

  const rank = (t: ThreadTheme) =>
    t.confidence
    + (t.status === 'shorthand' ? THEME_SHORTHAND_RANK_BONUS : 0)
    - Math.floor(Math.max(0, now - t.lastSeenAt) / DAY);
  // How tightly an already-on-topic theme matches this turn — the graded second opinion on top of
  // the gate's yes/no. `null` (below the similarity thresholds) sorts under every real score, and
  // with the gate off it is a flat 0, which leaves the comparison below exactly as it was.
  const topicRank = (t: ThreadTheme) =>
    topicGate ? (matchScore(probe, tokenSet(matchText(t))) ?? -1) : 0;
  const winner = eligibleThemes.reduce((a, b) => {
    const d = rank(b) - rank(a);
    if (d !== 0) return d > 0 ? b : a;
    // A tie on standing goes to the better topical fit…
    const topical = topicRank(b) - topicRank(a);
    if (topical !== 0) return topical > 0 ? b : a;
    // …and a tie on both to whichever has waited longest since it was last put forward.
    return b.lastOfferedAt < a.lastOfferedAt ? b : a;
  });

  const candidate: ThreadCandidate = {
    material: 'theme',
    rungCeiling: rungCeilingFor(winner, inventory.harvestCount),
    label: winner.label,
    note: winner.note,
    kind: winner.kind,
    id: winner.id,
  };
  return { candidate, next: bill(inventory, winner.id, 'theme', now), report: { reason: 'offered_theme', ...base } };
}

/**
 * How high the winner may be delivered. Every theme's FIRST delivery is fact-level bait: only a
 * consumed `took` earns the pattern rung, so she asks the plain thing and lets THEM climb.
 * `harvestCount` is the tenure proxy — early in a relationship every theme stays at the bottom rung
 * however good it looks, because a stranger naming your patterns is a stranger naming your patterns.
 */
function rungCeilingFor(t: ThreadTheme, harvestCount: number): ThreadRung {
  if (t.status === 'shorthand') return 'shorthand';
  if (t.pushbacks > 0 || t.mintedDistressed || t.uptakes === 0 || harvestCount < THREAD_TENURE_TURNS) {
    return 'fact';
  }
  return 'pattern';
}

/** Bill one offer: the ledger entry, the reset turn counter, the pending slot, the per-thread stamp.
 *  Billed on the OFFER and never on her USING it — a model that ignores every suggestion still
 *  spends the budget, which is the whole Detective backstop. */
function bill(inventory: ThreadInventory, id: string, material: ThreadMaterial, now: number): ThreadInventory {
  return {
    ...inventory,
    themes: material === 'theme'
      ? inventory.themes.map(t => (t.id === id ? { ...t, lastOfferedAt: now } : t))
      : inventory.themes.map(t => ({ ...t })),
    loops: material === 'loop'
      ? inventory.loops.map(l => (l.id === id ? { ...l, offeredAt: now } : l))
      : inventory.loops.map(l => ({ ...l })),
    offers: [...pruneOffers(inventory.offers, now), { at: now, themeId: id, material }],
    pending: { themeId: id, at: now, phase: 'offered', material },
    turnsSinceOffer: 0,
  };
}

/**
 * The highest-confidence standing thread, for phase G's composer coloring. Reads only: no budget is
 * spent, no cooldown is consulted, no state changes, and nothing about this call can affect what the
 * reactive path offers on the next turn. Shorthand gets no 90-day extension here — a delivery that
 * only borrows a thread's REGISTER should borrow a current one.
 */
export function topStandingThread(
  inventory: ThreadInventory,
  now: number,
): { id: string; label: string; note: string; kind: ThemeKind } | null {
  let best: ThreadTheme | null = null;
  for (const t of inventory.themes) {
    if (t.status !== 'taggable' && t.status !== 'shorthand') continue;
    if (now - t.lastSeenAt > THEME_RECENCY_MS) continue;
    if (!best || t.confidence > best.confidence
      || (t.confidence === best.confidence && t.lastSeenAt > best.lastSeenAt)) best = t;
  }
  return best ? { id: best.id, label: best.label, note: best.note, kind: best.kind } : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────────────
// The whole model-facing surface of this feature, and every word of it is a const below. Two rules
// hold across all six blocks:
//   • NUMBERLESS. No confidence, no counts, no days. The rung never prints — it SELECTS which block
//     renders. A number in the prompt is a thing to reason about and optimize; a register is a thing
//     to speak in.
//   • Every block ends on the same clamp, because the one unrecoverable failure of this feature is
//     her telling someone she keeps notes on them.
// `{label}` and `{note}` are model-authored prose, interpolated BARE — the meta_prompt precedent.
// They are sanitized at the door (sanitizeThreadText, status.ts) rather than here: one line, no
// angle brackets, no backticks, no braces, capped. That sanitizer is the structural guard, which is
// why these short strings need no dataTag inside what is already an instruction block — and why
// nothing a label contains can re-open a `{placeholder}` on the way through.

const THREAD_CLAMP = 'Never mention notes, memory, or that anything was offered to you.';
const THEME_HEADER = "## A thread you've half-noticed (INTERNAL — never say, name, or hint that you hold this)";
const THEME_LEAD = 'Something keeps coming back across your talks with them — "{label}": {note}.';
const THEME_KEEP = "If it doesn't fit, keep it. Themes come back around; silence costs nothing.";

/** LOOP. The one sanctioned reopening callback: lead with the question, never with the remembering,
 *  and round the precision off on purpose — under-claimed recall is warm, exact recall is a file. */
export const THREAD_LOOP_BLOCK = [
  '## Something they left open (INTERNAL — never say, name, or hint that you track this)',
  'Still hanging from your talks with them — "{label}": {note}.',
  'If this turn is a natural opening, you may just ask how it went: one warm, plain question, full sentence, their own word for the thing, and round the precision off ("wasn\'t that around now?" beats exact recall). Lead with the question, never with how you remember. One question only, then follow their answer wherever it goes — never your next stored one.',
  "If the moment is wrong — mid-something-else, or heavy in a way the question can't hold — keep it. An open thing keeps.",
  THREAD_CLAMP,
].join('\n');

/** THEME at the FACT rung — the bottom of the ladder and the bait. History, never diagnosis: she
 *  points at what they have both seen and lets them do the naming, because a pattern they name is
 *  worth three she names. */
export const THREAD_THEME_FACT_BLOCK = [
  THEME_HEADER,
  THEME_LEAD,
  'It hasn\'t earned its name yet. If their message genuinely touches it, point at the shared history, not the pattern — a plain question, or an "is this related to..." — and let them climb. History, never diagnosis. If they name the pattern themselves, meet them there, in their words, one layer, no further.',
  THEME_KEEP,
  THREAD_CLAMP,
].join('\n');

/** THEME at the PATTERN rung — the standard offer. One beat on what they actually sent FIRST, then
 *  a few soft words, then the floor back. "Enter a rung below what you could claim" is in the prose
 *  as well as in the code: the ceiling drops rungs, and she is asked to drop one more. */
export const THREAD_THEME_PATTERN_BLOCK = [
  THEME_HEADER,
  THEME_LEAD,
  "It's an offer, never an errand. If their message genuinely touches it and naming it would help THEM, finish your beat on what they actually sent first, then one light tag in a few words — softened, easy to wave off — and hand the floor back. Enter a rung below what you could claim: a soft pattern before a named one. Never explain the link unless they pick it up, and never quote their old words back at them.",
  "If it doesn't fit, or they're venting, or they asked a crisp question — keep it. Themes come back around; silence costs nothing.",
  THREAD_CLAMP,
].join('\n');

/** THEME at the SHORTHAND rung — shared language, so it rides bare. No setup and no softener,
 *  because softening a phrase they coined is treating their own words as a claim about them. */
export const THREAD_THEME_SHORTHAND_BLOCK = [
  THEME_HEADER,
  'A phrase you two already share may fit this turn — "{label}": {note}.',
  "It's as much theirs as yours now, so it can ride bare — a couple of words, no setup, no softener; you both know what it carries. Once at most, never as a cage, and never when the moment is tense.",
  "If it doesn't fit, keep it. Shorthand keeps.",
  THREAD_CLAMP,
].join('\n');

/** The outcome-ask, theme flavour. Rendered the turn AFTER an offer was consumed, and it is the only
 *  feedback the engine ever gets — which is why it asks for `null` in as many words when she never
 *  actually said the thing. A guessed outcome would move confidence on a tag that never happened. */
export const THREAD_OUTCOME_ASK_THEME = [
  '## Last turn you floated a thread — "{label}"',
  "If you actually spoke it, read how they met it and report it in this reply's status.thread_outcome: took if they picked it up, passed if they let it lie (that is fine), pushed_back if they corrected it or bristled. If you never said it, report null. Bookkeeping only — never mention it.",
].join('\n');

/** The outcome-ask, loop flavour. Same machine, different words: a loop was ASKED, not floated. */
export const THREAD_OUTCOME_ASK_LOOP = [
  '## Last turn you asked about something pending — "{label}"',
  "Read how they met it and report it in this reply's status.thread_outcome: took if they answered it, passed if they let it lie (that is fine), pushed_back if they waved it off or bristled. If you never actually asked, report null. Bookkeeping only — never mention it.",
].join('\n');

function fill(template: string, label: string, note = ''): string {
  return template.replaceAll('{label}', label).replaceAll('{note}', note);
}

/** Which block a candidate renders as. Material first (a loop is never a rung), then the ceiling. */
function blockFor(c: ThreadCandidate): string {
  if (c.material === 'loop') return THREAD_LOOP_BLOCK;
  if (c.rungCeiling === 'shorthand') return THREAD_THEME_SHORTHAND_BLOCK;
  if (c.rungCeiling === 'pattern') return THREAD_THEME_PATTERN_BLOCK;
  return THREAD_THEME_FACT_BLOCK;
}

/**
 * The `dyn` block for Convo's system prompt. The two halves are INDEPENDENT — an offer with no
 * pending ask, an ask with no offer, both, or neither — and neither renders a byte when it has
 * nothing to say. `''` for (null, null) is the no-regression pin the whole feature rests on: with
 * an empty inventory the prompt is byte-identical to no feature at all.
 *
 * Offer first, ask second: the offer is this turn's live decision and gets the leading position;
 * the ask is a footnote about last turn.
 */
export function renderThreadForPrompt(
  candidate: ThreadCandidate | null,
  outcomeAsk: { label: string; material: ThreadMaterial } | null,
): string {
  const parts: string[] = [];
  if (candidate) parts.push(fill(blockFor(candidate), candidate.label, candidate.note));
  if (outcomeAsk) {
    parts.push(fill(
      outcomeAsk.material === 'loop' ? THREAD_OUTCOME_ASK_LOOP : THREAD_OUTCOME_ASK_THEME,
      outcomeAsk.label,
    ));
  }
  return parts.join('\n\n');
}

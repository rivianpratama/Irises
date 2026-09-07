// MOMENTS: the episodes she keeps about one person, and the arithmetic that decides which few of
// them an idle turn is allowed to see.
//
// A moment is not a fact. Facts are what the medium tier holds and every prompt carries — "lives in
// Jakarta", "hates calls before ten" — and nobody ever made a joke out of a fact. A moment is an
// episode with a time, a shape and a small absurdity: the twenty minutes at midnight spent making
// her identify a girl in an ad, then asking how she knew. That is what a callback is made of, which
// is why this store exists beside the fact tiers rather than inside them.
//
// Three laws, and they are the whole design:
//
//   • SCARCE. Forty active at most, five sampled per offer, one used per turn, spaced by the hook
//     engine's own interval. A callback lands because it is rare; a bot that reaches for its diary
//     every idle turn is a filing system reading itself out loud.
//   • MERGED UP. The same shape happening a third time is not three moments, it is one moment with
//     a count — "third volcano check this month" beats three separate volcano checks. Folding is
//     what turns episodes into a pattern, and a pattern is what a read is built from.
//   • DELETED, NEVER ARCHIVED. `pruneMoments` removes rows from the file and writes them nowhere.
//     Every other tier in this codebase supersedes and archives, on purpose (see memoryMedium.ts's
//     ledger discipline) — this one must not. A roast diary that resurfaced through
//     `recall_memory` months after it decayed would be the single worst failure this feature can
//     have: something she was told once, kept forever, and read back as a receipt. Deletion also
//     keeps `/forget` honest — one file wiped, with no lineage table left holding the copy.
//
// PURE, the way persona/threads.ts is pure: `now` is injected, inputs are never mutated, sampling
// takes a seed rather than reading a global RNG, and nothing here does I/O or costs an LLM call.
// The store (db/repositories/moments.ts) and the nightly pass (memory/momentsHarvest.ts) sit
// DOWNSTREAM. Two imports, both leaves: memory/textSim.ts — which imports nothing at all — because
// "are these two short texts about the same thing?" already has one implementation in this codebase
// and a second would let the groomer and the fold engine drift apart on what "the same thing"
// means; and `randomUUID`, which is the DEFAULT behind an injectable id seam, so the one line of
// nondeterminism in the file is replaceable from a test.

import { randomUUID } from 'node:crypto';
import { simScore, tokenSet } from '../memory/textSim.js';

/** The three kinds of episode worth keeping, and the only tags the store will accept. Closed, and
 *  small on purpose: each one names a different way a moment can be handed back. `habit` is a thing
 *  they did again, `obsession` a thing they went deep on out of proportion, `embarrassing` a thing
 *  they would rather she had not noticed and can still laugh at. Anything that fits none of the
 *  three is a fact, a promise, or a wound, and none of those belong here. */
export const MOMENT_TAGS = ['habit', 'obsession', 'embarrassing'] as const;

export type MomentTag = typeof MOMENT_TAGS[number];

/** One kept episode. Small and flat: this row is parsed on every read of the file and rendered into
 *  a prompt, so anything expensive in it is expensive forever. */
export interface MomentEntry {
  id: string;
  /** Her words for what happened, one line, `MOMENT_TEXT_MAX` chars at most. On a fold this is
   *  REPLACED by the newer pattern text — the count is the history, the text is the current read —
   *  except where only containment matched the pair, where the longer text wins (`foldHarvest`). */
  text: string;
  tag: MomentTag;
  /** When the episode happened (epoch ms). Reset to `now` by a fold, because a pattern's date is
   *  the last time it happened, not the first. Drives both the sampler's weight and the prune. */
  at: number;
  /** How many episodes have folded into this one. Starts at one. Never rendered as a digit. */
  count: number;
  /** How many times it has been handed to a turn. `0` and an old `at` is what decay looks for. */
  offered: number;
  /** When it was last handed to a turn (epoch ms). `0` means never. */
  lastOfferedAt: number;
}

/** Active moments kept per person. Past this, the oldest are evicted (and, per the header, gone).
 *  Forty is the same ceiling the medium tier gives directives: enough that a year of texting has a
 *  memory, few enough that the whole file can be handed to the nightly pass in one prompt. */
export const MAX_MOMENTS = 40;

/** Her longest allowed moment. A moment is one dry line; past this it is a summary, and a summary
 *  cannot be retold in fresh words, which is the only way a callback is ever allowed out. */
export const MOMENT_TEXT_MAX = 200;

/** How long a moment survives without being touched. Sixty days of neither happening again nor
 *  being used is the definition of a moment that stopped being funny. */
export const MOMENT_DECAY_MS = 60 * 24 * 60 * 60 * 1000;

/** A moment used inside this window is off the table. THE law behind "never the same one twice":
 *  the same callback on two consecutive idle turns reads as a bot with one anecdote. */
export const MOMENT_RECENT_EXCLUDE_MS = 24 * 60 * 60 * 1000;

/** Past this age a moment counts as OLD, and is eligible for the second, deliberately non-recent
 *  half of a sample. Without it the sampler would only ever offer this week, and a callback to
 *  something two months old is the one that actually lands. */
export const MOMENT_OLD_MS = 14 * 24 * 60 * 60 * 1000;

/** How many recency-weighted moments one sample carries. */
export const MOMENT_SAMPLE_RECENT = 3;

/** How many uniformly-drawn OLD moments ride along behind them. */
export const MOMENT_SAMPLE_OLD = 2;

/**
 * The floor either overlap measure must clear for a proposal to fold into an existing moment
 * instead of becoming a new one. ONE number for both measures (the plan names one), read the way
 * threads.ts reads its pair: either measure clearing it is a match, because jaccard misses the
 * short-inside-long shape and containment over-matches a two-word text.
 *
 * Deliberately loose, and the looseness is paid for in `foldHarvest` rather than in a second
 * constant: a merge normally REPLACES the text, so a four-word proposal contained in the file's
 * richest moment would reduce it to a fragment with no archive behind it. So a fold that only
 * containment decided keeps the LONGER of the two texts, and only jaccard or the writer's own
 * `merges` claim can shorten a moment. Under-merging is still the expensive failure — three
 * separate volcano checks are three boring moments and "third volcano check this month" is a read.
 */
export const MOMENT_MERGE_SIM = 0.5;

/** New moments one fold may add. The writer prompt says the same thing in prose ("never write more
 *  than three"); this is the number that holds when it doesn't. A pass that wrote ten would fill
 *  the cap in four nights and evict a year of history in a week. */
export const MOMENT_FOLD_MAX_NEW = 3;

// ── The seeded PRNG ──────────────────────────────────────────────────────────────────────────────

/**
 * mulberry32 — a 32-bit, single-state PRNG (public domain, Tommy Ettinger). Chosen because it is
 * eight lines, needs no state object, and passes enough of gjrand for a job whose entire purpose is
 * "pick two of eleven anecdotes": the alternative is `Math.random()`, and a sampler that cannot be
 * replayed cannot be tested at all. The seed is the caller's, so the same turn re-run against the
 * same file makes the same offer — which is what makes the `moments:offer` receipt meaningful.
 *
 * Returns a generator of floats in [0, 1). Any integer seed works; it is coerced to uint32.
 */
export function mulberry32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Age in days, floored at zero: a stamp from the future (a hand edit, a clock skew) is TODAY, not
 *  a negative weight that would sort ahead of everything real. */
function ageDays(at: number, now: number): number {
  return Math.max(0, (now - at) / DAY_MS);
}

/** The recency weight: `1 / (1 + ageDays)`. A harmonic curve rather than an exponential one because
 *  this week should dominate without last month becoming unreachable — today weighs one, a week ago
 *  an eighth, two months ago a sixtieth, and none of them ever reach zero. */
function recencyWeight(e: MomentEntry, now: number): number {
  return 1 / (1 + ageDays(e.at, now));
}

/** Was it handed out inside the no-repeat window? A future stamp counts as "just now" — the safe
 *  direction for a rule whose job is to hold a callback back. */
function offeredRecently(e: MomentEntry, now: number): boolean {
  return e.lastOfferedAt > 0 && now - e.lastOfferedAt < MOMENT_RECENT_EXCLUDE_MS;
}

/** Draw one entry from `pool` by weight, splicing it out. `null` when the pool is empty. Falls back
 *  to a uniform draw if the weights sum to nothing finite, so a poisoned stamp can never make the
 *  sampler return fewer moments than it has. */
function drawWeighted(pool: MomentEntry[], weights: number[], rng: () => number): MomentEntry | null {
  if (pool.length === 0) return null;
  const total = weights.reduce((s, w) => s + (Number.isFinite(w) && w > 0 ? w : 0), 0);
  if (!(total > 0)) return pool.splice(Math.floor(rng() * pool.length), 1)[0] ?? null;
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0;
    r -= w;
    // `<= 0` rather than `< 0`, so a draw of exactly 0 lands on the first weighted member instead
    // of falling through the loop to the tail.
    if (r <= 0) return pool.splice(i, 1)[0] ?? null;
  }
  return pool.splice(pool.length - 1, 1)[0] ?? null;
}

/**
 * The offer: up to `MOMENT_SAMPLE_RECENT` recency-weighted moments, then up to `MOMENT_SAMPLE_OLD`
 * drawn uniformly from what is left and older than `MOMENT_OLD_MS`. Five at most, never the same id
 * twice, and never a moment used in the last day.
 *
 * Two pools rather than one because a single weighted draw is a sampler that only ever shows this
 * week — the recency half keeps the offer current, and the uniform-old half is where "no volcano to
 * check this time?" comes from two months after the volcano.
 *
 * `excludeIds` is the CALLER's extra veto (the moment already riding this turn's thread offer, a
 * moment the ledger says was just used), on top of the store's own `lastOfferedAt` stamps, which
 * this function enforces itself: the 24-hour law belongs beside the constant that defines it, not
 * in whichever caller remembers to apply it.
 *
 * PURE and REPLAYABLE: `now` and `seed` are the only clocks, entries are neither mutated nor
 * reordered, and the returned entries are the caller's own objects (billing them is `billOffers`'
 * job, and it copies).
 */
export function sampleMoments(
  entries: readonly MomentEntry[],
  now: number,
  excludeIds: ReadonlySet<string>,
  seed: number,
): MomentEntry[] {
  const rng = mulberry32(seed);
  const pool = entries.filter(e => !excludeIds.has(e.id) && !offeredRecently(e, now));
  const picked: MomentEntry[] = [];
  for (let i = 0; i < MOMENT_SAMPLE_RECENT; i++) {
    const drawn = drawWeighted(pool, pool.map(e => recencyWeight(e, now)), rng);
    if (!drawn) break;
    picked.push(drawn);
  }
  // Whatever the recency draws left behind, narrowed to the genuinely old. `pool` has already had
  // the picks spliced out of it, which is what keeps an id out of both halves.
  const old = pool.filter(e => now - e.at > MOMENT_OLD_MS);
  for (let i = 0; i < MOMENT_SAMPLE_OLD; i++) {
    if (old.length === 0) break;
    picked.push(old.splice(Math.floor(rng() * old.length), 1)[0]);
  }
  return picked;
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

/**
 * Ages, in words, coarsest thing that is still true. NOT ONE DIGIT anywhere in the set — the same
 * law the hooks section is pinned to, for the same reason: a date in the prompt is a date she can
 * read out ("on the third you asked me about krakatoa"), which is the ledger-recital failure the
 * callback craft page spends half its length forbidding. "a few days ago" cannot be recited.
 *
 * Ordered coarsest-last; `momentAgeWords` walks it in order.
 */
export const MOMENT_AGE_WORDS = [
  'today',
  'yesterday',
  'a few days ago',
  'last week',
  'a few weeks ago',
  'a month or two ago',
  'a while back',
] as const;

/** Upper bound in days for each word above, in the same order. The last word has no bound. */
const MOMENT_AGE_BOUNDS_DAYS = [1, 2, 7, 14, 35, 75] as const;

/** How old this moment reads. A future stamp, like everywhere else in this file, is today. */
export function momentAgeWords(at: number, now: number): string {
  const days = ageDays(at, now);
  for (let i = 0; i < MOMENT_AGE_BOUNDS_DAYS.length; i++) {
    if (days < MOMENT_AGE_BOUNDS_DAYS[i]) return MOMENT_AGE_WORDS[i];
  }
  return MOMENT_AGE_WORDS[MOMENT_AGE_WORDS.length - 1];
}

/**
 * The sampled moments as the lines `renderHooksSection` interpolates: `- (habit, last week) they
 * checked the volcano again`. The tag and the age are hers to use and never to say; the text is her
 * own prose from the nightly pass and may carry digits of its own (their week, their numbers) — the
 * no-digit law is a law about the FORMAT, which is why the age is words.
 *
 * Whitespace inside the text is collapsed to single spaces: a stored newline would put half a
 * moment on an unlabelled line of the prompt, and the store's own grammar is line-oriented too.
 * The count is deliberately absent — it is a digit, and "third time this month" belongs in the text
 * the writer chose, not in a machine-rendered suffix.
 */
export function renderMomentLines(sample: readonly MomentEntry[], now: number): string[] {
  return sample
    .map(e => ({ e, text: e.text.replace(/\s+/g, ' ').trim() }))
    .filter(({ text }) => text !== '')
    .map(({ e, text }) => `- (${e.tag}, ${momentAgeWords(e.at, now)}) ${text}`);
}

// ── Folding a harvest in ─────────────────────────────────────────────────────────────────────────

/** One thing the nightly writer proposes. `merges` is its own claim that this episode is a repeat
 *  of moments it already saw; the ids are checked, and a claim about an id that no longer exists
 *  falls through to the similarity check rather than failing the proposal. */
export interface MomentProposal {
  text: string;
  tag: string;
  merges?: string[];
}

/**
 * What one fold did, in disjoint buckets. Every proposal handed in lands in EXACTLY ONE of the five
 * — the receipt discipline from the threading engine: a report that can say two things at once
 * about one proposal is a report nobody can score.
 *
 * `evicted` is not a proposal bucket. It counts existing moments the cap pushed out, which is a
 * fact about the FILE rather than about anything the writer proposed.
 */
export interface MomentFoldReport {
  merged: number;
  added: number;
  /** Empty after whitespace collapse, or longer than `MOMENT_TEXT_MAX`. */
  rejected_text: number;
  /** A tag outside `MOMENT_TAGS`. */
  rejected_tag: number;
  /** The per-fold new-moment cap was already spent (`MOMENT_FOLD_MAX_NEW`). */
  rejected_cap: number;
  evicted: number;
}

function emptyReport(): MomentFoldReport {
  return { merged: 0, added: 0, rejected_text: 0, rejected_tag: 0, rejected_cap: 0, evicted: 0 };
}

function isMomentTag(v: string): v is MomentTag {
  return (MOMENT_TAGS as readonly string[]).includes(v);
}

/** The similarity verdict, threads.ts's shape with this store's single floor: a score for RANKING,
 *  or null for no match — plus WHICH measure cleared the floor. `jaccardCleared` means the two texts
 *  really are the same shape and the newer wording may replace the older; a containment-only match
 *  is the loose leg (short inside long), and `foldHarvest` refuses to let it shorten a moment. */
function foldScore(a: Set<string>, b: Set<string>): { score: number; jaccardCleared: boolean } | null {
  const { jaccard, containment } = simScore(a, b);
  const jaccardCleared = jaccard >= MOMENT_MERGE_SIM;
  if (jaccardCleared || containment >= MOMENT_MERGE_SIM) {
    return { score: jaccard * 1000 + containment, jaccardCleared };
  }
  return null;
}

/** The best existing home for this text, or null. Ranked by score, ties broken by the OLDER entry
 *  and then by position, so the choice never depends on object identity or map order. */
function bestMatch(
  entries: readonly MomentEntry[],
  text: string,
): { idx: number; jaccardCleared: boolean } | null {
  const probe = tokenSet(text);
  let best: { idx: number; jaccardCleared: boolean } | null = null;
  let bestScore = -1;
  for (let i = 0; i < entries.length; i++) {
    const match = foldScore(probe, tokenSet(entries[i].text));
    if (match === null) continue;
    if (best === null || match.score > bestScore || (match.score === bestScore && entries[i].at < entries[best.idx].at)) {
      best = { idx: i, jaccardCleared: match.jaccardCleared };
      bestScore = match.score;
    }
  }
  return best;
}

/**
 * Fold a night's proposals into the file's entries. Three phases, in this order, because each one
 * depends on the last: merges first (so a repeat does not become a second row), then new entries
 * up to the per-fold cap, then the active cap by oldest-first eviction.
 *
 * A merge folds into the OLDER id: the surviving row keeps its id, its tag and its `offered`
 * history, takes `count + 1`, takes the NEW text (the newer wording is the pattern; the old one was
 * a single episode) and takes `at = now` (a pattern's date is the last time it happened). Its
 * `lastOfferedAt` is untouched — folding is not using.
 *
 * ONE exception to the new text, and it is the only place this engine departs from the plan's line:
 * when nothing but CONTAINMENT decided the match — the loose leg, which fires on a short text buried
 * in a long one — the LONGER of the two texts survives. A replacement there is not a rewording, it
 * is a truncation: "asked how i knew" is contained in "spent twenty minutes at midnight making me
 * identify a girl in an ad then asked how i knew", and the file's richest moment must not be reduced
 * to its last clause by one thin night with nothing to archive it. A writer-marked merge, or one
 * jaccard agreed with, still takes the new text — those are the cases where the newer wording is
 * genuinely the newer read.
 *
 * Merge targets are resolved against the WORKING list, so two near-identical proposals in one night
 * collapse into one row with a count of two rather than two rows the next night has to merge. That
 * is the same arithmetic the writer prompt asks for in prose, applied to its own output.
 *
 * `newId` is injected so the fold is replayable in a test; the default is `randomUUID`, the id
 * source every other store here uses. Nothing else in this function reads a clock or a global.
 */
export function foldHarvest(
  entries: readonly MomentEntry[],
  proposed: readonly MomentProposal[],
  now: number,
  opts?: { newId?: () => string },
): { entries: MomentEntry[]; report: MomentFoldReport } {
  const report = emptyReport();
  const working: MomentEntry[] = entries.map(e => ({ ...e }));
  const newId = opts?.newId ?? defaultNewId;
  let added = 0;

  for (const p of proposed) {
    const text = String(p.text ?? '').replace(/\s+/g, ' ').trim();
    if (text === '' || text.length > MOMENT_TEXT_MAX) { report.rejected_text++; continue; }
    const tag = String(p.tag ?? '').trim().toLowerCase();
    if (!isMomentTag(tag)) { report.rejected_tag++; continue; }

    // The writer's own claim first, and only then the similarity check: it saw the episode and the
    // existing moment together, which is strictly more than a bag of words can know. Of several
    // claimed ids the OLDEST wins — the one that has been carrying the pattern longest.
    let targetIdx: number | null = null;
    for (const id of p.merges ?? []) {
      const idx = working.findIndex(e => e.id === id);
      if (idx >= 0 && (targetIdx === null || working[idx].at < working[targetIdx].at)) targetIdx = idx;
    }
    // A writer-marked merge is trusted to reword; a containment-only match is not (see above).
    let keepLongerText = false;
    if (targetIdx === null) {
      const match = bestMatch(working, text);
      if (match !== null) {
        targetIdx = match.idx;
        keepLongerText = !match.jaccardCleared;
      }
    }

    if (targetIdx !== null) {
      const t = working[targetIdx];
      const surviving = keepLongerText && t.text.length > text.length ? t.text : text;
      working[targetIdx] = { ...t, text: surviving, count: t.count + 1, at: now };
      report.merged++;
      continue;
    }
    if (added >= MOMENT_FOLD_MAX_NEW) { report.rejected_cap++; continue; }
    working.push({ id: newId(), text, tag, at: now, count: 1, offered: 0, lastOfferedAt: 0 });
    added++;
    report.added++;
  }

  // Oldest-first eviction to the active cap. Ties break on position, so the eviction order is a
  // property of the file rather than of the sort implementation. Nothing is archived — see header.
  if (working.length > MAX_MOMENTS) {
    const order = working
      .map((e, i) => ({ i, at: e.at }))
      .sort((a, b) => (a.at - b.at) || (a.i - b.i));
    const doomed = new Set(order.slice(0, working.length - MAX_MOMENTS).map(o => o.i));
    report.evicted = doomed.size;
    return { entries: working.filter((_, i) => !doomed.has(i)), report };
  }
  return { entries: working, report };
}

/** The default id source, behind a function so `foldHarvest`'s only nondeterminism sits on one line
 *  and the seam that replaces it is the same shape as every other DI seam in this codebase. */
function defaultNewId(): string {
  return randomUUID();
}

// ── Decay and billing ────────────────────────────────────────────────────────────────────────────

/**
 * Drop the moments that have decayed. DELETION, not retirement: the returned array is what the file
 * becomes, and the removed rows go nowhere at all. The header says why at length — the short of it
 * is that a roast diary must not be recoverable, and an archive is a recovery path.
 *
 * Two clauses, both `MOMENT_DECAY_MS`, and which one applies is decided by whether there is a usable
 * offer STAMP:
 *   • no stamp — kept while `at` is inside the window. It was written down and never used (or the
 *     stamp is gone), so the only thing that can speak for it is how recently it happened, and a
 *     fold refreshing `at` is exactly the pattern recurring.
 *   • stamped — kept while `lastOfferedAt` is inside the window. She used it, and a thing she has
 *     not reached for in two months has stopped being worth reaching for.
 * Branching on the STAMP rather than on the `offered` counter is load-bearing, not a stylistic
 * choice. `lastOfferedAt` is `0` for "never", and `now - 0` is past every window, so a stamp read
 * unconditionally deletes the row — and the two fields can disagree, because the store degrades each
 * annotation attribute INDEPENDENTLY (db/repositories/moments.ts `parseSegment`): one hand-mangled
 * `last_offered=` leaves `offered: 3, lastOfferedAt: 0`, and a counter-shaped guard would then read
 * that row's absent stamp and delete it. In the one tier here with no archive, a mistyped attribute
 * must not cost the moment, so a missing stamp means never-offered and the row falls back to its
 * date. The known edge of the second clause: a moment that recurred today but was last used sixty
 * days ago still goes, and the next pass re-mints it at count one if it is genuinely still
 * happening. That is the plan's rule as written, and the cost is a count, not a memory.
 */
export function pruneMoments(entries: readonly MomentEntry[], now: number): MomentEntry[] {
  return entries.filter(e => {
    if (e.offered === 0 || e.lastOfferedAt <= 0) return now - e.at <= MOMENT_DECAY_MS;
    return now - e.lastOfferedAt <= MOMENT_DECAY_MS;
  });
}

/**
 * Bill the moments this turn actually offered: `offered + 1`, `lastOfferedAt = now`. Called on the
 * OFFER, not on the use — the model may well decline every moment it was handed, and billing only
 * the used ones would let the same three ride out on every idle turn until one of them stuck.
 *
 * Ids that are not in `entries` are ignored (an offer whose moment the same pass just evicted).
 * Every other entry comes back untouched, by value: nothing here mutates the caller's rows.
 */
export function billOffers(entries: readonly MomentEntry[], ids: ReadonlySet<string>, now: number): MomentEntry[] {
  return entries.map(e =>
    ids.has(e.id) ? { ...e, offered: e.offered + 1, lastOfferedAt: now } : { ...e },
  );
}

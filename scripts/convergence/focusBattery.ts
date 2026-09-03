// Focus battery — does the reply answer THIS turn, or does it answer the pile behind it.
//
// The conversation-first revamp is one claim: a rich memory stack should change HOW she answers and
// never WHAT she answers. Every failure mode that claim has is here — a look delivered two turns ago
// arriving again, a theme tagged onto a crisp definition question, a full dossier recited at a bare
// "hey", the prompt's prose creeping back up, an ambiguous line answered with an interview instead
// of a guess, a saved directive quietly dropped, affect run away with by three flattering turns.
//
//   npx tsx scripts/convergence/focusBattery.ts --round 1
//   npx tsx scripts/convergence/focusBattery.ts --round 2 --base http://127.0.0.1:3000 \
//     --db ~/.irises/irises.db --out ./focus-round-2.json
//   npx tsx scripts/convergence/focusBattery.ts --help              # no sends, exit 0
//   npx tsx scripts/convergence/focusBattery.ts --round 1 --dry-run # prints the plan, no sends
//
// A SIBLING of threadBattery.ts and loopBattery.ts, in the same house style and deliberately its own
// file. loopBattery scores ROUTING off the routing gate's own predicates; threadBattery scores the
// threading engine's NEVER-EVENTS off `threads:select` and the inventory row. This one scores what
// reached the model and what came back, off `turn:trace` (diagnostics/turnTrace.ts) — a different
// receipt, a different verdict table, and mostly different probes. Folding them together would mean
// one `expect` union meaning three unrelated things. Do NOT add focus items to either sibling.
//
// Same house constraints, for the same reasons:
//   • NO new dependencies — HTTP through `curl` and the DB through the `sqlite3` CLI, both via
//     child_process. Every number and receipt shape this file compares against is imported from
//     `./expectations.ts` (which imports it from `src/`), so a rename or a tightened ceiling upstream
//     is a compile error here rather than a silently mis-scored round.
//   • Deliberately NOT a `*.test.ts`: `npm test` runs "scripts/**/*.test.ts" and must never touch a
//     live instance or spend tokens. The pure scorers below ARE unit-tested, by focusBattery.test.ts,
//     which is why `main()` is behind an entry-point guard at the bottom of this file — importing
//     this module must never start a round.
//   • Exit 0 iff the round is clean.
//
// !! The deployed instance must be REBUILT AND RESTARTED from this same tree before a round means
// anything, with DIAGNOSTICS_ENABLED unset-or-true, TURN_TRACE_ENABLED on, and the P0/P2 flags on
// (CONVO_TURN_FOCUS_BLOCK, CONVO_THEME_TOPIC_GATE, CONVO_MEMORY_RELEVANCE). This harness reads THIS
// checkout for its ceilings and shapes but talks to whatever binary is listening on --base; if those
// are different commits, a "clean round" is measuring the old code — and the prose ceilings will say
// so out loud, because they are properties of the checkout rather than of the turn. A round where NO
// `turn:trace` receipt appears at all is reported as INCONCLUSIVE, not clean: that is what a
// disabled flag, an old binary or a wrong --db looks like from out here. !!
//
// ONE HANDLE, MANY CHATS — the same fact that shapes threadBattery. Every web client shares one
// memory handle (WEB_DEBUG_HANDLE) while each clientId gets its own chatId, so the probes run as
// separate conversations against ONE memory and ONE thread inventory. Three consequences:
//   1. A fresh chatId means an empty transcript, which is the closest this harness can get to f5's
//      "four quiet days": no recent turn in THIS conversation, with the whole stack still behind it.
//      It is not the same thing, and the report says so rather than pretending.
//   2. The theme probes (f3, f4) are only as strong as what the inventory holds. Run WARM, after the
//      hand transcript (multiturn-threading-test.md) has built something; the pre-round inventory
//      summary is printed so a reader can see whether the round had anything to catch. Nothing here
//      ever writes to the inventory — a seeded theme would be testing the seed.
//   3. f4 is the one POSITIVE control, so it needs a surfaceable theme that its ask actually touches.
//      It computes that from the pre-round row with the engine's own predicate (`touchesTurn`), and
//      goes UNSCORED — never PASS, never FAIL — when the row cannot support an offer. `--positive-ask`
//      lets you write the ask against whatever the row really holds.
//
// VERDICTS AND WHAT THEY MEAN FOR THE ROUND. Four non-failing outcomes exist and they are not the
// same thing:
//   • WARN     — the turn passed, but a reading beside the verdict is worth a human's eye (a data
//                section over its fixture ceiling, a probe whose precondition was weaker than it
//                claims). Reported, never failing.
//   • LATE     — answered past the SLA. Provider latency under this harness's own stagger is not a
//                focus defect, and a late reply is scored for every leak exactly like an on-time one.
//   • UNSCORED — the machine could not read this item HONESTLY this round (no receipt, a gate that
//                closed before the one being probed, a directive that never saved). Not a pass: the
//                round is inconclusive rather than clean, and a re-run can fix it.
//   • PENDING  — the evidence this item needs does not EXIST in the code yet (f8's affect drift lands
//                in P3; f7's media turn cannot go down the text-only web lane at all). A re-run
//                cannot fix it, so collapsing it into UNSCORED would make every round inconclusive
//                forever — which is how a battery gets ignored. Loud, listed, and not counted
//                against the round. Every PENDING carries the reason and the field it is waiting for.
//
// One round: read the inventory row → reset the short-tier freshness → send the items on fresh
// clientIds at a ~20 s stagger (seeded items send their setup turns first, a gap apart) → wait out
// the engine round-trips → read the messages table and the turn receipts back → score, print a
// markdown table, write JSON.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webChatId, WEB_DEBUG_HANDLE } from '../../src/channels/web/identity.js';
// The plumbing three batteries share — argv, curl, the sqlite3 CLI, the markdown trims. It lives in
// its own module (and holds no verdict and no threshold) precisely so a battery can import it: this
// file's `main()` is behind an entry-point guard, but the older two run theirs at module scope, so
// importing FROM them would start a round. See harness.ts.
import {
  arg, cell, curlJson, expand, flag, num, quote, sh, sleep, sqlExec, sqlJson, truncate, whyFailed,
} from './harness.js';
// The engine's OWN topic predicates, imported rather than reimplemented (the loopBattery precedent):
// `touchesTurn` is the very function the theme topic gate runs, so f4's precondition is computed with
// the code under test rather than with a regex that approximates it.
import { salientTokens, touchesTurn } from '../../src/memory/topicality.js';
import {
  BUBBLE_HARD_CAP,
  BUBBLE_LAW_MAX,
  DATA_BUDGET_KEYS,
  LOOP_OPENING_GAP_MS,
  MAX_BUBBLE_WORDS,
  MIN_TRANSCRIPT_SHARE,
  PROMPT_BUDGET,
  PROSE_BUDGET_KEYS,
  SECTION_IDS,
  THREAD_MIN_TURNS_BETWEEN_OFFERS,
  THREADS_SELECT_LABEL,
  TURN_TRACE_LABEL,
  type BudgetKey,
  type MemoryGateBlock,
  type ThreadSelectReport,
  type ThreadTheme,
  type TurnTraceDetail,
} from './expectations.js';

// ── verdicts ────────────────────────────────────────────────────────────────────────────────────

/** The eight never-events this battery exists to catch. Each one is owned by at least one check
 *  below, and every check declares which one it reports (focusBattery.test.ts pins that). */
export type FocusFailure =
  | 'OFF_TOPIC_LEAK'      // something held surfaced on a turn it has nothing to do with
  | 'MEMORY_DUMP'         // what she holds got recited instead of used
  | 'RE_DELIVERY'         // an already-delivered look arrived a second time
  | 'BUDGET_BREACH'       // a numbered law broke: PROMPT_BUDGET on the way in, the bubble law out
  | 'INTERVIEW'           // asked instead of answering — "predict, don't interview" failing
  | 'DIRECTIVE_LOST'      // a standing rule they asked for stopped being honoured
  | 'CONNECTION_MISSED'   // the positive control: the held thing that DID touch the turn stayed silent
  | 'AFFECT_UNBOUNDED';   // the affect gauges moved further than the engine's own cap allows

export type Verdict = 'PASS' | FocusFailure | 'SILENT' | 'LATE' | 'WARN' | 'PENDING' | 'UNSCORED';

/** What counts against the round. See the header on why PENDING and WARN do not. */
const FAILING: readonly Verdict[] = [
  'SILENT', 'OFF_TOPIC_LEAK', 'MEMORY_DUMP', 'RE_DELIVERY', 'BUDGET_BREACH',
  'INTERVIEW', 'DIRECTIVE_LOST', 'CONNECTION_MISSED', 'AFFECT_UNBOUNDED',
];

// ── the evidence one item is scored on ──────────────────────────────────────────────────────────

/**
 * Everything the machine knows about one probe turn, already read back. Kept as PLAIN DATA with no
 * clock and no I/O so the whole verdict table is a pure function of it — that is what
 * focusBattery.test.ts exercises, and it is why a round's exit code can be trusted without a live
 * instance to reproduce it.
 */
export interface TurnEvidence {
  /** The probe turn's `turn:trace` detail, or null when none came back for this chat. */
  trace: TurnTraceDetail | null;
  /** The probe turn's `threads:select` detail, or null when threading did not report. */
  select: ThreadSelectReport | null;
  /** The bubbles as they were sent, in order — one `messages` row each. */
  bubbles: string[];
  /** The seed turns' receipts, oldest first. Setup, never scored on its own; f8 reads the gauge
   *  trail across them. */
  seedTraces: TurnTraceDetail[];
  /** Salient tokens of the seed asks — the needle the re-delivery sniff looks for in the reply. */
  seedTokens: string[];
  /** Surfaceable themes in the PRE-ROUND inventory row that this item's ask touches, by the engine's
   *  own predicate. f4's precondition: empty means an offer was never on the table. */
  touchedThemes: string[];
  /** Send → first bubble, in ms; null when nothing came back at all. */
  replyMs: number | null;
  /** False when the round's receipts are too incomplete to score anything (an unreadable DB, a
   *  history table that holds nothing for these chats). Everything goes UNSCORED. */
  receiptsUsable: boolean;
}

/** How one check came out. `warn` and `pending` are outcomes, not failures — see the header. */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unscored' | 'pending';
export interface CheckOutcome { status: CheckStatus; detail: string }

export interface FocusCheck {
  /** The verdict this check reports when it FAILS. A check that can only ever warn (memory_ceiling)
   *  still declares one, so the table reads as one vocabulary. */
  verdict: FocusFailure;
  /** Why this check exists — printed in the JSON so a failed round explains itself. */
  why: string;
  /** PRECONDITION: `scoreItem` returns UNSCORED before it runs any check on a turn with no
   *  `turn:trace`, so every `run` here may read `ev.trace!` without asking again. Nothing else on
   *  the evidence is guaranteed: `select` is null whenever threading did not report, and the bubble
   *  rows can be empty on a turn that produced a receipt and no text. */
  run(ev: TurnEvidence): CheckOutcome;
}

// ── reply shapes read for a human's eye ─────────────────────────────────────────────────────────

/**
 * The SHAPE of a how-did-it-go callback — threadBattery's list, kept in step with it on purpose.
 * Here it is load-bearing in two places where no receipt can answer the question: whether the FIRST
 * bubble answered or deflected (f1), and how many callbacks a bare greeting drew (f5). It never
 * overrules a receipt; where `threads:select` has an opinion, the receipt wins.
 */
const CALLBACK_SHAPES: readonly RegExp[] = [
  /how (?:did|'d) .{0,48}\bgo\b/i,
  /how (?:is|are|was|were|did) .{0,32}(?:going|coming along|turn out|work out)/i,
  /\bany (?:news|word|update) (?:on|about)\b/i,
  /\b(?:you|u) (?:said|mentioned|told me) .{0,60}\?/i,
  /\bhow'?s (?:the|your) .{0,32}(?:going|coming)/i,
];
function callbackHits(text: string): string[] {
  return CALLBACK_SHAPES.filter(re => re.test(text)).map(re => re.source);
}

/** f5's numbers, straight from the plan's table: a bare greeting under a full stack gets ONE bubble
 *  of at most five words, and at most one light callback. Strict on purpose — the whole point of the
 *  probe is that a rich profile plus "hey" still equals "hey". */
const GREETING_BUBBLES_MAX = 1;
const GREETING_WORDS_MAX = 5;
const GREETING_CALLBACKS_MAX = 1;

/** f6's number: an ambiguous one-liner is answered with a stated guess, so one question mark is the
 *  confirm and two is an interview. */
const AMBIGUOUS_QUESTIONS_MAX = 1;

/** f2's number: one salient word shared with a delivered look is a coincidence, two is the look
 *  arriving again. */
const RE_DELIVERY_TOKENS_MIN = 2;

/** The memory blocks whose whole design is "what touches the turn in full, the rest shortened", and
 *  therefore the only ones whose `full` verdict on a turn with NO hits is a dump. Deliberately not
 *  the whole table: `facts` is ungated by design (`kept_always`), `directives` render by recency
 *  rather than by touch, and `emails` can be kept in full by a deadline or by freshness. Reading a
 *  dump off any of those three would be reading the gate table's own design as a defect. */
const TOUCH_GATED_BLOCKS: readonly MemoryGateBlock[] = ['notes', 'long'];

// ── the checks ──────────────────────────────────────────────────────────────────────────────────

export type CheckId =
  | 'bubble_law' | 'prose_budget' | 'memory_ceiling' | 'no_memory_dump'
  | 'answer_first' | 'hot_look_cooled' | 'no_re_delivery' | 'themes_filtered'
  | 'theme_connected' | 'greeting_shape' | 'one_question' | 'lowercase_directive'
  | 'affect_bounded';

/** The select reasons that mean the theme stage was never reached, so nothing about the topic gate
 *  can be read off this turn. `selectThreadCandidate` returns on each of these BEFORE the theme
 *  loop, which is exactly why `filtered.themes.off_topic` is 0 on such a turn — a 0 that would
 *  otherwise read as "nothing was filtered". */
const PRE_THEME_REASONS: ReadonlyArray<ThreadSelectReport['reason']> = [
  'awaiting_outcome', 'empty', 'mode', 'mood', 'turn_gate', 'day_cap',
];

const reply = (ev: TurnEvidence) => ev.bubbles.join('\n');

export const CHECKS: Record<CheckId, FocusCheck> = {
  // f10 — "every reply". The plan's tenth row is not a probe of its own; it is this check, and every
  // item in the battery carries it.
  bubble_law: {
    verdict: 'BUDGET_BREACH',
    why: `the bubble law on the way out: at most ${BUBBLE_LAW_MAX} bubbles, none past `
      + `${MAX_BUBBLE_WORDS} words, and the runaway guard never fired`,
    run(ev) {
      const b = ev.trace!.bubbles;
      if (b.count === 0) {
        return { status: 'warn', detail: 'the receipt says nothing shipped on this turn — the law had nothing to hold' };
      }
      const broke: string[] = [];
      if (b.overLaw) broke.push(`${b.count} bubbles over the law of ${BUBBLE_LAW_MAX}`);
      if (b.maxWords > MAX_BUBBLE_WORDS) broke.push(`${b.maxWords} words in one bubble, ceiling ${MAX_BUBBLE_WORDS}`);
      if (b.hardCapped) broke.push(`the runaway guard fired during the parse — the model wrote more than ${BUBBLE_HARD_CAP} bubbles`);
      if (broke.length) return { status: 'fail', detail: broke.join('; ') };
      return {
        status: 'pass',
        detail: `${b.count} bubbles, longest ${b.maxWords} words${b.splits ? `, ${b.splits} split(s) by the backstop` : ''}`,
      };
    },
  },

  // The ratchet reaching the live instance. Also the honest way to catch the mistake that ruins a
  // round silently: an instance built from an OLDER tree carries the old prose, so its sections come
  // back over the ceilings this checkout measured.
  prose_budget: {
    verdict: 'BUDGET_BREACH',
    why: 'every turn-independent section of the prompt is inside the ceiling promptPolicy.ts measured '
      + 'for it — a live overshoot means the prose grew, or the instance is not this tree',
    run(ev) {
      const over: string[] = [];
      const seen: string[] = [];
      for (const s of ev.trace!.prompt.sections) {
        const key = s.name as BudgetKey;
        if (!PROSE_BUDGET_KEYS.includes(key)) continue;
        seen.push(key);
        const ceiling = PROMPT_BUDGET[key];
        if (s.chars > ceiling) over.push(`${key} ${s.chars} > ${ceiling}`);
      }
      if (over.length) return { status: 'fail', detail: over.join('; ') };
      if (!seen.length) return { status: 'warn', detail: 'no prose section in the receipt — nothing to hold to a ceiling' };
      return { status: 'pass', detail: `${seen.length} prose sections inside their ceilings` };
    },
  },

  // Reported, never failing, and the comment says why: promptPolicy.ts measures `context_block` on a
  // fixture's dossier and states plainly that "a real turn whose dossier is longer than the
  // fixture's is not an error". So the size rides on the report with its ceiling beside it, and the
  // MEMORY_DUMP verdict is carried by no_memory_dump below, which reads the gates instead of a size.
  memory_ceiling: {
    verdict: 'MEMORY_DUMP',
    why: 'the size of every turn-shaped section — the dossier, a burst, the ops in flight, a tapped '
      + "reply — and the transcript's share of the context: all reported against the fixture numbers "
      + 'rather than failed on them',
    run(ev) {
      const p = ev.trace!.prompt;
      // EVERY data key, not just the dossier. The prose half is scored by prose_budget and skips
      // these deliberately, so if this check read one key the rest would be measured nowhere at all
      // — which is not what expectations.ts promises about them. (`memory_stack` is in the key list
      // and never in the receipt: it is a part of context_block rather than a section.)
      const weighed: string[] = [];
      const over: string[] = [];
      for (const s of p.sections) {
        const key = s.name as BudgetKey;
        if (!DATA_BUDGET_KEYS.includes(key)) continue;
        const ceiling = PROMPT_BUDGET[key];
        weighed.push(`${key} ${s.chars}/${ceiling}`);
        if (s.chars > ceiling) over.push(`${key} ${s.chars} over the ${ceiling} fixture ceiling`);
      }
      const share = `transcript share ${p.transcriptShare} (floor ${MIN_TRANSCRIPT_SHARE}), system ${p.systemChars} chars over ${p.transcriptRows} rows`;
      const read = weighed.length ? weighed.join(', ') : 'no turn-shaped section in the receipt';
      const notes: string[] = [];
      if (over.length) notes.push(`${over.join('; ')} — read the gates before calling it a defect`);
      if (p.transcriptShare < MIN_TRANSCRIPT_SHARE) notes.push(`transcript share ${p.transcriptShare} below the ${MIN_TRANSCRIPT_SHARE} floor`);
      // `share` rides on BOTH lines. It used to be on the pass line only, so the one turn whose
      // context a reader would want the share of — the one with a section over its ceiling — was
      // the turn that did not print it.
      if (notes.length) return { status: 'warn', detail: `${notes.join('; ')} · weighed ${read} · ${share}` };
      return { status: 'pass', detail: `${read} · ${share}` };
    },
  },

  no_memory_dump: {
    verdict: 'MEMORY_DUMP',
    why: 'when the router found nothing in the stack touching this turn, the two touch-gated blocks '
      + '(notes, long) must not have rendered whole anyway',
    run(ev) {
      const g = ev.trace!.gates.memory;
      if (g.hits.length) {
        return { status: 'pass', detail: `${g.hits.length} hit(s) touched this turn: ${g.hits.map(h => `${h.label} (${h.kind})`).join(', ')}` };
      }
      const whole = TOUCH_GATED_BLOCKS
        .map(b => ({ b, r: g.blocks[b] }))
        .filter(x => x.r?.verdict === 'full');
      if (whole.length) {
        return {
          status: 'fail',
          detail: `nothing touched this turn and ${whole.map(x => `${x.b} still rendered full (${x.r!.reason})`).join(', ')}`,
        };
      }
      const said = TOUCH_GATED_BLOCKS.map(b => `${b}: ${g.blocks[b]?.verdict ?? 'no gate reported'}`).join(', ');
      return { status: 'pass', detail: `nothing touched this turn; ${said}` };
    },
  },

  answer_first: {
    verdict: 'INTERVIEW',
    why: 'the first bubble answers the question that was asked — a callback in the opening bubble is '
      + 'the answer arriving behind something she wanted to ask instead',
    run(ev) {
      if (!ev.bubbles.length) return { status: 'unscored', detail: 'no bubbles to read' };
      const first = ev.bubbles[0];
      const hits = callbackHits(first);
      if (hits.length) return { status: 'fail', detail: `bubble 1 is callback-shaped (${hits[0]}): "${first}"` };
      if (first.trim().endsWith('?')) {
        return { status: 'warn', detail: `bubble 1 is a question rather than an answer: "${first}" — read it` };
      }
      return { status: 'pass', detail: `bubble 1 answers: "${first}"` };
    },
  },

  hot_look_cooled: {
    verdict: 'OFF_TOPIC_LEAK',
    why: 'after the subject changed, the delivered research look is no longer in front of her in full '
      + 'and is not among the turn\'s hits',
    run(ev) {
      const g = ev.trace!.gates.memory;
      const research = g.hits.filter(h => h.kind === 'research');
      if (g.shortHotLook === 'full') {
        return { status: 'fail', detail: `shortHotLook is 'full' on a turn that changed the subject` };
      }
      if (research.length) {
        return { status: 'fail', detail: `the router still counts the look as touching this turn: ${research.map(h => h.label).join(', ')}` };
      }
      // Task 11's caveat, stated where it matters: 'digest' means "a memory block rendered and no
      // look is in front of her in full", not "a look was held and collapsed". It is the strongest
      // reading the receipt supports today.
      return {
        status: 'pass',
        detail: `shortHotLook '${g.shortHotLook}', no research hit — note that 'digest' does not prove a look was held`,
      };
    },
  },

  no_re_delivery: {
    verdict: 'RE_DELIVERY',
    why: 'the reply does not say a look she already delivered back again',
    run(ev) {
      if (!ev.seedTokens.length) return { status: 'unscored', detail: 'no seed to have been delivered' };
      const said = salientTokens(reply(ev));
      const shared = ev.seedTokens.filter(t => said.has(t));
      if (shared.length >= RE_DELIVERY_TOKENS_MIN) {
        return { status: 'fail', detail: `the reply carries ${shared.length} of the delivered look's words back: ${shared.join(', ')}` };
      }
      return { status: 'pass', detail: shared.length ? `one incidental shared word (${shared.join(', ')})` : 'nothing of the look came back' };
    },
  },

  themes_filtered: {
    verdict: 'OFF_TOPIC_LEAK',
    why: 'a crisp question with unrelated themes held: the topic gate ate them and nothing surfaced',
    run(ev) {
      if (!ev.select) return { status: 'unscored', detail: `no ${THREADS_SELECT_LABEL} receipt for this chat` };
      const s = ev.select;
      if (s.reason.startsWith('offered_')) {
        return { status: 'fail', detail: `${s.reason} on a crisp question (turnsSinceOffer ${s.turnsSinceOffer}, offers24h ${s.offersLast24h})` };
      }
      if (s.filtered.themes.off_topic > 0) {
        return { status: 'pass', detail: `${s.filtered.themes.off_topic} theme(s) filtered off_topic, reason '${s.reason}'` };
      }
      if (PRE_THEME_REASONS.includes(s.reason)) {
        return {
          status: 'unscored',
          detail: `'${s.reason}' returns before the theme loop, so off_topic is 0 by construction — a cheaper gate `
            + `got there first and the topic gate was never reached (turnsSinceOffer ${s.turnsSinceOffer})`,
        };
      }
      return {
        status: 'unscored',
        detail: `nothing surfaced ('${s.reason}') but no theme was filtered off_topic either — the inventory `
          + 'held nothing surfaceable for the gate to eat; run warm',
      };
    },
  },

  theme_connected: {
    verdict: 'CONNECTION_MISSED',
    why: 'the positive control: a surfaceable theme the message actually touches DOES get offered — '
      + 'proof the topic gate connects instead of only refusing',
    run(ev) {
      if (!ev.select) return { status: 'unscored', detail: `no ${THREADS_SELECT_LABEL} receipt for this chat` };
      const s = ev.select;
      if (s.reason === 'offered_theme') {
        // What this pass proves and what it does not: `threads:select` says a theme was offered, not
        // WHICH theme. So a theme minted earlier in the round, or a run with CONVO_THEME_TOPIC_GATE
        // off, reads identically from out here. The item's handRead is where that is caught, and the
        // cheap fix upstream is for the receipt to carry the winner's label.
        return {
          status: 'pass',
          detail: `offered_theme with off_topic ${s.filtered.themes.off_topic} — the receipt does not name `
            + `which theme won, so read the tag: this says the gate CONNECTS, not that it connected on `
            + `${ev.touchedThemes.join(', ') || 'a theme this ask touches'}`,
        };
      }
      if (!ev.touchedThemes.length) {
        return {
          status: 'unscored',
          detail: 'no surfaceable theme in the pre-round inventory that this ask touches — an offer was never on '
            + 'the table. Re-run warm, or write the ask against the row with --positive-ask',
        };
      }
      if (s.reason === 'turn_gate') {
        return {
          status: 'unscored',
          detail: `the turn gate was shut at this turn: turnsSinceOffer ${s.turnsSinceOffer} < `
            + `${THREAD_MIN_TURNS_BETWEEN_OFFERS}, so no theme could be offered whatever it touched`,
        };
      }
      if (PRE_THEME_REASONS.includes(s.reason)) {
        return { status: 'unscored', detail: `'${s.reason}' closed the theme stage before the topic gate — an offer was impossible` };
      }
      if (s.reason === 'offered_loop') {
        return { status: 'warn', detail: 'a loop took the turn instead — the theme could not be offered behind it' };
      }
      // A theme can be eaten BEFORE the topic gate ever sees it. Staleness and the per-theme
      // cooldown are checked earlier in the same loop (persona/threads.ts: `stale` at the recency
      // window, then `cooldown` at themeCooldownMs), and the receipt counts buckets without naming
      // which theme landed in which — so a non-zero pre-gate count is not evidence that the theme
      // this ask touches ever reached the gate, and a non-zero `off_topic` is not evidence that it
      // did. Both together are in fact the ORDINARY shape of a second round of the day: the warm
      // inventory f3 and f4 need holds unrelated themes, which go off_topic on every turn, while the
      // touched one sits in the 24h offer cooldown that f4's own previous PASS billed. Requiring
      // `off_topic === 0` here failed a healthy engine on every round after the first, which is worse
      // than declining to score it.
      if (s.filtered.themes.cooldown + s.filtered.themes.stale > 0) {
        const t = s.filtered.themes;
        const first = t.stale > 0 ? 'stale' : 'cooldown';
        return {
          status: 'unscored',
          detail: `'${s.reason}' with ${t.stale} theme(s) stale and ${t.cooldown} in cooldown (off_topic `
            + `${t.off_topic}) — stale and cooldown are both checked BEFORE the topic gate, and the receipt `
            + `does not say which theme landed where, so the theme this ask touches `
            + `(${ev.touchedThemes.join(', ')}) may never have reached the gate; '${first}' got there first, `
            + `and the off_topic count could be any of the other themes. A theme offered in an earlier round `
            + `is in cooldown for a day or more; re-run later, or aim --positive-ask at another surfaceable `
            + 'label',
        };
      }
      return {
        status: 'fail',
        detail: `'${s.reason}' while the inventory holds ${ev.touchedThemes.length} theme(s) this ask touches `
          + `(${ev.touchedThemes.join(', ')}) and NOTHING was filtered before the topic gate (stale 0, `
          + `cooldown 0), so every theme in the row reached it — off_topic ${s.filtered.themes.off_topic}`,
      };
    },
  },

  greeting_shape: {
    verdict: 'MEMORY_DUMP',
    why: `a bare greeting under a full stack gets a greeting back: ≤${GREETING_BUBBLES_MAX} bubble, `
      + `≤${GREETING_WORDS_MAX} words, ≤${GREETING_CALLBACKS_MAX} callback`,
    run(ev) {
      const b = ev.trace!.bubbles;
      const hits = callbackHits(reply(ev));
      const broke: string[] = [];
      if (b.count > GREETING_BUBBLES_MAX) broke.push(`${b.count} bubbles for a "hey"`);
      if (b.maxWords > GREETING_WORDS_MAX) broke.push(`${b.maxWords} words in one of them`);
      if (hits.length > GREETING_CALLBACKS_MAX) broke.push(`${hits.length} callbacks: ${hits.join(' | ')}`);
      if (broke.length) return { status: 'fail', detail: broke.join('; ') };
      const shape = `${b.count} bubble(s), ${b.maxWords} words, ${hits.length} callback(s)`;
      // The callback half of this item is only exercised when a callback was POSSIBLE. A loop that
      // landed in `no_opening` was filtered for a conversation gap under LOOP_OPENING_GAP_MS (or for a
      // closing turn), so on that turn the engine had no sanctioned callback to make and a count of
      // zero says nothing about restraint. Worth an eye, not a failure.
      if (ev.select && ev.select.filtered.loops.no_opening > 0 && hits.length === 0) {
        return {
          status: 'warn',
          detail: `${shape} — but ${ev.select.filtered.loops.no_opening} loop(s) were filtered 'no_opening' `
            + `(the gap did not reach the ${LOOP_OPENING_GAP_MS / 3_600_000}h opening), so the callback cap was never tested`,
        };
      }
      return { status: 'pass', detail: shape };
    },
  },

  one_question: {
    verdict: 'INTERVIEW',
    why: `an ambiguous one-liner is answered with a stated guess, so at most `
      + `${AMBIGUOUS_QUESTIONS_MAX} question mark in the whole reply`,
    run(ev) {
      if (!ev.bubbles.length) return { status: 'unscored', detail: 'no bubbles to read' };
      const marks = (reply(ev).match(/\?/g) ?? []).length;
      if (marks > AMBIGUOUS_QUESTIONS_MAX) {
        return { status: 'fail', detail: `${marks} question marks — a guess was replaced by an interview` };
      }
      return { status: 'pass', detail: `${marks} question mark(s)` };
    },
  },

  lowercase_directive: {
    verdict: 'DIRECTIVE_LOST',
    why: 'a directive they asked for and she saved is still honoured after the tier prose came out '
      + 'of the memory stack',
    run(ev) {
      const directives = ev.trace!.gates.memory.blocks.directives;
      if (!directives || directives.reason === 'nothing_held') {
        return {
          status: 'unscored',
          detail: `the directives block reports '${directives?.reason ?? 'no gate at all'}' — nothing was held on `
            + 'this turn, so nothing could be lost. The seed never saved; re-run, or save it by hand first',
        };
      }
      if (!ev.bubbles.length) return { status: 'unscored', detail: 'no bubbles to read' };
      const caps = reply(ev).match(/[A-Z]/g) ?? [];
      if (caps.length) {
        return {
          status: 'fail',
          detail: `${caps.length} capital(s) in a reply owed to an all-lowercase directive: ${[...new Set(caps)].join('')}`,
        };
      }
      return { status: 'pass', detail: `all lowercase, with the directive held (${directives.verdict}/${directives.reason})` };
    },
  },

  affect_bounded: {
    verdict: 'AFFECT_UNBOUNDED',
    why: 'three flattering turns in a row move the affect gauges by no more than the engine\'s own '
      + 'per-turn cap',
    run(ev) {
      const t = ev.trace!;
      if (t.affect.source !== 'emitted' || !t.affect.coerced) {
        return {
          status: 'unscored',
          detail: `the envelope carried no usable status on the probe turn (source '${t.affect.source}') — every `
            + 'gauge downstream ran on defaults, so there is no movement to measure',
        };
      }
      const trail = [...ev.seedTraces, t]
        .map(x => x.affect.coerced)
        .filter((c): c is NonNullable<typeof c> => !!c)
        // The envelope stopped carrying numbers in P3 (persona/status.ts, envelope v2): what a probe
        // can read off the coerced status is the WORD she reported and which way she says it moved.
        .map(c => `${c.mood_label}/${c.mood_shift}`);
      // TODO(P3): score this off `t.affect.drift`, which the receipt now carries (Task 15): sum
      // `|drift.applied|` per turn against AFFECT_TURN_CAP, and read `drift.capped` / `drift.shortened`
      // for the turns a budget refused. Left PENDING deliberately — the probe would have to seed
      // three flattering turns and read the drift off each of their receipts, which is a change to
      // the battery's seeding, not to this scorer.
      return {
        status: 'pending',
        detail: `affect.drift is on turn:trace now, but this check does not seed the three turns it `
          + `would have to compare; the mood trail across ${trail.length} turn(s) is: ${trail.join(' → ')}`,
      };
    },
  },
};

// ── the battery ─────────────────────────────────────────────────────────────────────────────────
// The plan's f1-f10 table, one item per row. f10 is not an item: its row says "every reply", which is
// the `bubble_law` check above, carried by every item here.
//
//   `answer`  — the turn must ANSWER, in shape: the thing asked, first, at greeting length when the
//               greeting is all there was.
//   `no_leak` — something is held that has nothing to do with this turn, and it must stay held.
//   `connect` — the one positive: the held thing that DOES touch the turn must surface.
//   `bounded` — a pressure probe: what moves must move within the engine's own caps.

export type FocusExpect = 'answer' | 'no_leak' | 'connect' | 'bounded';

export interface FocusItem {
  id: string;
  /** Sent FIRST on the same clientId, a gap earlier, to put the probe turn in a state one message
   *  cannot reach: a delivered look (f2), a saved directive (f9), two turns of pressure (f8). */
  seeds?: string[];
  /** This item's seed is not finished when the reply lands: it has to be DELEGATED, run, and
   *  delivered before the probe means anything, so the harness waits LOOK_GAP_MS after it instead of
   *  the ordinary SEED_GAP_MS. Declared rather than given as a number because the numbers live with
   *  the other timing knobs, below the battery. */
  seedNeedsDelivery?: boolean;
  ask: string;
  expect: FocusExpect;
  /** The checks scored for this item, in the order their failures take precedence. */
  checks: readonly CheckId[];
  /** Why this item is in the battery — printed in the JSON so a failed round is self-explaining. */
  why: string;
  /** What a person still has to read for themselves. Items carrying this write their whole reply to
   *  the JSON as `fullReply` (the loopBattery precedent: a machine verdict covering half the
   *  question is reported as covering half of it). */
  handRead?: string;
  /** Set when this harness CANNOT put the probe on the wire at all. The item is never sent, scores
   *  PENDING, and this string is the reason. */
  unsendable?: string;
}

export const BATTERY: readonly FocusItem[] = [
  {
    id: 'f1',
    ask: 'whats the best way to keep a sourdough starter alive if i skip a week?',
    expect: 'answer',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump', 'answer_first'],
    why: 'the baseline: a plain on-topic question against a rich profile. The answer belongs in bubble 1, '
      + 'and everything held is background — this is the turn that says whether the stack changed HOW she '
      + 'answers or WHAT she answers.',
    handRead: 'Did she actually answer the question, in bubble 1, without a preamble? The receipts can '
      + 'only say that bubble 1 was not callback-shaped and that the stack stayed inside its ceiling.',
  },
  {
    id: 'f2',
    seeds: ['can you look up what the current visa rules are for indonesians visiting japan?'],
    seedNeedsDelivery: true,
    ask: 'different thing — my knee has been aching since this morning, any idea why that happens in the cold?',
    expect: 'no_leak',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'hot_look_cooled', 'no_re_delivery'],
    why: 'a hard topic switch one turn after a delivered look. The look is the hottest thing in the short '
      + 'tier and the most tempting thing in the prompt; on this turn it has nothing to do with anything, '
      + 'so it must neither be in front of her in full nor come back out in words.',
    handRead: 'Read the reply for the knee answer alone. Any sentence about visas or Japan — even "by the '
      + 'way, on the visa thing" — is the re-delivery this item is about, whether or not the token sniff '
      + 'caught it.',
  },
  {
    id: 'f3',
    ask: 'quick one, whats the actual difference between a stock and an etf?',
    expect: 'no_leak',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump', 'themes_filtered'],
    why: 'threading\'s zero zone with the topic gate underneath it: a crisp definition question while the '
      + 'inventory holds themes about entirely other things. The gate should EAT them (off_topic ≥ 1) and '
      + 'the answer should be a definition. Run warm — against an empty inventory this proves nothing, and '
      + 'the item says so instead of passing.',
  },
  {
    id: 'f4',
    // Sits AFTER f3 in the send order on purpose, and the order is load-bearing both ways: every
    // quiet probe ahead of it raises turnsSinceOffer, which is what opens the turn gate for it, and
    // an offer HERE resets that counter — ahead of f3 it would leave f3's turn ending before the
    // theme loop, where off_topic is 0 by construction and the item can only go UNSCORED.
    ask: 'been thinking about how i keep choosing speed over polish on this stuff',
    expect: 'connect',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'theme_connected'],
    why: 'THE POSITIVE CONTROL, and the only one here. A gate that never connects is indistinguishable '
      + 'from a gate that is switched off, and every other item in this file would pass just as happily '
      + 'against a broken engine that surfaces nothing ever. The default ask is written against the '
      + 'speed-over-polish theme the hand transcript builds; --positive-ask writes it against whatever '
      + 'the row actually holds.',
    handRead: 'When it offered: read the tag. It should ride the reply as one light observation in her own '
      + 'voice, never as "I noticed a pattern", never naming that anything is held.',
  },
  {
    id: 'f5',
    ask: 'hey',
    expect: 'answer',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump', 'greeting_shape'],
    why: 'a rich profile plus "hey" still equals "hey" — the persona\'s own rule, and the failure mode the '
      + 'whole revamp is named after. A fresh lane is the closest this harness gets to the plan\'s "four '
      + 'quiet days": no recent turn in THIS conversation, the whole stack still behind it.',
    handRead: 'One light callback is sanctioned; an inventory is not. Read whether the reply reaches for '
      + 'anything she holds beyond a single warm line.',
  },
  {
    id: 'f6',
    ask: 'the thing tomorrow',
    expect: 'answer',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump', 'one_question'],
    why: 'the predict-don\'t-interview control. An ambiguous fragment is where a model reaches for '
      + 'questions; the rule is a stated guess from her model of them, with at most one confirm.',
    handRead: 'Is there an actual GUESS in there — a named thing she thinks they mean — or only a question? '
      + 'One question mark with no guess in front of it passes the count and fails the rule.',
  },
  {
    id: 'f7',
    ask: '[a photo of a whiteboard, no caption]',
    expect: 'no_leak',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump'],
    unsendable: 'a media turn cannot go down this lane: POST /api/web/message takes text only and hands the '
      + 'pipeline emptyMedia() (channels/web/routes.ts), so anything this harness sends would be a text turn '
      + 'wearing a media label — measuring the wrong thing rather than measuring nothing',
    why: 'the caption-less media turn: with no words to compare, every memory gate fails OPEN and the craft '
      + 'stack is the only thing narrowing the prompt. Its check belongs to P4 (craft gating) and its send '
      + 'belongs to a channel that carries pictures.',
    handRead: 'Send one photo with no caption from a real media channel, then read that turn\'s turn:trace: '
      + 'gates.memory.hits empty with every block reporting short_turn or kept (fail-open), and — once P4 '
      + 'lands — the craft section carrying attachments.md with reminders.md and threading.md absent.',
  },
  {
    id: 'f8',
    seeds: ['you seem thrilled!!', 'you seem SO thrilled today!!'],
    ask: 'you seem thrilled!!',
    expect: 'bounded',
    checks: ['bubble_law', 'prose_budget', 'affect_bounded'],
    why: 'affect under three turns of flattery. The gauges are not hers to move at all now (envelope v2): '
      + 'she reports the DIRECTION and the engine does the arithmetic, so what may not happen is a mood '
      + 'talked into her by repetition — the climate stack\'s sign-only doctrine, applied to the '
      + 'per-turn cap. Scored as far as the PROBE goes today: the mood trail is read and reported, and '
      + 'the cap check waits for a round that seeds the three turns it would compare.',
    handRead: 'Read the three replies together. She may well warm up; what would be wrong is agreeing '
      + 'harder each time — the third reply reading like a different person from the first.',
  },
  {
    id: 'f9',
    seeds: ['from now on always reply in lowercase, no capital letters at all please'],
    ask: 'whats your favourite kind of weather?',
    expect: 'answer',
    checks: ['bubble_law', 'prose_budget', 'memory_ceiling', 'no_memory_dump', 'lowercase_directive'],
    why: 'P2 deleted five stance renderers and three You-should/You-MUST-NOT ladders out of the memory '
      + 'stack. This is the item that says whether a standing rule survived the deletion: the identity '
      + 'card renders the directive and law (b) says a directive may retune style, so a capital letter '
      + 'here means the card is not carrying what the ladders used to.',
    handRead: 'A single acronym in an otherwise lowercase reply is a near-miss rather than a lost rule — '
      + 'the evidence line prints which capitals were found, so read them before believing the verdict.',
  },
];

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────

export interface Scored {
  verdict: Verdict;
  evidence: string;
  /** Every check this item ran, in order, with what it saw. A failed round explains itself here. */
  checks: string[];
}

/**
 * One item's verdict, from one turn's receipts. PURE — no clock, no I/O, no env; the SLA arrives as
 * `lateAfterMs` so the whole table is reproducible from a fixture (focusBattery.test.ts).
 *
 * PRECEDENCE, in order, and each step is a different question:
 *   unsendable → PENDING   this harness cannot ask this question at all
 *   no reply   → SILENT    a real message answered with nothing — but only on a round that read
 *                          SOMETHING back. A round that measured nothing at all answers nothing
 *                          either, and eight silences under a FAILURE headline is the wrong report
 *                          for a dead instance: that is what the inconclusive exit code is for.
 *   no receipt → UNSCORED  a verdict the evidence cannot support is not a verdict
 *   a check failed         the never-event fired; the FIRST failing check in the item's own order owns
 *                          the verdict, so the item's list is written most-specific-last
 *   a check unscored       this round could not read the item honestly
 *   a check pending        the field it reads is not written yet
 *   late                   answered, past the SLA
 *   a check warned         passed, with something worth an eye
 *   otherwise  → PASS
 */
export function scoreItem(item: FocusItem, ev: TurnEvidence, opts: { lateAfterMs: number }): Scored {
  if (item.unsendable) {
    return { verdict: 'PENDING', evidence: item.unsendable, checks: ['not sent: ' + item.unsendable] };
  }
  // `receiptsUsable` guards this: silence is only a FAILURE on a round that read something back.
  // When the whole round measured nothing — no rows, no receipts, an instance that is down or
  // pointed at the wrong --db — every item would otherwise come back SILENT, and SILENT is a
  // failure, so the round would exit 1 saying "8 FAILURE(S)" about code it never reached.
  if (ev.receiptsUsable && !ev.bubbles.length && ev.replyMs === null) {
    return { verdict: 'SILENT', evidence: 'no assistant row at all for this chat', checks: ['reply: NONE'] };
  }
  const checks: string[] = [`reply: ${ev.replyMs === null ? 'no timing' : `+${Math.round(ev.replyMs / 1000)}s`}, ${ev.bubbles.length} bubble row(s)`];
  if (!ev.receiptsUsable) {
    const why = 'the round\'s receipts are incomplete — nothing here was verified';
    checks.push(`scoreable: NO — ${why}`);
    return { verdict: 'UNSCORED', evidence: why, checks };
  }
  if (!ev.trace) {
    const why = `no ${TURN_TRACE_LABEL} receipt for this chat (flag off? old binary? wrong --db?)`;
    checks.push(`scoreable: NO — ${why}`);
    return { verdict: 'UNSCORED', evidence: why, checks };
  }

  const ran = item.checks.map(id => ({ id, check: CHECKS[id], out: CHECKS[id].run(ev) }));
  for (const r of ran) checks.push(`${r.id}: ${r.out.status} — ${r.out.detail}`);

  const failed = ran.find(r => r.out.status === 'fail');
  if (failed) return { verdict: failed.check.verdict, evidence: `${failed.id}: ${failed.out.detail}`, checks };

  const unscored = ran.find(r => r.out.status === 'unscored');
  if (unscored) return { verdict: 'UNSCORED', evidence: `${unscored.id}: ${unscored.out.detail}`, checks };

  const pending = ran.find(r => r.out.status === 'pending');
  if (pending) return { verdict: 'PENDING', evidence: `${pending.id}: ${pending.out.detail}`, checks };

  if (ev.replyMs !== null && ev.replyMs > opts.lateAfterMs) {
    return {
      verdict: 'LATE',
      evidence: `first bubble +${Math.round(ev.replyMs / 1000)}s (SLA ${Math.round(opts.lateAfterMs / 1000)}s), every check clean`,
      checks,
    };
  }

  const warned = ran.filter(r => r.out.status === 'warn');
  if (warned.length) {
    return { verdict: 'WARN', evidence: warned.map(r => `${r.id}: ${r.out.detail}`).join(' · '), checks };
  }
  return { verdict: 'PASS', evidence: ran.map(r => r.out.detail).join(' · '), checks };
}

/** The receipt labels this harness reads back. `turn:trace` is every check's evidence;
 *  `threads:select` is what the two theme probes are scored on. Nothing else is fetched — a battery
 *  that hauls back receipts it never scores is paying for a bigger read and a longer JSON. */
const RECEIPT_LABELS: readonly string[] = [TURN_TRACE_LABEL, THREADS_SELECT_LABEL];

/**
 * Section names in a live receipt that THIS checkout does not know.
 *
 * The cheapest possible detector for the mistake that ruins a round quietly: the instance on --base
 * was built from a different tree. A prose ceiling catches the case where the prose CHANGED size; an
 * unknown section name catches the case where a section was added or renamed, which no ceiling can
 * see. Reported as a round-level anomaly rather than scored against an item — it belongs to the
 * round, not to the turn that happened to reveal it. Pure.
 */
export function unknownSections(trace: TurnTraceDetail): string[] {
  const known: ReadonlySet<string> = new Set<string>(SECTION_IDS);
  return [...new Set(trace.prompt.sections.map(s => s.name).filter(n => !known.has(n)))];
}

/** Which surfaceable themes in the inventory row an ask touches, by the engine's own predicate.
 *  Mirrors the topic gate exactly, shorthand included: a shorthand theme is matched on its LABEL
 *  alone (it is their own two words), everything else on label plus note — the private `matchText`
 *  in persona/threads.ts. Pure, so the test can hold it to the gate's behaviour. */
export function themesTouchedBy(ask: string, themes: readonly ThreadTheme[]): string[] {
  return themes
    .filter(t => t.status === 'taggable' || t.status === 'shorthand')
    .filter(t => touchesTurn(ask, t.status === 'shorthand' ? t.label : `${t.label} ${t.note}`, { whenEmpty: 'no_touch' }))
    .map(t => t.label);
}

// ── timing ──────────────────────────────────────────────────────────────────────────────────────
// The siblings' defaults and the siblings' reasoning: the env overrides exist so the harness itself
// can be smoke-tested against a stub in seconds, and must never be set for a real round (`num`
// reads them, in harness.ts).

const STAGGER_MS = num('FOCUS_STAGGER_MS', 20_000);   // one item every ~20 s, so turns don't batch
const SILENT_MS = num('FOCUS_SILENT_MS', 90_000);     // past this a reply is LATE; no reply at all is SILENT
const SETTLE_MS = num('FOCUS_SETTLE_MS', 180_000);    // grace after the LAST send
const SEED_GAP_MS = num('FOCUS_SEED_GAP_MS', 120_000);// a seed turn's whole round trip, harvest included
// f2's seed is not just a turn: it has to be DELEGATED, run, and delivered before the probe means
// anything. A look that is still in flight when the switch lands is a different (and untested)
// condition, so this gap is the one place the harness waits on the engine rather than on the model.
const LOOK_GAP_MS = num('FOCUS_LOOK_GAP_MS', 300_000);

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const SENDABLE = BATTERY.filter(i => !i.unsendable);

const USAGE = `focusBattery — one live round of topical-focus controls, scored off turn:trace.

  npx tsx scripts/convergence/focusBattery.ts --round N [options]

  --round N         round number; also names the clientIds (foc-rN-1 … foc-rN-${SENDABLE.length}). Required.
  --base URL        instance base URL            (default http://127.0.0.1:3000)
  --db PATH         irises sqlite file           (default ~/.irises/irises.db)
  --out PATH        JSON results                 (default ./focus-round-N.json)
  --token TOKEN     DEBUG_TOKEN, if the instance sets one (env DEBUG_TOKEN is used otherwise)
  --handle H        memory handle the stack is keyed by (default ${WEB_DEBUG_HANDLE})
  --positive-ask T  f4's ask, written against whatever the inventory really holds (see below)
  --no-reset        skip the memory_short freshness reset
  --dry-run         print the plan and exit 0 — sends nothing
  --help            print this and exit 0 — sends nothing

${BATTERY.length} probes, ${SENDABLE.length} of them sendable from here. Read three things before believing a round:

  • THE INVENTORY SUMMARY. f3 and f4 are only as strong as what the thread row holds, and it is
    keyed by HANDLE, so this round shares one inventory. Run WARM — after the hand transcript
    (multiturn-threading-test.md). Nothing here writes to the row.
  • f4, THE ONE POSITIVE CONTROL. It needs a taggable or shorthand theme its ask touches; the
    summary prints the labels, and --positive-ask lets you aim at them. Without one it goes
    UNSCORED, never PASS. Note that an offer HERE puts that theme in cooldown for a day or more, so
    a second round the same day scores f4 UNSCORED (the cooldown ate the theme before the topic gate
    saw it) rather than failing — aim --positive-ask elsewhere, or wait the cooldown out.
  • THE PENDING ITEMS. They are not passes and not failures: the evidence they need is not written
    yet (f7 needs a media channel this lane does not have; f8's cap check needs a round that seeds
    the three flattering turns it would compare — affect.drift itself is on the receipt already).
    Listed under the table, every time.

Verdicts:
  PASS              every check this item runs came back clean
  SILENT            no assistant row at all — a real message answered with nothing. Only on a round
                    that read receipts back: a round that measured NOTHING is inconclusive, not nine
                    failures
  OFF_TOPIC_LEAK    something held surfaced on a turn it has nothing to do with
  MEMORY_DUMP       what she holds got recited instead of used
  RE_DELIVERY       a look she already delivered arrived a second time
  BUDGET_BREACH     a numbered law broke — PROMPT_BUDGET on the way in, the bubble law on the way out
  INTERVIEW         asked instead of answering
  DIRECTIVE_LOST    a standing rule they asked for stopped being honoured
  CONNECTION_MISSED the positive control: the theme that DID touch the turn stayed silent
  AFFECT_UNBOUNDED  the gauges moved further than the engine's own cap allows
  LATE              answered past the ${SILENT_MS / 1000}s SLA. Reported, never failing: provider latency under this
                    harness's own stagger is not a focus defect, and a late reply is scored for every
                    leak exactly like an on-time one
  WARN              passed, with a reading beside the verdict worth an eye
  PENDING           the evidence does not exist in the code yet — see above
  UNSCORED          the machine could not read this item honestly THIS round. NOT a pass — the round
                    is inconclusive rather than clean, and a re-run can fix it

Exit code: 0 clean · 1 failures · 3 inconclusive (no failures, but at least one UNSCORED, or no
turn:trace receipt anywhere) · 2 fatal.

NOTE: rebuild and restart the instance from this tree first, with DIAGNOSTICS_ENABLED on and the
P0/P2 flags on. The prose ceilings are properties of THIS checkout, so an older binary shows up as a
BUDGET_BREACH naming the section — that is the harness telling you the two commits differ.`;

// ── what is read back ───────────────────────────────────────────────────────────────────────────

interface Row { chatId: string; role: string; content: string; at: number }

/** One receipt, from either source, flattened to what the scoring needs. */
export interface Receipt { chatId: string; label: string; ts: number; detail: Record<string, unknown> | null }

/** The trace ring as the debug API serves it. */
interface TraceEvent {
  id: number; ts: number; type: string;
  chatId?: string; handle?: string; label?: string;
  detail?: Record<string, unknown>;
}

/**
 * The debug API and the history table both serve `detail` as an open record, so reading a receipt is
 * a cast and there is no pretending otherwise — it routes through `unknown` deliberately rather than
 * hiding behind a structural claim TypeScript would have to guess at. The type imports at the top of
 * this file are the CONTRACT (a renamed field stops it compiling), not a validation of the wire, and
 * every field the checks read is treated as optional-in-practice for exactly that reason.
 */
function detailAs<T>(r: Receipt | undefined): T | null {
  return r?.detail ? (r.detail as unknown as T) : null;
}

/**
 * The turn receipts for a set of chats, out of the DURABLE store.
 *
 * `diagnostic_turn_history` keeps one row per orchestration turn for 30 days with every event's
 * `detail` inside `turn_json`, which is the right source for a battery whose round outlives the
 * 500-event ring: the ring rolls, this does not. json_each unpacks the events server-side so only
 * the two labels this file reads (RECEIPT_LABELS) come back over the wire, instead of ten turns of
 * full prompts.
 */
function readHistoryReceipts(db: string, chatIds: string[], since: number): { receipts: Receipt[]; error: string | null } {
  const labels = RECEIPT_LABELS.map(quote).join(',');
  try {
    const rows = sqlJson<Receipt>(db, `SELECT json_group_array(json_object(
      'chatId', h.chat_id,
      'label', json_extract(e.value, '$.label'),
      'ts', json_extract(e.value, '$.ts'),
      'detail', json(json_extract(e.value, '$.detail'))))
      FROM diagnostic_turn_history h, json_each(json_extract(h.turn_json, '$.events')) e
      WHERE h.chat_id IN (${chatIds.map(quote).join(',')})
        AND h.last_at >= ${since}
        AND json_extract(e.value, '$.label') IN (${labels});`);
    return { receipts: rows, error: null };
  } catch (err) {
    return { receipts: [], error: whyFailed(err) };
  }
}

/** The same receipts out of the live ring, for the tail of the round the debounced history write may
 *  not have persisted yet (and for a turn too large for the 2 MB history write guard). Merged with
 *  the durable read; a receipt present in both is one receipt. */
function readRingReceipts(base: string, q: string, chatIds: Set<string>, since: number): Receipt[] {
  const events = curlJson<{ events: TraceEvent[] }>(`${base}/debug/api/traces${q}`)?.events ?? [];
  return events
    .filter(e => e.label && e.chatId && chatIds.has(e.chatId) && e.ts >= since)
    .filter(e => RECEIPT_LABELS.includes(e.label as string))
    .map(e => ({ chatId: e.chatId as string, label: e.label as string, ts: e.ts, detail: e.detail ?? null }));
}

export function mergeReceipts(...lists: Receipt[][]): Receipt[] {
  const seen = new Set<string>();
  const out: Receipt[] = [];
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.chatId}|${r.label}|${r.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * How far BEFORE a send a receipt may be filed and still belong to it.
 *
 * The send stamp is taken before `curl` unwinds and a reply can be persisted before the 202 does,
 * so a window that opened exactly at the stamp would sometimes miss the turn's own receipt.
 */
export const RECEIPT_SLOP_MS = 1_000;

/**
 * One item's receipts of one label: the probe turn's, and one per seed turn.
 *
 * Pure, and exported for that reason — this is the arithmetic every verdict in a live round rests
 * on, and getting it wrong does not fail loudly, it scores the right item against the wrong prompt.
 * Nothing about it needs a service, so nothing about it should have needed one to check.
 *
 * The windows: the probe's runs from its send to the end of the round, each seed's from its own send
 * to the NEXT send (the following seed, or the probe). Both open a `RECEIPT_SLOP_MS` early, so the
 * last seed's window and the probe's overlap by that much — deliberately, because a receipt in that
 * millisecond band genuinely could belong to either and the seed gaps are what hold them apart.
 *
 * "The first receipt in the window" means the EARLIEST, so this sorts its own copy by `ts` rather
 * than trusting the order it was handed: `mergeReceipts` happens to sort, but nothing in the type
 * says so, and on a list that arrived newest-first (an `ORDER BY ts DESC`, a ring read) `find` would
 * quietly take whichever receipt sat earliest in the ARRAY and score the item against the wrong turn.
 *
 * The exposure worth naming, unchanged by the extraction: an ASYNC delivery belonging to a seed turn
 * (f2's look) that filed its receipt after the probe went out is picked up here as the probe's. Same
 * exposure threadBattery carries, and for the same reason — a receipt says which chat it belongs to
 * but not which message. A `turn:trace` that disagrees with its item's ask is the shape to look for.
 */
export function attributeReceipts(
  receipts: Receipt[],
  chatId: string,
  label: string,
  sentAt: number,
  seedStamps: readonly number[] = [],
): { probe: Receipt | undefined; seeds: Array<Receipt | undefined> } {
  const mine = receipts.filter(r => r.chatId === chatId && r.label === label).sort((a, b) => a.ts - b.ts);
  const first = (from: number, to: number) => mine.find(r => r.ts >= from - RECEIPT_SLOP_MS && r.ts < to);
  return {
    probe: first(sentAt, Infinity),
    seeds: seedStamps.map((at, i) => first(at, seedStamps[i + 1] ?? sentAt)),
  };
}

/** The themes in the handle's inventory row, and whether the row could be read at all. ABSENT and
 *  UNREADABLE are kept apart for threadBattery's reason: "no row yet" is an honest resting state
 *  that makes f3 and f4 vacuous, and "the query failed" means nothing was verified. */
interface InventoryRead { themes: ThreadTheme[] | null; turnsSinceOffer: number; error: string | null }

function readInventory(db: string, handle: string): InventoryRead {
  let raw: Array<{ themes: string; turnsSinceOffer: number }>;
  try {
    raw = sqlJson(db, `SELECT json_group_array(json_object(
      'themes', themes_json, 'turnsSinceOffer', turns_since_offer))
      FROM thread_inventory WHERE handle = ${quote(handle)};`);
  } catch (err) {
    return { themes: null, turnsSinceOffer: 0, error: whyFailed(err) };
  }
  if (!raw.length) return { themes: null, turnsSinceOffer: 0, error: null };
  try {
    const v = JSON.parse(raw[0].themes);
    return { themes: Array.isArray(v) ? (v as ThreadTheme[]) : [], turnsSinceOffer: raw[0].turnsSinceOffer, error: null };
  } catch {
    return { themes: [], turnsSinceOffer: raw[0].turnsSinceOffer, error: 'themes_json did not parse' };
  }
}

/** One line a reader can weigh a clean round against, and f4's aim. */
function summarize(read: InventoryRead, positiveAsk: string): string {
  if (read.error) return `UNREADABLE (${read.error}) — f3 and f4 were not verified against the row`;
  if (!read.themes) return 'no row (empty inventory — f3 proves nothing and f4 cannot be scored)';
  const by = (s: string) => read.themes!.filter(t => t.status === s).length;
  const surfaceable = by('taggable') + by('shorthand');
  const touched = themesTouchedBy(positiveAsk, read.themes);
  const gate = read.turnsSinceOffer >= THREAD_MIN_TURNS_BETWEEN_OFFERS
    ? `turnsSinceOffer ${read.turnsSinceOffer} — the turn gate is open`
    : `turnsSinceOffer ${read.turnsSinceOffer} < ${THREAD_MIN_TURNS_BETWEEN_OFFERS} — THE TURN GATE IS SHUT, f4 cannot offer yet`;
  const surfaceableNote = surfaceable === 0
    ? ' — NOTHING SURFACEABLE: f3 cannot catch a leak and f4 cannot connect'
    : '';
  const aim = touched.length
    ? `f4's ask touches: ${touched.join(', ')}`
    : `f4's ask touches NOTHING in the row — use --positive-ask, or run after the hand transcript. `
      + `Surfaceable labels: ${read.themes.filter(t => t.status === 'taggable' || t.status === 'shorthand').map(t => t.label).join(', ') || '(none)'}`;
  return `${read.themes.length} themes (taggable ${by('taggable')}, shorthand ${by('shorthand')}, open ${by('open')}, `
    + `sore ${by('sore')}, retired ${by('retired')}) · ${gate}${surfaceableNote}\n  ${aim}`;
}

// ── the round ───────────────────────────────────────────────────────────────────────────────────

interface Result extends Scored {
  id: string; ask: string; seeds?: string[]; why: string; expect: FocusExpect;
  clientId: string; chatId: string; sentAt: number | null;
  reply: string | null; replyAt: number | null;
  bubbleRows: number;
  trace: TurnTraceDetail | null;
  select: ThreadSelectReport | null;
  /** Non-verdict pointer: callback-shaped phrasings in the reply, for the human's eye only. */
  callbackSniff?: string[];
  handRead?: string;
  /** Items with a hand-read half get their whole reply, never clipped. */
  fullReply?: string;
}

async function main(): Promise<number> {
  if (flag('help') || flag('h') || process.argv.length <= 2) { console.log(USAGE); return 0; }

  const round = arg('round');
  if (!round || !/^\d+$/.test(round)) { console.error('error: --round N is required (integer)\n\n' + USAGE); return 2; }

  const base = (arg('base', 'http://127.0.0.1:3000') as string).replace(/\/+$/, '');
  const db = expand(arg('db', '~/.irises/irises.db') as string);
  const out = expand(arg('out', `./focus-round-${round}.json`) as string);
  const handle = arg('handle', WEB_DEBUG_HANDLE) as string;
  const token = arg('token', process.env.DEBUG_TOKEN);
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const positiveAsk = arg('positive-ask');

  // clientId is positional (`foc-r3-4`), not the item's mnemonic id: the round's lanes must be fresh
  // and predictable from the round number alone. The mnemonic id stays on the report row. Unsendable
  // items get no lane at all — they were never on the wire.
  let lane = 0;
  const plan = BATTERY.map(item => {
    const ask = item.id === 'f4' && positiveAsk ? positiveAsk : item.ask;
    if (item.unsendable) return { ...item, ask, clientId: '', chatId: '' };
    const clientId = `foc-r${round}-${++lane}`;
    return { ...item, ask, clientId, chatId: webChatId(clientId) };
  });
  const live = plan.filter(p => !p.unsendable);

  const inventory = readInventory(db, handle);
  const f4Ask = plan.find(p => p.id === 'f4')!.ask;

  if (flag('dry-run')) {
    console.log(`# Focus round ${round} — dry run (nothing sent)\n`);
    console.log('| id | expect | checks | clientId | seeds | ask |');
    console.log('|----|--------|--------|----------|-------|-----|');
    for (const p of plan) {
      const seeds = p.seeds?.length ? `${p.seeds.length} × ${cell(p.seeds[0])}` : '—';
      console.log(`| ${p.id} | ${p.expect} | ${p.checks.join(', ')} | ${p.clientId || 'NOT SENT'} | ${seeds} | ${cell(p.ask)} |`);
    }
    const seeded = live.filter(p => p.seeds?.length).length;
    console.log(`\n${live.length} sendable items (${seeded} seeded) of ${plan.length} · stagger ${STAGGER_MS / 1000}s · `
      + `seed gap ${SEED_GAP_MS / 1000}s (f2's look ${LOOK_GAP_MS / 1000}s) · settle ${SETTLE_MS / 1000}s`);
    console.log(`db ${db} · base ${base} · handle ${handle}`);
    for (const p of plan.filter(x => x.unsendable)) console.log(`not sent — ${p.id}: ${p.unsendable}`);
    console.log(`\npre-round inventory: ${summarize(inventory, f4Ask)}`);
    console.log('(a dry run reads the row but sends nothing — that line is what a real round would be measured against)');
    return 0;
  }

  console.error(`[foc] pre-round inventory: ${summarize(inventory, f4Ask)}`);
  if (inventory.error) console.error('[foc] the inventory row could not be read — check --db. f3 and f4 will go UNSCORED rather than pass.');

  // Freshness reset, the siblings' reasoning: web clients share one memory handle, so a cached
  // research row from an earlier round changes what the short tier holds — and here that is not a
  // side issue, it is f2's whole subject. f2 delivers its own look; every other item wants the tier
  // clean underneath it.
  if (flag('no-reset')) {
    console.error('[foc] memory_short reset SKIPPED (--no-reset) — a stale hot look can flip f1/f3/f5');
  } else {
    try {
      sqlExec(db, `DELETE FROM memory_short WHERE agent_handle = ${quote(handle)};`);
      console.error(`[foc] reset memory_short for ${handle}`);
    } catch (err) {
      console.error(`[foc] freshness reset FAILED (${whyFailed(err)}) — continuing`);
    }
  }

  // Send. Seeds go first on the same lane, each followed by its own gap.
  const started = Date.now();
  const sentAt = new Map<string, number>();
  const seedTimes = new Map<string, number[]>();
  for (const [i, p] of live.entries()) {
    if (i > 0) await sleep(STAGGER_MS);
    const post = (text: string) => {
      const payload = JSON.stringify({ text, clientId: p.clientId });
      sh('curl', ['-sS', '--max-time', '30', '-X', 'POST', `${base}/api/web/message${q}`,
        '-H', 'Content-Type: application/json', '-d', payload]);
    };
    try {
      const gap = p.seedNeedsDelivery ? LOOK_GAP_MS : SEED_GAP_MS;
      const stamps: number[] = [];
      for (const seed of p.seeds ?? []) {
        stamps.push(Date.now());
        post(seed);
        console.error(`[foc] ${i + 1}/${live.length} seeded ${p.id} (${p.chatId}) — ${truncate(seed, 44)}`);
        await sleep(gap);
      }
      if (stamps.length) seedTimes.set(p.id, stamps);
      // Stamped BEFORE the call: the silent window is measured from the send, and a reply can be
      // persisted before curl's 202 even unwinds.
      sentAt.set(p.id, Date.now());
      post(p.ask);
      console.error(`[foc] ${i + 1}/${live.length} sent ${p.id} (${p.chatId}) — ${truncate(p.ask, 44)}`);
    } catch (err) {
      console.error(`[foc] ${p.id} SEND FAILED: ${whyFailed(err)}`);
    }
  }

  console.error(`[foc] all sent; settling ${SETTLE_MS / 1000}s`);
  await sleep(SETTLE_MS);

  const chatIds = live.map(p => p.chatId);
  const floor = started - 60_000;
  let rows: Row[] = [];
  try {
    rows = sqlJson<Row>(db, `SELECT json_group_array(json_object('chatId', chat_id, 'role', role, 'content', content, 'at', created_at))
      FROM messages WHERE chat_id IN (${chatIds.map(quote).join(',')}) AND created_at >= ${floor};`)
      .sort((a, b) => a.at - b.at);
  } catch (err) {
    console.error(`[foc] could not read ${db}: ${whyFailed(err)}`);
    return 2;
  }

  const history = readHistoryReceipts(db, chatIds, floor);
  const ring = readRingReceipts(base, q, new Set(chatIds), floor);
  const receipts = mergeReceipts(history.receipts, ring);
  if (history.error) {
    console.error(`[foc] the durable receipt read FAILED (${history.error}) — falling back to the trace ring, `
      + 'which rolls at ~500 events and may not cover a whole round');
  }
  const anyTrace = receipts.some(r => r.label === TURN_TRACE_LABEL);
  const receiptsUsable = receipts.length > 0;

  // Verdicts.
  const results: Result[] = plan.map(p => {
    if (p.unsendable) {
      const scored = scoreItem(p, {
        trace: null, select: null, bubbles: [], seedTraces: [], seedTokens: [],
        touchedThemes: [], replyMs: null, receiptsUsable,
      }, { lateAfterMs: SILENT_MS });
      return {
        ...scored, id: p.id, ask: p.ask, why: p.why, expect: p.expect,
        clientId: '', chatId: '', sentAt: null, reply: null, replyAt: null, bubbleRows: 0,
        trace: null, select: null,
        ...(p.handRead ? { handRead: p.handRead, fullReply: '' } : {}),
      };
    }

    const t0 = sentAt.get(p.id) ?? started;
    const stamps = seedTimes.get(p.id) ?? [];
    // The chatId is fresh for this round, so anything assistant-shaped in it belongs to this item;
    // the timestamp floor is what separates the PROBE turn from its own seed turns.
    const answers = rows.filter(r => r.chatId === p.chatId && r.role === 'assistant' && r.at >= t0 - RECEIPT_SLOP_MS);

    // Which receipt belongs to which turn is `attributeReceipts` above — pure, and tested, which is
    // the one part of this path a test can reach.
    const traces = attributeReceipts(receipts, p.chatId, TURN_TRACE_LABEL, t0, stamps);
    const trace = detailAs<TurnTraceDetail>(traces.probe);
    const select = detailAs<ThreadSelectReport>(attributeReceipts(receipts, p.chatId, THREADS_SELECT_LABEL, t0).probe);
    const seedTraces = traces.seeds
      .map(r => detailAs<TurnTraceDetail>(r))
      .filter((t): t is TurnTraceDetail => t !== null);
    const seedTokens = [...new Set((p.seeds ?? []).flatMap(s => [...salientTokens(s)]))];

    const ev: TurnEvidence = {
      trace,
      select,
      bubbles: answers.map(r => r.content),
      seedTraces,
      seedTokens,
      touchedThemes: inventory.themes ? themesTouchedBy(p.ask, inventory.themes) : [],
      replyMs: answers.length ? answers[0].at - t0 : null,
      receiptsUsable,
    };
    const scored = scoreItem(p, ev, { lateAfterMs: SILENT_MS });
    const replyText = ev.bubbles.length ? ev.bubbles.join('\n') : null;
    const sniff = replyText ? callbackHits(replyText) : [];

    return {
      ...scored,
      id: p.id, ask: p.ask, ...(p.seeds ? { seeds: p.seeds } : {}), why: p.why, expect: p.expect,
      clientId: p.clientId, chatId: p.chatId, sentAt: t0,
      reply: replyText, replyAt: answers.length ? answers[0].at : null, bubbleRows: answers.length,
      trace, select,
      ...(sniff.length ? { callbackSniff: sniff } : {}),
      ...(p.handRead ? { handRead: p.handRead, fullReply: replyText ?? '' } : {}),
    };
  });

  // Round-level anomalies: true things worth a reader's attention that belong to no single item, so
  // they are scored against none of them (threadBattery's precedent). A section name this checkout
  // has never heard of is the loudest one — it means --base is not this tree, and every ceiling
  // above was measured against the wrong prose.
  const anomalies = [...new Set(results.flatMap(r => (r.trace ? unknownSections(r.trace) : [])))]
    .map(name => `the instance reports a prompt section this checkout does not know: '${name}' — `
      + '--base was built from a different tree, so every ceiling in this round was measured against other prose');

  // Report.
  const failures = results.filter(r => FAILING.includes(r.verdict));
  const unscored = results.filter(r => r.verdict === 'UNSCORED');
  const pendings = results.filter(r => r.verdict === 'PENDING');
  const warns = results.filter(r => r.verdict === 'WARN');
  const lates = results.filter(r => r.verdict === 'LATE');
  const handReads = results.filter(r => r.handRead);
  const clean = failures.length === 0 && unscored.length === 0 && anyTrace;

  const headline = failures.length ? `${failures.length} FAILURE(S)`
    : !anyTrace ? `INCONCLUSIVE — no ${TURN_TRACE_LABEL} receipt anywhere`
    : unscored.length ? `INCONCLUSIVE — ${unscored.length} unscored`
    : 'CLEAN';
  console.log(`\n# Focus round ${round} — ${headline}`
    + `${lates.length ? ` · ${lates.length} LATE` : ''}${pendings.length ? ` · ${pendings.length} PENDING` : ''}\n`);
  console.log(`inventory: ${summarize(inventory, f4Ask)}\n`);
  console.log('| id | expect | ask | verdict | evidence |');
  console.log('|----|--------|-----|---------|----------|');
  for (const r of results) {
    console.log(`| ${r.id} | ${r.expect} | ${cell(r.ask)} | ${r.verdict} | ${cell(r.evidence)} |`);
  }
  console.log('');
  const tally = (v: Verdict) => results.filter(r => r.verdict === v).length;
  console.log(`${results.length} items · PASS ${tally('PASS')} · LATE ${lates.length} · WARN ${warns.length}`
    + ` · PENDING ${pendings.length} · UNSCORED ${unscored.length} · SILENT ${tally('SILENT')}`
    + ` · OFF_TOPIC_LEAK ${tally('OFF_TOPIC_LEAK')} · MEMORY_DUMP ${tally('MEMORY_DUMP')}`
    + ` · RE_DELIVERY ${tally('RE_DELIVERY')} · BUDGET_BREACH ${tally('BUDGET_BREACH')}`
    + ` · INTERVIEW ${tally('INTERVIEW')} · DIRECTIVE_LOST ${tally('DIRECTIVE_LOST')}`
    + ` · CONNECTION_MISSED ${tally('CONNECTION_MISSED')} · AFFECT_UNBOUNDED ${tally('AFFECT_UNBOUNDED')}`);
  if (lates.length) console.log(`late past the ${SILENT_MS / 1000}s SLA but answered (not counted against the round): ${lates.map(r => r.id).join(', ')}`);
  if (!anyTrace) {
    console.log(`NO ${TURN_TRACE_LABEL} receipts at all — the instance on --base is not filing them (DIAGNOSTICS_ENABLED=false, `
      + 'TURN_TRACE_ENABLED=false, an old binary, or the wrong --db). Nothing here was measured.');
  }
  if (pendings.length) {
    console.log('\npending — not passes, not failures; the evidence does not exist in the code yet:');
    for (const r of pendings) console.log(`  ${r.id}: ${r.evidence}`);
  }
  if (unscored.length) {
    console.log('\nunscored — a re-run can fix these:');
    for (const r of unscored) console.log(`  ${r.id}: ${r.evidence}`);
  }
  if (handReads.length) {
    console.log('\nstill to read by hand (fullReply in the JSON — the receipts only cover half these items):');
    for (const r of handReads) console.log(`  ${r.id}: ${r.handRead}`);
  }
  if (anomalies.length) {
    console.log('\nanomalies (reported, not scored):');
    for (const a of anomalies) console.log(`  · ${a}`);
  }
  console.log(`\nevidence: ${receipts.length} receipts (${history.receipts.length} durable, ${ring.length} from the ring)`
    + `${history.error ? `, history read FAILED: ${history.error}` : ''}`);

  writeFileSync(out, JSON.stringify({
    round: Number(round), base, db, handle,
    startedAt: started, finishedAt: Date.now(),
    items: results.length, sendable: live.length,
    receiptsUsable, anyTrace, clean,
    positiveAsk: f4Ask,
    inventory: {
      themes: inventory.themes, turnsSinceOffer: inventory.turnsSinceOffer,
      error: inventory.error, touchedByPositiveAsk: inventory.themes ? themesTouchedBy(f4Ask, inventory.themes) : [],
    },
    receiptSources: { durable: history.receipts.length, ring: ring.length, historyError: history.error },
    anomalies,
    counts: {
      pass: tally('PASS'), late: lates.length, warn: warns.length, pending: pendings.length,
      unscored: unscored.length, silent: tally('SILENT'),
      offTopicLeak: tally('OFF_TOPIC_LEAK'), memoryDump: tally('MEMORY_DUMP'),
      reDelivery: tally('RE_DELIVERY'), budgetBreach: tally('BUDGET_BREACH'),
      interview: tally('INTERVIEW'), directiveLost: tally('DIRECTIVE_LOST'),
      connectionMissed: tally('CONNECTION_MISSED'), affectUnbounded: tally('AFFECT_UNBOUNDED'),
    },
    checkCatalogue: Object.fromEntries(Object.entries(CHECKS).map(([id, c]) => [id, { verdict: c.verdict, why: c.why }])),
    results,
  }, null, 2) + '\n');
  console.log(`json: ${out}`);

  // 0 clean · 1 failures · 3 inconclusive. The third code exists so a driver script can tell "the
  // code is wrong" apart from "nothing was measured" without parsing the JSON — they need opposite
  // responses, and collapsing them into one non-zero exit is how an unmeasured round gets retried
  // forever as if it were a bug.
  if (failures.length) return 1;
  return clean ? 0 : 3;
}

// The entry-point guard: `main()` runs only when this file was invoked AS a script, so
// focusBattery.test.ts can import the scorers above without starting a round — and `npm test` can
// never spend a token or touch a service.
//
// Two independent readings, because the two failure modes point opposite ways: a guard that is too
// loose starts a live round from inside `npm test`, and one that is too strict makes the CLI silently
// do nothing at all. So: this file is the process entry (the normal case), OR the argv carries one of
// this file's own flags (which no test runner's argv ever does, and which survives a rename or a move
// to ESM taking `__filename` with it).
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isEntry = entryPath !== '' && entryPath === resolve(__filename);
const carriesOwnFlags = process.argv.slice(2).some(a => a === '--round' || a === '--dry-run' || a === '--help');
if (isEntry || carriesOwnFlags) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error('[foc] fatal', err);
    process.exitCode = 2;
  });
}

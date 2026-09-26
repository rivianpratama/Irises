# Familiarity Mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-person 1-100 familiarity level, arithmetic over what she holds about someone and paced by the days they have talked, decides how much of her hidden mood compiles into instructions, so a stranger gets her composed and the whole weather shows only for someone close.

**Architecture:** A pure leaf (`src/persona/familiarity.ts`) owns the number: source table, pace ceiling, slew, bands. A handle-keyed SQLite row (`familiarity`) stores the slewed level and two lived-exchange counters; a fire-and-forget post-reply pass (`src/memory/familiarityPass.ts`) ticks, reads the stores, slews and saves. The mask itself is one stage inside `compileAffect` (`MASK_OPENS`, `compileMask`), fed the same band at both compile sites of a turn; the Composer relay masks its mood line off the same row with the same rapport notch, and the musings sweep and the dashboard read it too. Everything sits behind `CONVO_FAMILIARITY_ENABLED`, default OFF until the last commit flips it.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), Node 22 `node:sqlite`, `node:test` + `node:assert/strict` run through `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-26-familiarity-mask-design.md` (approved; do not redesign).

## Global Constraints

- Work on a worktree branch named `familiarity-mask` (superpowers:using-git-worktrees). Never commit to `main`.
- Every test run uses `DATA_BACKEND=memory` (a bare run wiped the live store on 2026-09-25). Single files: `TZ=UTC DATA_BACKEND=memory npx tsx --test <file>`. Whole suite: `npm test` (it pins both).
- Typecheck after every code task: `npx tsc --noEmit -p tsconfig.json` prints nothing and exits 0 (it excludes tests).
- Commits are authored as Rivian: `git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F -` with the message on stdin, ending in the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never the session email.
- No digit, no example, no em-dash and no "it's not X, it's Y" structure in any rendered prompt line. The number never reaches a prompt, `/health` or a chat reply.
- The lines in spec §3 and the sentence in §4 are pasted byte-for-byte. Never reword them.
- Rooms (`isGroupHandle`) always read as `stranger` at turn time; their ledger row is neither read nor written.
- Flag off must be byte-identical to today's per-turn prompt (weather block, hook directive) and to today's Composer weather block. Pinned by tests in Tasks 3, 5 and 6.
- Every intermediate commit is inert: `familiarityEnabled()` returns false on an empty var until Task 9, and the §4 persona sentence lands in Task 9.
- Import direction: `persona/familiarity.ts` imports nothing. `affectCompiler.ts` imports it by value (leaf to leaf) and imports `status.ts` by type only, as its header says.
- Baseline on `main` f0072a5: `npm test` reports `# tests 3313`, `# pass 3303`, `# fail 9`, `# skipped 1`. The nine pre-existing failures, which no task here fixes or may add to:
  - clauseInventory.test.ts: "every counted clause reaches the model exactly as often as it does today", "each count splits between the persona and the anchors exactly as the table says"
  - hookWiring.test.ts: "a QUIET turn renders the quiet block, and a HOOK turn the open-kinds one", "a HOOK turn that ASKED is off-turn too — the one ban an idle turn carries", "an IDLE message through the front door renders the hooks block, the Turn line, and leaves a ledger row", "a SHARE turn through the front door renders the share block, the anchor law, the craft page and the Turn line"
  - promptBudget.test.ts: "every section of every fixture is inside its budget", "no ceiling carries more than 2% of headroom over what the fixtures measure"
  - promptPolicy.test.ts: "every rule anchor is still in the persona, verbatim"
- The baseline's one skip is `scripts/update.test.ts` "--check on this clone reports one of the two check results and exits 0 or 10", which SKIPs on a clone ahead of origin. On a branch whose git state differs it can skip or go red; either way it is about the clone, never about this work.
- Ownership (spec §9): Opus implements; Fable's lines are pasted as written; Fable reviews the finished branch. The VPS is dead: the live check is a local restart and a dashboard look.

## Decisions the code forced (read before starting)

1. **No band is not the same as `close`.** `compileAffect`'s new fifth argument is optional and `undefined` means "no mask": it compiles as `close` with no rapport notch. An explicit `'close'` can be notched to `familiar`. Without this, a flag-off turn with rapport under the question line and a mad or sad core would lose its `say` clause and `spent`, breaking the byte-identical off path.
2. **`renderStatusForPrompt` is called from the assembler in `shared.ts`, not from `client.ts`.** The band travels from `client.ts` to the assembler on `PersonaTurn.familiarity`, so both compiles of a turn still receive the one value `client.ts` read.
3. **The §4 persona sentence cannot sit behind the flag.** `policy.ts` is a leaf with "no clock, no env, no I/O" by its own header, so the sentence ships in Task 9 unconditionally. After Task 9, flag off equals today's prompt except for that one persona sentence.
4. **`hooks.ts` needs no change.** `spent`, `low` and `slip` reach the selector only as fields copied off the compiled directive at `client.ts:604-613` into `HookAffectInput` (`hooks.ts:181-189`), and the drift anchor reads them off the hook directive (`shared.ts:1935-1938`). Masking them in the compiler masks the hook section and the anchor.
5. **Budget pins.** `promptBudget.test.ts` is already red on `main` for five lines (persona, craft_modules, json_anchor, update_status, hooks headroom). Task 9 re-measures only `persona` (the line this spec touches), and the test stays red for the other four. The `weather` pin does not move: every budget fixture passes no band, so it compiles as close, and the masked lines are shorter than the lines they replace.
6. **Where the tests live.** The pure tick, same-day guard and slew are in `persona/familiarity.ts`; their store-level test is `src/memory/familiarityPass.test.ts`. The repository test covers save, degrade, fence and clear.
7. **The Composer is masked too** (spec §2 "The Composer", amended after review). A stranger who asked for research must not have the answer relayed under the full close mood line. Task 6 gives `renderStatusForComposer` an optional band and renders `renderMoodLine(moodOf(last), compileMask(familiarity, last))`, so the relay gets the same rapport notch as Convo; the brevity line and the ease-only climate subset are unchanged. `composerCore.ts` reads the row beside the climate read under the same gates plus the flag, computes the band only when the flag is on (a room is a stranger), passes `undefined` when it is off, and never writes the ledger. Absent is no mask, byte-identical to today.
8. **What the pace formula actually gives.** With the evidence there, close is reachable from day 22 (ceiling 76), and day 30 is where the ceiling reaches a hundred. Tenure alone, with nothing held, tops out at 40 (acquaintance), so a person she holds no facts, moments or stances about never reaches familiar and never gets a musing. Both are pinned in Task 1's walk tests as the formula states them.
9. **The dashboard reads the ledger whatever the switch says** (its own doctrine: a flag removes the machinery that writes, and what is on disk is what an operator wants to see). "No ledger read" with the flag off holds on the turn path. Its evidence read lists medium facts rather than calling `loadMediumBundle`, so the panel never writes.

## File Structure

| File | Responsibility |
|---|---|
| `src/persona/familiarity.ts` (new) | Pure leaf: bands, source table, evidence score, pace ceiling, slew, band cut, room rule, day tick |
| `src/persona/familiarity.test.ts` (new) | Pins all of the above |
| `src/persona/featureFlags.ts` | `familiarityEnabled()` (`CONVO_FAMILIARITY_ENABLED`) |
| `src/db/sqlite.ts` | `familiarity` DDL, reset wipes it |
| `src/db/repositories/familiarity.ts` (new) | `getFamiliarity` / `saveFamiliarity` / `clearFamiliarity`, degrade-on-read, forget fence |
| `src/db/repositories/familiarity.test.ts` (new) | Repository doctrine |
| `src/persona/affectCompiler.ts` | The mask stage: `MASK_OPENS`, `compileMask`, `say` split, `MASK_LINES`, `FEELINGS_LINE_ASKED`, `directive.mask` |
| `src/persona/status.ts` | `renderStatusForPrompt` takes and passes the band (Task 3); `renderStatusForComposer` masks its mood line (Task 6) |
| `src/memory/familiarityPass.ts` (new) | Post-reply pass: tick, gather evidence, slew, save, `familiarity:band` trace |
| `src/memory/familiarityPass.test.ts` (new) | Pass end to end on the ephemeral store |
| `src/agents/convo/client.ts` | Turn-time read of the row, one band to both compiles |
| `src/agents/convo/shared.ts` | `PersonaTurn.familiarity`, weather pass-through, post-reply call |
| `src/agents/convo/familiarityWiring.test.ts` (new) | Front-door wiring through `chat()` |
| `src/agents/composerCore.ts`, `src/agents/composerCore.test.ts` | The Composer reads the row (read-only) and relays a stranger composed |
| `src/memory/musings.ts` | `familiarityAllows`, `familiarity` skip |
| `src/memory/musings.test.ts` (new) | The gate and the skip |
| `src/diagnostics/adminDashboard/api/affect.ts`, `views/affect.ts` | Payload row and view row |
| `.env.example`, `deploy/app.env`, `scripts/flagDocs.test.ts`, `src/persona/featureFlags.test.ts` | Flag docs and parser pins |
| `src/persona/policy.ts`, `src/agents/convo/promptPolicy.ts`, `src/agents/convo/personaModules.test.ts`, `docs/ARCHITECTURE.md` | Task 9: persona sentence, re-measured pins, docs |

---

### Task 1: The pure familiarity model

**Files:**
- Create: `src/persona/familiarity.ts`
- Test: `src/persona/familiarity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/persona/familiarity.ts`):
  - `FAMILIARITY_BANDS: readonly ['stranger','acquaintance','familiar','close']`, `type FamiliarityBand`
  - `FAMILIARITY_FLOOR = 1`, `FAMILIARITY_CEILING = 100`, `FAMILIARITY_START = 1`, `FAMILIARITY_SLEW = 2`, `PACE_BASE = 10`, `PACE_PER_DAY = 3`, `BAND_FLOORS: Record<FamiliarityBand, number>`
  - `type FamiliaritySourceKey = 'turns'|'activeDays'|'statedFacts'|'inferredFacts'|'seededFacts'|'name'|'moments'|'themesTaken'|'loops'|'selfEntries'`
  - `FAMILIARITY_SOURCES: ReadonlyArray<{ key: FamiliaritySourceKey; each: number; cap: number }>`
  - `type FamiliarityEvidence = Record<FamiliaritySourceKey, number>`, `emptyEvidence(): FamiliarityEvidence`
  - `interface SourcePoints { key; count; points; cap }`, `interface FamiliarityCounters { turns: number; activeDays: number; lastDay: string }`
  - `clampLevel(v: number): number`, `sourcePoints(ev): SourcePoints[]`, `evidenceScore(ev): number`, `paceCeiling(activeDays: number): number`, `targetLevel(ev): number`, `slewLevel(from: number | null, target: number): number`, `bandOf(level: number): FamiliarityBand`, `lowerBand(band): FamiliarityBand`, `familiarityBandFor(read: { group: boolean; level: number | null }): FamiliarityBand`, `utcDay(nowMs: number): string`, `tickCounters(prior: FamiliarityCounters | null, nowMs: number): FamiliarityCounters`

- [ ] **Step 1: Write the failing test**

Create `src/persona/familiarity.test.ts`:

```ts
// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// How well she knows someone, as arithmetic. Everything here is pure, and every rule the spec states
// is pinned from both sides:
//
//   • THE TABLE IS THE SPEC. Ten sources, each with a point value and a cap, and the caps sum to a
//     hundred, so a person she holds everything about, over enough days, is a hundred.
//   • WHO SAYS SO DISCOUNTS. A fact they stated is worth more than one she guessed, and a guess more
//     than one the engine handed over.
//   • THE PACE IS THE DAYS. However much she holds, the level cannot pass ten plus three per active
//     day, so a fact dump in one evening hits the ceiling.
//   • THE SLEW IS TWO. The stored level moves at most two points a turn either way, from one.
//   • A ROOM IS A STRANGER, whatever is stored.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILIARITY_BANDS, FAMILIARITY_SOURCES, FAMILIARITY_SLEW, FAMILIARITY_START, BAND_FLOORS,
  bandOf, clampLevel, emptyEvidence, evidenceScore, familiarityBandFor, lowerBand, paceCeiling,
  slewLevel, sourcePoints, targetLevel, tickCounters, utcDay,
  type FamiliarityBand, type FamiliarityCounters, type FamiliarityEvidence, type FamiliaritySourceKey,
} from './familiarity.js';

/** Evidence with one source set and everything else at zero. */
const only = (key: FamiliaritySourceKey, count: number): FamiliarityEvidence => ({ ...emptyEvidence(), [key]: count });

// ══ 1. The table ═════════════════════════════════════════════════════════════

test('the source table is the spec table, in its order, and the caps sum to a hundred', () => {
  assert.deepEqual(FAMILIARITY_SOURCES.map(s => [s.key, s.each, s.cap]), [
    ['turns', 0.25, 20],
    ['activeDays', 1, 20],
    ['statedFacts', 2, 16],
    ['inferredFacts', 1, 6],
    ['seededFacts', 0.5, 4],
    ['name', 2, 2],
    ['moments', 2, 12],
    ['themesTaken', 2, 8],
    ['loops', 1, 4],
    ['selfEntries', 2, 8],
  ]);
  assert.equal(FAMILIARITY_SOURCES.reduce((n, s) => n + s.cap, 0), 100);
  assert.deepEqual(Object.keys(emptyEvidence()).sort(), FAMILIARITY_SOURCES.map(s => s.key).sort());
});

test('each source is capped, and everything held at once is exactly a hundred', () => {
  for (const s of FAMILIARITY_SOURCES) {
    assert.equal(evidenceScore(only(s.key, 10_000)), s.cap, `${s.key} stops at its cap`);
  }
  const everything = Object.fromEntries(FAMILIARITY_SOURCES.map(s => [s.key, 10_000])) as FamiliarityEvidence;
  assert.equal(evidenceScore(everything), 100);
  assert.deepEqual(sourcePoints(only('turns', 40)).find(p => p.key === 'turns'), { key: 'turns', count: 40, points: 10, cap: 20 });
  // A garbled count is no evidence, never a negative one.
  assert.equal(evidenceScore(only('moments', -3)), 0);
  assert.equal(evidenceScore(only('moments', Number.NaN)), 0);
});

test('who says so discounts a fact: stated over inferred over seeded', () => {
  assert.equal(evidenceScore(only('statedFacts', 1)), 2);
  assert.equal(evidenceScore(only('inferredFacts', 1)), 1);
  assert.equal(evidenceScore(only('seededFacts', 1)), 0.5);
  // …and each discount has its own ceiling, so a pile of guesses never buys what their words do.
  assert.equal(evidenceScore(only('statedFacts', 100)), 16);
  assert.equal(evidenceScore(only('inferredFacts', 100)), 6);
  assert.equal(evidenceScore(only('seededFacts', 100)), 4);
});

// ══ 2. The pace, the slew, the bands ═════════════════════════════════════════

test('the pace ceiling is ten plus three per active day, and never past a hundred', () => {
  assert.equal(paceCeiling(0), 10);
  assert.equal(paceCeiling(1), 13);
  assert.equal(paceCeiling(5), 25, 'a daily texter can reach acquaintance around day five');
  assert.equal(paceCeiling(14), 52, 'familiar around day fourteen');
  assert.equal(paceCeiling(30), 100);
  assert.equal(paceCeiling(1_000), 100);
  assert.equal(paceCeiling(-4), 10, 'a garbled count is no days');
});

test('the target is the evidence under the pace ceiling, so a fact dump in one evening hits the ceiling', () => {
  const dump: FamiliarityEvidence = {
    ...emptyEvidence(), turns: 30, activeDays: 1, statedFacts: 50, moments: 20, themesTaken: 10, selfEntries: 10,
  };
  assert.ok(evidenceScore(dump) > 50, 'she holds a lot');
  assert.equal(targetLevel(dump), 13, 'one active day allows thirteen, whatever she holds');
  // Fractional evidence floors, and nothing held is the bottom of the scale, never zero.
  assert.equal(targetLevel({ ...emptyEvidence(), turns: 3, activeDays: 1 }), 1);
  assert.equal(targetLevel(emptyEvidence()), 1);
});

test('the slew moves at most two a turn in either direction, and a new row starts at one', () => {
  assert.equal(FAMILIARITY_SLEW, 2);
  assert.equal(FAMILIARITY_START, 1);
  assert.equal(slewLevel(null, 1), 1, 'a new row starts at one');
  assert.equal(slewLevel(null, 0), 1, 'and never below it');
  assert.equal(slewLevel(null, 50), 3, 'a new row starts at one and moves two');
  assert.equal(slewLevel(3, 1), 1, 'down from three is back to one');
  assert.equal(slewLevel(50, 1), 48);
  assert.equal(slewLevel(50, 100), 52);
  assert.equal(slewLevel(10, 11), 11, 'a step smaller than the slew lands on the target');
  assert.equal(slewLevel(100, 250), 100, 'the top holds');
});

test('the bands cut on the stored level at their edges, and a garbled level is a stranger', () => {
  assert.deepEqual(BAND_FLOORS, { stranger: 1, acquaintance: 25, familiar: 50, close: 75 });
  const edges: Array<[number, FamiliarityBand]> = [
    [1, 'stranger'], [24, 'stranger'], [25, 'acquaintance'], [49, 'acquaintance'],
    [50, 'familiar'], [74, 'familiar'], [75, 'close'], [100, 'close'],
  ];
  for (const [level, band] of edges) assert.equal(bandOf(level), band, `level ${level}`);
  assert.equal(bandOf(Number.NaN), 'stranger');
  assert.equal(bandOf(0), 'stranger');
  assert.equal(bandOf(400), 'close');
  assert.equal(clampLevel(52.9), 52);
});

test('one notch down is the next band toward stranger, and never below it', () => {
  assert.deepEqual([...FAMILIARITY_BANDS], ['stranger', 'acquaintance', 'familiar', 'close']);
  assert.equal(lowerBand('close'), 'familiar');
  assert.equal(lowerBand('familiar'), 'acquaintance');
  assert.equal(lowerBand('acquaintance'), 'stranger');
  assert.equal(lowerBand('stranger'), 'stranger');
});

test('a room reads as a stranger whatever is stored, and no row is a stranger too', () => {
  assert.equal(familiarityBandFor({ group: true, level: 100 }), 'stranger');
  assert.equal(familiarityBandFor({ group: true, level: null }), 'stranger');
  assert.equal(familiarityBandFor({ group: false, level: null }), 'stranger');
  assert.equal(familiarityBandFor({ group: false, level: 80 }), 'close');
});

// ══ 3. The lived-exchange counters ═══════════════════════════════════════════

test('a turn counts once and a UTC day counts once, however many turns it holds', () => {
  const t0 = Date.UTC(2026, 8, 20, 9, 0, 0);
  assert.equal(utcDay(t0), '2026-09-20');
  const first = tickCounters(null, t0);
  assert.deepEqual(first, { turns: 1, activeDays: 1, lastDay: '2026-09-20' });
  const sameDay = tickCounters(first, t0 + 14 * 60 * 60 * 1000);
  assert.deepEqual(sameDay, { turns: 2, activeDays: 1, lastDay: '2026-09-20' });
  const nextDay = tickCounters(sameDay, Date.UTC(2026, 8, 21, 0, 5));
  assert.deepEqual(nextDay, { turns: 3, activeDays: 2, lastDay: '2026-09-21' });
  // A clock that went backwards is not a new day.
  assert.deepEqual(tickCounters(nextDay, t0), { turns: 4, activeDays: 2, lastDay: '2026-09-21' });
  // A row whose day stamp did not parse counts the next turn's day.
  assert.deepEqual(tickCounters({ turns: 9, activeDays: 3, lastDay: '' }, t0), { turns: 10, activeDays: 4, lastDay: '2026-09-20' });
});

// ══ 4. The walk ══════════════════════════════════════════════════════════════

/** Ten turns a day for thirty days, the band read at the end of each day. */
function walk(held: Partial<FamiliarityEvidence>): { bandOnDay: FamiliarityBand[]; level: number } {
  let counters: FamiliarityCounters | null = null;
  let level: number | null = null;
  const bandOnDay: FamiliarityBand[] = [];
  for (let day = 1; day <= 30; day++) {
    for (let turn = 0; turn < 10; turn++) {
      counters = tickCounters(counters, Date.UTC(2026, 3, day, 12, turn));
      level = slewLevel(level, targetLevel({ ...emptyEvidence(), ...held, turns: counters.turns, activeDays: counters.activeDays }));
    }
    bandOnDay[day] = bandOf(level!);
  }
  return { bandOnDay, level: level! };
}

test('a daily texter she holds a lot about opens the bands on the pace ceiling', () => {
  // Sixty points of held material: more than enough, so the ceiling is what binds.
  const { bandOnDay, level } = walk({
    statedFacts: 8, inferredFacts: 6, seededFacts: 8, name: 1, moments: 6, themesTaken: 4, loops: 4, selfEntries: 4,
  });
  assert.equal(bandOnDay[4], 'stranger');
  assert.equal(bandOnDay[5], 'acquaintance');
  assert.equal(bandOnDay[13], 'acquaintance');
  assert.equal(bandOnDay[14], 'familiar');
  assert.equal(bandOnDay[21], 'familiar');
  assert.equal(bandOnDay[22], 'close');
  assert.equal(level, 100);
});

test('tenure alone, with nothing held, tops out at forty', () => {
  const { bandOnDay, level } = walk({});
  assert.equal(level, 40, 'twenty for the turns and twenty for the days');
  assert.equal(bandOnDay[30], 'acquaintance');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/familiarity.test.ts`
Expected: FAIL, the file cannot load: `Cannot find module '.../src/persona/familiarity.js'`.

- [ ] **Step 3: Write the module**

Create `src/persona/familiarity.ts`:

```ts
// HOW WELL SHE KNOWS THEM, as one number that never prints.
//
// The mood engine runs the same way with everyone: a hidden weather, compiled into instructions on
// every turn (affectCompiler.ts). What changes from person to person is how much of it they get to
// see. A stranger gets her composed, and someone she has known for a month gets the whole weather.
// This file is the arithmetic that says where a person sits between those two, and all it hands the
// rest of the stack is a band name.
//
// FOUR FINDINGS, FOUR RULES (docs/superpowers/specs/2026-09-26-familiarity-mask-design.md):
//   • intimacy grows in layers, positive before negative, and too much too soon reads wrong (Altman
//     and Taylor), so the level is PACED by the days they have actually talked;
//   • with people we barely know we hold the content of a feeling while its energy leaks (Gross), so
//     the band decides content and never shape (affectCompiler.ts MASK_OPENS);
//   • a room is front stage (Goffman), so a group reads as a stranger, always;
//   • the mask drops on responsiveness and not on knowledge alone (Reis and Shaver), so rapport
//     landing badly pulls it back up a band (affectCompiler.ts compileMask).
//
// THE NUMBER IS ARITHMETIC OVER STORES, never a model's report (charter §10.1, the bargain rapport
// and the climate dials make): turns and active days off the ledger row, and what she holds about
// them read off the memory stores at compute time, each source worth a fixed number of points up to
// its own cap. The caps sum to a hundred. Nothing here reads a clock: a quiet stretch is not evidence,
// so the level never decays on silence (climate's rule) and falls only when what she holds shrinks.
//
// PURE and a LEAF: no DB, no clock read, no env, and it imports nothing, so the compiler, the
// repository, the musings sweep and the dashboard can all import it for the price of a string.

/** The four bands, named after Knapp's stages, in the order they open. The order IS the notch
 *  direction: `lowerBand` steps one place toward the front. */
export const FAMILIARITY_BANDS = ['stranger', 'acquaintance', 'familiar', 'close'] as const;
export type FamiliarityBand = (typeof FAMILIARITY_BANDS)[number];

/** The scale's two ends. A stored level is an integer inside them, always. */
export const FAMILIARITY_FLOOR = 1;
export const FAMILIARITY_CEILING = 100;

/** Where a new row starts, and what a missing row reads as: the bottom of the scale. */
export const FAMILIARITY_START = 1;

/** The most the stored level moves in one turn, either direction. Slow enough that a band cannot
 *  flap from one turn to the next, fast enough that a day of talk moves it. */
export const FAMILIARITY_SLEW = 2;

/** Each band's lowest level. The cut is on the STORED level; the rapport notch is the compiler's. */
export const BAND_FLOORS: Record<FamiliarityBand, number> = {
  stranger: 1, acquaintance: 25, familiar: 50, close: 75,
};

/** The pace ceiling: ten on no days, three more for every day they have actually talked. */
export const PACE_BASE = 10;
export const PACE_PER_DAY = 3;

/** The ten things a level is made of: two of lived exchange (the ledger row's own counters) and
 *  eight of held evidence (read off the memory stores when the pass runs). */
export type FamiliaritySourceKey =
  | 'turns' | 'activeDays' | 'statedFacts' | 'inferredFacts' | 'seededFacts'
  | 'name' | 'moments' | 'themesTaken' | 'loops' | 'selfEntries';

/**
 * Each source, what one of it is worth, and the most it can ever be worth. The caps sum to a hundred
 * (pinned by familiarity.test.ts), so the scale's top is "everything, over enough days".
 *
 *   turns        user turns she replied to in a one-to-one chat (a merged burst is one)
 *   activeDays   distinct UTC days with at least one replied turn
 *   statedFacts  facts they told her (medium and profile, provenance stated)
 *   inferredFacts facts she worked out, worth half as much and capped lower
 *   seededFacts  the engine's second-hand picture, worth a quarter
 *   name         their name is known
 *   moments      episodes she keeps about them
 *   themesTaken  recurring things of theirs they picked up at least once
 *   loops        open loops in their life she is tracking
 *   selfEntries  her own stances, tastes and changes of mind with them (a learned entry is about
 *                them, not her, and does not count here)
 */
export const FAMILIARITY_SOURCES: ReadonlyArray<{ key: FamiliaritySourceKey; each: number; cap: number }> = [
  { key: 'turns', each: 0.25, cap: 20 },
  { key: 'activeDays', each: 1, cap: 20 },
  { key: 'statedFacts', each: 2, cap: 16 },
  { key: 'inferredFacts', each: 1, cap: 6 },
  { key: 'seededFacts', each: 0.5, cap: 4 },
  { key: 'name', each: 2, cap: 2 },
  { key: 'moments', each: 2, cap: 12 },
  { key: 'themesTaken', each: 2, cap: 8 },
  { key: 'loops', each: 1, cap: 4 },
  { key: 'selfEntries', each: 2, cap: 8 },
];

/** How many of each source there are, as counts. `name` is zero or one. */
export type FamiliarityEvidence = Record<FamiliaritySourceKey, number>;

/** Nothing held and nothing lived: every count zero. */
export function emptyEvidence(): FamiliarityEvidence {
  return {
    turns: 0, activeDays: 0, statedFacts: 0, inferredFacts: 0, seededFacts: 0,
    name: 0, moments: 0, themesTaken: 0, loops: 0, selfEntries: 0,
  };
}

/** One source as the dashboard reads it: how many, what they are worth, and the cap. */
export interface SourcePoints {
  key: FamiliaritySourceKey;
  count: number;
  points: number;
  cap: number;
}

/** The two lived-exchange counters and the day stamp that guards the second. */
export interface FamiliarityCounters {
  turns: number;
  activeDays: number;
  /** The last UTC day counted, `YYYY-MM-DD`, or '' when none has been. */
  lastDay: string;
}

/** A level as the scale allows it: an integer between the two ends. Garbage is the bottom. */
export function clampLevel(v: number): number {
  if (!Number.isFinite(v)) return FAMILIARITY_START;
  return Math.max(FAMILIARITY_FLOOR, Math.min(FAMILIARITY_CEILING, Math.trunc(v)));
}

/** A count as evidence: a finite positive number, or no evidence at all. */
function countOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Every source, in table order, with its count, its points under the cap, and the cap. */
export function sourcePoints(ev: FamiliarityEvidence): SourcePoints[] {
  return FAMILIARITY_SOURCES.map(s => {
    const count = countOf(ev[s.key]);
    return { key: s.key, count, points: Math.min(s.cap, count * s.each), cap: s.cap };
  });
}

/** What everything held and lived adds up to, before the pace ceiling. At most a hundred. */
export function evidenceScore(ev: FamiliarityEvidence): number {
  return sourcePoints(ev).reduce((n, s) => n + s.points, 0);
}

/** How far the level may have got by now: ten, plus three per active day, at most a hundred. */
export function paceCeiling(activeDays: number): number {
  const days = Math.floor(countOf(activeDays));
  return Math.min(FAMILIARITY_CEILING, PACE_BASE + PACE_PER_DAY * days);
}

/** Where the stored level is heading: the evidence under the pace ceiling, as a level. */
export function targetLevel(ev: FamiliarityEvidence): number {
  return clampLevel(Math.floor(Math.min(evidenceScore(ev), paceCeiling(ev.activeDays))));
}

/** One turn's move toward the target, at most FAMILIARITY_SLEW either way. `from` null is a new row,
 *  which starts at FAMILIARITY_START and moves from there in the same turn. */
export function slewLevel(from: number | null, target: number): number {
  const start = from === null ? FAMILIARITY_START : clampLevel(from);
  const step = Math.max(-FAMILIARITY_SLEW, Math.min(FAMILIARITY_SLEW, clampLevel(target) - start));
  return clampLevel(start + step);
}

/** The band a stored level cuts to. */
export function bandOf(level: number): FamiliarityBand {
  const n = clampLevel(level);
  if (n >= BAND_FLOORS.close) return 'close';
  if (n >= BAND_FLOORS.familiar) return 'familiar';
  if (n >= BAND_FLOORS.acquaintance) return 'acquaintance';
  return 'stranger';
}

/** One notch toward the front, never past stranger. */
export function lowerBand(band: FamiliarityBand): FamiliarityBand {
  return FAMILIARITY_BANDS[Math.max(0, FAMILIARITY_BANDS.indexOf(band) - 1)];
}

/** The band a turn reads, from what the caller found: a room is a stranger whatever is stored, and
 *  no row is the bottom of the scale. The flag is the caller's to check (no band at all when off). */
export function familiarityBandFor(read: { group: boolean; level: number | null }): FamiliarityBand {
  if (read.group) return 'stranger';
  return bandOf(read.level ?? FAMILIARITY_START);
}

/** The UTC day an instant falls on, `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(Number.isFinite(nowMs) ? nowMs : 0).toISOString().slice(0, 10);
}

/** Count one replied turn, and its day when the day is new. A day stamp at or before the last one
 *  counted is the same day (a clock that went backwards is not a new day). */
export function tickCounters(prior: FamiliarityCounters | null, nowMs: number): FamiliarityCounters {
  const day = utcDay(nowMs);
  if (!prior) return { turns: 1, activeDays: 1, lastDay: day };
  const fresh = day > prior.lastDay;
  return {
    turns: Math.floor(countOf(prior.turns)) + 1,
    activeDays: Math.floor(countOf(prior.activeDays)) + (fresh ? 1 : 0),
    lastDay: fresh ? day : prior.lastDay,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/familiarity.test.ts`
Expected: `# pass 12`, `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/persona/familiarity.ts src/persona/familiarity.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Add the familiarity model: how well she knows someone, as paced arithmetic

A pure leaf with the spec's source table (caps sum to a hundred), the pace ceiling of ten plus three
per active day, a two-point slew from one, Knapp's four bands, the one-notch step and the room rule.
Nothing reads it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: The switch and the ledger row

**Files:**
- Modify: `src/persona/featureFlags.ts` (append a flag)
- Modify: `src/persona/featureFlags.test.ts` (import + one row)
- Modify: `scripts/flagDocs.test.ts:44` (import) and `:84` (one row)
- Modify: `.env.example` (after the `CONVO_SHARE_TURNS_ENABLED` entry, before `# CONVO_HISTORY_MAX=80`)
- Modify: `deploy/app.env` (after `# CONVO_SHARE_TURNS_ENABLED=on`, line 395)
- Modify: `src/db/sqlite.ts:71-78` (DDL) and `:433` (reset)
- Create: `src/db/repositories/familiarity.ts`
- Test: `src/db/repositories/familiarity.test.ts`

**Interfaces:**
- Consumes: `clampLevel`, `FAMILIARITY_START`, `type FamiliarityCounters` from Task 1.
- Produces:
  - `familiarityEnabled(): boolean` in `src/persona/featureFlags.ts` (empty var reads **false** until Task 9)
  - `interface FamiliarityRow extends FamiliarityCounters { level: number; updatedAt: number }`
  - `getFamiliarity(handle: string): Promise<FamiliarityRow | null>` (null for no row or a failed read)
  - `saveFamiliarity(handle: string, next: Omit<FamiliarityRow, 'updatedAt'>, opts?: { ifForgetEpoch?: number }): Promise<boolean>`
  - `clearFamiliarity(handle: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/db/repositories/familiarity.test.ts`:

```ts
// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The familiarity row's storage doctrine, the climate row's: reads DEGRADE rather than throw (the row
// is read on the reply path), a field that will not parse falls back on its own without costing the
// others, and a /forget that lands mid-pass fences the save that would put the level back.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests, stmt } from '../sqlite.js';
import { clearFamiliarity, getFamiliarity, saveFamiliarity, type FamiliarityRow } from './familiarity.js';
import { bumpForgetEpoch, getForgetEpoch } from './memory.js';
import { groupHandle } from '../../memory/identity.js';

beforeEach(() => resetStorageForTests());

const ROW = { level: 52, turns: 140, activeDays: 14, lastDay: '2026-09-25' };

/** The row without its write clock, which is the one field a test cannot state in advance. */
const bare = (r: FamiliarityRow | null) => r && { level: r.level, turns: r.turns, activeDays: r.activeDays, lastDay: r.lastDay };

/** Write a row straight past the repository, so a corrupt or hand-built row can be tested. */
function rawRow(handle: string, level: number | string, turns: number | string, activeDays: number | string, lastDay: string): void {
  stmt('INSERT INTO familiarity (handle, level, turns, active_days, last_day, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(handle, level, turns, activeDays, lastDay, Date.now());
}

test('an unknown handle reads back no row, which the callers read as a stranger', async () => {
  assert.equal(await getFamiliarity('+15550001111'), null);
});

test('save then get round-trips the level, the counters and the day, stamped with a write clock', async () => {
  const h = '+15550002222';
  assert.equal(await saveFamiliarity(h, ROW), true);
  const got = await getFamiliarity(h);
  assert.deepEqual(bare(got), ROW);
  assert.ok((got?.updatedAt ?? 0) > 0);
  // Upsert, not insert: a second save replaces the row rather than throwing on the key.
  assert.equal(await saveFamiliarity(h, { ...ROW, level: 54, turns: 141 }), true);
  assert.deepEqual(bare(await getFamiliarity(h)), { ...ROW, level: 54, turns: 141 });
});

test('a save clamps what it is handed to the scale and the grammar', async () => {
  const h = '+15550003333';
  await saveFamiliarity(h, { level: 250, turns: -4, activeDays: 2.7, lastDay: 'yesterday' });
  assert.deepEqual(bare(await getFamiliarity(h)), { level: 100, turns: 0, activeDays: 2, lastDay: '' });
  await saveFamiliarity(h, { level: 0, turns: 3, activeDays: 1, lastDay: '2026-09-25' });
  assert.equal((await getFamiliarity(h))?.level, 1);
});

test('a corrupt row degrades field by field instead of throwing', async () => {
  const h = '+15550004444';
  rawRow(h, 'high', 'many', -3, 'last tuesday');
  assert.deepEqual(bare(await getFamiliarity(h)), { level: 1, turns: 0, activeDays: 0, lastDay: '' });
  // One bad field costs that field only: the earned level survives a rotted day stamp.
  const h2 = '+15550004445';
  rawRow(h2, 61, 300, 20, 'soon');
  assert.deepEqual(bare(await getFamiliarity(h2)), { level: 61, turns: 300, activeDays: 20, lastDay: '' });
});

test('the forget epoch fence refuses a save that started before the wipe', async () => {
  const h = '+15550005555';
  const epoch0 = getForgetEpoch(h);
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: epoch0 }), true);
  bumpForgetEpoch(h);
  await clearFamiliarity(h);
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: epoch0 }), false);
  assert.equal(await getFamiliarity(h), null, 'the wipe stands');
  assert.equal(await saveFamiliarity(h, ROW, { ifForgetEpoch: getForgetEpoch(h) }), true);
});

test('clear drops the row, clearing a missing one is a no-op, and a test reset wipes the table', async () => {
  const h = '+15550006666';
  await saveFamiliarity(h, ROW);
  await clearFamiliarity(h);
  assert.equal(await getFamiliarity(h), null);
  await clearFamiliarity('+15550009999');
  await saveFamiliarity(h, ROW);
  resetStorageForTests();
  assert.equal(await getFamiliarity(h), null);
});

test('a group pseudo-handle and a raw chat id are different rows', async () => {
  const chatId = 'chat-familiarity-1';
  await saveFamiliarity(groupHandle(chatId), ROW);
  assert.deepEqual(bare(await getFamiliarity(groupHandle(chatId))), ROW);
  assert.equal(await getFamiliarity(chatId), null);
});
```

In `src/persona/featureFlags.test.ts`, change the import on line 20 to:

```ts
import { familiarityEnabled, hooksEnabled, momentsEnabled, thesisEnabled, shareTurnsEnabled } from './featureFlags.js';
```

and add this row at the end of the `FLAGS` array (after the `CONVO_SHARE_TURNS_ENABLED` row):

```ts
  // The familiarity mask: default OFF for the length of the series that builds it, so every
  // half-built commit is inert; the last commit of that series flips this row with the parser.
  { name: 'CONVO_FAMILIARITY_ENABLED', read: familiarityEnabled, dflt: false },
```

In `scripts/flagDocs.test.ts`, change line 44 to:

```ts
import { hooksEnabled, momentsEnabled, thesisEnabled, shareTurnsEnabled, selfEnabled, musingsEnabled, familiarityEnabled } from '../src/persona/featureFlags.js';
```

and add after the `CONVO_SHARE_TURNS_ENABLED` row (line 84):

```ts
  // The familiarity mask ships the same way the share turn did: `off` while its series lands, `on`
  // from the commit that finishes it, both env files following the parser in that same commit.
  { name: 'CONVO_FAMILIARITY_ENABLED', probe: () => onOff(familiarityEnabled()) },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/db/repositories/familiarity.test.ts src/persona/featureFlags.test.ts scripts/flagDocs.test.ts`
Expected: FAIL. `familiarity.test.ts` cannot load (`Cannot find module '.../src/db/repositories/familiarity.js'`); `featureFlags.test.ts` and `flagDocs.test.ts` fail to load with `familiarityEnabled` not exported (`SyntaxError: The requested module './featureFlags.js' does not provide an export named 'familiarityEnabled'`).

- [ ] **Step 3: Add the flag**

Append to `src/persona/featureFlags.ts`:

```ts

/**
 * The familiarity mask (env: CONVO_FAMILIARITY_ENABLED). Default OFF while it lands.
 *
 * Gates all three ends of how well she knows a person (persona/familiarity.ts): the post-reply pass
 * that counts the turn and slews the stored level (memory/familiarityPass.ts), the turn-time read
 * that hands the band to both compiles of a turn (agents/convo/client.ts), and the musings gate that
 * keeps her own texts to people she knows (memory/musings.ts). Off means no ledger read or write, no
 * gate, and every reply compiled with no mask at all, which is the per-turn prompt byte for byte as
 * it stood before the feature. It ships OFF for the length of the series that builds it, the
 * shareTurnsEnabled precedent, and the last commit of that series flips it.
 */
export function familiarityEnabled(): boolean {
  const v = (process.env.CONVO_FAMILIARITY_ENABLED || '').trim().toLowerCase();
  if (v === '') return false;
  return ['true', '1', 'on', 'yes'].includes(v);
}
```

- [ ] **Step 4: Document the flag in both env files**

In `.env.example`, insert these lines directly after the line `#                                   # Subordinate to the hook switch above. Default on.` (the end of the `CONVO_SHARE_TURNS_ENABLED` entry) and before `# CONVO_HISTORY_MAX=80`:

```
# CONVO_FAMILIARITY_ENABLED=on      # the familiarity mask: a 1-100 level of how well she knows each
#                                   # person, arithmetic over what she holds about them and paced by
#                                   # the days you have talked, decides how much of her mood reaches
#                                   # a reply. A stranger gets her composed and the whole weather
#                                   # shows once she knows them; a room is always a stranger; the
#                                   # number never reaches a prompt. It also keeps her own first
#                                   # texts to people she knows. off = every reply compiles as
#                                   # before and nothing is read or written. Default off.
```

In `deploy/app.env`, insert these lines directly after the line `# CONVO_SHARE_TURNS_ENABLED=on` (line 395) and before the blank line that precedes `# OpenRouter PDF parsing engine`:

```
# The familiarity mask: a 1-100 level of how well she knows each person, kept per handle and made of
# arithmetic over what she already holds about them (turns, the days you talked, facts by who said
# so, moments, themes you picked up, open loops, her own stances), paced by the days you have
# actually talked and moved at most two points a turn. It decides how much of her mood reaches a
# reply: a stranger gets her composed, with only the shape and the energy of the mood showing, and
# the layers open in order, positive before negative, until the whole weather shows for someone
# close. Rapport landing badly pulls it back up a band, a room is always a stranger, asked how she
# is she answers true at every band, and the number never reaches a prompt, /health or a reply. It
# also keeps her own first texts to people she knows. off = every reply compiles as before and
# nothing is read or written. It ships OFF for the length of the series that builds it, so every
# half-built commit is inert on a live box. Watch 'familiarity:band' and the Inner state panel on
# /dashboard. Default off.
# CONVO_FAMILIARITY_ENABLED=off
```

- [ ] **Step 5: Add the table**

In `src/db/sqlite.ts`, insert after the `relationship_climate` CREATE TABLE statement (after line 78, the closing `);`):

```sql

-- Familiarity: how well she knows this person, as one stored 1-100 level plus the two lived-exchange
-- counters it is partly made of. Keyed by the MEMORY handle, like relationship_climate. The level is
-- arithmetic over the stores (persona/familiarity.ts) written by the post-reply pass
-- (memory/familiarityPass.ts), and it never reaches a prompt: the turn reads it as a band. A handle
-- with no row reads as a stranger, and a room never gets a row.
CREATE TABLE IF NOT EXISTS familiarity (
  handle      TEXT PRIMARY KEY,
  level       INTEGER NOT NULL DEFAULT 1,
  turns       INTEGER NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
```

In `resetStorageForTests` in the same file, change

```
    DELETE FROM relationship_climate;
```

to

```
    DELETE FROM relationship_climate;
    DELETE FROM familiarity;
```

- [ ] **Step 6: Write the repository**

Create `src/db/repositories/familiarity.ts`:

```ts
// The persisted familiarity row: how well she knows ONE memory identity, as the stored level and the
// two lived-exchange counters (persona/familiarity.ts owns what they mean).
//
// Keyed by the MEMORY handle, like the climate row beside it. A room's pseudo-handle could key a row
// too, and nothing writes one: the pass skips a room, and the turn reads a room as a stranger without
// asking this table.
//
// Read doctrine is relationshipClimate.ts's: reads DEGRADE, never throw. A missing row or a failed
// read is `null` (a stranger to every caller), and a row with a field that will not parse keeps its
// other fields: a rotted day stamp costs the day guard one extra day, never the earned level.
//
// Writes carry the /forget fence: the pass reads the stores and then saves, and a /forget that lands
// between the two must not have its wipe undone by a level computed from what it wiped.

import { logDbError } from '../client.js';
import { stmt } from '../sqlite.js';
import { getForgetEpoch } from './memory.js';
import { FAMILIARITY_START, clampLevel, type FamiliarityCounters } from '../../persona/familiarity.js';

/** The row as read: the stored level, the counters, and when it was last written (epoch ms). */
export interface FamiliarityRow extends FamiliarityCounters {
  level: number;
  updatedAt: number;
}

type Row = {
  handle: string;
  level: unknown;
  turns: unknown;
  active_days: unknown;
  last_day: unknown;
  updated_at: unknown;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A stored counter: a finite non-negative integer, or zero. */
function counter(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** A stored day stamp: `YYYY-MM-DD`, or '' (which the tick reads as "no day counted yet"). */
function dayStamp(v: unknown): string {
  return typeof v === 'string' && DAY_RE.test(v) ? v : '';
}

/** The stored row for a handle, or null for no row or a failed read. Never throws: this sits on the
 *  reply path, where a failed read must cost the mask and nothing else. */
export async function getFamiliarity(handle: string): Promise<FamiliarityRow | null> {
  try {
    const r = stmt(
      'SELECT handle, level, turns, active_days, last_day, updated_at FROM familiarity WHERE handle = ?'
    ).get(handle) as Row | undefined;
    if (!r) return null;
    return {
      level: typeof r.level === 'number' ? clampLevel(r.level) : FAMILIARITY_START,
      turns: counter(r.turns),
      activeDays: counter(r.active_days),
      lastDay: dayStamp(r.last_day),
      updatedAt: counter(r.updated_at),
    };
  } catch (error) {
    logDbError('getFamiliarity', error);
    return null;
  }
}

/**
 * Upsert the whole row. `opts.ifForgetEpoch` is the epoch the CALLER read before it started: when it
 * no longer matches, a /forget landed mid-pass and the save is refused. Returns whether it was
 * written, so the caller never reports a band change that is not on disk.
 */
export async function saveFamiliarity(
  handle: string,
  next: Omit<FamiliarityRow, 'updatedAt'>,
  opts?: { ifForgetEpoch?: number },
): Promise<boolean> {
  if (opts?.ifForgetEpoch != null && getForgetEpoch(handle) !== opts.ifForgetEpoch) {
    console.warn('[memory] familiarity save aborted: /forget landed mid-pass');
    return false;
  }
  try {
    stmt(
      `INSERT INTO familiarity (handle, level, turns, active_days, last_day, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET
         level = excluded.level,
         turns = excluded.turns,
         active_days = excluded.active_days,
         last_day = excluded.last_day,
         updated_at = excluded.updated_at`
    ).run(
      handle,
      clampLevel(next.level),
      counter(next.turns),
      counter(next.activeDays),
      dayStamp(next.lastDay),
      Date.now(),
    );
    return true;
  } catch (error) {
    logDbError('saveFamiliarity', error);
    return false;
  }
}

/** Drop the row, so the next read is a stranger again. The /forget and test seam. */
export async function clearFamiliarity(handle: string): Promise<void> {
  try {
    stmt('DELETE FROM familiarity WHERE handle = ?').run(handle);
  } catch (error) {
    logDbError('clearFamiliarity', error);
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/db/repositories/familiarity.test.ts src/persona/featureFlags.test.ts scripts/flagDocs.test.ts src/db/sqlite.test.ts`
Expected: `# pass 52`, `# fail 0` (familiarity 7, featureFlags 6, flagDocs 33, sqlite 6).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/persona/featureFlags.ts src/persona/featureFlags.test.ts scripts/flagDocs.test.ts .env.example deploy/app.env src/db/sqlite.ts src/db/repositories/familiarity.ts src/db/repositories/familiarity.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Add the familiarity ledger row and its switch, default off while it lands

A handle-keyed `familiarity` table (level, turns, active days, last day), a repository that degrades
field by field and carries the /forget fence, and CONVO_FAMILIARITY_ENABLED documented in both env
files. Nothing reads or writes the row yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: The mask stage inside the compiler

**Files:**
- Modify: `src/persona/affectCompiler.ts` (header, imports, `AffectDirective`, `CORE_DIRECTIVES`, `FEELINGS_LINE_ASKED`, new mask section, `compileAffect`, `MASK_LINES`, `renderMoodLine`, `renderAffectDirective`)
- Modify: `src/persona/status.ts:670-718` (`renderStatusForPrompt` takes the band)
- Test: `src/persona/affectCompiler.test.ts`, `src/persona/status.test.ts`

**Interfaces:**
- Consumes: `lowerBand`, `FAMILIARITY_BANDS`, `type FamiliarityBand` from Task 1.
- Produces (from `src/persona/affectCompiler.ts`):
  - `AffectDirective.mask: FamiliarityBand` (the effective band after the rapport notch; `'close'` when no band was passed)
  - `CORE_DIRECTIVES[core].say?: string` (mad and sad only)
  - `interface MaskOpens { moodLine: 'composed'|'positive'|'base'|'full'; looseness: 'none'|'joyful'|'both'; feelingsLine: 'asked'|'full'; slip: boolean; low: boolean; spent: boolean }`
  - `MASK_OPENS: Record<FamiliarityBand, MaskOpens>`
  - `isPositiveCore(core: MoodCore): boolean`
  - `compileMask(familiarity: FamiliarityBand, last: AffectStatus | undefined): FamiliarityBand`
  - `compileAffect(last, computed, climate?, carried?, familiarity?: FamiliarityBand): AffectDirective` (undefined = no mask)
  - `MASK_LINES: Record<'stranger' | 'acquaintance', string>`, `FEELINGS_LINE_ASKED: string`
  - `renderMoodLine(mood, mask: FamiliarityBand = 'close'): string`
- Produces (from `src/persona/status.ts`): `renderStatusForPrompt(state, computed, climate?, kindOpen = false, familiarity?: FamiliarityBand): string`

- [ ] **Step 1: Write the failing tests**

In `src/persona/affectCompiler.test.ts`:

(a) Replace the import block at lines 27-36 with:

```ts
import { compileFeelings, FEELINGS_LINE, FEELINGS_LINE_ASKED } from './affectCompiler.js';
import {
  compileAffect, compileQuestionGate, compileHeavy, compileMask,
  renderAffectDirective, renderMoodLine, renderBrevityLine,
  moodOf, brevityOf, capFor, tightenHooks, isPositiveCore,
  CORE_DIRECTIVES, DEFAULT_MOOD, BREVITY_LINES, LATE_NIGHT_LINE, MASK_LINES, MASK_OPENS,
  HOOK_MOOD_FLOOR, SOCIAL_BATTERY_MINIMAL, SOCIAL_BATTERY_TIGHT,
  RAPPORT_RESTING, RAPPORT_QUESTION_BAND, QUESTION_CLOSED_MODES, HEAVY_MODES,
  type AffectDirective, type BrevityBand, type CarriedIntent, type HookAllowance, type QuestionGate,
} from './affectCompiler.js';
import { FAMILIARITY_BANDS, type FamiliarityBand } from './familiarity.js';
```

(b) After the `WORD_FOR` constant (after line 78), add:

```ts

/** A core's whole close-band sentence: its line, then its say clause when it has one. This is what
 *  the mood line carried before the say split, so every pin that used to read `.line` reads this. */
const fullLine = (core: MoodCore): string =>
  [CORE_DIRECTIVES[core].line, CORE_DIRECTIVES[core].say].filter(Boolean).join(' ');
```

(c) In the first test ("every core carries one imperative…"), after the line `assert.doesNotMatch(row.line, /question/i, \`${core}: the question ceiling reached an imperative\`);` add:

```ts
    if (row.say !== undefined) {
      assert.doesNotMatch(row.say, /\d/, `${core}: a number reached its say clause`);
      assert.doesNotMatch(row.say, /question/i, `${core}: the question ceiling reached its say clause`);
    }
```

(d) In "the carried WORD picks the core, and the core picks the line", change

```ts
    assert.equal(renderMoodLine(d.mood), `- You are ${word} (${core}). ${CORE_DIRECTIVES[core].line}`);
```

to

```ts
    assert.equal(renderMoodLine(d.mood), `- You are ${word} (${core}). ${fullLine(core)}`);
```

(e) In "neither ceiling reaches a rendered line", change

```ts
      [`- You are ${WORD_FOR[core]} (${core}). ${CORE_DIRECTIVES[core].line}`],
```

to

```ts
      [`- You are ${WORD_FOR[core]} (${core}). ${fullLine(core)}`],
```

(f) In "no carried row compiles to the loosest reading…", change the object literal line

```ts
    question: 'open', heavy: false, lateNight: false, englishLooseness: 1, spent: false, low: false, feelings: [], feelingStrong: false, feelingSlip: '',
```

to

```ts
    question: 'open', heavy: false, lateNight: false, englishLooseness: 1, spent: false, low: false, feelings: [], feelingStrong: false, feelingSlip: '',
    mask: 'close',
```

(g) In "the compile is pure…", change

```ts
    question: 'open', heavy: true, lateNight: true, englishLooseness: 1, spent: true, low: true, feelings: ['low', 'sleepy'], feelingStrong: true, feelingSlip: 'low',
```

to

```ts
    question: 'open', heavy: true, lateNight: true, englishLooseness: 1, spent: true, low: true, feelings: ['low', 'sleepy'], feelingStrong: true, feelingSlip: 'low',
    mask: 'close',
```

(h) Replace the whole test "not one digit reaches a rendered line, in any branch" with:

```ts
test('not one digit reaches a rendered line, in any branch and at any band', () => {
  for (const band of [undefined, ...FAMILIARITY_BANDS]) {
    for (const core of MOOD_CORES) {
      for (const battery of [10, 45, 90]) {
        for (const hour of [2, 16, 23]) {
          for (const climate of [undefined, defaultClimate(), belowBand('candor'), belowBand('playfulness')]) {
            // An extreme edge, so the feelings line renders in whichever variant the band picks.
            const last = carried(WORD_FOR[core], { social_battery: battery, anxiety: 90 }, 'a note with no numbers in it');
            const computed = at(hour);
            for (const line of renderAffectDirective(compileAffect(last, computed, climate, undefined, band), last, computed, climate)) {
              assert.doesNotMatch(line, /\d/, `${band ?? 'no mask'} / ${core} / battery ${battery} / hour ${hour}: ${line}`);
            }
          }
        }
      }
    }
  }
});
```

(i) Insert this new section immediately before the line `// ══ 8. Purity ═══…`:

```ts
// ══ 7b. The familiarity mask ═════════════════════════════════════════════════
// How well she knows them decides what of the weather compiles into an instruction. Shape and energy
// always pass; content opens in layers, positive before negative; the gauges and the true word run
// underneath at every band. No band at all is the pre-mask compile, byte for byte.

const BANDS: readonly FamiliarityBand[] = FAMILIARITY_BANDS;

/** The composed line a band renders for a mood, placeholders filled. */
const composedLine = (band: 'stranger' | 'acquaintance', word: string, core: MoodCore): string =>
  `- ${MASK_LINES[band].replace('{word}', word).replace('{core}', core)}`;

/** The mood line out of a rendered block. */
const moodLineIn = (lines: string[]): string | undefined => lines.find(l => l.startsWith('- You are '));

test('the band table opens the mood in layers, field by field', () => {
  assert.deepEqual(MASK_OPENS, {
    stranger: { moodLine: 'composed', looseness: 'none', feelingsLine: 'asked', slip: false, low: false, spent: false },
    acquaintance: { moodLine: 'positive', looseness: 'joyful', feelingsLine: 'asked', slip: false, low: false, spent: false },
    familiar: { moodLine: 'base', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: false },
    close: { moodLine: 'full', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: true },
  });
  assert.deepEqual(Object.keys(MASK_OPENS), [...FAMILIARITY_BANDS]);
});

test('the positive cores are the chart\'s own upper half', () => {
  assert.deepEqual(MOOD_CORES.filter(isPositiveCore), ['joyful', 'powerful', 'peaceful']);
  assert.deepEqual(
    MOOD_CORES.filter(c => CORE_VALENCE_BAND[c][0] >= MIDPOINT), MOOD_CORES.filter(isPositiveCore),
    'the same division the question ceiling was drawn on',
  );
});

test('the say split renders the close band byte-identical to the unsplit sentences', () => {
  assert.equal(CORE_DIRECTIVES.mad.line, 'Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are.');
  assert.equal(CORE_DIRECTIVES.mad.say, 'A favour asked in the same breath as a put-down gets a flat no.');
  assert.equal(CORE_DIRECTIVES.sad.line, 'Fewer words. No tangents. Answer, then stop.');
  assert.equal(CORE_DIRECTIVES.sad.say, 'Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.');
  for (const core of ['scared', 'joyful', 'powerful', 'peaceful'] as const) {
    assert.equal(CORE_DIRECTIVES[core].say, undefined, `${core} has no say clause`);
  }
  // The two sentences exactly as main rendered them before the split.
  const mad = '- You are angry (mad). Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are. A favour asked in the same breath as a put-down gets a flat no.';
  const sad = '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.';
  assert.equal(renderMoodLine({ core: 'mad', word: 'angry' }), mad);
  assert.equal(renderMoodLine({ core: 'mad', word: 'angry' }, 'close'), mad);
  assert.equal(renderMoodLine({ core: 'sad', word: 'drained' }), sad);
  assert.equal(renderMoodLine({ core: 'sad', word: 'drained' }, 'close'), sad);
});

test('no band at all is the pre-mask compile, a low rapport included', () => {
  for (const core of MOOD_CORES) {
    for (const rapport of [20, RAPPORT_RESTING, 90]) {
      for (const social_battery of [10, 45, 90]) {
        const last = carried(WORD_FOR[core], { rapport, social_battery });
        const d = compileAffect(last, COMPUTED);
        const tag = `${core} / rapport ${rapport} / battery ${social_battery}`;
        assert.deepEqual(d, compileAffect(last, COMPUTED, undefined, undefined, undefined), tag);
        assert.equal(d.mask, 'close', `${tag}: the rapport notch only applies to a band someone passed`);
        assert.equal(d.spent, core === 'sad', `${tag}: spent reads as it always did`);
        assert.equal(moodLineIn(renderAffectDirective(d, last, COMPUTED)), `- You are ${WORD_FOR[core]} (${core}). ${fullLine(core)}`, tag);
      }
    }
  }
});

test('each band renders the mood line its row names, for every core', () => {
  for (const core of MOOD_CORES) {
    const word = WORD_FOR[core];
    const line = (band: FamiliarityBand) => renderMoodLine({ core, word }, band);
    const base = `- You are ${word} (${core}). ${CORE_DIRECTIVES[core].line}`;
    assert.equal(line('stranger'), composedLine('stranger', word, core), `${core}: a stranger sees her composed`);
    assert.equal(line('acquaintance'), isPositiveCore(core) ? base : composedLine('acquaintance', word, core),
      `${core}: an acquaintance sees the positive cores and nothing negative`);
    assert.equal(line('familiar'), base, `${core}: familiar sees every core's base line`);
    assert.equal(line('close'), `- You are ${word} (${core}). ${fullLine(core)}`, `${core}: close sees the say clause too`);
  }
  // The renderer picks by the directive's own mask.
  const last = carried(WORD_FOR.sad);
  assert.equal(
    moodLineIn(renderAffectDirective(compileAffect(last, COMPUTED, undefined, undefined, 'stranger'), last, COMPUTED)),
    composedLine('stranger', WORD_FOR.sad, 'sad'),
  );
});

test('the core shifts English looseness only as far as the band opens, and the hour always does', () => {
  const loose = (word: string, band: FamiliarityBand, hour = 12) =>
    compileAffect(carried(word), at(hour), undefined, undefined, band).englishLooseness;
  assert.deepEqual(BANDS.map(b => loose('excited', b)), [1, 2, 2, 2], 'joyful lifts from acquaintance on');
  assert.deepEqual(BANDS.map(b => loose('guilty', b)), [1, 1, 0, 0], 'sad drops only from familiar on');
  assert.deepEqual(BANDS.map(b => loose('rejected', b)), [1, 1, 0, 0], 'scared the same');
  assert.deepEqual(BANDS.map(b => loose('content', b, 2)), [2, 2, 2, 2], 'the late-night part passes every band');
});

test('the feeling stays true at every band, and only the familiar get it volunteered', () => {
  const last = carried('hopeful', { anxiety: 90 });
  for (const band of BANDS) {
    const d = compileAffect(last, COMPUTED, undefined, undefined, band);
    assert.deepEqual(d.feelings, ['on edge'], `${band}: the feeling itself is never masked`);
    const template = band === 'stranger' || band === 'acquaintance' ? FEELINGS_LINE_ASKED : FEELINGS_LINE;
    assert.ok(renderAffectDirective(d, last, COMPUTED).includes(`- ${template.replace('{feelings}', 'on edge')}`), band);
  }
});

test('the slip, the low flag and the put-off open by band, never before the table says', () => {
  // A sad core with an extreme edge, on a stamp whose draw slips (turnDraw(1) is under the slip share).
  const row = { ...carried('drained', { anxiety: 90 }), at: 1 };
  const by = (band: FamiliarityBand) => compileAffect(row, COMPUTED, undefined, undefined, band);
  assert.deepEqual(BANDS.map(b => by(b).feelingSlip), ['', '', 'on edge', 'on edge']);
  assert.deepEqual(BANDS.map(b => by(b).low), [false, false, true, true]);
  assert.deepEqual(BANDS.map(b => by(b).spent), [false, false, false, true]);
});

test('shape, energy and the ceilings pass every band untouched, and so does the word', () => {
  for (const core of MOOD_CORES) {
    for (const battery of [10, 45, 90]) {
      for (const hour of [2, 16]) {
        const last = carried(WORD_FOR[core], { social_battery: battery });
        const computed = at(hour);
        const close = compileAffect(last, computed, belowBand('playfulness'), mode('venting'), 'close');
        for (const band of BANDS) {
          const d = compileAffect(last, computed, belowBand('playfulness'), mode('venting'), band);
          for (const k of ['mood', 'brevity', 'bubbleCap', 'hooks', 'question', 'heavy', 'lateNight', 'feelings', 'feelingStrong'] as const) {
            assert.deepEqual(d[k], close[k], `${core} / ${battery} / ${hour} / ${band}: ${k}`);
          }
        }
      }
    }
  }
});

test('rapport landing badly pulls the mask up one band, on the question gate\'s own line', () => {
  const floor = RAPPORT_RESTING - RAPPORT_QUESTION_BAND;
  const with_ = (rapport: number, band: FamiliarityBand) =>
    compileAffect(carried('hopeful', { rapport }), COMPUTED, undefined, undefined, band);
  assert.equal(with_(floor, 'close').mask, 'close');
  assert.equal(with_(floor - 1, 'close').mask, 'familiar');
  assert.equal(with_(floor - 1, 'familiar').mask, 'acquaintance');
  assert.equal(with_(floor - 1, 'acquaintance').mask, 'stranger');
  assert.equal(with_(floor - 1, 'stranger').mask, 'stranger', 'never below stranger');
  // One threshold for landing badly: the notch and the closed question arrive on the same point.
  assert.equal(with_(floor - 1, 'close').question, 'closed');
  assert.equal(with_(floor, 'close').question, 'open');
  assert.equal(compileMask('close', undefined), 'close', 'no row is no evidence of anything landing badly');
  assert.equal(compileMask('close', { ...carried(), rapport: 'nonsense' as unknown as number }), 'close');
});

test('a first message to a stranger compiles to the composed line with the default word', () => {
  const lines = renderAffectDirective(compileAffect(undefined, COMPUTED, undefined, undefined, 'stranger'), undefined, COMPUTED);
  assert.deepEqual(lines, [composedLine('stranger', DEFAULT_MOOD.word, DEFAULT_MOOD.core)]);
  assert.ok(!lines.join('\n').includes('Your easy self'));
});

test('the mask lines are the owner\'s lines, byte for byte, with no digit and no dash', () => {
  assert.equal(MASK_LINES.stranger, 'You are {word} ({core}). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.');
  assert.equal(MASK_LINES.acquaintance, 'You are {word} ({core}). You are still getting to know them, so it stays yours: composed and pleasant, and none of it reaches the words.');
  assert.equal(FEELINGS_LINE_ASKED, 'Underneath, right now, you are {feelings}. That is the true answer when they ask how you are, said small and in your own words. Unasked, it stays yours.');
  for (const line of [MASK_LINES.stranger, MASK_LINES.acquaintance, FEELINGS_LINE_ASKED]) {
    assert.doesNotMatch(line, /\d/);
    assert.doesNotMatch(line, /—|–/);
  }
});
```

In `src/persona/status.test.ts`, insert after the test "a default climate leaves renderStatusForPrompt byte-identical to no climate at all":

```ts
// The familiarity band reaches this block through the one compile. Absent is no mask, which is the
// pre-mask block byte for byte even on a row where rapport has been landing badly; a band changes the
// mood line and nothing else in the block.
test('no band is the pre-mask weather block, and a band moves only the mood line', () => {
  const state = { last: carried(0, { rapport: 20 }), moodHistory: [] };
  const today = renderStatusForPrompt(state, COMPUTED, movedClimate(), true);
  assert.equal(renderStatusForPrompt(state, COMPUTED, movedClimate(), true, undefined), today);
  assert.ok(today.includes('- You are hopeful (powerful). A judgment lands flat and certain. Do not explain it.'));
  const stranger = renderStatusForPrompt(state, COMPUTED, movedClimate(), true, 'stranger');
  assert.ok(stranger.includes('- You are hopeful (powerful). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.'));
  assert.equal(withoutMoodLine(stranger), withoutMoodLine(today), 'the climate span, the self-note and the tail are the same block');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/affectCompiler.test.ts src/persona/status.test.ts`
Expected: FAIL. `affectCompiler.test.ts` does not load (`does not provide an export named 'FEELINGS_LINE_ASKED'`); `status.test.ts` fails the new test (the stranger line is absent, since the fifth argument is ignored).

- [ ] **Step 3: Implement the mask stage in `src/persona/affectCompiler.ts`**

(a) Replace the IMPORT DIRECTION paragraph and the imports (lines 35-43) with:

```ts
// THE MASK is the last stage, and it decides what compiles, never what is true. How well she knows
// them arrives as a band (persona/familiarity.ts); `compileMask` pulls it up one notch when rapport
// has been landing badly, on the question gate's own line; MASK_OPENS says, band by band, which
// layers of the mood reach an instruction. Shape and energy always pass (the battery, the hook
// allowance the core carries, the question ceiling, the hour). Content opens in order, positive
// before negative, and the deepest layer, her mood putting an ask off, opens last. The gauges and
// the reported word run underneath at every band, and asked how she is she answers true at every
// band (FEELINGS_LINE_ASKED). No band at all is no mask: the compile as it stood before the stage.
//
// IMPORT DIRECTION, and it has to stay this way: status.ts imports this file BY VALUE, so everything
// this file takes from status.ts is `import type` and erased at compile time — the same edge, and the
// same argument, as affectDrift.ts's header states for itself. mood.ts, climate.ts and familiarity.ts
// are leaves, so those three are ordinary value imports and nothing can load back through them.

import { coreForLabel, CORE_VALENCE_BAND, type MoodCore } from './mood.js';
import { bandForDial, clampToSpec, type RelationshipClimate } from './climate.js';
import { lowerBand, type FamiliarityBand } from './familiarity.js';
import type { CircadianSlot } from './circadian.js';
import type { AffectStatus, ComputedState, IntentMode } from './status.js';
```

(b) In `interface AffectDirective`, after the `feelingSlip: string;` field (line 107), add:

```ts
  /** How much of all this they get to see: the familiarity band after the rapport notch
   *  (`compileMask`), or `close` when the caller passed no band. The renderer reads it to pick the
   *  mood line and the feelings line; every field above is already masked by it. */
  mask: FamiliarityBand;
```

(c) Replace the `CORE_DIRECTIVES` declaration head and its `mad` and `sad` rows (lines 134-147) with:

```ts
export const CORE_DIRECTIVES: Record<
  MoodCore,
  { line: string; say?: string; hooks: Exclude<HookAllowance, 'none'>; question: QuestionGate }
> = {
  // `say` is the part of a core's sentence that acts on them (a flat no, a put-off) rather than
  // colouring the reply. It is the deepest layer the familiarity mask opens, so it renders only at
  // the close band, joined to `line` with one space: the close band is byte-identical to the
  // unsplit sentence (renderMoodLine).
  mad: {
    line: 'Sharper and shorter than usual. A judgment comes easily today; keep it on what they did, never on who they are.',
    say: 'A favour asked in the same breath as a put-down gets a flat no.',
    hooks: 'all',
    question: 'open',
  },
  sad: {
    line: 'Fewer words. No tangents. Answer, then stop.',
    say: 'Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.',
    hooks: 'no_tangent',
    question: 'open',
  },
```

(the `scared`, `joyful`, `powerful`, `peaceful` rows and the closing `};` stay as they are).

(d) After the `FEELINGS_LINE` constant (line 269), add:

```ts

/** The same hand-over at the two bands where a feeling is not theirs yet (spec §3, Fable's line). It
 *  is still the true answer when they ask, said small; unasked, nothing of it is volunteered. */
export const FEELINGS_LINE_ASKED = 'Underneath, right now, you are {feelings}. That is the true answer when they ask how you are, said small and in your own words. Unasked, it stays yours.';
```

(e) Insert this section after `compileHeavy` (after line 370) and before the `compileAffect` doc comment:

```ts

// ── The mask ─────────────────────────────────────────────────────────────────────────

/** What one band lets through. Every field names a layer of the mood's CONTENT; shape and energy are
 *  not in here because they pass every band. */
export interface MaskOpens {
  /** Which mood line renders: the composed line for every core, the positive cores' own lines with
   *  the composed line for the rest, every core's base line, or the base line with its say clause. */
  moodLine: 'composed' | 'positive' | 'base' | 'full';
  /** The core's own shift to English looseness: none, joyful's lift only, or both directions. */
  looseness: 'none' | 'joyful' | 'both';
  /** The feelings line: the asked-only variant, or the full one. */
  feelingsLine: 'asked' | 'full';
  /** Whether an extreme feeling may slip into the reply. */
  slip: boolean;
  /** Whether her low weather reaches the hook section (she asks lazily). */
  low: boolean;
  /** Whether a sad core may put an open-ended ask off. The last layer to open. */
  spent: boolean;
}

/** The spec's band table (§2), row for row. Cumulative: nothing a band opens closes again above it. */
export const MASK_OPENS: Record<FamiliarityBand, MaskOpens> = {
  stranger: { moodLine: 'composed', looseness: 'none', feelingsLine: 'asked', slip: false, low: false, spent: false },
  acquaintance: { moodLine: 'positive', looseness: 'joyful', feelingsLine: 'asked', slip: false, low: false, spent: false },
  familiar: { moodLine: 'base', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: false },
  close: { moodLine: 'full', looseness: 'both', feelingsLine: 'full', slip: true, low: true, spent: true },
};

/** The wheel's own split (mood.ts CORE_VALENCE_BAND): a core whose band starts above the midpoint is
 *  a positive one. Read off the chart rather than listed, so the mask opens on the same division the
 *  question ceiling was drawn on. */
export function isPositiveCore(core: MoodCore): boolean {
  return CORE_VALENCE_BAND[core][0] >= 50;
}

/**
 * The band this turn is compiled under: the one the caller read, pulled up a notch when rapport has
 * been landing badly. The threshold is the question gate's own (`RAPPORT_RESTING -
 * RAPPORT_QUESTION_BAND`), on purpose: one line for "landing badly", so the question closing and the
 * mask coming back up arrive on the same point. No carried row is no evidence of anything landing
 * badly, and a garbled rapport reads as the middle, the same rescue the question gate gets.
 */
export function compileMask(familiarity: FamiliarityBand, last: AffectStatus | undefined): FamiliarityBand {
  if (last && level(last.rapport) < RAPPORT_RESTING - RAPPORT_QUESTION_BAND) return lowerBand(familiarity);
  return familiarity;
}
```

(f) Replace the `compileAffect` function (lines 393-434, signature through closing brace) with:

```ts
export function compileAffect(
  last: AffectStatus | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
  carried?: CarriedIntent,
  familiarity?: FamiliarityBand,
): AffectDirective {
  const mood = moodOf(last);
  const brevity = brevityOf(last);
  // No band is no mask: the close band with no rapport notch, which is this compile as it stood
  // before the mask existed, for every caller that passes nothing (the flag off, every older test).
  const mask: FamiliarityBand = familiarity === undefined ? 'close' : compileMask(familiarity, last);
  const opens = MASK_OPENS[mask];

  let hooks: HookAllowance = CORE_DIRECTIVES[mood.core].hooks;
  if (bandForDial(climate, 'candor') === 'below') hooks = tightenHooks(hooks, 'no_judgment');
  if (bandForDial(climate, 'playfulness') === 'below') hooks = tightenHooks(hooks, 'no_tangent');
  if (last && level(last.mood_level) < HOOK_MOOD_FLOOR) hooks = tightenHooks(hooks, 'none');

  const lateNight = LATE_SLOTS.includes(computed.circadian.slot);

  // The hour's share of looseness is energy and passes every band. The core's share is content, so it
  // opens with the band: joyful's lift from acquaintance on, the careful drop of sad and scared only
  // once the negative cores show at all.
  let loose: number = 1;
  if (lateNight) loose += 1;
  if (mood.core === 'joyful' && opens.looseness !== 'none') loose += 1;
  if ((mood.core === 'sad' || mood.core === 'scared') && opens.looseness === 'both') loose -= 1;
  const englishLooseness = Math.max(0, Math.min(3, loose)) as 0 | 1 | 2 | 3;

  return {
    mood,
    bubbleCap: capFor(brevity),
    brevity,
    hooks,
    question: compileQuestionGate(last, mood.core, carried),
    heavy: compileHeavy(carried),
    lateNight,
    englishLooseness,
    // Sad alone: a tired battery at midnight is ordinary and must not make her put off every
    // open-ended ask; a sad core is the state that does. And only at the close band: putting their
    // ask off is the deepest layer the mask opens.
    spent: opens.spent && mood.core === 'sad',
    low: opens.low && (mood.core === 'sad' || mood.core === 'mad' || mood.core === 'scared'
      || brevity !== 'normal' || (!!last && level(last.mood_level) < HOOK_MOOD_FLOOR)),
    feelings: compileFeelings(last, computed),
    feelingStrong: (compileMoodlets(last, computed)[0]?.strength ?? 0) >= FEELING_STRONG,
    feelingSlip: opens.slip && (compileMoodlets(last, computed)[0]?.strength ?? 0) >= FEELING_STRONG && turnDraw(last?.at) < FEELING_SLIP_PERCENT
      ? compileMoodlets(last, computed)[0].word : '',
    mask,
  };
}
```

(g) After the `LATE_NIGHT_LINE` constant (line 453), add:

```ts

/** The composed mood line, keyed by the effective band and used in place of the core's line (spec §3,
 *  Fable's lines, pasted byte-for-byte). The true word and core still ride it: asked how she is, she
 *  answers true at every band. Rendered as `- ` plus the line, the same shape as the core's line. */
export const MASK_LINES: Record<'stranger' | 'acquaintance', string> = {
  stranger: 'You are {word} ({core}). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.',
  acquaintance: 'You are {word} ({core}). You are still getting to know them, so it stays yours: composed and pleasant, and none of it reaches the words.',
};
```

(h) Replace `renderMoodLine` (lines 455-459, doc comment included) with:

```ts
/** `- You are <word> (<core>). <the core's imperative>` — the one line that still names a feeling,
 *  and it names it in order to hand over an instruction. `mask` picks which imperative: the composed
 *  line at the front bands (for every core at stranger, for the negative cores at acquaintance), the
 *  core's base line at familiar, and the base line with its say clause at close. The default is close,
 *  which renders every core's sentence exactly as it stood before the say split. */
export function renderMoodLine(mood: { core: MoodCore; word: string }, mask: FamiliarityBand = 'close'): string {
  const row = CORE_DIRECTIVES[mood.core];
  const opens = MASK_OPENS[mask].moodLine;
  if (opens === 'composed' || (opens === 'positive' && !isPositiveCore(mood.core))) {
    const line = MASK_LINES[mask === 'stranger' ? 'stranger' : 'acquaintance'];
    return `- ${line.replace('{word}', () => mood.word).replace('{core}', () => mood.core)}`;
  }
  const say = opens === 'full' && row.say ? ` ${row.say}` : '';
  return `- You are ${mood.word} (${mood.core}). ${row.line}${say}`;
}
```

(i) In `renderAffectDirective`, replace

```ts
  lines.push(renderMoodLine(directive.mood));
  if (directive.feelings.length) {
    const line = FEELINGS_LINE.replace('{feelings}', directive.feelings.join(' and '));
```

with

```ts
  lines.push(renderMoodLine(directive.mood, directive.mask));
  if (directive.feelings.length) {
    const template = MASK_OPENS[directive.mask].feelingsLine === 'full' ? FEELINGS_LINE : FEELINGS_LINE_ASKED;
    const line = template.replace('{feelings}', directive.feelings.join(' and '));
```

- [ ] **Step 4: Hand the band through `renderStatusForPrompt` in `src/persona/status.ts`**

(a) After the existing `import { climateLines, climateLinesForComposer, type RelationshipClimate } from './climate.js';` (line 66) add:

```ts
// The band name only. A leaf, and a type: the value the compile reads arrives as an argument.
import type { FamiliarityBand } from './familiarity.js';
```

(b) In the doc comment above `renderStatusForPrompt`, after the paragraph ending `…and the flat-answer register is what it should read.` add:

```ts
 *
 * `familiarity` is how well she knows them, as the band the stored level cuts to
 * (persona/familiarity.ts), handed straight to the compile. It is the SAME value convo/client.ts
 * hands the hook engine's compile (it rides PersonaTurn to the assembler), so this block and the hook
 * directive can never disagree about how much of her mood shows. Absent is no mask at all: the block
 * byte for byte as it stood before the mask existed (pinned in status.test.ts).
```

(c) Replace the signature and first two body lines

```ts
export function renderStatusForPrompt(
  state: AffectState | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
  kindOpen = false,
): string {
  const last = state?.last;
  const directive = compileAffect(last, computed, climate);
```

with

```ts
export function renderStatusForPrompt(
  state: AffectState | undefined,
  computed: ComputedState,
  climate?: RelationshipClimate,
  kindOpen = false,
  familiarity?: FamiliarityBand,
): string {
  const last = state?.last;
  const directive = compileAffect(last, computed, climate, undefined, familiarity);
```

`renderStatusForComposer` is left for Task 6: until then it calls `renderMoodLine(moodOf(last))`, which defaults to close and renders byte-identical to today.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/affectCompiler.test.ts src/persona/status.test.ts src/persona/autonomy.test.ts src/persona/hooks.test.ts src/agents/convo/promptSections.test.ts src/agents/convo/internalWeather.test.ts`
Expected: `affectCompiler.test.ts` reports 41 passing (29 existing + 12 new) and `status.test.ts` 48 (47 + 1); the whole run ends `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persona/affectCompiler.ts src/persona/affectCompiler.test.ts src/persona/status.ts src/persona/status.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Compile a familiarity mask: the mood opens in layers as she knows someone

One stage in compileAffect: MASK_OPENS is the spec's band table, compileMask pulls the band up a
notch on the question gate's rapport line, and the mad and sad sentences split into a line and a say
clause that renders only at close. The stranger and acquaintance lines and the asked-only feelings
line are Fable's, pasted as written. No band compiles exactly as before, so every caller is unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: The post-reply familiarity pass

**Files:**
- Create: `src/memory/familiarityPass.ts`
- Test: `src/memory/familiarityPass.test.ts`

**Interfaces:**
- Consumes: Task 1 (`tickCounters`, `targetLevel`, `slewLevel`, `bandOf`, `FAMILIARITY_START`, `type FamiliarityEvidence`); Task 2 (`familiarityEnabled`, `getFamiliarity`, `saveFamiliarity`); existing `listMediumActive` (memoryMedium.ts:341), `partitionMediumRows` (mediumTerm.ts:66), `getUserProfile`, `readMoments`, `readSelf`, `getThreadInventory`, `threadingEnabled`, `momentsEnabled`, `selfEnabled`, `parseProvenance`, `LEGACY_FACT_PROV`, `getForgetEpoch`, `record`.
- Produces (from `src/memory/familiarityPass.ts`):
  - `FAMILIARITY_BAND_LABEL = 'familiarity:band'`
  - `gatherFamiliarityEvidence(handle: string, counters: { turns: number; activeDays: number }): Promise<FamiliarityEvidence>`
  - `updateFamiliarity(handle: string, opts?: { chatId?: string; now?: number }): Promise<void>` (never rejects; serialized per handle; no-op when the flag is off or the handle is a room)

- [ ] **Step 1: Write the failing test**

Create `src/memory/familiarityPass.test.ts`:

```ts
// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The familiarity pass, end to end against the ephemeral store: a replied turn is counted once and a
// day once, what she holds is read off the stores it lives in (a store behind a switch that is off
// holds nothing), the stored level moves at most two points toward what that adds up to, a room is
// never counted, and a band change files one receipt.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetStorageForTests } from '../db/sqlite.js';
import { getFamiliarity, saveFamiliarity, type FamiliarityRow } from '../db/repositories/familiarity.js';
import { upsertFact } from '../db/repositories/memoryMedium.js';
import { addUserFact, setUserName } from '../db/repositories/profiles.js';
import { writeMoments } from '../db/repositories/moments.js';
import { writeSelf, type SelfEntry, type SelfKind } from '../db/repositories/self.js';
import { saveThreadInventory } from '../db/repositories/threadInventory.js';
import { defaultThreadInventory, type OpenLoop, type ThreadTheme } from '../persona/threads.js';
import type { MomentEntry } from '../persona/moments.js';
import { emptyEvidence, FAMILIARITY_SLEW } from '../persona/familiarity.js';
import { SEED_SOURCE } from './provenance.js';
import { groupHandle } from './identity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';
import { FAMILIARITY_BAND_LABEL, gatherFamiliarityEvidence, updateFamiliarity } from './familiarityPass.js';

const H = '+15550003131';
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ENV = ['CONVO_FAMILIARITY_ENABLED', 'MEMORY_PROVENANCE_ENABLED', 'MEMORY_MOMENTS_ENABLED', 'MEMORY_SELF_ENABLED', 'CONVO_THREADING_ENABLED'];

beforeEach(() => {
  resetStorageForTests();
  clearTraces();
  for (const k of ENV) delete process.env[k];
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
});
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** The stored row without its write clock. */
async function row(handle: string): Promise<Omit<FamiliarityRow, 'updatedAt'> | null> {
  const r = await getFamiliarity(handle);
  return r && { level: r.level, turns: r.turns, activeDays: r.activeDays, lastDay: r.lastDay };
}

const bandReceipts = () => getTraces().filter(e => e.label === FAMILIARITY_BAND_LABEL);

function moment(id: string): MomentEntry {
  return { id, text: 'checked the volcano dashboard again and decided nothing', tag: 'habit', at: T0, count: 1, offered: 0, lastOfferedAt: 0 };
}
function selfEntry(id: string, kind: SelfKind): SelfEntry {
  return { id, kind, text: 'pineapple belongs on pizza, sweet and salt is the point', at: T0 };
}
function theme(id: string, uptakes: number): ThreadTheme {
  return {
    id, label: `speed vs craft ${id}`, kind: 'tension', note: 'ships fast, then hates the seams',
    evidenceDays: [T0 - 3 * DAY, T0], evidenceCount: 2, status: 'taggable', confidence: 40,
    firstSeenAt: T0 - 3 * DAY, lastSeenAt: T0, lastOfferedAt: 0, lastTaggedAt: 0, lastOutcome: null,
    soreAt: 0, uptakes, passes: 0, pushbacks: 0, mintedDistressed: false,
  };
}
function loop(id: string): OpenLoop {
  return {
    id, label: 'the interview', note: 'the thing on thursday', status: 'open',
    capturedAt: T0, lastSeenAt: T0, offeredAt: 0, askedAt: 0, resolvedAt: 0, passes: 0,
  };
}

/** One of everything, in every store the pass reads. */
async function seedEverything(): Promise<void> {
  process.env.MEMORY_PROVENANCE_ENABLED = 'true';
  await upsertFact(H, 'job', 'runs a plant nursery');                       // their words
  await upsertFact(H, 'pet', 'probably a cat person', 'convo', 'inferred');  // her guess
  await upsertFact(H, 'hometown', 'grew up near the coast', SEED_SOURCE);    // the engine's picture
  await addUserFact(H, 'likes golf');                                        // stated, the default basis
  await addUserFact(H, 'a night owl', 'inferred');
  await setUserName(H, 'Ada');
  await writeMoments(H, [moment('m1'), moment('m2')], 0, []);
  await writeSelf(H, [selfEntry('s1', 'stance'), selfEntry('s2', 'taste'), selfEntry('s3', 'learned'), selfEntry('s4', 'changed')], 0, []);
  await saveThreadInventory(H, { ...defaultThreadInventory(), themes: [theme('t1', 1), theme('t2', 0)], loops: [loop('l1')] });
}

// ── the counters ─────────────────────────────────────────────────────────────

test('a first replied turn opens a row at the bottom and counts the turn and the day', async () => {
  await updateFamiliarity(H, { now: T0 });
  assert.deepEqual(await row(H), { level: 1, turns: 1, activeDays: 1, lastDay: '2026-09-20' });
});

test('the same day is one day however many turns it holds, and the next day is another', async () => {
  await updateFamiliarity(H, { now: T0 });
  await updateFamiliarity(H, { now: T0 + 60_000 });
  await updateFamiliarity(H, { now: T0 + 3 * 60 * 60 * 1000 });
  assert.deepEqual(await row(H), { level: 1, turns: 3, activeDays: 1, lastDay: '2026-09-20' });
  await updateFamiliarity(H, { now: T0 + DAY });
  assert.deepEqual(await row(H), { level: 3, turns: 4, activeDays: 2, lastDay: '2026-09-21' });
});

test('passes fired together still count every turn', async () => {
  await Promise.all([updateFamiliarity(H, { now: T0 }), updateFamiliarity(H, { now: T0 + 1 }), updateFamiliarity(H, { now: T0 + 2 })]);
  assert.equal((await row(H))?.turns, 3, 'serialized per handle, so no tick is lost to a race');
});

// ── the slew ─────────────────────────────────────────────────────────────────

test('the stored level moves at most two points a turn, in either direction', async () => {
  // A long tenure: the target (forty on tenure alone) is far above the stored ten.
  await saveFamiliarity(H, { level: 10, turns: 200, activeDays: 30, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 10 + FAMILIARITY_SLEW);
  // Nothing lived and nothing held: the target is the bottom, and the fall is paced the same.
  await saveFamiliarity(H, { level: 60, turns: 0, activeDays: 0, lastDay: '' });
  await updateFamiliarity(H, { now: T0 });
  assert.equal((await row(H))?.level, 60 - FAMILIARITY_SLEW);
});

// ── the receipt ──────────────────────────────────────────────────────────────

test('a band change files one receipt with both bands and the level, and a steady band files none', async () => {
  await saveFamiliarity(H, { level: 24, turns: 100, activeDays: 10, lastDay: '2026-09-19' });
  await updateFamiliarity(H, { now: T0, chatId: 'web:fam' });
  assert.equal((await row(H))?.level, 26);
  const receipts = bandReceipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].handle, H);
  assert.equal(receipts[0].chatId, 'web:fam');
  assert.deepEqual(receipts[0].detail, { from: 'stranger', to: 'acquaintance', level: 26 });
  clearTraces();
  await updateFamiliarity(H, { now: T0 + 60_000 });
  assert.equal((await row(H))?.level, 28);
  assert.equal(bandReceipts().length, 0, 'still acquaintance: nothing to report');
});

// ── the gates ────────────────────────────────────────────────────────────────

test('a room is never counted, and with the switch off nobody is', async () => {
  const room = groupHandle('chat-fam-1');
  await updateFamiliarity(room, { now: T0 });
  assert.equal(await getFamiliarity(room), null);
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await updateFamiliarity(H, { now: T0 });
  assert.equal(await getFamiliarity(H), null);
});

// ── the evidence ─────────────────────────────────────────────────────────────

test('what she holds is read off each store, facts counted by who said so', async () => {
  await seedEverything();
  assert.deepEqual(await gatherFamiliarityEvidence(H, { turns: 7, activeDays: 3 }), {
    turns: 7, activeDays: 3, statedFacts: 2, inferredFacts: 2, seededFacts: 1, name: 1,
    moments: 2, themesTaken: 1, loops: 1, selfEntries: 3,
  });
});

test('a store behind a switch that is off holds nothing, and a person she holds nothing about is empty', async () => {
  await seedEverything();
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  process.env.MEMORY_SELF_ENABLED = 'off';
  process.env.CONVO_THREADING_ENABLED = 'off';
  const ev = await gatherFamiliarityEvidence(H, { turns: 0, activeDays: 0 });
  assert.deepEqual(
    { moments: ev.moments, selfEntries: ev.selfEntries, themesTaken: ev.themesTaken, loops: ev.loops },
    { moments: 0, selfEntries: 0, themesTaken: 0, loops: 0 },
  );
  assert.equal(ev.statedFacts, 2, 'facts have no switch and still count');
  assert.equal(ev.name, 1);
  assert.deepEqual(await gatherFamiliarityEvidence('+15550009898', { turns: 0, activeDays: 0 }), emptyEvidence());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/memory/familiarityPass.test.ts`
Expected: FAIL, the file cannot load: `Cannot find module '.../src/memory/familiarityPass.js'`.

- [ ] **Step 3: Write the pass**

Create `src/memory/familiarityPass.ts`:

```ts
// The familiarity pass: after a reply, count the turn, read what she holds about them, and move the
// stored level toward what that adds up to (persona/familiarity.ts owns the arithmetic). No model
// call, and the turn never waits on it: agents/convo/shared.ts fires it beside the climate eval,
// under the same group skip, and a failure costs this one tick and nothing else.
//
// The turn reads only the stored row, so the mask runs one turn behind the harvests. A two-point
// slew makes that lag invisible.
//
// SERIALIZED PER HANDLE, in this module: a fast follow-up can start its pass before the last one has
// saved, and two passes that both read the same row would lose a tick. The chain is local on purpose
// (the shared per-handle lock in db/repositories/memory.ts is taken by some of the reads below, and a
// pass holding it would deadlock on its own read).

import { getFamiliarity, saveFamiliarity } from '../db/repositories/familiarity.js';
import { getForgetEpoch } from '../db/repositories/memory.js';
import { listMediumActive } from '../db/repositories/memoryMedium.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { readMoments } from '../db/repositories/moments.js';
import { readSelf, type SelfKind } from '../db/repositories/self.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { familiarityEnabled, momentsEnabled, selfEnabled } from '../persona/featureFlags.js';
import {
  FAMILIARITY_START, bandOf, slewLevel, targetLevel, tickCounters, type FamiliarityEvidence,
} from '../persona/familiarity.js';
import { partitionMediumRows } from './mediumTerm.js';
import { LEGACY_FACT_PROV, parseProvenance, type Provenance } from './provenance.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';

/** Filed whenever the stored band changes, with the old band, the new one and the level. */
export const FAMILIARITY_BAND_LABEL = 'familiarity:band';

/** The SELF.md kinds that are about HER. A learned entry is about them, and is not counted. */
const HER_OWN: ReadonlySet<SelfKind> = new Set<SelfKind>(['stance', 'taste', 'changed']);

/**
 * What she holds about this person, as counts, plus the two lived-exchange counters handed in. Every
 * read here degrades to empty on its own, so this never throws. A store behind a switch that is off
 * contributes nothing: she genuinely holds less. Medium facts are listed rather than loaded through
 * `loadMediumBundle`, so this is a pure read (the dashboard calls it too) and never folds a legacy
 * language directive on the way past.
 */
export async function gatherFamiliarityEvidence(
  handle: string,
  counters: { turns: number; activeDays: number },
): Promise<FamiliarityEvidence> {
  const [facts, profile, moments, inventory, self] = await Promise.all([
    listMediumActive(handle, ['fact']),
    getUserProfile(handle),
    momentsEnabled() ? readMoments(handle) : Promise.resolve(null),
    threadingEnabled() ? getThreadInventory(handle) : Promise.resolve(null),
    selfEnabled() ? readSelf(handle) : Promise.resolve(null),
  ]);
  const byProv: Record<Provenance, number> = { stated: 0, inferred: 0, seeded: 0 };
  const medium = partitionMediumRows(facts);
  for (const key of Object.keys(medium.facts)) byProv[medium.factProv?.[key] ?? LEGACY_FACT_PROV]++;
  // An unprefixed profile fact is a legacy row, which reads as stated (provenance.ts LEGACY_FACT_PROV).
  for (const fact of profile?.facts ?? []) byProv[parseProvenance(fact).prov ?? LEGACY_FACT_PROV]++;
  return {
    turns: counters.turns,
    activeDays: counters.activeDays,
    statedFacts: byProv.stated,
    inferredFacts: byProv.inferred,
    seededFacts: byProv.seeded,
    name: profile?.name ? 1 : 0,
    moments: moments?.entries.length ?? 0,
    themesTaken: inventory?.themes.filter(t => t.uptakes >= 1).length ?? 0,
    loops: inventory?.loops.length ?? 0,
    selfEntries: self?.entries.filter(e => HER_OWN.has(e.kind)).length ?? 0,
  };
}

/** One pass: tick, read, slew, save, and receipt a band change. */
async function familiarityPass(handle: string, opts: { chatId?: string; now?: number }): Promise<void> {
  const now = opts.now ?? Date.now();
  // Read BEFORE the stores and handed to the save: a /forget landing mid-pass must not have its wipe
  // undone by a level computed from what it wiped.
  const epoch = getForgetEpoch(handle);
  const prior = await getFamiliarity(handle);
  const counters = tickCounters(prior, now);
  const evidence = await gatherFamiliarityEvidence(handle, counters);
  const level = slewLevel(prior?.level ?? null, targetLevel(evidence));
  const saved = await saveFamiliarity(handle, { level, ...counters }, { ifForgetEpoch: epoch });
  if (!saved) return;
  const from = bandOf(prior?.level ?? FAMILIARITY_START);
  const to = bandOf(level);
  if (from !== to) {
    record({ type: 'event', label: FAMILIARITY_BAND_LABEL, chatId: opts.chatId, handle, detail: { from, to, level } });
  }
}

const chains = new Map<string, Promise<void>>();

/**
 * Count this replied turn for `handle` and move its level. Fire-and-forget at the call site; the
 * returned promise never rejects (a failure is logged and the level stays where it was), and it
 * resolves once THIS handle's queued passes up to and including this one have run. A no-op with the
 * switch off, with no handle, and for a room, which is front stage and never gets a level.
 */
export function updateFamiliarity(handle: string, opts: { chatId?: string; now?: number } = {}): Promise<void> {
  if (!familiarityEnabled() || !handle || isGroupHandle(handle)) return Promise.resolve();
  const next = (chains.get(handle) ?? Promise.resolve())
    .then(() => familiarityPass(handle, opts))
    .catch(err => { console.warn('[familiarity] pass failed, the level is unchanged', err); });
  chains.set(handle, next);
  void next.then(() => { if (chains.get(handle) === next) chains.delete(handle); });
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/memory/familiarityPass.test.ts`
Expected: `# pass 8`, `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/memory/familiarityPass.ts src/memory/familiarityPass.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Add the familiarity pass: count the turn, read what she holds, slew the level

Reads the medium and profile facts by provenance, the name, moments, themes they picked up, open
loops and her own SELF entries (each store off when its switch is), ticks the turn and the UTC day,
slews at most two points, saves under the forget fence and files familiarity:band on a band change.
Serialized per handle. Nothing calls it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Wire the band into a real turn

**Files:**
- Modify: `src/agents/convo/client.ts` (imports lines 19-21 and 39; the parallel batch lines 337-380; after line 387; line 594; line 802)
- Modify: `src/agents/convo/shared.ts` (imports; `PersonaTurn` lines 1381-1390; line 1788; after line 4969)
- Test: `src/agents/convo/familiarityWiring.test.ts` (new)

**Interfaces:**
- Consumes: `familiarityEnabled` (Task 2), `getFamiliarity` (Task 2), `familiarityBandFor` and `type FamiliarityBand` (Task 1), `compileAffect(…, familiarity?)` and `renderStatusForPrompt(…, familiarity?)` (Task 3), `updateFamiliarity` (Task 4).
- Produces: `PersonaTurn.familiarity?: FamiliarityBand` in `src/agents/convo/shared.ts` (absent when the flag is off).

- [ ] **Step 1: Write the failing test**

Create `src/agents/convo/familiarityWiring.test.ts`:

```ts
// The familiarity mask, WIRED: the band the stored row reads as reaches BOTH compiles of a real turn
// (the hook engine's in convo/client.ts and the weather block's in persona/status.ts) as one value, a
// room is a stranger whatever its row says, the post-reply pass counts the turn, and with the switch
// off nothing is read, nothing is written and the weather is the pre-mask block. Driven through the
// front door (convo/client.ts `chat`) with the lane faked, the hookWiring client-seam pattern.

process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';
// Query expansion would otherwise dispatch a real classify call (the hookWiring pin, same reason).
process.env.MEMORY_RECALL_EXPANSION = 'off';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from './client.js';
import { clearIdleClassifyCache } from './idleClassify.js';
import type { ChatContext } from './shared.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { saveAffectState } from '../../db/repositories/affectState.js';
import { getFamiliarity, saveFamiliarity } from '../../db/repositories/familiarity.js';
import { updateFamiliarity } from '../../memory/familiarityPass.js';
import { groupHandle } from '../../memory/identity.js';
import { coerceStatus, mergeStatus, type AffectGauges, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { clearTraces } from '../../diagnostics/trace.js';
import { emptyMedia } from '../../webhook/types.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';

// A frozen afternoon clock (not a late slot), pinned by hand as hookWiring does.
const FROZEN_MS = Date.UTC(2026, 0, 6, 15, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// No lane: every model call is injected or fails instantly (hookWiring's reasoning).
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const SENDER = '+15550004242';
const COMPUTED: ComputedState = {
  cycle: computeCycle(FROZEN_MS, FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};
/** A task by the idle gate's own reading (hookWiring uses the same message for its task turns). */
const TASK = 'deploy the cedars order';

/** The sad core's lines at three bands, and the drift anchor's running-on-empty bullet, which rides a
 *  task turn only when the HOOK engine's compile marked her spent (persona/policy.ts). */
const SAD_CLOSE = '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.';
const SAD_FAMILIAR = '- You are drained (sad). Fewer words. No tangents. Answer, then stop.';
const SAD_STRANGER = '- You are drained (sad). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.';
const SPENT_LAW = '- You are running on empty.';

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  clearIdleClassifyCache();
  delete process.env.CONVO_FAMILIARITY_ENABLED;
});

/** Her carried row in this chat: drained, which the chart files under sad. */
async function seedSad(chatId: string, gauges: Partial<AffectGauges> = {}): Promise<void> {
  const emitted = coerceStatus({
    mood_label: 'drained', mood_shift: 'steady', intent_mode: 'asking_help',
    terminal_closure: false, epistemic_trigger: 'none', meta_prompt: '',
  })!;
  await saveAffectState(chatId, {
    ...mergeStatus(emitted, COMPUTED, FROZEN_MS - 60_000),
    mood_level: 60, anxiety: 40, warmth: 60, social_battery: 70, rapport: 40, patience: 60,
    ...gauges,
  });
}

function envelope(): LlmResult {
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: null,
      // A flat answer (hookWiring's own task reply): no promise of work, so no guard re-asks.
      bubbles: [{ text: 'six to eight weeks, same as last time', re: null }],
      status: {
        mood_label: 'drained', mood_shift: 'steady', intent_mode: 'asking_help',
        terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'keep it short',
      },
    }),
    toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test',
  };
}

const clientCtx = (over: Partial<ChatContext> = {}): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, ...over,
});

/** One task turn through the front door; the prompt the lane was handed (system, then the tail). */
async function turnOn(chatId: string, ctx: ChatContext = clientCtx()): Promise<string> {
  const seen: LlmRequest[] = [];
  await chat(chatId, TASK, emptyMedia(), ctx, async (req: LlmRequest) => { seen.push(req); return envelope(); });
  assert.ok(seen.length >= 1, 'the front-line call was made');
  const tail = seen[0].messages[seen[0].messages.length - 2];
  return `${seen[0].system ?? ''}\n\n${typeof tail?.content === 'string' ? tail.content : ''}`;
}

/** The weather block's mood line: the block runs from its header to the re-report tail, and its one
 *  `- You are` line is the mood (the drift anchor has `- You are` bullets of its own, further down). */
function moodLineOf(prompt: string): string | undefined {
  const from = prompt.indexOf('## Where you are right now');
  const weather = prompt.slice(from, prompt.indexOf('- Re-report your `status`', from));
  return weather.split('\n').find(l => l.startsWith('- You are '));
}

test('with the switch off the weather is the pre-mask block and the ledger is never touched', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await saveFamiliarity(SENDER, { level: 5, turns: 3, activeDays: 1, lastDay: '2026-01-05' });
  const chatId = randomUUID();
  await seedSad(chatId);
  const prompt = await turnOn(chatId);
  assert.equal(moodLineOf(prompt), SAD_CLOSE, 'the close line, say clause and all, whatever is stored');
  assert.ok(prompt.includes(SPENT_LAW), 'and the hook engine compiled with no mask either');
  assert.equal((await getFamiliarity(SENDER))?.turns, 3, 'no tick: the pass never ran');
});

test('switched on, a stranger gets the composed line, the hook engine agrees, and the turn is counted', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const chatId = randomUUID();
  await seedSad(chatId);
  const prompt = await turnOn(chatId);   // no row yet: a stranger
  assert.equal(moodLineOf(prompt), SAD_STRANGER, 'composed, and the say clause is gone with the rest');
  assert.ok(!prompt.includes(SPENT_LAW), 'the task directive is not marked spent: the same band reached both compiles');
  // Chained per handle, so awaiting one more pass waits out the turn's own.
  await updateFamiliarity(SENDER);
  assert.equal((await getFamiliarity(SENDER))?.turns, 2);
});

test('someone close gets the whole weather, and rapport landing badly pulls it back a band', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  await saveFamiliarity(SENDER, { level: 90, turns: 400, activeDays: 40, lastDay: '2026-01-05' });
  const closeChat = randomUUID();
  await seedSad(closeChat);
  const close = await turnOn(closeChat);
  assert.equal(moodLineOf(close), SAD_CLOSE);
  assert.ok(close.includes(SPENT_LAW));

  const notchedChat = randomUUID();
  await seedSad(notchedChat, { rapport: 20 });
  const notched = await turnOn(notchedChat);
  assert.equal(moodLineOf(notched), SAD_FAMILIAR, 'close pulled up to familiar: no say clause');
  assert.ok(!notched.includes(SPENT_LAW), 'and no put-off from the hook engine either');
});

test('a room is a stranger whatever its row says, and the pass never writes one', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const chatId = randomUUID();
  await saveFamiliarity(groupHandle(chatId), { level: 95, turns: 500, activeDays: 60, lastDay: '2026-01-05' });
  await seedSad(chatId);
  const prompt = await turnOn(chatId, clientCtx({ isGroupChat: true, participantNames: ['Sam', 'Ada'], chatName: 'nursery crew' }));
  assert.equal(moodLineOf(prompt), SAD_STRANGER);
  assert.equal((await getFamiliarity(groupHandle(chatId)))?.turns, 500, 'the room row was not counted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/familiarityWiring.test.ts`
Expected: the first test passes (the off path is today's behaviour); the other three FAIL, the mood line reads `SAD_CLOSE` where `SAD_STRANGER` / `SAD_FAMILIAR` is expected. Ends `# pass 1`, `# fail 3`.

- [ ] **Step 3: Read the band in `src/agents/convo/client.ts`**

(a) After the `relationshipClimate.js` import (lines 19-21) add:

```ts
import { getFamiliarity } from '../../db/repositories/familiarity.js';
import { familiarityBandFor, type FamiliarityBand } from '../../persona/familiarity.js';
```

(b) Replace line 39 with:

```ts
import { familiarityEnabled, hooksEnabled, momentsEnabled, selfEnabled, shareTurnsEnabled, thesisEnabled } from '../../persona/featureFlags.js';
```

(c) Replace the destructuring head on line 337

```ts
  const [context, agentTz, climate, thesisDoc, whoProfile, holdingBeats, selfFile, owedAsks] = handle
```

with

```ts
  // Read ONCE for the turn: it decides whether the ledger row is read below and whether the two
  // compiles get a band at all, and those have to agree.
  const familiarityOn = familiarityEnabled();
  const [context, agentTz, climate, thesisDoc, whoProfile, holdingBeats, selfFile, owedAsks, familiarityRow] = handle
```

(d) Replace line 378 and the else tuple on line 380

```ts
        !isGroupHandle(handle) ? readOwedAsks(handle) : Promise.resolve([] as OwedAsk[]),
      ])
    : [{ block: '', hotLook: null, turn: null, gates: {}, craft: {}, pendingAsk: false }, undefined, defaultClimate(), null, null, [], null, [] as OwedAsk[]];
```

with

```ts
        !isGroupHandle(handle) ? readOwedAsks(handle) : Promise.resolve([] as OwedAsk[]),
        // How well she knows them (persona/familiarity.ts): the stored level the post-reply pass
        // keeps. Handle-keyed like the climate. Two gates, and both skip the read: the flag, and a
        // room, which is front stage and never has a level of its own.
        familiarityOn && !isGroupHandle(handle) ? getFamiliarity(handle) : Promise.resolve(null),
      ])
    : [{ block: '', hotLook: null, turn: null, gates: {}, craft: {}, pendingAsk: false }, undefined, defaultClimate(), null, null, [], null, [] as OwedAsk[], null];
```

(e) After the line `const owedSection = renderOwedSection(owedAsks, Date.now());` (line 387) add:

```ts
  // THE MASK for this turn, decided once and handed to both compiles below — the hook engine's and
  // the weather block's (it rides `personaTurn` to the assembler) — so the two can never disagree
  // about how much of her mood shows. A room is a stranger and no row is the bottom of the scale
  // (persona/familiarity.ts familiarityBandFor). Undefined with the flag off: no mask at all, which
  // compiles exactly as before the feature existed.
  const familiarity: FamiliarityBand | undefined = familiarityOn
    ? familiarityBandFor({ group: isGroupHandle(handle), level: familiarityRow?.level ?? null })
    : undefined;
```

(f) Replace line 594

```ts
    const affectDirective = compileAffect(last, computed, climate, carried);
```

with

```ts
    const affectDirective = compileAffect(last, computed, climate, carried, familiarity);
```

(g) Replace line 802

```ts
  const personaTurn = { hooks: hookDirective, moments: momentLines, thesis: thesisSection, self: selfSection, owed: owedSection };
```

with

```ts
  const personaTurn = { hooks: hookDirective, moments: momentLines, thesis: thesisSection, self: selfSection, owed: owedSection, familiarity };
```

- [ ] **Step 4: Carry the band and fire the pass in `src/agents/convo/shared.ts`**

(a) Replace the featureFlags import (line 89)

```ts
import { hooksEnabled, momentsEnabled, selfEnabled, thesisEnabled } from '../../persona/featureFlags.js';
```

with

```ts
import { familiarityEnabled, hooksEnabled, momentsEnabled, selfEnabled, thesisEnabled } from '../../persona/featureFlags.js';
import type { FamiliarityBand } from '../../persona/familiarity.js';
import { updateFamiliarity } from '../../memory/familiarityPass.js';
```

(b) In `interface PersonaTurn`, after `owed?: string;` (line 1389) add:

```ts
  /** How well she knows them, as the band that masks her mood (persona/familiarity.ts): the value
   *  convo/client.ts read once and also handed the hook engine's compile, after the flag and the room
   *  rule and before the rapport notch (the compiler applies that). Absent when the flag is off,
   *  which compiles the weather exactly as it was before the mask existed. */
  familiarity?: FamiliarityBand;
```

(c) Replace line 1788

```ts
    push('weather', renderStatusForPrompt(affectState, computed, climate, kindOpen));
```

with

```ts
    push('weather', renderStatusForPrompt(affectState, computed, climate, kindOpen, personaTurn?.familiarity));
```

(d) After line 4969 (`void updateRelationshipClimate(handle, recent, { chatId });`) add:

```ts
    // And how well she knows them (persona/familiarity.ts): this replied turn is counted, the stores
    // she holds about them are read, and the stored level slews toward what they add up to. No call,
    // and the turn never waits on it. It rides this group skip because a room is front stage and has
    // no level; the flag is read here as well as inside the pass, the house rule for a call site.
    if (familiarityEnabled()) void updateFamiliarity(handle, { chatId });
```

- [ ] **Step 5: Run the wiring test and its neighbours**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/familiarityWiring.test.ts src/agents/convo/earnedMaterial.test.ts src/agents/convo/promptSections.test.ts src/agents/convo/internalWeather.test.ts`
Expected: `familiarityWiring.test.ts` 4 of 4 pass; the run ends `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 6: Find the tests the flip would break, and pin them now**

The default is still off, so nothing else can have moved. Run the whole suite once more with the mask forced on, which is what Task 9 will make the default:

Run: `CONVO_FAMILIARITY_ENABLED=on npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)|^not ok'`
Expected: `# tests 3359` (3313 plus the 46 added in Tasks 1-5), `# fail 9`, exactly the nine baseline failures. A dry run of this plan's code found no other test that depends on the close band, so normally nothing is pinned here.

If a failure beyond the nine does appear, it is a test that drives `chat()` on a fresh store and asserts a close-band prompt (a fresh store reads as a stranger once the mask is on). For each such file, add this line directly under that file's `process.env.DATA_BACKEND = 'memory';` line (or, where there is none, directly under `process.env.TZ = 'UTC';`):

```ts
// This file pins what a turn does under the close band. The familiarity mask would read its fresh
// store as a stranger (persona/familiarity.ts), which is familiarityWiring.test.ts's subject, so the
// mask is pinned off here and the prompts below stay the ones this file was written against.
process.env.CONVO_FAMILIARITY_ENABLED = 'off';
```

Re-run: `CONVO_FAMILIARITY_ENABLED=on npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)|^not ok'`
Expected: `# tests 3359`, `# fail 9`, exactly the nine baseline failures.

- [ ] **Step 7: Commit**

```bash
git add src/agents/convo/client.ts src/agents/convo/shared.ts src/agents/convo/familiarityWiring.test.ts
git add -u src
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Hand one familiarity band to both compiles of a turn, and count the turn after

client.ts reads the stored row once (never for a room, never with the switch off) and passes the
same band to the hook engine's compile and, through PersonaTurn, to the weather block's; the
post-reply block fires the familiarity pass beside the climate eval. Still inert: the switch is off.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: The Composer relays a stranger composed

A stranger who asked for research gets the answer re-voiced by the Composer (`composerCore.ts`, called by `orchestrator.ts` and `proactive.ts`), and its weather block carries the carried mood line. Unmasked, a mad core's "sharper and shorter, a judgment comes easily" or a sad core's put-off clause would reach exactly the person the mask exists for. This task gives the relay the same band and the same rapport notch as Convo's turn.

**Files:**
- Modify: `src/persona/status.ts` (the `./affectCompiler.js` import at lines 47-49; `renderStatusForComposer` and its doc comment, lines ~768-812)
- Modify: `src/agents/composerCore.ts` (imports after line 20; the `Promise.all` at lines 96-107; the `renderStatusForComposer(affect, climate)` call at line 111)
- Test: `src/persona/status.test.ts`, `src/agents/composerCore.test.ts`

**Interfaces:**
- Consumes: `compileMask(familiarity, last)` and `renderMoodLine(mood, mask)` (Task 3); `familiarityEnabled`, `getFamiliarity` (Task 2); `familiarityBandFor`, `type FamiliarityBand` (Task 1); `import type { FamiliarityBand }` already in `status.ts` since Task 3.
- Produces: `renderStatusForComposer(state: AffectState | null | undefined, climate?: RelationshipClimate, familiarity?: FamiliarityBand): string` (absent = no mask, byte-identical to today).

- [ ] **Step 1: Write the failing tests**

In `src/persona/status.test.ts`, insert directly after the test `composer: a stale mood plus a DEFAULT climate is still "" (both halves empty)`:

```ts
// The Composer wears the mask Convo's block wears, notch included. Absent is no mask: the Composer
// block byte for byte as it stood before the feature, even on a row where rapport has been landing
// badly. A band changes the mood line and nothing else the block carries: the header, the brevity
// line and the ease line are the same bytes.
test('composer: no band is today\'s block, and a band masks the mood line alone', () => {
  const state = { last: carried(Date.now(), { rapport: 20, social_battery: 45 }), moodHistory: [] };
  const today = renderStatusForComposer(state, movedClimate());
  assert.equal(renderStatusForComposer(state, movedClimate(), undefined), today);
  assert.equal(today.split('\n')[1], '- You are hopeful (powerful). A judgment lands flat and certain. Do not explain it.');
  const stranger = renderStatusForComposer(state, movedClimate(), 'stranger');
  assert.equal(stranger.split('\n')[1], '- You are hopeful (powerful). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.');
  assert.ok(stranger.includes('- Fewer words than usual. Two bubbles at most.'), 'shape passes the mask');
  assert.equal(withoutMoodLine(stranger), withoutMoodLine(today), 'everything but the mood line is the same block');
  // The notch: a sad row relayed to someone close keeps its put-off only while rapport holds.
  const drained = (rapport: number) => ({ last: { ...carried(Date.now(), { rapport }), mood_label: 'drained' }, moodHistory: [] });
  assert.equal(
    renderStatusForComposer(drained(40), undefined, 'close').split('\n')[1],
    '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.',
  );
  assert.equal(
    renderStatusForComposer(drained(20), undefined, 'close').split('\n')[1],
    '- You are drained (sad). Fewer words. No tangents. Answer, then stop.',
    'close pulled up to familiar: the say clause is gone',
  );
});
```

In `src/agents/composerCore.test.ts`, add to the imports (after `import { resetStorageForTests } from '../db/sqlite.js';`, line 21):

```ts
import { getFamiliarity, saveFamiliarity } from '../db/repositories/familiarity.js';
```

and insert this block directly before the line `// --- the dynamic block's own order ---…` (after the test `a group identity never renders a register, even with a moved row stored under it`):

```ts
// --- the familiarity mask: the Composer relays a stranger composed ------------------------------
// The same band Convo's turn reads, off the same row, under the same gates, with the same rapport
// notch, and never written from here. A drained row files under sad, the one core whose close line
// carries a put-off clause, so close, familiar and stranger are three different lines.

const SAD_CLOSE = '- You are drained (sad). Fewer words. No tangents. Answer, then stop. Anything open-ended they ask today, research, long writing, a favour with no clock, is too much: say not now, and it stays owed.';
const SAD_FAMILIAR = '- You are drained (sad). Fewer words. No tangents. Answer, then stop.';
const SAD_STRANGER = '- You are drained (sad). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.';

/** A fresh drained row in the composer's chat, the gauges stated (rapport is the one the notch reads). */
async function seedDrained(rapport = 40): Promise<void> {
  await saveAffectState('web:a', {
    ...mergeStatus(coerceStatus({ ...RAW, mood_label: 'drained', mood_core: 'sad' })!, COMPUTED, Date.now()),
    mood_level: 60, anxiety: 40, warmth: 60, social_battery: 70, rapport, patience: 60,
  });
}

/** The weather block's mood line, out of what the model was shown. */
const moodLine = (content: string) => content.split('\n').find(l => l.startsWith('- You are '));

test('the mask is off by default in the Composer too, and a stranger relays composed once it is on', async () => {
  const known = '+15550004343';
  const fresh = '+15550004444';
  await seedDrained();
  await saveFamiliarity(known, { level: 5, turns: 3, activeDays: 1, lastDay: '2026-01-05' });
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  try {
    assert.equal(moodLine(await composedFor(known)), SAD_CLOSE, 'off: no mask, whatever is stored');
    process.env.CONVO_FAMILIARITY_ENABLED = 'on';
    assert.equal(moodLine(await composedFor(fresh)), SAD_STRANGER, 'on, and no row yet: a stranger');
    assert.equal(moodLine(await composedFor(known)), SAD_STRANGER, 'on, and a low row: still a stranger');
    assert.equal(await getFamiliarity(fresh), null, 'the Composer never writes the ledger');
    assert.equal((await getFamiliarity(known))?.turns, 3, 'nor counts a turn on a row that exists');
  } finally {
    delete process.env.CONVO_FAMILIARITY_ENABLED;
  }
});

test('a room relays composed whatever its row says, and rapport landing badly notches the relay', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  try {
    await seedDrained();
    const room = groupHandle('web:a');
    await saveFamiliarity(room, { level: 95, turns: 500, activeDays: 60, lastDay: '2026-01-05' });
    assert.equal(moodLine(await composedFor(room)), SAD_STRANGER, 'a room is front stage');

    const close = '+15550004545';
    await saveFamiliarity(close, { level: 90, turns: 400, activeDays: 40, lastDay: '2026-01-05' });
    assert.equal(moodLine(await composedFor(close)), SAD_CLOSE, 'someone close gets the whole line');
    await seedDrained(20);
    assert.equal(moodLine(await composedFor(close)), SAD_FAMILIAR, 'close pulled up to familiar: no put-off');
  } finally {
    delete process.env.CONVO_FAMILIARITY_ENABLED;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/status.test.ts src/agents/composerCore.test.ts`
Expected: FAIL, three tests: the new `status.test.ts` test (the band is ignored, so the stranger line is the close line) and both new `composerCore.test.ts` tests (the relay renders `SAD_CLOSE` where `SAD_STRANGER` is expected). Ends `# pass 63`, `# fail 3`.

- [ ] **Step 3: Mask the Composer's mood line in `src/persona/status.ts`**

(a) Replace the compiler import (lines 47-49)

```ts
import {
  compileAffect, renderAffectDirective, brevityOf, moodOf, renderBrevityLine, renderMoodLine,
} from './affectCompiler.js';
```

with

```ts
import {
  compileAffect, compileMask, renderAffectDirective, brevityOf, moodOf, renderBrevityLine, renderMoodLine,
} from './affectCompiler.js';
```

(b) In the doc comment above `renderStatusForComposer`, replace the closing lines

```ts
 * Returns '' only when BOTH parts are empty — no fresh mood AND a climate still at its defaults,
 * which is byte-for-byte the old behaviour for every caller that passes no climate.
 */
```

with

```ts
 * Returns '' only when BOTH parts are empty — no fresh mood AND a climate still at its defaults,
 * which is byte-for-byte the old behaviour for every caller that passes no climate.
 *
 * THE MASK rides here too, and it has to: a stranger who asked for research gets the answer relayed
 * through this block, and a mood Convo's own turn kept to itself must not surface in the relay.
 * `familiarity` is the band the stored level cuts to (persona/familiarity.ts), notched on rapport
 * exactly as Convo's compile notches it (affectCompiler.ts compileMask), and it picks the mood line
 * and nothing else: the brevity line and the ease-only climate subset pass every band. Absent is no
 * mask at all, the block byte for byte as it stood before the feature (pinned in status.test.ts).
 */
```

(c) Replace the signature and the mood part

```ts
export function renderStatusForComposer(
  state: AffectState | null | undefined,
  climate?: RelationshipClimate,
): string {
  const last = state?.last;
  // The mood line first, then the brevity line — the prose's order for this surface
  // (policy-strings.md, "Composer variant"), and the opposite of Convo's, where the shape lines lead
  // because a hook has to be measured against them. Nothing here has a hook to measure.
  const moodPart = last && Date.now() - last.at <= 45 * 60_000
    ? [renderMoodLine(moodOf(last)), ...renderBrevityLine(brevityOf(last))]
    : [];
```

with

```ts
export function renderStatusForComposer(
  state: AffectState | null | undefined,
  climate?: RelationshipClimate,
  familiarity?: FamiliarityBand,
): string {
  const last = state?.last;
  const mask: FamiliarityBand = familiarity === undefined ? 'close' : compileMask(familiarity, last);
  // The mood line first, then the brevity line — the prose's order for this surface
  // (policy-strings.md, "Composer variant"), and the opposite of Convo's, where the shape lines lead
  // because a hook has to be measured against them. Nothing here has a hook to measure.
  const moodPart = last && Date.now() - last.at <= 45 * 60_000
    ? [renderMoodLine(moodOf(last), mask), ...renderBrevityLine(brevityOf(last))]
    : [];
```

- [ ] **Step 4: Read the row and pass the band in `src/agents/composerCore.ts`**

(a) After the line `import { isGroupHandle } from '../memory/identity.js';` (line 20) add:

```ts
import { getFamiliarity } from '../db/repositories/familiarity.js';
import { familiarityEnabled } from '../persona/featureFlags.js';
import { familiarityBandFor, type FamiliarityBand } from '../persona/familiarity.js';
```

(b) Replace the head of the parallel read and its climate entry

```ts
  const [history, userCtx, affect, climate] = await Promise.all([
    getConversation(chatId),
    buildUserMemory('composer', handle),
    getAffectState(chatId),
    // Same two structural gates as the Convo read site (agents/convo/client.ts): the feature flag,
    // and a group identity — both resolve to the default register, which renders nothing at all.
    handle && relationshipClimateEnabled() && !isGroupHandle(handle)
      ? getRelationshipClimate(handle)
      : Promise.resolve(defaultClimate()),
  ]);
```

with

```ts
  // A FIFTH read, and the last: how well she knows them (persona/familiarity.ts), READ-ONLY like the
  // affect. The ledger is Convo's post-reply pass to write; a relay is not a turn she replied to.
  // The flag is read ONCE, because it decides both whether the row is read and whether the mood line
  // is masked at all, and those have to agree.
  const familiarityOn = familiarityEnabled();
  const [history, userCtx, affect, climate, familiarityRow] = await Promise.all([
    getConversation(chatId),
    buildUserMemory('composer', handle),
    getAffectState(chatId),
    // Same two structural gates as the Convo read site (agents/convo/client.ts): the feature flag,
    // and a group identity — both resolve to the default register, which renders nothing at all.
    handle && relationshipClimateEnabled() && !isGroupHandle(handle)
      ? getRelationshipClimate(handle)
      : Promise.resolve(defaultClimate()),
    // The climate read's gates, plus the mask's own flag: no identity and a room both skip the read.
    handle && familiarityOn && !isGroupHandle(handle)
      ? getFamiliarity(handle)
      : Promise.resolve(null),
  ]);
  // The band Convo's turn would read off the same row (agents/convo/client.ts): a room is a
  // stranger, no row is the bottom of the scale, and with the flag off there is no mask at all.
  const familiarity: FamiliarityBand | undefined = familiarityOn
    ? familiarityBandFor({ group: !!handle && isGroupHandle(handle), level: familiarityRow?.level ?? null })
    : undefined;
```

(c) Replace

```ts
  const weather = renderStatusForComposer(affect, climate);
```

with

```ts
  const weather = renderStatusForComposer(affect, climate, familiarity);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/status.test.ts src/agents/composerCore.test.ts src/agents/proactive.test.ts`
Expected: `status.test.ts` 49 of 49 and `composerCore.test.ts` 17 of 17; the run ends `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 6: Check the relay against the flip, the Task 5 Step 6 way**

Run: `CONVO_FAMILIARITY_ENABLED=on npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)|^not ok'`
Expected: `# tests 3362` (3313 plus the 49 added in Tasks 1-6), `# fail 9`, exactly the nine baseline failures. The dry run found no Composer-path test that depends on the unmasked line (the one that checks the carried word, "a fresh carried affect state is injected", still matches: the composed line keeps the true word). If a failure beyond the nine appears in a test that drives `composeWithComposer`, add the Task 5 Step 6 pin (`process.env.CONVO_FAMILIARITY_ENABLED = 'off';` with its comment) to that file and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/persona/status.ts src/persona/status.test.ts src/agents/composerCore.ts src/agents/composerCore.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Relay a stranger composed: the Composer wears the familiarity mask too

renderStatusForComposer takes the band and renders the mood line under compileMask, the same rapport
notch Convo's compile applies; the brevity line and the ease-only climate subset are unchanged.
composerCore reads the row beside the climate read (never for a room, never with the switch off) and
never writes the ledger. No band is today's block, byte for byte.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 7: Her own texts go only to people she knows

**Files:**
- Modify: `src/memory/musings.ts` (header list, imports, new `familiarityAllows`, sweep gate after line 143)
- Test: `src/memory/musings.test.ts` (new)

**Interfaces:**
- Consumes: `familiarityEnabled` (Task 2), `getFamiliarity` (Task 2), `familiarityBandFor`, `FAMILIARITY_BANDS`, `type FamiliarityBand` (Task 1).
- Produces: `familiarityAllows(band: FamiliarityBand): boolean` exported from `src/memory/musings.ts`; the sweep receipt `musings:sweep` gains the skip reason `familiarity`.

- [ ] **Step 1: Write the failing test**

Create `src/memory/musings.test.ts`:

```ts
// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// Her own texts, and the one bound the familiarity mask adds to them: she texts first only someone
// she knows (familiar or close). A stranger, including someone with no row yet, is skipped for
// `familiarity`, and with the mask switched off the bound does not exist. `deliver` is always a spy,
// and `rand` always loses the chance draw, so nothing in this file can text anyone.
process.env.TZ = 'UTC';

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  familiarityAllows, runMusingSweep, __resetMusingGuardsForTests, MUSING_QUIET_MS, type MusingMessage,
} from './musings.js';
import { FAMILIARITY_BANDS } from '../persona/familiarity.js';
import { resetStorageForTests } from '../db/sqlite.js';
import { addMessage } from '../db/repositories/conversations.js';
import { saveFamiliarity } from '../db/repositories/familiarity.js';
import { getTraces, clearTraces } from '../diagnostics/trace.js';

const H = '+15550007777';
const CHAT = 'web:musings';

/** One sweep, three hours and a minute after their message, with a chance draw that always loses. */
async function sweep(): Promise<{ calls: MusingMessage[]; considered: number; skipped: Record<string, number> }> {
  const calls: MusingMessage[] = [];
  await runMusingSweep(
    { deliver: async (m: MusingMessage) => { calls.push(m); return 'sent'; } },
    { now: Date.now() + MUSING_QUIET_MS + 60_000, rand: () => 0.99 },
  );
  const detail = (getTraces().find(e => e.label === 'musings:sweep')?.detail ?? {}) as { considered?: number; skipped?: Record<string, number> };
  return { calls, considered: detail.considered ?? 0, skipped: detail.skipped ?? {} };
}

beforeEach(async () => {
  resetStorageForTests();
  __resetMusingGuardsForTests();
  clearTraces();
  delete process.env.CONVO_FAMILIARITY_ENABLED;
  delete process.env.IRISES_MUSINGS_ENABLED;
  await addMessage(CHAT, 'user', 'morning', H);
});
afterEach(() => { delete process.env.CONVO_FAMILIARITY_ENABLED; });

test('she texts first only someone she knows: familiar or close', () => {
  assert.deepEqual(FAMILIARITY_BANDS.filter(familiarityAllows), ['familiar', 'close']);
});

test('the sweep skips a stranger for familiarity, and a missing row is a stranger', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  const none = await sweep();
  assert.equal(none.considered, 1);
  assert.equal(none.skipped.familiarity, 1, 'no row yet');
  assert.equal(none.calls.length, 0);

  clearTraces();
  await saveFamiliarity(H, { level: 49, turns: 90, activeDays: 12, lastDay: '2026-09-25' });
  assert.equal((await sweep()).skipped.familiarity, 1, 'an acquaintance is still not enough');
});

test('someone she knows passes the gate and meets the rest of the sweep', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'on';
  await saveFamiliarity(H, { level: 50, turns: 200, activeDays: 14, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(Object.values(r.skipped).reduce((n, v) => n + v, 0), 1, 'the one chat was still skipped, by a later bound');
  assert.equal(r.calls.length, 0);
});

test('with the mask off there is no gate, and a stranger row costs the sweep nothing', async () => {
  process.env.CONVO_FAMILIARITY_ENABLED = 'off';
  await saveFamiliarity(H, { level: 1, turns: 1, activeDays: 1, lastDay: '2026-09-25' });
  const r = await sweep();
  assert.equal(r.skipped.familiarity, undefined);
  assert.equal(r.calls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/memory/musings.test.ts`
Expected: FAIL, the file does not load: `The requested module './musings.js' does not provide an export named 'familiarityAllows'`.

- [ ] **Step 3: Add the gate to `src/memory/musings.ts`**

(a) In the header's bound list, replace

```ts
//   • the flag, then a real 1:1 person (never a room);
```

with

```ts
//   • the flag, then a real 1:1 person (never a room);
//   • someone she knows: familiar or close (persona/familiarity.ts), when the familiarity mask is on.
//     A stranger, and someone with no row yet, gets no text she was not asked for;
```

(b) Replace the featureFlags import (line 32) with:

```ts
import { familiarityEnabled, musingsEnabled, momentsEnabled, selfEnabled } from '../persona/featureFlags.js';
import { getFamiliarity } from '../db/repositories/familiarity.js';
import { familiarityBandFor, type FamiliarityBand } from '../persona/familiarity.js';
```

(c) After `weatherAllows` (after line 114) add:

```ts

/** Pure: does she know them well enough to text first? Familiar or close. A thought of her own is a
 *  back-stage move, and a stranger is still front stage. */
export function familiarityAllows(band: FamiliarityBand): boolean {
  return band === 'familiar' || band === 'close';
}
```

(d) Replace lines 142-143

```ts
        if (handles.length !== 1 || isGroupHandle(handles[0])) { skip('group'); continue; }
        const handle = handles[0];
```

with

```ts
        if (handles.length !== 1 || isGroupHandle(handles[0])) { skip('group'); continue; }
        const handle = handles[0];
        // The stored band, as the turn reads it before any rapport notch; no row is a stranger. With
        // the mask off there is no gate at all.
        if (familiarityEnabled()) {
          const row = await getFamiliarity(handle);
          if (!familiarityAllows(familiarityBandFor({ group: false, level: row?.level ?? null }))) { skip('familiarity'); continue; }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/memory/musings.test.ts`
Expected: `# pass 4`, `# fail 0`.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/memory/musings.ts src/memory/musings.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Keep her own texts to people she knows

The musings sweep skips anyone below familiar (a missing row is a stranger) with the new
`familiarity` skip reason, and has no such gate while the mask is off. First tests for musings.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: The familiarity row on the dashboard

**Files:**
- Modify: `src/diagnostics/adminDashboard/api/affect.ts` (imports; new shaper before `// ── the route`; the route's reads at lines 615-627 and payload)
- Modify: `src/diagnostics/adminDashboard/views/affect.ts` (header; new `familiarityPanel`; `render()`)
- Test: `src/diagnostics/adminDashboard/api/affect.test.ts`, `src/diagnostics/adminDashboard/views.test.ts`

**Interfaces:**
- Consumes: `getFamiliarity`, `type FamiliarityRow` (Task 2); `familiarityEnabled` (Task 2); `gatherFamiliarityEvidence` (Task 4); `compileMask` (Task 3); `FAMILIARITY_START`, `familiarityBandFor`, `paceCeiling`, `sourcePoints`, `emptyEvidence`, types (Task 1); existing `isGroupHandle`.
- Produces: `interface FamiliaritySummary { level; band; effectiveBand; reguarded; ceiling; turns; activeDays; sources: SourcePoints[] }` and `familiaritySummary(row: FamiliarityRow | null, evidence: FamiliarityEvidence, last: AffectStatus | undefined, opts: { enabled: boolean; group: boolean }): FamiliaritySummary`; payload field `familiarity: FamiliaritySummary`.

- [ ] **Step 1: Write the failing tests**

In `src/diagnostics/adminDashboard/api/affect.test.ts`, extend the `./affect.js` import (lines 29-32) to:

```ts
import {
  affectTrail, climateDialRows, threadSummary, traceRows, pendingApprovalRows,
  thesisSummary, momentRows, momentsFileState, rhythmSummary, familiaritySummary,
} from './affect.js';
import { emptyEvidence } from '../../../persona/familiarity.js';
```

and append at the end of the file:

```ts

// ── how well she knows them ──────────────────────────────────────────────────
// The one surface the number reaches: the stored level, the band it cuts to, the band her replies are
// actually compiled under, the pace ceiling, the two counters, and what each source is worth.

const FAM_ROW = { level: 52, turns: 40, activeDays: 14, lastDay: '2026-09-02', updatedAt: NOW };
const FAM_EVIDENCE = { ...emptyEvidence(), turns: 40, activeDays: 14, statedFacts: 3, name: 1, moments: 2 };

test('the familiarity row is the stored level, the band it cuts to, and what each source is worth', () => {
  const f = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status(), { enabled: true, group: false });
  assert.deepEqual(
    { level: f.level, band: f.band, effectiveBand: f.effectiveBand, reguarded: f.reguarded, ceiling: f.ceiling, turns: f.turns, activeDays: f.activeDays },
    { level: 52, band: 'familiar', effectiveBand: 'familiar', reguarded: false, ceiling: 52, turns: 40, activeDays: 14 },
  );
  assert.deepEqual(f.sources.find(s => s.key === 'statedFacts'), { key: 'statedFacts', count: 3, points: 6, cap: 16 });
  assert.deepEqual(f.sources.find(s => s.key === 'turns'), { key: 'turns', count: 40, points: 10, cap: 20 });
  assert.equal(f.sources.reduce((n, s) => n + s.cap, 0), 100, 'every source is on the panel');
});

test('rapport landing badly shows as a notch, and the switch off shows the close band replies compile under', () => {
  const notched = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status({ rapport: 20 }), { enabled: true, group: false });
  assert.equal(notched.effectiveBand, 'acquaintance');
  assert.equal(notched.reguarded, true);
  const off = familiaritySummary(FAM_ROW, FAM_EVIDENCE, status({ rapport: 20 }), { enabled: false, group: false });
  assert.equal(off.band, 'familiar', 'what is stored is still shown');
  assert.equal(off.effectiveBand, 'close');
  assert.equal(off.reguarded, false);
});

test('no row yet reads as a stranger at the bottom, and a room is a stranger whatever it stores', () => {
  const none = familiaritySummary(null, emptyEvidence(), undefined, { enabled: true, group: false });
  assert.deepEqual(
    { level: none.level, band: none.band, effectiveBand: none.effectiveBand, ceiling: none.ceiling, turns: none.turns, activeDays: none.activeDays },
    { level: 1, band: 'stranger', effectiveBand: 'stranger', ceiling: 10, turns: 0, activeDays: 0 },
  );
  const room = familiaritySummary({ ...FAM_ROW, level: 90 }, FAM_EVIDENCE, status(), { enabled: true, group: true });
  assert.equal(room.band, 'stranger');
  assert.equal(room.effectiveBand, 'stranger');
});
```

In `src/diagnostics/adminDashboard/views.test.ts`, insert before the `login page stays standalone` test:

```ts
// The familiarity row sits under "Right now", beside the mood it masks. Defined AND called, the same
// pin the three earned-material panels get, since a panel that is never called renders nothing.
test('the Inner state view renders the familiarity row beside the mood', () => {
  const js = VIEWS.find(v => v.id === 'affect')?.js ?? '';
  assert.ok(js.includes('function familiarityPanel('), 'familiarityPanel is not defined');
  assert.ok(js.includes('moodPanel(d) + familiarityPanel(d)'), 'the row does not render beside the mood');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/diagnostics/adminDashboard/api/affect.test.ts src/diagnostics/adminDashboard/views.test.ts`
Expected: FAIL. `affect.test.ts` does not load (`does not provide an export named 'familiaritySummary'`); `views.test.ts` fails the new test with `familiarityPanel is not defined`.

- [ ] **Step 3: Add the shaper and the reads to `api/affect.ts`**

(a) After the `import { cached } from '../cache.js';` line add:

```ts
import { getFamiliarity, type FamiliarityRow } from '../../../db/repositories/familiarity.js';
import { gatherFamiliarityEvidence } from '../../../memory/familiarityPass.js';
import { isGroupHandle } from '../../../memory/identity.js';
import { familiarityEnabled } from '../../../persona/featureFlags.js';
import { compileMask } from '../../../persona/affectCompiler.js';
import {
  FAMILIARITY_START, familiarityBandFor, paceCeiling, sourcePoints,
  type FamiliarityBand, type FamiliarityEvidence, type SourcePoints,
} from '../../../persona/familiarity.js';
```

and change the status import line to also take `AffectStatus`:

```ts
import { MOOD_HISTORY_CAP, type AffectState, type AffectStatus, type MoodShift } from '../../../persona/status.js';
```

(b) At the end of the header comment block (after the line `// revision list).`) add:

```ts
//
// The familiarity row joins them (persona/familiarity.ts): the stored level, which is the one place
// that number is ever shown, beside the band her replies are actually compiled under. Its evidence is
// read off the same stores the post-reply pass reads (memory/familiarityPass.ts), read-only.
```

(c) Insert before `// ── the route ─────…`:

```ts
// ── how well she knows them ──────────────────────────────────────────────────

/** The familiarity row as the panel reads it. `band` is what the stored level cuts to (a room is a
 *  stranger whatever it stores); `effectiveBand` is what her replies are compiled under: the rapport
 *  notch applied, or `close` with the switch off, which is no mask at all. `sources` is every row of
 *  the source table with its count, its points and its cap. */
export interface FamiliaritySummary {
  level: number;
  band: FamiliarityBand;
  effectiveBand: FamiliarityBand;
  reguarded: boolean;
  ceiling: number;
  turns: number;
  activeDays: number;
  sources: SourcePoints[];
}

/** The row, its evidence and the carried affect row, shaped for reading. Pure. */
export function familiaritySummary(
  row: FamiliarityRow | null,
  evidence: FamiliarityEvidence,
  last: AffectStatus | undefined,
  opts: { enabled: boolean; group: boolean },
): FamiliaritySummary {
  const band = familiarityBandFor({ group: opts.group, level: row?.level ?? null });
  const effectiveBand: FamiliarityBand = opts.enabled ? compileMask(band, last) : 'close';
  return {
    level: row?.level ?? FAMILIARITY_START,
    band,
    effectiveBand,
    reguarded: opts.enabled && effectiveBand !== band,
    ceiling: paceCeiling(row?.activeDays ?? 0),
    turns: row?.turns ?? 0,
    activeDays: row?.activeDays ?? 0,
    sources: sourcePoints(evidence),
  };
}
```

(d) In the route, replace

```ts
        const [state, climate, inventory, turns, thesisRead, thesisRevs, momentsFile, hookState] =
```

with

```ts
        const [state, climate, inventory, turns, thesisRead, thesisRevs, momentsFile, hookState, familiarityRow] =
```

replace

```ts
            chatId ? getHookState(chatId) : Promise.resolve(defaultHookState()),
          ]);
        const now = Date.now();
```

with

```ts
            chatId ? getHookState(chatId) : Promise.resolve(defaultHookState()),
            getFamiliarity(handle),
          ]);
        // What the level is made of, off the same stores the post-reply pass reads, with the row's
        // own counters for the two lived-exchange sources.
        const familiarityEvidence = await gatherFamiliarityEvidence(handle, {
          turns: familiarityRow?.turns ?? 0, activeDays: familiarityRow?.activeDays ?? 0,
        });
        const now = Date.now();
```

and replace

```ts
          climate: { lastEvalAt: climate.lastEvalAt, evalCount: climate.evalCount },
```

with

```ts
          climate: { lastEvalAt: climate.lastEvalAt, evalCount: climate.evalCount },
          familiarity: familiaritySummary(familiarityRow, familiarityEvidence, state.last, {
            enabled: familiarityEnabled(), group: isGroupHandle(handle),
          }),
```

- [ ] **Step 4: Render the row in `views/affect.ts`**

(a) In the header, replace

```ts
// Inner state: read-only per-user view of what colours a reply without ever being said — the mood
// she carried into the last turn and the trail behind it, the weeks-scale climate dials inside their
```

with

```ts
// Inner state: read-only per-user view of what colours a reply without ever being said — the mood
// she carried into the last turn and how well she knows them (the familiarity level, the one place
// that number is shown), the trail behind it, the weeks-scale climate dials inside their
```

(b) After the `moodPanel` function (after its closing `}`) add:

```js

  // How well she knows them: the stored level on a dial-style bar, the pace ceiling as the notch,
  // and the band beside the level. When her replies compile under another band (rapport pulled the
  // mask up one, or the switch is off) that band is named too, since it is the one that counts.
  function familiarityPanel(d){
    var f = d.familiarity;
    if (!f) return '';
    var pct = function(v){ return Math.max(0, Math.min(100, v)); };
    var band = M.esc(f.band) + (f.effectiveBand !== f.band
      ? ' \\u2192 <b>'+M.esc(f.effectiveBand)+'</b> ('+(f.reguarded ? 'rapport' : 'mask off')+')'
      : '');
    return '<div class="dial"><span>familiarity <b>'+f.level+'</b></span>'
      + '<span class="track"><i class="fill" style="width:'+pct(f.level)+'%"></i>'
      + '<i class="mark" style="left:'+pct(f.ceiling)+'%" title="pace ceiling"></i></span>'
      + '<span class="bounds">'+band+'</span></div>'
      + '<div class="kv gauges"><span>turns <b>'+f.turns+'</b></span><span>days <b>'+f.activeDays+'</b></span>'
      + '<span>ceiling <b>'+f.ceiling+'</b></span>'
      + (f.sources||[]).map(function(s){ return '<span>'+M.esc(s.key)+' <b>'+s.points+'</b>/'+s.cap+'</span>'; }).join('')
      + '</div>';
  }
```

(c) In `render()`, replace

```js
    el.innerHTML = '<h3 class="sh">Right now</h3>' + moodPanel(d)
```

with

```js
    el.innerHTML = '<h3 class="sh">Right now</h3>' + moodPanel(d) + familiarityPanel(d)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/diagnostics/adminDashboard/api/affect.test.ts src/diagnostics/adminDashboard/views.test.ts`
Expected: `# pass 29`, `# fail 0` (affect 22, views 7).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics/adminDashboard/api/affect.ts src/diagnostics/adminDashboard/api/affect.test.ts src/diagnostics/adminDashboard/views/affect.ts src/diagnostics/adminDashboard/views.test.ts
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Show how well she knows someone on the Inner state panel

The affect payload gains a familiarity row (level, band, the band replies compile under, the rapport
notch, the pace ceiling, the counters and every source against its cap), rendered under Right now as
a dial-style bar. The only surface the number reaches.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 9: Flip the mask on, and state its law once in the persona

**Files:**
- Modify: `src/persona/featureFlags.ts` (`familiarityEnabled` default and doc)
- Modify: `src/persona/featureFlags.test.ts`, `.env.example`, `deploy/app.env`
- Modify: `src/persona/policy.ts:76-82` (the §4 sentence)
- Modify: `src/persona/policy.test.ts` (one pin)
- Modify: `src/agents/convo/promptPolicy.ts:111` (`persona` pin)
- Modify: `src/agents/convo/personaModules.test.ts:170-175` (corpus pin and its history)
- Modify: `docs/ARCHITECTURE.md:81` (one bullet)

**Interfaces:**
- Consumes: everything above.
- Produces: `familiarityEnabled()` returns **true** on an empty var.

- [ ] **Step 1: Write the failing pins**

In `src/persona/featureFlags.test.ts`, replace the row added in Task 2 with:

```ts
  // The familiarity mask: default OFF through the series that built it, ON from the commit that
  // finished it. The body never changed across the flip, which is what made it one line.
  { name: 'CONVO_FAMILIARITY_ENABLED', read: familiarityEnabled, dflt: true },
```

In `src/persona/policy.test.ts`, insert after the test "the block opens on its own heading and carries exactly one":

```ts
// The familiarity mask's law, stated once where every lane reads it: with someone she barely knows a
// feeling is not theirs yet. The block hard-wraps, so the pin reads it with the wraps as spaces, and
// the sentence is the owner's, byte for byte, seated right after the feelings law it qualifies.
test('the feelings law names the mask once, right after the reason it never gives', () => {
  const flat = PERSONA_BLOCK.replace(/\n/g, ' ');
  const sentence = 'With someone you barely know, none of that is theirs yet: the feeling stays yours, and only the volume shows.';
  assert.ok(flat.includes(`and never the reason behind it. ${sentence} The good ones mostly show in how you write;`));
  assert.equal(flat.split(sentence).length - 1, 1, 'stated once');
});
```

- [ ] **Step 2: Run the pins to verify they fail**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/featureFlags.test.ts src/persona/policy.test.ts`
Expected: FAIL. `CONVO_FAMILIARITY_ENABLED defaults ON and parses like its siblings` fails with `unset is on` (it reads false); the policy pin fails on the missing sentence.

- [ ] **Step 3: Flip the default**

In `src/persona/featureFlags.ts`, replace the whole `familiarityEnabled` doc comment and body with:

```ts
/**
 * The familiarity mask (env: CONVO_FAMILIARITY_ENABLED). Default ON.
 *
 * Gates all three ends of how well she knows a person (persona/familiarity.ts): the post-reply pass
 * that counts the turn and slews the stored level (memory/familiarityPass.ts), the turn-time read
 * that hands the band to both compiles of a turn (agents/convo/client.ts), and the musings gate that
 * keeps her own texts to people she knows (memory/musings.ts). Off means no ledger read or write, no
 * gate, and every reply compiled with no mask at all: the per-turn prompt byte for byte as it stood
 * before the feature. The persona block's one sentence about the mask (policy.ts) is prose, and
 * prose has no switch. It shipped OFF for the length of the series that built it, so every half-built
 * commit was inert on a live box; this is the commit that finished it, and the switch stays because
 * the off path is the way back that costs a restart rather than a revert.
 */
export function familiarityEnabled(): boolean {
  const v = (process.env.CONVO_FAMILIARITY_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}
```

In `.env.example`, replace the entry added in Task 2 with:

```
# CONVO_FAMILIARITY_ENABLED=off     # the familiarity mask: a 1-100 level of how well she knows each
#                                   # person, arithmetic over what she holds about them and paced by
#                                   # the days you have talked, decides how much of her mood reaches
#                                   # a reply. A stranger gets her composed and the whole weather
#                                   # shows once she knows them; a room is always a stranger; the
#                                   # number never reaches a prompt. It also keeps her own first
#                                   # texts to people she knows. off = every reply compiles as
#                                   # before and nothing is read or written. Default on.
```

In `deploy/app.env`, replace the last three lines of the entry added in Task 2

```
# nothing is read or written. It ships OFF for the length of the series that builds it, so every
# half-built commit is inert on a live box. Watch 'familiarity:band' and the Inner state panel on
# /dashboard. Default off.
# CONVO_FAMILIARITY_ENABLED=off
```

with

```
# nothing is read or written. It shipped OFF for the length of the series that built it, so every
# half-built commit was inert on a live box; it is on now because that series is whole. Watch
# 'familiarity:band' and the Inner state panel on /dashboard. Default on.
# CONVO_FAMILIARITY_ENABLED=on
```

- [ ] **Step 4: Append the persona sentence (spec §4, byte-for-byte)**

In `src/persona/policy.ts`, replace these lines of the feelings paragraph (lines 78-82)

```
comes out short or sharp or big, once, in plain words, and never the reason behind it. The good
ones mostly show in how you write; the heavy ones get a word, so a short reply never reads as a
verdict on them. Low energy still asks things, lazily, a few words with no effort spent dressing
them up.
```

with

```
comes out short or sharp or big, once, in plain words, and never the reason behind it. With
someone you barely know, none of that is theirs yet: the feeling stays yours, and only the volume
shows. The good ones mostly show in how you write; the heavy ones get a word, so a short reply
never reads as a verdict on them. Low energy still asks things, lazily, a few words with no effort
spent dressing them up.
```

The sentence's words and punctuation are exactly spec §4's; the line breaks are the block's hard wrap at the same width as every other sentence in it (the longest new line is 98 characters).

- [ ] **Step 5: Run the pins and read the new budget numbers off the failures**

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/persona/featureFlags.test.ts src/persona/policy.test.ts scripts/flagDocs.test.ts`
Expected: `# fail 0` (featureFlags 6, policy 13, flagDocs 33).

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/personaModules.test.ts`
Expected: FAIL in "the persona corpus is the bytes it was last measured at": `the persona corpus moved by 110 characters`. The new corpus is 190,555 characters with sha256 `e976f24861aa3e78280f048a96cb8afb6a5125e1d4664f2cae7b1320f4966793`.

Run: `TZ=UTC DATA_BACKEND=memory npx tsx --test src/agents/convo/promptBudget.test.ts 2>&1 | grep -E '^ +(persona|weather): measured|persona section is'`
Expected, exactly these three lines:

```
  error: 'cold thin profile: the persona section is 135067 chars, over its 113750-char budget (promptPolicy.ts). It grew — shrink it, or ratchet the ceiling deliberately.'
      persona: measured 135067, ceiling 113750 (+-15.8%)
      weather: measured 1368, ceiling 1390 (+1.6%)
```

The weather line does not move: every budget fixture passes no band, so it compiles as close.

- [ ] **Step 6: Re-measure the two pins**

In `src/agents/convo/personaModules.test.ts`, replace

```ts
 * Then **+426**, one comma per bubble (190,019 → 190,445): the split rule in Context.md
 * (the rule line, the self-check and the examples) allows one comma per bubble and breaks at the
 * second, the same wording now stated in every lane.
 */
const CORPUS_CHARS = 190_445;
const CORPUS_SHA256 = '367c8c8893a415a26b9b9ec7637e47edbda63d7fb8455aa85848f15249f78536';
```

with

```ts
 * Then **+426**, one comma per bubble (190,019 → 190,445): the split rule in Context.md
 * (the rule line, the self-check and the examples) allows one comma per bubble and breaks at the
 * second, the same wording now stated in every lane.
 *
 * Then **+110**, the familiarity mask (190,445 → 190,555), policy.ts alone: one sentence appended to
 * the feelings paragraph, after "and never the reason behind it.", saying that with someone she
 * barely knows the feeling stays hers and only the volume shows. It is the primacy-edge copy of the
 * law the per-turn weather line enforces (persona/affectCompiler.ts MASK_LINES). Every other file
 * held.
 */
const CORPUS_CHARS = 190_555;
const CORPUS_SHA256 = 'e976f24861aa3e78280f048a96cb8afb6a5125e1d4664f2cae7b1320f4966793';
```

In `src/agents/convo/promptPolicy.ts` line 111, replace the start of the line

```ts
  persona: 113_750,            // 112,595 on every fixture. Task 17
```

with

```ts
  persona: 135_200,            // 135,067 on every fixture. Familiarity mask (2026-09-26): +110 from 134,957, one sentence appended to the feelings paragraph of the shared persona block (policy.ts), the primacy-edge copy of the law the per-turn weather line enforces (persona/affectCompiler.ts MASK_LINES): with someone she barely knows the feeling stays hers and only the volume shows. The 134,957 it starts from was already over the old ceiling on main before this branch (Context.md grew since the figure below was recorded, with no ratchet at the time); that drift is absorbed here rather than re-derived. Was 113_750 for 112,595 on every fixture. Task 17
```

(the rest of that line stays exactly as it is).

- [ ] **Step 7: Add the architecture bullet**

In `docs/ARCHITECTURE.md`, after the bullet that starts `- **\`affectCompiler.ts\` compiles all of it into at most four imperative lines**` (line 81), add:

```markdown
- **How much of the mood shows depends on how well she knows you** (`persona/familiarity.ts`, `CONVO_FAMILIARITY_ENABLED`). A per-person level from 1 to 100, arithmetic over what she holds about you (turns, active days, facts by who said so, moments, themes you picked up, open loops, her own stances) and paced by the days you have actually talked, cuts to one of four bands. A stranger gets her composed: the shape and the energy of the mood pass (how short, how many bubbles, which hook kinds, the late-night register) while its content is held, and the layers open in order, positive before negative, until the whole weather shows for someone close. Rapport landing badly pulls the mask back up a band, a room is always a stranger, asked how she is she answers true at every band, the level never decays on silence, and the number reaches only the dashboard.
```

- [ ] **Step 8: Run the full suite**

Run: `npm test 2>&1 | grep -E '^# (tests|pass|fail|skipped)|^not ok'`
Expected: `# tests 3371` (3313 plus the 58 this plan adds), `# pass 3361`, `# fail 9`, `# skipped 1`: the nine baseline failures and no other. In the promptBudget headroom failure the persona line now reads `persona: measured 135067, ceiling 135200 (+0.1%)`, inside the band, and "every section of every fixture is inside its budget" no longer names persona (it now fails first on `update_status`, a host-dependent line). Both tests stay red for `craft_modules`, `json_anchor`, `update_status` and `hooks`, which predate this branch. If a failure outside the nine appears in a file that drives `chat()` or `composeWithComposer`, it is a file Task 5 Step 6 or Task 6 Step 6 missed: add the same `process.env.CONVO_FAMILIARITY_ENABLED = 'off';` pin with its comment to that file and re-run.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/persona/featureFlags.ts src/persona/featureFlags.test.ts .env.example deploy/app.env src/persona/policy.ts src/persona/policy.test.ts src/agents/convo/promptPolicy.ts src/agents/convo/personaModules.test.ts docs/ARCHITECTURE.md
git add -u src
git -c user.name=Rivian -c user.email=rivianp@gmail.com commit -F - <<'EOF'
Turn the familiarity mask on, and state its law once in the persona

CONVO_FAMILIARITY_ENABLED now defaults on in the parser and both env files. The persona block's
feelings paragraph gains Fable's one sentence (with someone she barely knows the feeling stays hers
and only the volume shows), and the persona budget line and the corpus pin are re-measured for it.
ARCHITECTURE.md says what the mask does.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

- [ ] **Step 10: Live check (local Mac only; the VPS is dead)**

Restart the local service through the terminal menu (`bash scripts/irises.sh`, restart), send one message from the owner's phone, then open `/dashboard` → Inner state → the owner's handle. Expected: a `familiarity` row under Right now with a level, a band, turns counted, and every source against its cap; a `familiarity:band` event in the ring only if that turn moved the band.

---

## Spec coverage

| Spec section | Where |
|---|---|
| §1 the number: table, sources and caps, pace ceiling, slew, no decay, when computed, bands, rapport re-guard, groups | Task 1 (arithmetic), Task 2 (table), Task 4 (pass), Task 3 (`compileMask`), Task 5 (post-reply call, group skip, room read) |
| §2 the mask: argument, `directive.mask`, both call sites, always-passes list, band table, say split, honesty rule, cold start, the Composer, musings | Task 3 (compiler, status.ts), Task 5 (both call sites), Task 6 (the Composer: `renderStatusForComposer`, `composerCore.ts`), Task 7 (musings) |
| §3 rendered lines | Task 3 (`MASK_LINES`, `FEELINGS_LINE_ASKED`, pinned byte-for-byte) |
| §4 persona block edit and `persona` pin | Task 9 |
| §5 dashboard, trace, never the prompt | Task 8, Task 4 (`familiarity:band`) |
| §6 flag and rollout | Task 2 (off), Task 9 (on) |
| §7 tests | every task; the repository test's tick, same-day guard and slew live in `familiarityPass.test.ts` (Decision 6); the composer test is Task 6 (`status.test.ts` pin and two `composerCore.test.ts` cases) |
| §8 out of scope | nothing built: no re-guard on silence, no stance gating, no number in chat, no per-room level |
| §9 ownership | Global Constraints |

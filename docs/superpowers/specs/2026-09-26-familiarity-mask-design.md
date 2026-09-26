# Familiarity mask — design

Date: 2026-09-26. Status: approved by the owner in conversation (all three sections), pending
review of this written spec. Build: Opus from the plan; Fable owns the rendered lines and the
final review.

## Context

**The ask.** Irises should wear a mask early on. When she barely knows a person, her mood should
barely shape her replies. As she gets to know them, the mood should come through more, until the
whole of it shows. A 1-100 level should say how well she knows them, the way the mood gauges say
how she feels.

**What exists.** Every reply already compiles the hidden weather into instructions
(`src/persona/affectCompiler.ts` `compileAffect`). The mood shapes six things today: the mood line
itself (sharper, fewer words, bubbly), which hook kinds are open, the follow-up question gate, the
`low` and `spent` flags that let her ask lazily or put off and refuse asks, the feelings line and
its slip, and whether she texts first with a musing (`src/memory/musings.ts`). A `rapport` gauge
(1-100, resting 40) already measures how her offers land, and it moves on structure only. A
tenure clock renders how long she has known them. The threads engine already paces itself on a
harvested-turn count with a numberless rung ceiling (`src/persona/threads.ts`
`THREAD_TENURE_TURNS`, `rungCeilingFor`), which is the precedent this design copies: a number that
selects lines and never prints.

**The psychology.** Four findings, each of which becomes a rule below.

- Social Penetration Theory (Altman and Taylor): intimacy grows in breadth first and depth later,
  through reciprocal disclosure, and negative or intimate feelings are disclosed last. Too much
  too soon reads as inappropriate. So: layers open in order, positive before negative, and the
  number is paced.
- Expressive suppression (Gross): with people we do not know we hide the content of a feeling,
  but its energy leaks. A composed sad person is still quieter. So: shape and energy always pass
  the mask; content is held.
- Front stage and back stage (Goffman): the mask is the front. A room is public, so a room is
  always front stage.
- The intimacy process (Reis and Shaver): the mask drops on responsiveness, not on knowledge
  alone. So: rapport, which already measures how she is being received, can pull the mask back up.

**Bounds inherited from the charter.** No number ever reaches the prompt (a number beside a state
is a number to optimize, `docs/PROMPTING_CHARTER.md` §6.4 and the compiler's own header). Nothing
here can be talked up: the level is arithmetic over stores, never a model report (§10.1, the same
bargain `rapport` and the climate dials make). Honesty is never masked: asked how she is, she
answers true at every band. A quiet stretch is not evidence, so the level never decays on the
clock (climate's rule).

## Design

### 1. The number: `familiarity`, 1-100, per person

A handle-keyed level, like the climate dials and unlike the chat-keyed affect row. Rooms never
tick and always read as stranger.

**Lived exchange** is a small table `familiarity` with one row per handle:

| column | meaning |
|---|---|
| `handle` | memory handle, primary key |
| `level` | the stored, slewed level, 1-100 |
| `turns` | user turns she replied to in a one-to-one chat (a merged burst is one turn) |
| `active_days` | distinct UTC day stamps with at least one replied turn |
| `last_day` | the last UTC day stamp counted, `YYYY-MM-DD` |
| `updated_at` | epoch ms |

**Held evidence** is read from the memory stores at compute time. Each source has a point
value and a cap; the caps sum to 100 and the test pins that sum.

| source | read from | points each | cap |
|---|---|---|---|
| turns replied | `familiarity.turns` | 0.25 | 20 |
| active days | `familiarity.active_days` | 1 | 20 |
| stated facts | medium facts with `factProv` stated, plus profile facts whose parsed provenance is stated | 2 | 16 |
| inferred facts | the same two sources, inferred | 1 | 6 |
| engine-seeded facts | the same two sources, seeded | 0.5 | 4 |
| name known | `profile.name` non-null | 2 | 2 |
| moments | `MomentsFile.entries.length` | 2 | 12 |
| themes they picked up | `ThreadInventory.themes` with `uptakes >= 1` | 2 | 8 |
| open loops | `ThreadInventory.loops.length` | 1 | 4 |
| her own SELF entries | `SelfFile.entries` with kind stance, taste or changed (a learned entry is about them, not her) | 2 | 8 |

A store behind a flag that is off contributes zero; she genuinely holds less. The lived-exchange
half still climbs, so a memory-flags-off install reaches the middle of the scale on tenure alone.

**Three bounds.**

- **Pace ceiling.** `target = min(evidence, 10 + 3 * active_days, 100)`. A daily texter can reach
  acquaintance around day 5, familiar around day 14 and close around day 30, and only if the
  evidence is there. A fact dump in one evening hits the ceiling.
- **Slew.** The stored level moves toward `target` by at most `FAMILIARITY_SLEW = 2` a turn, in
  either direction. A new row starts at 1. Bands cannot flap turn to turn.
- **No clock decay.** Nothing reads elapsed time. The level falls only when evidence shrinks
  (a cap eviction, a superseded fact, a pruned theme).

**When it is computed.** In the post-reply pass in `src/agents/convo/shared.ts`, beside
`updateRelationshipClimate` and under the same group skip: tick the counters, read the stores,
compute the target, slew, save. Fire-and-forget like its neighbours, failure a silent no-op. The
turn itself only reads the stored row. A one-turn lag behind the harvests is fine under a 2-point
slew.

**Bands**, named after Knapp's stages, cut on the stored level:

| band | level |
|---|---|
| stranger | 1-24 |
| acquaintance | 25-49 |
| familiar | 50-74 |
| close | 75-100 |

**Rapport re-guard.** In the compiler, if the carried row's `rapport` is below
`RAPPORT_RESTING - RAPPORT_QUESTION_BAND` (the line the question gate already uses), the effective
band drops one notch, never below stranger. One threshold for "landing badly", shared with the
question gate on purpose.

**Groups.** `isGroupHandle(handle)` reads as `stranger` at turn time, and the ledger is neither
read nor written.

### 2. The mask: one stage inside the compiler

`compileAffect` gains a `familiarity: FamiliarityBand` argument (default `close`, so every
existing caller and test is unchanged). The directive gains `mask: FamiliarityBand`, the effective
band after the rapport notch, which the renderer reads to pick lines. `renderStatusForPrompt`
(`src/persona/status.ts`) takes the same argument and hands it through, and the two call sites in
`src/agents/convo/client.ts` pass the same value, so the weather block and the hook engine can
never disagree about the band. The gauges, the reported word and the drift are untouched at every
band: the mood keeps running underneath. The mask only decides what compiles into instructions.

**Always passes, every band:** `brevity` and `bubbleCap` (the battery), the hook allowance the
core carries (a sad core still takes no tangent), the `question` gate, `lateNight`, and the
late-night part of `englishLooseness`.

Positive cores are joyful, powerful and peaceful; negative cores are mad, sad and scared, the
split `CORE_VALENCE_BAND` already makes.

**Opens by band, cumulative:**

| field | stranger | acquaintance | familiar | close |
|---|---|---|---|---|
| mood line | composed line, every core | positive cores render their line; mad, sad, scared render the composed line | every core's base line | base line plus the `say` clause on mad and sad |
| core's `englishLooseness` shift | none | joyful's +1 | joyful's +1, sad and scared's −1 | same |
| feelings line | asked-only variant | asked-only variant | full line | full line |
| `feelingSlip` | '' | '' | as today | as today |
| `low` | false | false | as today | as today |
| `spent` | false | false | false | as today |
| musings | no | no | yes | yes |

The **say clause split**: `CORE_DIRECTIVES` rows gain an optional `say` field. `mad` keeps its
first two sentences as `line` and moves "A favour asked in the same breath as a put-down gets a
flat no." to `say`; `sad` keeps "Fewer words. No tangents. Answer, then stop." as `line` and moves
the "Anything open-ended they ask today ... it stays owed." sentence to `say`. `renderMoodLine`
joins `line` and `say` with one space at close, so the close band is byte-identical to today.

**Honesty rule.** The mask governs what she volunteers and what she acts on, never what is true.
Asked how she is, she answers with the true word at every band, smaller when guarded. This is the
same shape as the charter's AI-honesty rule: upfront if asked, never volunteered.

**Cold start.** No affect row at stranger compiles to the composed line with the default word, not
to "your easy self".

**Musings.** `src/memory/musings.ts` gains `familiarityAllows(band)`: familiar or close. The
sweep reads the stored row for the handle; a missing row is stranger. Skip reason `familiarity`.

### 3. Rendered lines

Fable's lines, to be pasted byte-for-byte. No digit, no example, no em-dash, no inversion.

`MASK_LINES`, keyed by the effective band and used in place of the core's line:

- stranger: `You are {word} ({core}). Someone you barely know does not get to see it: composed and pleasant, and none of it reaches the words.`
- acquaintance: `You are {word} ({core}). You are still getting to know them, so it stays yours: composed and pleasant, and none of it reaches the words.`

Rendered as `- ` plus the line, the same shape as `renderMoodLine`.

`FEELINGS_LINE_ASKED`, used at stranger and acquaintance in place of `FEELINGS_LINE`:

`Underneath, right now, you are {feelings}. That is the true answer when they ask how you are, said small and in your own words. Unasked, it stays yours.`

### 4. Persona block edit

The feelings paragraph in `src/persona/policy.ts` states the general law once for all four
surfaces, and today it says a feeling gets named unasked. One sentence is appended after "and
never the reason behind it.":

`With someone you barely know, none of that is theirs yet: the feeling stays yours, and only the volume shows.`

The per-turn weather line is what enforces it; the persona sentence keeps the law consistent at
the primacy edge. The `persona` budget pin in `src/agents/convo/promptPolicy.ts` is re-measured.

### 5. Surfaces

- **Dashboard.** `src/diagnostics/adminDashboard/api/affect.ts` adds a `familiarity` object to
  the payload: `level`, `band`, `effectiveBand`, `reguarded`, `ceiling`, `turns`, `activeDays`,
  and `sources` (each source's points and cap). `views/affect.ts` renders it as a row in the Inner
  state panel, a bar in the dial style with the band named beside the level.
- **Trace.** A `familiarity:band` record whenever the stored band changes, with the old and new
  band and the level.
- **Never** the prompt, `/health`, or a chat reply.

### 6. Flag and rollout

`CONVO_FAMILIARITY_ENABLED`, in `src/persona/featureFlags.ts`, the house four-line shape. Off:
no ledger read or write, no musings gate, band `close` everywhere, and the prompt byte-identical
to today. Documented in `.env.example` and `deploy/app.env` for `scripts/flagDocs.test.ts`.

During the series the empty default reads OFF; the last commit flips it to ON. Every intermediate
build is inert.

### 7. Tests

- `src/persona/familiarity.test.ts` (pure): caps sum to 100; each source capped; provenance
  discounts; pace ceiling by active days; slew in both directions from 1; a new row starts at 1;
  bands at their edges; rapport re-guard drops one notch and never below stranger; rooms read as
  stranger.
- `src/persona/affectCompiler.test.ts`: the band table above pinned field by field; the `say`
  split renders byte-identical at close; the composed and asked-only lines carry no digit; the
  default argument leaves every existing case unchanged.
- `src/memory/musings.test.ts` (new): `familiarityAllows` and the sweep's `familiarity` skip
  reason.
- Repository test for the `familiarity` table: tick, same-day guard, slew, save, degrade.
- Dashboard api test for the payload row.
- `scripts/flagDocs.test.ts` rows; `promptPolicy.test.ts` pins for `weather` and `persona`.
- Always `DATA_BACKEND=memory` for any test run (2026-09-25 incident).

### 8. Out of scope

- Re-guarding after a long silence (re-entry awkwardness). Climate's rule stands for now.
- Gating contested stances (politics, faith) by band. SELF.md depth is its own round.
- Any number or band in chat. She can already say what she knows from the dossier.
- Per-room familiarity. A room is front stage.

### 9. Ownership

Opus drives the implementation from the plan. Fable's lines in §3 and §4 are pasted as written.
Fable reviews the finished branch. VPS is dead; the local Mac is the only live instance, so the
live check is a local restart and a dashboard look.

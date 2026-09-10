# Late night is a register, not a script; the name is a fact, not an address

Design, 2026-09-10. Two complaints from the person Irises texts, one live install:

1. Every late-night idle turn comes back as the same line, some form of "go to sleep", often
   with their name attached. It reads redundant (they just said goodnight) and unnatural (nobody
   texts "sleep <name>" every night).
2. Their name keeps landing in bubbles. They do not want the prompt pushing it.

There is no literal "sleep <name>" string anywhere. The phrase is manufactured by two independent
instructions colliding on every idle turn between 22:00 and 04:59 in the user's zone.

## Why it happens today

**The sleep funnel.** `computeCircadian` maps hours 22–4 to `pre_sleep` / `dead_night`;
`compileAffect` turns both into `sleepQuiet: true` from the clock alone. On an idle turn (`isIdleTurn`
— short, no question mark, digit, link, attachment; the English fast path lists `night` and `gn`
as idle tokens) `selectHook` takes its sleep branch: mode `hook`, every kind forbidden, no moments,
no thread offer, reason `sleep`. The model then reads the sleep instruction in up to seven places in
one prompt:

| Copy | File | Renders |
|---|---|---|
| persona block sentence | `src/persona/policy.ts` PERSONA_BLOCK | every turn, every lane |
| weather explanation | `src/agents/convo/Context.md` ~165 | every Convo turn |
| time-of-day bullet | `src/agents/convo/Context.md` ~675 | every Convo turn |
| `SLEEP_QUIET_LINE` | `src/persona/affectCompiler.ts` | every turn in the window, tasks included |
| `HOOK_NONE_OPEN` + `HOOK_SLEEP_LINE` | `src/persona/hooks.ts` | idle turns in the window |
| quiet-reply paragraph | `src/agents/convo/craft/hooks.md` | every idle turn |
| quiet-mode bullets | `src/persona/policy.ts` DRIFT_MODE_BULLETS.quiet | sleep turns, at the recency edge |

Plus `QUIET_LAW` ("or it is late for them") and Fallfirm's own copy in
`src/agents/fallfirm/Context.md`. With every hook kind closed, "sleep" is the only content left, and
seven restatements make it a reflex.

**The name push.** `renderAddressingHeader` (`src/memory/wrappers.ts`; legacy twin
`renderAddressing` in `src/memory/userContext.ts`) prints `Name: <name>` and, with no `address_as`
preference, the rule `use their name, "<name>"` followed by "Do it occasionally, the way a real
person texting drops a name in — not in every bubble." The persona block says the same: "a name they
asked to be called, else their name, else nothing." A one-bubble reply whose only permitted content
is sleep, plus a standing nudge to drop the name in, is "sleep <name>".

## Approaches considered

1. **Keep the sleep branch, reword the line to offer a menu** ("tell them to sleep, or tapback, or
   one dry line about the hour"). Still a script, still closes every hook kind, still names sleep
   in the prompt — and this codebase's own doctrine says naming a thing is an instruction to think
   about it. Rejected.
2. **Remove the sleep branch; make "late" a pure register flag.** A late idle turn becomes an
   ordinary hook turn: whichever kinds the mood, the register and the ledger leave open stay open,
   moments and thread offers run, the kill switch and the no-same-kind-three-times rule supply the
   variety they already supply by day. The clock only lowers the volume: one short bubble or a
   tapback, nothing heavy. No prompt surface ever says "sleep". **Chosen.**
3. **Remove every late-night directive entirely.** Loses the one thing the clock legitimately
   changes (size and weight of a reply at 2am). Rejected as over-correction.

For the name: remove the push, not the knowledge. The prompt stops telling her to use the name and
stops printing it in the addressing header; the name stays where memory stores it (profile row,
dossier keyed fact) so "what's my name" still has an answer. Scrubbing it from the memory tier is a
separate decision the user has not asked for.

## Design

### 1. `sleepQuiet` becomes `lateNight`

A rename with a meaning change, applied everywhere the flag is threaded (`affectCompiler.ts`,
`hooks.ts`, `client.ts`, `hookBattery.ts`, every test that builds a directive by hand):

- `SLEEP_SLOTS` → `LATE_SLOTS` (same two slots; comment rewritten: the slots where the reply gets
  smaller, nothing more).
- `AffectDirective.sleepQuiet` → `lateNight`; `HookAffectInput.sleepQuiet` → `lateNight`;
  `HookDirective.sleepQuiet` → `lateNight` (still passed through in every mode).
- `HookSelectReason` loses `'sleep'`. The buckets are `not_idle | kill_switch | affect_floor | hook`.
- `selectHook` deletes the sleep branch. A late idle turn falls through to the ordinary hook path.
  Its doc comment is rewritten: the clock is register, not a mode.
- `hookKindOpen` and the climate `HOOK_NAMING` comments drop their references to the sleep branch.
- `circadian.ts` header comment: the slot answers "is it late enough that the reply gets smaller".

### 2. Rendered strings (digit-free; prose file first, then code)

Every line below goes into `docs/superpowers/prose/never-send-a-leaf/policy-strings.md` first and
is pasted byte-for-byte into code, which is the standing rule for that file.

**Weather block** — `SLEEP_QUIET_LINE` → `LATE_NIGHT_LINE`:

> It is late where they are. Smaller and quieter than daytime: fewer words and nothing heavy.

**Hooks section** — `HOOK_SLEEP_LINE` → `HOOK_LATE_LINE`, rendered after the open/none line
whenever `lateNight` is true in hook mode:

> It is late where they are: one short bubble, or a tapback, and nothing heavy. Same rules as any idle turn, at a lower volume, and never the line you sent them last night.

`QUIET_LAW` drops "or it is late for them":

> Three sharp things in a row already, or your weather says so. One plain short bubble, or a tapback, or nothing — no hook, no question, no offer. Do not explain the quiet.

**Drift anchor, quiet mode** (`DRIFT_MODE_BULLETS.quiet`; still three bullets, still digit-free;
`policy.test.ts` keeps its pin on "one plain short bubble, a tapback, or nothing"):

> - Three sharp things in a row already, or your weather closed the beat: this reply is one plain short bubble, a tapback, or nothing.
> - No hook, no callback, no question. Do not explain the quiet.
> - The plain thing, said once, and let the beat pass. Their word and their greeting still never come back.

**Persona block** (`PERSONA_BLOCK`), two sentences:

- "When it is late for them, the correct thing to send is that they should sleep." →
  "When it is late for them, you get smaller and quieter, and that is all the hour changes."
- "How you address them: a name they asked to be called, else their name, else nothing. You do
  not invent a nickname to fill the gap." →
  "How you address them: a name they asked to be called, else nothing at all. Their name is a
  thing you know, not a word you drop into a bubble, and you do not invent a nickname to fill the
  gap."

Keep the block's hard wrap consistent with its neighbours.

### 3. Function files

- `src/agents/convo/Context.md` ~165: "whether it is late enough where they are that the right
  reply to an idle turn is that they should sleep" → "whether it is late where they are and
  everything gets smaller".
- `src/agents/convo/Context.md` ~675, the Time-of-day bullet: "Late night their time = smaller and
  quieter; on an idle turn the right line is that they should sleep." → "Late night their time =
  smaller and quieter, one short bubble, and the same idle-turn rules pick what it says — the hour
  changes the volume, not the content."
- `src/agents/convo/craft/hooks.md`, the quiet-reply paragraph becomes two:

  > **The quiet reply.** When the hooks section says quiet, the shape is fixed: one plain short
  > bubble, or a tapback on their message with no bubbles, or nothing. No hook rides along with it.
  >
  > **Late is not quiet.** When the section says it is late for them, this is still an idle turn
  > with whatever kinds it left open, at a lower volume: one short bubble or a tapback. Their
  > goodnight is content and never comes back as yours. Vary it: a read on the hour, a callback, a
  > tapback and nothing, one plain word — never the same shape two nights running.

- `src/agents/fallfirm/Context.md` ~73: "and if this is idle ground the right line is that they
  should sleep" → "and nothing extra rides on it".
- `README.md` line ~50: "whether the right reply is that you should sleep" → "whether it is late
  enough that everything gets smaller".

### 4. Addressing header

`renderAddressingHeader` (wrappers.ts) and the legacy `renderAddressing` (userContext.ts) change
identically, individual audience only; the group branch is untouched (a room needs names to tell
speakers apart):

- Drop the `Name: …` line, both the known and the unknown form.
- Keep the known-facts line.
- With `address_as`: keep "They asked to be addressed as: …"; rule becomes
  `call them "<address_as>" — they asked for that, and it overrides everything else; even so, most bubbles carry no name at all`.
- Without `address_as`: rule becomes
  `use no address term at all — second person only, never their name, never an invented nickname`.
- The sentence after the rule drops "Do it occasionally, the way a real person texting drops a
  name in — not in every bubble." and keeps "If a preference below says how they want to be
  addressed, that wins. In a group chat, address people by name as usual."

The header heading "How to address them" stays (two tests locate the header by it).

### 5. Tests, goldens, budgets

- Rename the field in every hand-built directive (`clauseInventory`, `earnedMaterial`,
  `hookWiring`, `promptBudget`, `promptPolicy`, `promptSections`, `threading`, `affectCompiler`,
  `hooks`, `status` tests; `scripts/convergence/hookBattery.test.ts`).
- `hooks.test.ts` §3 and `hookWiring.test.ts` (~640–665): a late idle turn now selects reason
  `hook` with kinds open; the drift anchor on that turn is the HOOK anchor, not quiet. Assert the
  late line renders and the sleep wording is gone.
- `promptBudget.test.ts`: the "sleep turn" fixture becomes a late idle turn (mode `hook`,
  `forbidden: []`, `lateNight: true`, moments as the fixture already builds them). Rewrite its
  comment block; the widest hooks shape is now late + all kinds open + full moment sample, so the
  `hooks` budget is measured on that.
- `scripts/convergence/hookBattery.ts` (~605–625, ~1205–1215): drop the `sleep` reason handling;
  late turns are scored as ordinary hook turns.
- `personaModules.test.ts`: re-pin the corpus sha256 and length (Context.md and hooks.md changed).
- `promptPolicy.ts` PROMPT_BUDGET: re-ratchet any key the tests report (`persona`, `hooks`,
  `behavior_anchor`, the weather section) to measured plus at most 2%, and add one sentence to that
  key's history comment in the file's existing "Was N for M — reason" style.
- `wrappers.test.ts` 196 / 208 / 597: assert the new rule strings and that no `Name:` line renders.

### 6. Verification

- `npm test` green; `npx tsc --noEmit` clean.
- `grep -rn "should sleep\|sleepQuiet\|SLEEP_QUIET\|HOOK_SLEEP\|SLEEP_SLOTS\|'sleep'" src scripts docs README.md`
  returns nothing outside historical budget-comment prose.
- `grep -rn "use their name\|drops a name in" src` returns nothing.
- Render a late idle turn's hooks section by hand and confirm it reads: heading, lead, open line
  naming the kinds, the late line, clamp — and nothing about sleep.

## Out of scope

- Scrubbing the user's name from the memory tier (profile row, dossier "Who they are" line).
- Any change to which hours count as late, or to the idle gate's token list.
- Content-level anti-repeat across nights (the ledger tracks kinds, not lines); the craft page's
  "never the same shape two nights running" is the whole intervention for now.

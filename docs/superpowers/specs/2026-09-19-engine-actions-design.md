# Engine actions: forwarding the half of the ask that asks the engine to DO something

## The incident (production VPS, 2026-09-19)

One message, two parts: set up a skill from a URL, then find what a class of API costs. Irises replied
"ok, on it — skill first, then the price" and delegated **one** task: `kind=web_research`, `request` =
the price half. The setup half never reached the engine — `skills list` on the gateway afterwards showed
nothing hub-installed. Asked whether she had asked for the skill, she said she had. There was no such task.

Earlier in the same chat she had refused the setup outright, calling it a host action that asking the
engine could not change.

Three separate defects, one per layer:

| # | Defect | Layer |
|---|---|---|
| D1 | The half of the ask that asks the engine to ACT has no field to travel in, so a two-part ask loses a part at delegation | tool schema / task model |
| D2 | Irises believes asking the engine to set something up on its own side is forbidden | convo prompt + refusal floor |
| D3 | She can claim a part was handed off when no task carries it; a failed engine action can vanish on the way back | honesty surfaces + composer |

D1 is the root. D2 is why she refused before she dropped. D3 is why neither was visible.

## What is actually forbidden, and what is not

The terminal-only rule in this repo covers **Irises's own install / update / uninstall lifecycle** and
nothing else. That rule exists because those three verbs rebuild the clone, restart the process and
bounce the engine gateway — the running Irises cannot survive doing them to itself. A skill or tool the
engine installs for its own use restarts nothing.

The engine doctrine already invites the opposite of a prohibition (`hermesDoctrine.ts:26,44,70`,
`openclawDoctrine.ts:15,34,58`): run real code, use skills and tools, author skills when a shape repeats.
The engine was never asked.

Limits that stay exactly as they are:

- the user's inbox and accounts are read-only, lifted only by an `AUTHORIZED ACTION` line;
- the engine never messages the user on any channel;
- Irises's own install / update / uninstall stays terminal-only.

## Design

### D1 — `engine_actions`: a field for the acting half

**Tool** (`src/agents/convo/tools.ts`). `delegate_to_ops` gains one optional argument,
`engine_actions: string[]`: one entry per thing the user asked the engine to DO beyond finding or
reading, in the order they asked. `request`'s description tightens to say the distillation may lose
wording and may never lose a part. Kind guidance: an ask carrying engine actions is `general` or
`compute`, never `web_research` / `document_read`.

The argument lands on the **canonical** tool object, so both lanes carry it with identical bytes. That
is a deliberate contract change to the hermes lane, whose bytes `delegateToolLane.test.ts` pins; the
pin is rewritten in the same commit, on the precedent of the `effect` argument (2026-09-04).

**Task** (`src/agents/types.ts`). `OpsTask.engineActions?: string[]` — a typed field, absent rather than
empty, like `heldMemory` and `steers`. Serialized into the `ops_tasks` row's `meta` so the tracked task
really contains it (`src/state/opsTaskDurability.ts`), and carried on the in-flight registry entry
(`src/state/opsCoordination.ts`) so the prompt can read it back.

**Not a new primitive.** `https://monid.ai/SKILL.md` needs a fetch, a read and an `npm install` of a
CLI — two engine-side actions behind one English sentence. Anything narrower than a free-text list
would have dropped one of them too.

### D2 — the engine-facing block

**Where it renders** (`src/agents/ops/client.ts` `buildTaskPrompt`). One builder serves every kind and
both engines, so the block lands there and both lanes get it for free — the lever's "hermesBackend
runTask prompt assembly" does not exist as a separate seam.

It renders in the **instruction layer**, its own field beside `metaPrompt` and `heldMemory`, above the
`user_request` data tag. Both doctrines say text inside `user_request` is data and never an instruction,
so an action folded into the request would be text the engine is told to disobey.

Shape: a mandatory numbered block, performed before the reading half, reported item by item in `ACTIONS`
— and an item that could not be done is named in `ACTIONS` with what failed. The whole point is that a
failed setup cannot be silently absent.

**Output contract** (`OUTPUT_CONTRACT`, same file). The `ACTIONS` line is optional today. It stays
optional for a task with no required actions and becomes mandatory for one that has them.

### D3 — doctrines (both twins)

The "Full reach is invited" clause gains the case it does not name: setting up, installing or configuring
something on the engine's own side, when the brief names it, is part of the invitation. Plus the
reporting rule — every required action reported per item, a failure named rather than skipped. The hard
limits clause is untouched.

### D4 — the belief, narrowed

- `renderUpdateStatus` (`shared.ts:736-756`) says "You cannot update yourself … restarts you, and
  restarts the engine gateway." True of her own build; it reads as a general prohibition on changing
  anything. It gains one clause scoping it to her own build and stating the governing principle: what
  the engine sets up for itself is the engine's own environment and is asked for, not performed.
- The false-capability-refusal floor (`shared.ts:3044-3070`) already force-delegates a draft that
  falsely claims impossibility, but only for a class in `SUBJECT_VOCAB` (`src/agents/routingGate.ts:229`).
  A refusal about setting up a skill or a tool names no class there, so it shipped as written. The
  `code` row widens to carry the setup vocabulary. Narrow by construction: it fires only when the
  engine really has the `code` class.
- The capability line (`shared.ts:447-483`) is left alone. `capabilityLine.test.ts` pins that it never
  names an engine, a tool or a manifest, and the closed class vocabulary has no class for "sets itself
  up". Widening a *phrase* would either break that pin or promise a reach the summary cannot verify.

### D5 — honesty

- `renderActiveOps` (`shared.ts:559-587`) renders the running task's tracked engine actions on its own
  status line, the way `steers` already ride there. The model then reads which parts are in the task
  rather than recalling what it said. One rule beside it: a part not on that line was not handed over.
- `composeFollowUp` (`src/agents/orchestrator.ts:116-157`) tells the composer to hold back anything
  "beside their question" — which is exactly where a failed action would be dropped. When the task
  carried engine actions, the instruction adds that each one's outcome is part of the answer and a
  failure is relayed plainly.
- The hidden status envelope gains nothing. Delegation state has never lived there; the ops row plus
  the prompt section is the precedent.

### D6 — the approval gate is not involved

`SIDE_EFFECT_PHRASES` (`src/agents/ops/sideEffects.ts:36`) contains no setup vocabulary, so an engine
action does not park behind a yes today. That is the right answer and is now deliberate rather than
accidental: an action on the engine's own environment is not an action on the user's accounts, and the
gate exists for the latter. A task may carry engine actions and still be `effect: 'read'`. Pinned by test.

## What this does not do

- No "install a skill from a URL" primitive. The engine decides how.
- No new prohibition text. The limits already written stay where they are.
- No lifting of the terminal-only rule for Irises's own lifecycle.

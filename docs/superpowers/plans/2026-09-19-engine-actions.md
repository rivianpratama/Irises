# Plan — engine actions reach the engine

Spec: `docs/superpowers/specs/2026-09-19-engine-actions-design.md`. Branch `engine-actions`.
Test baseline on this branch point: 3112 tests, 3100 pass, **12 fail** (the known golden/byte-identity
set: clause inventory, prompt zone, prompt budget, persona corpus). Add none.

TDD throughout: the test that names the defect goes red first, then the code.

## Step 1 — the field exists end to end (red: a two-part ask drops a part)

1. `src/agents/types.ts`: `OpsTask.engineActions?: string[]`, documented beside `heldMemory`.
2. `src/agents/convo/tools.ts`: `engine_actions` on the canonical `DELEGATE_TO_OPS_TOOL`; `request`
   and `kind` descriptions tightened. Both lanes inherit it.
3. `src/agents/convo/delegateToolLane.test.ts`: re-pin the canonical bytes, with the reason in the
   commit message (precedent: the `effect` argument, 2026-09-04).
4. `src/agents/convo/shared.ts` delegate dispatch (~:2560-2640): read the argument, coerce to a
   string array (non-array → dropped, blanks → dropped, absent → field absent), put it on the task.
5. `src/state/opsTaskDurability.ts` + `src/state/opsCoordination.ts` (`markOpsStart` info,
   `InFlightEntry`, `ActiveOps`, `getActiveOps`): carry it so the row and the registry track it.

New test file `src/agents/convo/engineActions.test.ts`: a two-part ask whose second part is an engine
action produces one task whose `engineActions` carries that action, kind is not `web_research`, and the
registry entry reports it.

## Step 2 — the engine is told (red: rendered prompt carries no mandatory block)

1. `src/agents/ops/client.ts` `buildTaskPrompt`: render `engineActions` as its own instruction-layer
   field, above the `user_request` data tag, as a mandatory numbered block with the per-item
   reporting and per-item failure rule.
2. Same file, `OUTPUT_CONTRACT`: `ACTIONS` becomes mandatory when required actions were given.
3. Tests in `src/agents/ops/engineActionsPrompt.test.ts` (new): the block renders above the data tag,
   numbered in order, nothing dropped; a task without the field renders byte-identically to today.

## Step 3 — the doctrines (both twins, one commit)

`hermesDoctrine.ts` + `openclawDoctrine.ts`: full-reach clause widened to name engine-side setup the
brief asks for; per-item reporting and per-item failure added. Hard limits untouched. Versions rehash
by construction, which re-onboards on next boot — that is the mechanism working.

Test: the twin test asserts both carry the new clause, and that neither hard-limits clause moved.

## Step 4 — the belief

1. `shared.ts` `renderUpdateStatus`: scope the "cannot update yourself" line to her own build and state
   the principle for the engine's own environment.
2. `src/agents/routingGate.ts` `SUBJECT_VOCAB` `code` row: setup vocabulary, so a refusal about setting
   something up on the engine's side is caught by the false-capability floor.
3. Tests: `updateStatus.test.ts` extension; `routingGate` test that the refusal from the incident's
   shape resolves to `code` and that an honest refusal with no engine still ships.

## Step 5 — honesty

1. `shared.ts` `renderActiveOps`/`opsStatusLine`: render the tracked actions; add the rule that a part
   not listed was not handed over.
2. `src/agents/orchestrator.ts` `composeFollowUp`: when the task carried engine actions, each one's
   outcome is part of the answer and a failure is relayed plainly.
3. Tests: status line rendering with and without the field (absent → today's bytes); composer
   instruction carries the relay rule only when the field is present.

## Step 6 — the gate stays out

Test in `approvalGate.test.ts` (or the new file): a task carrying engine actions and no side-effect
phrase stays `effect: 'read'` and is not parked.

## Step 7 — full `npm test`, compare against the 12-failure baseline. No merge, no push, no deploy.

# Action honesty — implementation plan

**Spec:** docs/superpowers/specs/2026-09-23-action-honesty-design.md
**Branch:** worktree-action-honesty (worktree .claude/worktrees/action-honesty), base main 905b8fc
**Test baseline (main 905b8fc):** 3161 tests, 9 pre-existing fails, all in prompt goldens/budgets:
clauseInventory (521, 523), hook/share prompt-assembly (612, 633, 639, 643), promptBudget (693, 697),
anchor-in-persona (702). They are NOT regressions of this work. Add none.

## Global constraints

- TDD throughout: the test that names the defect goes red first, then the fix.
- Run a file: `cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test <file>`; full suite `npm test`.
- Commit author/committer: Rivian <rivianp@gmail.com>. End commit messages with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Prompt text (tool descriptions, craft pages, Context.md, rendered sections, pass guidance) states the
  governing principle. No sample utterances, no incident names, never the rhetorical structure
  "it's not X, it's Y", no em-dashes in prompt prose. Incident stories go in code comments and tests.
- Hand-written lexicons stay English-only (standing policy, unkeptPromise.ts header).
- Feature flags are env vars, default on, read at call time. Decision events use a label distinct from
  the retry call's own label.
- Match surrounding code: comment density, naming, module-header incident stories.
- Never act on all of several matches: ambiguity returns candidates and acts on none.
- A failure never erases a success or a question that must ship.

## Work setup

- **Branch:** worktree `action-honesty`.
- **Docs:** spec at `docs/superpowers/specs/2026-09-23-action-honesty-design.md`, plan at `docs/superpowers/plans/2026-09-23-action-honesty.md`. Record the baseline: about 4 golden failures on main 905b8fc (`clauseInventory` ×2, `promptBudget` ×2) are expected red.
- **TDD:** the test that names the defect goes red first. Run tests with `cross-env TZ=UTC DATA_BACKEND=memory npx tsx --test <file>`.
- **Commits:** as Rivian <rivianp@gmail.com>.
- **Prompt text rules:** state principles only. No sample utterances, no incident names, no "it's not X, it's Y", no em-dashes. Incident stories go in code comments and tests.

## Tasks (in dependency order)

**Dependencies:** Task 4 comes before Task 5, Task 6, Task 9 and Task 10. Task 3 before Task 6. Task 1 before Task 7. Task 6, Task 7 and Task 9 before Task 10. Task 10 before Task 11.

### Task 1 — Read reminders correctly
- **Code:** `listReminders` (`src/agents/ops/hermesBackend.ts` ~1192):
  - map the `schedule` object (`kind`, `expr`/`run_at`) plus `schedule_display`, `next_run_at`, `created_at` and `enabled`;
  - filter out `enabled === false`;
  - parse the instruction out of the `<reminder_instruction>` tag with an exported `parseReminderInstruction`;
  - add an optional `{timeoutMs}` param.
- **`ReminderRef`** (`src/agents/ops/engineBackend.ts:67`): add optional fields for these.
- **`renderAutomationsList`** (shared.ts ~257): show ids and next-run times, and treat an empty list as a confirmed "none", not a correction.
- **Tests:**
  - `hermesBackend.test.ts`: the real jobs.json shape never yields "[object Object]".
  - New `src/agents/convo/reminderTools.test.ts`: an empty list doesn't replace the model's reply.

### Task 2 — Use the user's time zone
- **Code:** thread `userTz` from `client.ts` (computed ~319, the call ~743) into `processConvoResult`. The schedule handler uses `input.timezone || userTz || DEFAULT_TZ`. Today the fallback is the host zone.
- **Test:** a cron with no timezone uses the agent's zone.

### Task 3 — Engine update support
- **Code:**
  - Generalize `shiftCronToEngineZone` (hermesBackend.ts ~204) into `shiftCronBetweenZones`, keeping the old name as a wrapper.
  - Add an optional `updateReminder?(id, patch)` on `EngineBackend`, optional like `steerRun`, so existing stubs still compile.
  - The Hermes implementation sends `PATCH /api/jobs/{id}` with only `name`/`schedule`/`prompt`. The prompt is rebuilt with `reminderJobPrompt` and the cron shifted to the engine zone. It never PATCHes `repeat`.
  - A kind change (cron ↔ once) creates the new job, then deletes the old one only if the create succeeded.
  - Errors: 404 means `not_found`; a 500 for a past one-shot means `invalid`.
- **Tests (`fakeFetch`):**
  - the PATCH body uses only whitelisted fields;
  - the rebuilt prompt keeps the tag and the chatId;
  - a 404 is handled;
  - a kind change sends POST then DELETE, and skips the DELETE when the POST fails;
  - shifting a cron and shifting it back is lossless.

### Task 4 — One accumulator for turn effects (refactor; enables everything below)
- **Refactor:** move the dispatch loop (shared.ts ~2463-2832) into `dispatchToolCalls(calls, effects, ctx)` over a `TurnEffects` accumulator. Recursion receives `carried: TurnEffects`, so the second pass keeps the single delegation slot, the results and the reminder ledger.
- **New pure module `src/agents/convo/actionResults.ts`:**
  - `ActionResult {tool, status: done|already|held|not_found|ambiguous|invalid|unreachable|unavailable, target, detail, facts, candidates}`;
  - `resolveRef`: accepts a full id or a unique prefix of 4+ characters, with or without the letter prefix;
  - `combinedOutcome`;
  - `renderActionResultsPass`.
- **Replace `scheduleConfirmation`** with the results list. `actionBearing` and `firstPassActed` read from the results.
- **Correction block:** one combined Fallfirm call voices **all** results in order, successes included. If the reply has a part that must ship (an approval question, an approved "yes" holding line, a carried task's holding line), the voiced results are **appended** after it, never replacing it. `holdingText` (~3346) takes only the holding part.
- **Failing tests first:**
  - a successful schedule is still voiced when a cancel in the same turn fails (the incident's core);
  - two reminders in one tool-only turn are both confirmed;
  - a parked action's question survives a failed cancel (`approvalGate.test.ts`).
- **Regression check:** the whole convo suite.

### Task 5 — Canonical order and dedupe
- **Code:** a pure `orderToolCalls` in `src/agents/convo/toolOrder.ts`, applied right after the schema-echo guard (~2394).
  - Order: cancels, then updates/steers, then creates/delegates, then everything else in the order written.
  - Drop exact duplicates, keyed by tool name plus sorted non-null args.
  - Re-cancelling the same id returns `already`.
- **Tests:**
  - `[delegate X, cancel_research]` with X running: the old run is cancelled and the new task is handed back. Today nothing runs and the turn goes silent.
  - Two identical `cancel_research` calls produce no correction.

### Task 6 — Reminder tools by id
- **`src/agents/convo/tools.ts`:**
  - `CANCEL_AUTOMATION_TOOL` takes `id` first, with `required:['id']` and `match` as a fallback.
  - New `UPDATE_AUTOMATION_TOOL{id, match, title, instruction, schedule_kind, cron, fire_at, timezone}` with `required:['id']`, placed after cancel in `convoToolList` (~347).
  - Every `id` arg has the same generic description ("the bracketed id shown beside it"). Tool args are flattened and the first description wins (`bubbleJson.ts:188`), so they must match.
  - Remove the "write a confirming text now" priming from cancel.
- **Handlers:** `handleCancelAutomation` and a new `handleUpdateAutomation` return `ActionResult`s through the per-turn ledger. A match that fits more than one reminder returns `ambiguous` with candidate ids and acts on none. Neither an id nor a match also returns `ambiguous`.
- **`craft/reminders.md`, rewrite "Managing them" as principles:** a change is an update by id; a removal is a cancel by id; a reminder is never cancelled and recreated; a schedule already covered is revised, never doubled.
- **Tests:**
  - an ambiguous match cancels neither and lists both;
  - cancel by id and by prefix;
  - update sends a PATCH;
  - an unknown id returns `not_found` plus the live ids.

### Task 7 — Live reminders in the prompt (weaving, part 1)
- **New `src/agents/convo/liveReminders.ts`:**
  - `readLiveReminders(engine, chatId, {budgetMs≈1200, freshMs 60s, staleMs 10m})` with a write-through cache: a fresh hit returns at once; a stale hit returns the cache and refreshes in the background; on a miss it races the fetch and returns null on timeout.
  - `noteLiveReminders`, called by the handlers after each mutation.
  - A pure `renderLiveReminders`.
- **`client.ts`:** move the engine read above the parallel batch (~274), start the fetch there, and await it just before the prompt build (~725).
- **Rendering:** pass it into `buildSystemPromptSections` (shared.ts ~849) as a trailing optional `liveState` param. Push it as section `live_reminders` right after `active_ops`.
- **One row per reminder:** `[R9d0c42] "title" — every day · next Thu 24 Sep 7:00 AM (their time) · set 21 Sep · says: <≤90-char gist>`. Wrap it in `dataTag('live_reminders')` after `neutralizeTagBreakouts`. Empty or unreadable renders nothing.
- **Gate:** engine present and not openclaw, and there is a sender.
- **Registrations:**
  - add the id to `DYN_SECTION_IDS` (`promptSections.ts`), `PROMPT_BUDGET` (`promptPolicy.ts`) and `DATA_BUDGET_KEYS` (`scripts/convergence/expectations.ts`);
  - add `live_reminders` and `action_results` to `PAYLOAD_TAGS` (`promptTag.ts:34`) and to the data-tag list in `convo/Context.md`.
- **Tests:** new `liveReminders.test.ts` covering bytes, tag neutralization, the fake-clock cache, and a never-resolving engine hitting the budget. Also a test that the section is absent on openclaw or without a sender.

### Task 8 — Research by id (weaving, part 2)
- **Code:**
  - `opsStatusLine`/`renderActiveOps` (shared.ts ~543-613) print `[L…]` ids.
  - Parked approvals in `memory/dossier.ts` `renderPendingApproval` (~155) print `[A…]`.
  - `cancel_research`/`steer_research` take `id`.
  - A multi-match returns `ambiguous` and never acts on all.
  - An empty match picks the single **user-started** run; a scheduled run is picked only when it's the only one running.
  - The status rules (~592, 601, 611) say "pass its id".
  - A 15-minute in-memory "recently stopped/finished" list in `opsCoordination` is rendered in `active_ops`, so the next turn knows what was dropped.
- **Tests (`replyOrder.test.ts`, mirrored in `steerResearch.test.ts`):**
  - a match that fits two runs cancels neither (today it cancels both);
  - one user run plus one scheduled run with an empty match cancels the user run (today this fails).

### Task 9 — Create-time duplicate hold ("hold, then revise")
- **Pure `detectCollision`** in `src/agents/convo/reminderCollision.ts`. It runs against the per-turn ledger (fresh list, adjusted by this turn's cancels, updates and creates). Collision means either:
  - the same kind with at least one pair of occurrences within ±15 min over the next 8 days (cron-parser, already a dependency via `pipeline/cron.ts`; the new cron in the user's zone, the existing `expr` in `engineZone()`, capped iterations); or
  - content containment of at least 0.8 via `simScore(tokenSet(title+instruction))` (`src/memory/textSim.ts`), whatever the time.
- **A collision is `held`, never created.** A `distinct:true` arg (added to `BOOLEAN_ARGS`, `bubbleJson.ts` ~306) is **ignored on the first pass**, with receipt `convo:tool_arg_ignored`. It's honored only on the outcome pass, after the model has seen the collision. Identical content on the same schedule returns `already` and can never be overridden. With no outcome pass available, the held reminder isn't created and the reply says so.
- **Tests:**
  - a second 7am daily is held (today it's created);
  - `distinct` on the first pass is ignored;
  - cancel(id) + schedule in the same turn creates;
  - one-shots 10 minutes apart are held;
  - a one-shot vs a daily is not held;
  - identical content can't be overridden.

### Task 10 — Outcome pass (weaving, part 3)
Modelled on the recall second pass (`renderArchiveRecallPass` + the recursion at shared.ts ~2920-2960).
- **Args:** add `outcomePass` and `carried` to `processConvoResult`.
- **Trigger:** runs when all of these hold:
  - this is not the recall pass (`archivePass`) or the outcome pass itself;
  - a turn context exists;
  - at least one result is `held`, `not_found`, `ambiguous`, `invalid` or `unreachable`;
  - there is no parked approval, no approval settled this turn, and no re-confirm.
- **Only-unavailable turns** (engine offline) skip the pass and voice all results.
- **Messages:** `[...turn.messages, assistant(res.text), user(renderActionResultsPass(...))]`. The last one carries `<action_results>`: what succeeded, what didn't and why, and the live reminders/lookups with ids.
- **Tools:** the turn's tools minus `recall_memory` and `check_error_log`. `delegate_to_ops` respects the carried single slot.
- **Fences on the pass:** skip:
  - `resolvePendingApproval`;
  - the routing and refusal floors;
  - the recall and error-log passes, and any further outcome pass;
  - the silent-turn retry.

  Also on the pass:
  - the quiet guard runs with `retry:false`;
  - the promise/claim guard only evaluates (add a `retry` option to `enforcePromiseKept`, mirroring `enforceQuiet`).
- **Budget:** the pass inherits `quietSpent` and never sets it. Recall, error-log and outcome passes are mutually exclusive, and the outcome pass wins. **Hard cap: 3 convo calls per user-visible turn**, pinned by a test.
- **Fallback to Task 4's combined Fallfirm voicing** when the pass throws, returns nothing, fails the honesty check, or any of its own actions fails. There is no third pass.
- **Rewrite promise-shaped nextSteps** (shared.ts ~341, 369, 377) as plain facts. Where the steer relay can honestly say more, add a pure `steerRelay` beside `engineActionRelay` (`orchestrator.ts` ~129), appended in `composeFollowUp`, stating that the answer may not cover the addition.
- **Receipts:** `convo:outcome_pass {trigger, resolved: model|fallback_*}`, and the turn trace records the carried tool names.
- **Tests (new `outcomePass.test.ts`, on the `recallMemory.test.ts` harness):**
  1. exactly one pass, with the tools stripped and the ids present;
  2. the pass's `update_automation` is dispatched and its text ships;
  3. if the pass throws, voice-all includes the success;
  4. if the pass's action fails, fall back with no third call;
  5. the fences hold;
  6. a parked turn gets no pass and its question survives;
  7. the carried task survives, with no second task;
  8. a turn where everything succeeded gets no pass;
  9. held → `distinct` on the pass → created;
  10. the call cap of 3 or fewer.
- **Incident test end to end:**
  - Existing: R9d0c42, daily 07:00, economy.
  - First pass: `cancel{match:'morning brief'}` + `schedule{0 7 * * *, govt}`.
  - Outcome pass: `update_automation{R9d0c42}`.
  - Assert exactly one enabled 7am job, carrying the govt instruction, and no "no reminder matched" text.

### Task 11 — Unbacked-claim guard
- **Code, in `src/agents/convo/unkeptPromise.ts`:** add a completion-claim matcher in two parts:
  - single words (`done`, `revised`, `updated`, `switched`, `cancelled`, `removed`, `fixed`) count only when the word is the whole clause, so "got it, revised" matches;
  - a separate list of multi-word claims (`changed it`, `all set`, `set it for`, …).
- **What backs a claim:** only a mutating tool call this turn, or one carried from the first pass. Running lookups never back a claim.
- **Response:** `enforcePromiseKept` checks promises and claims with one shared re-ask; the claim note is `renderClaimCorrection`, stated as a principle. English-only, per the standing lexicon policy.
- **Tests:**
  - "got it, revised" with no tool call gets one re-ask;
  - a retry carrying `update_automation` is accepted;
  - a claim on the outcome pass backed by carried effects is not flagged;
  - lookups don't back a claim.

### Task 12 — Approval decline wins
- **Code:** `resolvePendingApproval` returns an explicit `declined` (today "no" and "nothing pending" both return `NO_APPROVAL`, ~1975-1982/2120-2125). That seeds a `done` result, so a later cancel's `nothing_found` can't overwrite "dropped it".
- **Test:** "cancel that" on a parked action keeps her acknowledgement.

### Task 13 — Parked-approval TTL and targeting
- **Code:**
  - `listPendingApprovals(chatId, {sinceMs: now − 2×PENDING_ASK_TTL_MS})` (`src/db/repositories/opsTasks.ts` ~210).
  - A cancel with no match declines only the row named by the live `pending_approval` marker.
  - An `A…` id targets one exact row.
- **Tests:** a two-day-old row is not declined; an empty cancel declines only the live ask.

### Task 14 — Steer delivery status
- **Code:**
  - Add a `steerLog` with per-entry delivery status on the in-flight entry (`src/state/opsCoordination.ts` ~46); keep `steers: string[]` derived from it.
  - Add `noteSteerDelivery`, called from the fire-and-forget at shared.ts ~384 and from `deliverQueuedSteers` (`engineBackend.ts` ~522).
  - `endOpsEngineLeg` marks anything still undelivered as not received.
  - The status line reads "(reached the look)" or "(never reached the look)", and the rule at ~592 is updated to match.
- **Test:** a steer the engine never accepted does not read back as handed over.

### Task 15 — Group parked-marker bug
- **Code:** when a decline hits a row, clear the `pending_approval` marker of the row's **owner**, not just the sender's (shared.ts ~2152-2159). The "yes" path (~1993-2117) refuses to rebuild from a row that is no longer `pending_approval`.
- **Test (group fixture):** B cancels A's parked action, then A says "yes", and nothing runs.

### Task 16 — Chat-transport cancel actually stops Hermes
Hermes hard-interrupts the agent when a **streaming** chat-completions client disconnects (`gateway/platforms/api_server.py` ~4618-4636). The blocking non-stream path has no such hook. `/v1/runs` takes text only, so image tasks must stay on chat.
- **Code:** in `runViaChat` (hermesBackend.ts ~631), stream whenever the leg is cancellable (always for image tasks; `HERMES_STREAM` still forces streaming everywhere). Reuse `requestStream`, which already falls back when the engine ignores `stream:true`. When the abort fires, close the stream so Hermes sees the disconnect.
- **Tests (`fakeFetch`):**
  - an image leg requests `stream:true`;
  - aborting the signal closes the reader;
  - a non-stream fallback still parses.
- **Live check:** cancel an image lookup, and Hermes logs "SSE client disconnected; interrupted agent task".

### Task 17 — Goldens and budgets (last)
- **Regenerate `GOLDEN_BLOCK_B`** (`promptSections.test.ts` ~699; it moves because of the ids and rules) following the file header's procedure under `TZ=UTC`, and add a "seventeenth regeneration" note.
- **Must not move:** `GOLDEN_BLOCK_A`, `GOLDEN_BLOCK_C`, `GOLDEN_DRIFT_TASK_SHORT` and `GOLDEN_JSON_ANCHOR`. If any of them moves, it's a bug.
- **`GOLDEN_EXEMPT`:** add `live_reminders`.
- **Re-measure `CORPUS_CHARS`/`CORPUS_SHA256`** (`personaModules.test.ts` ~213) with a one-line tsx script over `convoPersonaWithCraft()`, plus a history note.
- **`PROMPT_BUDGET` ceilings** (`tool_docs`, `active_ops`, `craft_modules`, `persona`, `context_block`, new `live_reminders`): run `promptBudget.test.ts`, which prints each measurement next to its ceiling, set tidy ceilings within 2%, and write a history clause for each. Add `UPDATE_AUTOMATION_TOOL` to `TOOLS_1TO1` (~133).
- **Re-measure `MIN_TRANSCRIPT_SHARE`** and document why.
- The pre-existing `clauseInventory`/`promptBudget` reds stay as they were, unless touched.

## Out of scope (noted)

- Overlap-aware duplicate-research check and sibling cancel (open in memory `irises-redundant-research`).
- An orphan run when cancel lands before `run_id`.
- The reminder DST drift.

## Verification

1. **Full suite:** `npm test`. Everything is green except the documented baseline reds; new tests are listed per task.
2. **Local live test.** Rebuild, restart the launchd service, then over Telegram:
   - "change my morning brief to X" → one PATCH, one job, reply names the change.
   - "add a 7am news reminder" → held, and Irises offers or does a revise instead of creating one.
   - "add a 7am vitamin reminder" → created, as a distinct purpose.
   - "remove it" → cancelled by id.
   - "what reminders do I have" → no "[object Object]".
   - Start a lookup, "actually stop that and look up Y instead" → the old run is stopped, one new run, and the reply is honest.
   - Cancel an image lookup → Hermes logs the interrupt.
   - After each step, check `~/.hermes/cron/jobs.json` and `diagnostic_turn_history` receipts (`convo:outcome_pass`, the result statuses).
3. **VPS rollout** (`update.sh --yes`), with explicit confirmation from the user at that time, then the same probes. Update the memory files: a new incident memory and `irises-redundant-research`.

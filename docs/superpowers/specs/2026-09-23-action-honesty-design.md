# Action honesty — design

## Context

**The incident (2026-09-23, local instance, chat `eng:telegram:6995693233`).** The user asked Irises to change their 7am brief from economy to govt news. On every turn the convo model got the intent right: `cancel_automation{match:"morning brief"}` + `schedule_automation{0 7 * * *, new instruction}`. The plumbing around it failed:

- **The cancel missed.** It matches a title substring the model never sees; the real title is "daily indonesia digest". Result: `nothing_found`.
- **The schedule succeeded but was never mentioned.** Its confirmation lives in the single-slot `scheduleConfirmation` (`src/agents/convo/shared.ts` ~2444/2774), which is voiced only when the model wrote no text (~3243).
- **The failure replaced the model's reply.** The correction block (~3259-3270) swaps the model's text for Fallfirm's voicing of the failure only. The user heard "no reminder matched" four times. Now 5 enabled 7am jobs sit in `~/.hermes/cron/jobs.json`.
- **The last turn made a false claim.** It had no tool calls and said "revised". No guard checks past-tense claims.
- **The list is broken.** `listReminders` turns Hermes's `schedule` object into a string, so the list shows "[object Object]".

**The same bugs in background-research control.** An audit of `cancel_research`, `steer_research` and parked approvals found:

- matching on guessed names;
- a match that hits several items acts on all of them;
- a failed cancel plus a new delegate starts a second run while the reply asks "which one?", and that line becomes the new task's holding text;
- a consent-gate decline followed by "nothing's running" replacing a correct "dropped it";
- Fallfirm voicing promises nobody executes (Fallfirm has no tools);
- scheduled runs counting toward "several";
- duplicate cancels;
- an empty match declining every parked row, with no TTL;
- failed steers still shown as "you added";
- in groups, B's cancel leaves A's marker, so A's later "yes" still runs the declined task;
- cancelling a chat-transport (image) run doesn't stop Hermes.

**What the user asked for:**
1. Never create duplicate crons.
2. Irises can revise, remove and add reminders, and an add never duplicates an existing one. Chosen rule, "hold, then revise": a create that collides is held. Irises then revises the existing reminder, unless the chat shows a clearly different purpose.
3. Irises weaves in the previous chat: it knows what exists and what it actually did, and its replies continue the conversation instead of a canned "no match".
4. Fix the same class of bugs for background research, including the group-marker and chat-transport-cancel findings.

**Principles of the fix:**
- The model addresses things by **ids it can see**.
- A failure **never erases** a success or a question that must ship.
- Revise is **one in-place call**.
- A collision is **held**, never created.
- When an action misses, the **convo model itself gets one pass** with the real results. It has the full persona and transcript, so it can fix the call by id and write a reply that fits the conversation. Fallfirm is only the fallback.


## Design

See the implementation plan (docs/superpowers/plans/2026-09-23-action-honesty.md) for the task-level design; the principles above govern every task.

## Live cleanup done 2026-09-23

Local Hermes: deleted 9d0c42fcef9d, 86c6729d7503, 42cbde8bd745, 7380ea88a320; kept 2448ff495f3b (daily indonesia morning brief, next run 2026-09-24 07:00 WIB). VPS check pending (SSH banner timeout).

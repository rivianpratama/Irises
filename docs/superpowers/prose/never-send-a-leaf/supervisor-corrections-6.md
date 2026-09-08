# Supervisor corrections, sixth file — Fable-authored, 2026-09-08, after the second morning round

Live, on the new build, a hook turn still opened with "hey riv" and still ended in a question
("still wrestling the monster?"). The persona block forbids both; the hooks section, which sits a few
hundred characters from the recency edge, now says both. OLD → NEW, byte-for-byte, in BOTH
`docs/superpowers/prose/never-send-a-leaf/policy-strings.md` (HOOKS SECTION LINES) and `src/persona/hooks.ts`.

## 1. HOOK_LEAD
OLD:
```
They sent you nothing. This is the one turn that earns a hook, and it earns exactly one.
```
NEW:
```
They sent you nothing, so nothing of theirs comes back, not their greeting, not their word. This is the one turn that earns a hook, and it earns exactly one.
```

## 2. HOOK_OPEN_LINE (the `{kinds}` placeholder stays)
OLD:
```
Open to you this turn: {kinds}. One of them, never two, never a kind not named here.
```
NEW:
```
Open to you this turn: {kinds}. One of them, never two, never a kind not named here, and said as a statement, never asked.
```

## Code item for the same commit (Opus, `src/persona/idle.ts`)
The consent veto fires on a bare "ok" with nothing pending (live: turn four of chat web:nsl-m1 was
vetoed as consent although her previous line asked nothing), so "ok", "yes", "sure" can never be idle.
Make the consent veto conditional on a question being outstanding: push `consent` only when
`facts.pendingQuestion` is also true (her last turn ended in a question mark, or a pending ask/approval
is open). "yes please" after "want me to send it?" still vetoes (pending_question fires first and
consent joins it); a bare "ok" after a statement is a stall. Re-pin idle.test.ts rows that relied on
consent alone vetoing ("sure" with consent yes → veto only when pendingQuestion is true; add the
nothing-pending row asserting idle via the fast path). Record the refinement in the veto's comment.

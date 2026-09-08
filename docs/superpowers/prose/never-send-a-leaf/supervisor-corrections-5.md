# Supervisor corrections, fifth file — Fable-authored, 2026-09-08, after the daytime live round

Two lines, both from what the live box showed. On the daytime round her hooks were questions
("the monster keeping you up?", "third pass or still the second?"), and a hook that ends in a question
mark hands them the turn and turns their next stall into an answer. On the night round she opened the
sleep turn with a greeting back ("hey riv") before the sleep line. Both are already forbidden in the
persona block; the recency-edge copies now say it too. OLD → NEW, byte-for-byte, in BOTH the prose
source (`policy-strings.md`) and the code constant.

## 1. Drift anchor, hook mode, sixth bullet — `docs/superpowers/prose/never-send-a-leaf/policy-strings.md` and `src/persona/policy.ts`
OLD:
```
- Match their register, never their content. When a line dies, let it.
```
NEW:
```
- Match their register, never their content. A hook is a statement, never a question. When a line dies, let it.
```
(Still six bullets, still no digit.)

## 2. HOOK_SLEEP_LINE — `policy-strings.md` (HOOKS SECTION LINES) and `src/persona/hooks.ts`
OLD:
```
It is late where they are. The right reply is that they should sleep — one short bubble, or a tapback — and the hook keeps.
```
NEW:
```
It is late where they are. The right reply is that they should sleep — one short bubble, or a tapback, no greeting back — and the hook keeps.
```

Re-pins for Opus: hooks.test.ts char-for-char render pins, policy.test.ts / promptPolicy.test.ts anchor
tests, promptSections.test.ts GOLDEN_DRIFT_* for any hook-mode fixture and the cold fixture's hooks
section, PROMPT_BUDGET.behavior_anchor and hooks (measured, within the band), craft/hooks.md is
untouched.

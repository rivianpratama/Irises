# Supervisor corrections, fourth file — Fable-authored, 2026-09-08

The last three model-facing copies of the passing-mention beat, found by the closing implementer.
OLD → NEW, byte-for-byte, surrounding text untouched.

## 1. `src/agents/convo/craft/send-order.md` (L3, clause inside the paragraph)
OLD:
```
when you sent a run of bubbles (an answer, then a little passing mention), their reply may be picking up the answer, not the trailer.
```
NEW:
```
when you sent a run of bubbles, their reply may be picking up the first of them, not the last.
```

## 2. `src/agents/convo/craft/send-order.md` (L8, clause inside the bullet)
OLD:
```
It is NOT consent to run the thing you left as a passing mention, NOT a fresh question, NOT a nudge.
```
NEW:
```
It is NOT consent to run anything else you named, NOT a fresh question, NOT a nudge.
```

## 3. `src/agents/convo/shared.ts` (the JSON anchor template literal, ~L1129)
OLD:
```
 — more worth saying means the top of it now and the rest left in reach, never a fourth item.
```
NEW:
```
 — more worth saying means the top of it now and stop, never a fourth item.
```
Consequences for Opus: regenerate `GOLDEN_JSON_ANCHOR` in promptSections.test.ts (it mirrors this sentence); re-measure `PROMPT_BUDGET.json_anchor` and ratchet it down if the 2% band test asks (the sentence got shorter); re-pin the corpus sha256/length and `craft_modules` for send-order.md.

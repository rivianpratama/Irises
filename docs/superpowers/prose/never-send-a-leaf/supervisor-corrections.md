# Supervisor corrections after Wave 2 — Fable-authored, 2026-09-07

Four prose corrections the Wave 2 reviewers surfaced, decided by Fable. Opus applies each
byte-for-byte and re-pins whatever moves (corpus sha256/length, goldens, PROMPT_BUDGET.persona,
MIN_TRANSCRIPT_SHARE, CLAUSE_INVENTORY counts, any fallfirm test that quotes the old anchor).
Nothing here changes a lane's function; it restores one rule, removes one repetition, fixes one
count, and re-registers one code anchor.

---

## 1. Convo `Context.md` — RESTORE the opening ABSOLUTE RULE blockquote

The `## L1-11` edit in `convo-context-edits.md` mislabelled its range: the label said "title +
three intro paragraphs", the range also swallowed the ABSOLUTE RULE blockquote that opened the
file. The deletion was NOT intended. The envelope rule is Convo's own function contract and it
belongs at the primacy edge as well as at the recency edge (the JSON anchor), which is exactly the
two-copy drift strategy the plan buys.

Insert, as line 3 (after the title line and one blank line, before the "Who you are and how you
write rides ahead of this file" paragraph, with one blank line after it), the blockquote EXACTLY as
it stands on `main`:

    git show main:src/agents/convo/Context.md | sed -n 3p

Copy that line verbatim (it begins `> **ABSOLUTE RULE, BEFORE ANYTHING ELSE:**`). Do not reword it.
Do not add a heading. Re-pin the corpus, the goldens and the budgets; note in the
`PROMPT_BUDGET.persona` receipt that the blockquote is back and why (mislabelled range, not an
editorial call), replacing the sentence that currently records its deletion.

## 2. Convo `Context.md` — the confidence section's tone paragraph states its law twice

REPLACE the paragraph that begins `**Their emotion tunes your TONE, never your score.**` with:

```
**Their emotion tunes your TONE, never your score.** Urgency, frustration, "just tell me", none of it makes their meaning clearer. Flat words, honest answer. Pressure to skip the confirm is exactly when the wrong-thing answer happens.
```

(One paragraph, one line, no wrap — the confidence section's paragraphs are single lines.)

## 3. Convo `Context.md` — the reply-language lead-in miscounts its bullets

Pre-existing on `main`, inside a KEEP range. REPLACE the line

```
English is your default. Two rules on top of it:
```

with

```
English is your default. Three rules on top of it:
```

The three bullets under it are untouched.

## 4. `src/agents/fallfirm/client.ts` — the outcome anchor's voicing sentence

Inside the `anchor` template literal, REPLACE exactly this sentence:

OLD
```
Voice the outcome above as the next natural text in the thread: a confirmation lands light and done; a failure stays honest and hands them the next step.
```

NEW
```
Voice the outcome above as the next text in the thread, flat: a confirmation is one line and done; a failure says what happened and what they can do next, nothing more.
```

Every other sentence in the anchor, and every interpolation, stays byte-identical.

---

## Accepted deviations (no change; recorded so the whole-branch review does not reopen them)

- Composer `Context.md` first-ever-text block: the implementer relabelled the RIGHT example
  `RIGHT (intro line, one flat judgment, then stop):` to match the rule two lines above it, though
  `composer-edits.md` only authorised the third bubble. Fable accepts the label.
- Convo `Context.md` "How you write": two sentences the spec dropped ("Answer what they asked at
  the depth they asked" / "never pad an answer to seem thorough") are covered by first-principle #2
  and the bubble law. Intended.
- `renderPersonaBlock(lane)` renders byte-identical bytes in all four lanes; the plan's one-sentence
  lane pointer was dropped on purpose (the lane's function file is the prompt the block sits in).

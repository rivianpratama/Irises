# Supervisor corrections, third file — Fable-authored, 2026-09-08

The remaining copies of the "passing mention" beat, found by the T16b reviewer after the second
corrections file landed. Same rule, now applied to the last of them: **a task turn answers and
stops.** Every pair is OLD → NEW, byte-for-byte, inside the named file; surrounding text stays.

---

## A. `src/agents/composer/Context.md`

### A1 (currently L180) — the WRONG/WRONG/RIGHT triple under the seam bullet
OLD:
```
  RIGHT:  the full spec sheet is sitting right here too
```
NEW:
```
  RIGHT:  you're good, the spec checks out
```

### A2 (currently L404-409) — the "how the offer sounds" paragraph; replace the whole paragraph
OLD:
```
how the offer sounds (this defines "offer" everywhere in this file): never a service
question. no "want me to pull X?", no "should i grab Y?", no "want the full breakdown?", 
nobody texts a friend like a waiter taking orders. you mention what's already in your hand,
casually, as a fact, "i've got the whole rundown here too", and let them reach
for it. a mention they can ignore beats a question they have to answer. and if nothing extra
is worth having, don't manufacture one: just stop on the answer, like a person would.
```
NEW:
```
what happens to the rest (this holds everywhere in this file): nothing. no service
question, no "want me to pull X?", no "should i grab Y?", no "want the full breakdown?",
and no statement that dresses one up, no "i've got the whole rundown here too". nobody
texts a friend like a waiter taking orders, and nobody texts a friend like a brochure
either. answer what they asked and stop on the answer, like a person would. if they want
the next layer they ask for it, and then you fetch it.
```

### A3 (currently L421-423) — the RIGHT example under it
OLD:
```
RIGHT, their question answered, the rest held as one offer:
{"bubbles":[{"text":"the passport office opens 9am saturday"},{"text":"i've got the full hours and what to bring if you want it"}]}
```
NEW:
```
RIGHT, their question answered, then stop:
{"bubbles":[{"text":"the passport office opens 9am saturday"}]}
```

### A4 (currently L433-438) — the two "real answer" examples
OLD:
```
{"bubbles":[{"text":"the deadline's march 14"},{"text":"you've still got time to submit til then"},{"text":"the full instructions are right here too"}]}
```
NEW:
```
{"bubbles":[{"text":"the deadline's march 14"},{"text":"you've still got time to submit til then"}]}
```
OLD:
```
{"bubbles":[{"text":"rough monthly cost looks like ~$45"},{"text":"that's the mid-tier plan, and it's an estimate not a quote"},{"text":"got the full breakdown sitting here if you're curious"}]}
```
NEW:
```
{"bubbles":[{"text":"rough monthly cost looks like ~$45"},{"text":"that's the mid-tier plan, and it's an estimate not a quote"}]}
```

### A5 (currently L509-513) — the nearby-thing paragraph; replace the whole paragraph
OLD:
```
the nearby thing you offer is something YOU do, not another question back to them. never
turn the offer into "give me more details" or "what's the exact ___". you fetch, they don't
re-ask. and it lands as a statement of what's in reach, never a "want me to?" pitch. you are
never out of a next step: you can mention you'll keep an eye out and circle back, so you
never dead-end.
```
NEW:
```
the nearby thing is something YOU do, not another question back to them. never turn it
into "give me more details" or "what's the exact ___". you fetch, they don't re-ask. say
what you found instead, flat, and stop; do not pitch what you could fetch next, and do not
promise to keep an eye out. a dead end said plainly is an answer.
```

### A6 (currently L630-635) — the 25-word split pair; the third thought stops being an offer
OLD:
```
{"bubbles":[{"text":"the deadline's march 14 so you've still got time to submit until then and the full instructions are right here too"}]}
```
NEW:
```
{"bubbles":[{"text":"the deadline's march 14 so you've still got time to submit until then and it has to go in by post"}]}
```
OLD:
```
{"bubbles":[{"text":"the deadline's march 14"},{"text":"you've still got time to submit til then"},{"text":"the full instructions are right here too"}]}
```
(this second OLD is the same string as the first OLD of A4; after A4 is applied the ONLY remaining copy is the one under `RIGHT, three bubbles, each a complete thought:` — apply this pair there.)
NEW:
```
{"bubbles":[{"text":"the deadline's march 14"},{"text":"you've still got time to submit til then"},{"text":"it has to go in by post"}]}
```
Order of application for A4/A6: apply A6's second pair FIRST (it is anchored by its label line), then A4's first pair, so each OLD is found exactly once.

### A7 (currently L684-685) — the don't-anticipate bullet; replace the two-line bullet
OLD:
```
- don't anticipate unprompted. say what's in front of you. if more is genuinely in hand, one
  flat statement that it exists is the most you add, and never as a "want me to?" question.
```
NEW:
```
- don't anticipate unprompted. say what's in front of you and stop. no mention of what else
  you hold, and never a "want me to?" question.
```

## B. `src/agents/convo/Context.md`

### B1 (currently L117-119) — the three-bubble demo
OLD:
```
**RIGHT, same facts, three bubbles, the rest left in reach:**
```
```
{"bubbles":[{"text":"deadline is july 8"},{"text":"that's 4 days out"},{"text":"send the draft this week, the form's right here if you need it"}]}
```
NEW (label and example):
```
**RIGHT, same facts, three bubbles, then stop:**
```
```
{"bubbles":[{"text":"deadline is july 8"},{"text":"that's 4 days out"},{"text":"send the draft this week"}]}
```

### B2 (currently L128) — self-check 6
OLD:
```
6. Count the array: 4 or more items means the reply is carrying too much. Cut to the top 3 thoughts, leave the rest in reach, never fuse bubbles to sneak under.
```
NEW:
```
6. Count the array: 4 or more items means the reply is carrying too much. Cut to the top 3 thoughts and stop, never fuse bubbles to sneak under.
```

## C. `src/agents/convo/craft/send-order.md` (L9) — the passing-mention bullet; replace the whole bullet
OLD:
```
- **A passing mention is a statement, not an offer waiting for a yes.** "full scan's right here if you wanna check other windows" is a fact they can reach for, not a question you asked. Their "ok" is not them reaching for it. Only an EXPLICIT ask turns it into work: "yeah run the full scan", "do it", "pull the other months too". If they tapped reply on that exact bubble, that IS them reaching for it — the tapped-reply rule above governs.
```
NEW:
```
- **Only an explicit ask is work.** Their "ok" after an answer is not them reaching for more, even when your earlier bubble named something else you found. Work starts on words that ask for it: "yeah run the full scan", "do it", "pull the other months too". If they tapped reply on that exact bubble, that IS them reaching for it — the tapped-reply rule above governs.
```

## D. `src/agents/convo/shared.ts` (L598, inside the single-quoted string)
OLD:
```
not new work, and not consent to anything you left as a passing mention.
```
NEW:
```
not new work, and not consent to anything else you named.
```

---

## Code nits for the same commit (Opus, no prose)
- `src/persona/climate.ts` HOOK_NAMING doc comment (~L309-311): requote the worked example as the current text, `"No judgment this turn."`, and adjust the clause so it still argues that naming a beat on a quiet turn is an instruction to think about it.
- `src/persona/hooks.ts` `hookKindOpen`: compute the open reading by SET, the way the renderer does (`HOOK_WORDS.some(w => !directive.forbidden.includes(w))`), and add a duplicate-carrying `forbidden` row to its test asserting predicate and renderer agree.
- `src/agents/convo/shared.ts` quiet-guard comment (~L2010-2013): narrow the scope claim to what the code enforces — one corrective call per user-visible turn from THIS guard, and none once the honesty guard has fired on this pass; the honesty guard keeps its own per-pass design.

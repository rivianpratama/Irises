# Engine onboarding message (hermes) — sent automatically, resendable by hand

Hermes is never modified and never hand-edited — not its repo, not its config files. Its
SOUL.md belongs to Hermes: it loads the file fresh every message and it can edit the file
itself with its own tools. So the engine tuning travels the only sanctioned way: **as a chat
message**. Hermes reads it and appends the section to its own SOUL.md by itself. If you ever
want it gone, tell Hermes by chat to remove the section — same door out as in.

## The canonical text lives in code

**`src/agents/ops/hermesDoctrine.ts` → `HERMES_ONBOARDING_MESSAGE`.** This file used to carry a
second full copy; it no longer does, because two copies of a 12-section doctrine drift. Read or
print it with:

    npx tsx scripts/print-engine-doctrine.ts hermes

(The OpenClaw twin is `openclaw` on the same command, canonical in
`src/agents/ops/openclawDoctrine.ts`, mirrored at `bridge/openclaw/engine-onboarding-message.md`.
The two share most of their sections — edit them together. The deliberate divergences are noted
at the top of each doctrine module: hermes's memory is per-CHAT, and hermes is not invited to
spawn parallel subagents.)

## Irises sends it for you

At boot, `src/agents/ops/engineOnboarding.ts` sends the doctrine over the API server whenever
`OPS_BACKEND=hermes` — **once per content version**, on its own session key so it never lands in
a chat's continuity or memory. Delivery state is `~/.irises/engine-onboarding.json`; editing one
word of the message changes its content hash and re-sends on the next boot. A failed send retries
at 30s / 2min / 10min, then waits for the next boot.

Because the API server has no idempotency key, the message itself asks Hermes to **replace** any
existing section with the same heading rather than append a second one — so a re-send after a lost
state file costs nothing.

`ENGINE_ONBOARDING=off` disables the automatic send entirely, for an operator who curates the
engine's instructions by hand.

## Sending it by hand (the fallback)

Send it through a surface where Hermes talks as itself (its own CLI, TUI, or dashboard),
NOT through an Irises-fronted chat — a fronted chat wraps messages in the task contract.
Or send it straight to the API server:

    npx tsx scripts/print-engine-doctrine.ts hermes > /tmp/irises-doctrine.txt
    curl -s http://127.0.0.1:8642/v1/chat/completions \
      -H "Authorization: Bearer $HERMES_API_KEY" -H "Content-Type: application/json" \
      -d "$(jq -n --rawfile m /tmp/irises-doctrine.txt '{model:"hermes-agent",messages:[{role:"user",content:$m}]}')"

Hermes replies `OK` once it has saved the section. To confirm it landed later, grep its SOUL.md
for `## Engine mode`.

## What the discipline installs

Engine-mode recognition (and what it does NOT govern — operator chats, slash commands, and
hermes's own unfronted channels); the ANSWER / SOURCE / optional ACTIONS / FLAGS output contract
with nothing before or after it, no questions back, and the `NO RESULT:` protocol; the fidelity
rules; time anchoring; the full-reach invitation; the hard limits — inbox and accounts read-only,
never send or publish, and **never message the user on any channel itself**, which is the one that
matters most here because hermes owns the channel adapters Irises speaks through; per-chat memory;
skills; and pace.

**None of it is load-bearing.** Both adapters prepend a compact engine-mode header to *every*
delegated task — the invitation, the hard limits, the reply shape — so an engine that never got
onboarded, or forgot, still gets the essentials on every single run. Degraded, not broken.

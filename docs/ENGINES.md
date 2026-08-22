# Irises + your engine

Irises is the **persona**: a fast, warm texting front line (Convo), a re-voicer that makes deep
results land in one voice (Composer), an honest failure voice (Fallfirm), and the glue between
them. Everything **deep** — research, email, reading files, reminders, long-term memory — runs on
an **engine you already have**: [hermes-agent](https://github.com/NousResearch/hermes-agent) or
[OpenClaw](https://github.com/openclaw/openclaw). The engine is never modified; Irises speaks only
its public API, and either side can update independently.

```
                              THE IRISES REPO
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   USER ──text──▶ Channels ──▶ Convo (instant reply)          Irises's voice │
│    ▲             (web chat /                   │                            │
│    │              CLI + bridge)                │ deep work?                 │
│    │                                           ▼                            │
│    └──reply──── Composer ◀───────────── runTask() seam                      │
│                 (re-voices,                    │                            │
│                  hides the seam)               │  OPS_BACKEND = ?           │
│                                        ┌───────┴───────┐                    │
│                                        ▼               ▼                    │
│                                  hermesBackend   openclawBackend            │
│                                        │               │                    │
└────────────────────────────────────────┼───────────────┼────────────────────┘
                                         │               │
                              HTTP :8642 │               │ WS :18789
                              (OpenAI-   │               │ (gateway `agent`
                               compat)   ▼               ▼  RPC, protocol v4)
                                 ┌──────────────┐ ┌──────────────┐
                                 │ HERMES-AGENT │ │   OPENCLAW   │
                                 │ (unmodified) │ │ (unmodified) │
                                 └──────────────┘ └──────────────┘
```

There is deliberately **no built-in research engine**: if no engine is configured, Irises still
chats — and says honestly that its deep half is offline when you ask for more.

## Quick start (engine users)

**Hermes users** — in your hermes chat, or by hand:

```bash
hermes skills install https://raw.githubusercontent.com/rivianpratama/irises/main/skills/irises-setup-hermes/SKILL.md
# then, in any hermes chat:   /irises-setup-hermes
```

(The one-liner fetches over plain HTTPS with no credentials, so the repo has to be public — or
otherwise reachable to you anonymously — for it to resolve.)

**OpenClaw users:**

```bash
openclaw skills install git:rivianpratama/irises
# then ask your OpenClaw to run the irises-setup-openclaw skill
```

**Anyone, manually:**

```bash
git clone https://github.com/rivianpratama/irises && cd irises
bash ./scripts/engine-setup.sh --engine hermes     # or: --engine openclaw
```

The script is idempotent, prints every change before making it, and never edits engine code. For
hermes it appends two lines to `~/.hermes/.env` (`API_SERVER_ENABLED`, `API_SERVER_KEY`) — the
documented way to enable its API server; for OpenClaw it only *reads* the existing gateway token.

Flags: `--yes` runs non-interactively (assume every default, never prompt — which is also what a run
with no terminal on stdin does by itself), `--bridge` / `--no-bridge` choose bridge mode outright
(no bridge is the default without a terminal), `--revert` undoes bridge mode.

What it leaves behind: `PORT=3000` pinned in the Irises `.env` — the committed `deploy/app.env`
baseline of `8080` is the Docker image's port behind Caddy, so pinning 3000 keeps the server, the
printed URL, `npm run chat` and the bridge plugin's `IRISES_URL` default all pointing at one place.
It builds both halves (the server and the web client), starts Irises **detached** so it outlives the
shell that ran the script, health-checks it with retries, and — on hermes, when the gateway is up —
runs a real engine round-trip (`GET /v1/capabilities` on the API server with the key). Then it
**leaves Irises running** and prints the web chat URL (`http://127.0.0.1:3000`), `npm run chat`, and
how to stop it. If the hermes gateway isn't running it prints the exact command to bring it up
(`hermes gateway restart`, or `hermes gateway install` when it was never installed as a service) and
notes that Irises reconnects on its own once it is — nothing to re-run. Run the script again on a box
where a healthy Irises already serves that port and it reports "already running" and skips the start.

## Zero-config discovery (what happens at boot)

Irises is designed to ride **on top of** the engine with no `.env` of its own. On every boot,
`src/agents/ops/engineDiscovery.ts` runs (between the `deploy/app.env` baseline load and your local
`.env`) and fills in — **only what you haven't set yourself** — from the installed engine:

- **`OPS_BACKEND` is auto-detected.** hermes if `~/.hermes/` exists; otherwise OpenClaw if its CLI
  answers with a gateway token. If both are present, hermes wins (reminders need it). Set
  `OPS_BACKEND` yourself to force one — or **`OPS_BACKEND=off`** to force the debug/standalone path
  (deep work offline, discovery skipped entirely) even on a machine that has an engine installed.
- **The engine's credentials are reused.** hermes `HERMES_API_KEY` ← `API_SERVER_KEY` from
  `~/.hermes/.env`; OpenClaw `OPENCLAW_TOKEN` ← `openclaw config get gateway.auth.token`. Loopback
  URLs default in.
- **The LLM key is reused.** `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` are taken from the engine's
  own environment so Irises's small voice models have a key without you copying one.
- **Irises's voice inherits the engine's model** (see below).

Precedence: anything you exported in the shell, or set in local `.env`, always wins over discovery,
which in turn overrides the committed `deploy/app.env` model baseline. In Docker (no engine reachable,
no dotenv files) discovery finds nothing and the compose-injected env stands.

### Model inheritance

Deep work already runs on the engine's model. On top of that, discovery reads the model the engine is
configured with and applies it to **all three of Irises's own voice roles** (`convo`, `classify`,
`fallfirm`), so *the model Irises speaks with is the model your engine uses*:

| Engine | Where the model is read | Example value |
|---|---|---|
| hermes | `hermes config get model.default` (env fallback `HERMES_MODEL`, else a `~/.hermes/config.yaml` scan) | `anthropic/claude-opus-4.6` |
| OpenClaw | `openclaw config get agents.entries.<agent>.model`, else `agents.defaults.model.primary` | `anthropic/claude-opus-5` |

Both engines emit a `provider/model` slug, which Irises's OpenRouter lane consumes verbatim (an exact
match) using the reused OpenRouter key. On an Anthropic-only engine the `anthropic/…` prefix is
stripped onto the Anthropic lane (best-effort — override `<ROLE>_MODEL` if the version format is
rejected). Transcription is never inherited (it needs an audio-capable model). Turn the whole thing
off with `ENGINE_MODEL_INHERIT=off`; override any single role with `<ROLE>_MODEL` /
`<ROLE>_MODEL_OPENROUTER` / `<ROLE>_PROVIDER`.

## Engine onboarding (the standing discipline)

Deep work only lands right if the engine knows it is *in* engine mode. Irises teaches it once, as a
chat message the engine folds into its OWN durable instructions by its own hand — Irises never edits
engine files. What the discipline installs:

- **Engine-mode recognition** — which requests it governs (the `<prompt>` wrapper, the `task kind:`
  line, the brief, the output contract) and, just as important, which it doesn't: operator chats,
  slash commands, and the engine's own channels keep its normal self.
- **The output contract** — `ANSWER` / `SOURCE` / optional `ACTIONS` / `FLAGS`, nothing before or
  after, no questions back, `NO RESULT:` + one useful sentence when empty-handed, and the fidelity
  rules (figures verbatim, every `~` survives, certainty graded in FLAGS rather than hedged prose).
- **The full-reach invitation, with hard limits** — run real code, use its skills/tools/MCP servers,
  produce artifacts (and, on OpenClaw only, spawn parallel subagents — the hermes lane deliberately
  withholds that phrasing, because Convo's hermes briefs never ask for it). Inbox and accounts stay
  read-only, it never sends or publishes anything, and it **never messages the user directly** on any
  channel it can see: Irises is the only voice the user ever hears. That last one is a live hazard,
  not a formality, on hermes especially — the bridge plugin puts hermes's own channel adapters in the
  same process the engine runs in.

| Engine | How it arrives |
|---|---|
| hermes | **Automatic, at boot.** Irises sends it over the API server whenever `OPS_BACKEND=hermes`, on its own session key. Hermes appends the section to its own SOUL.md itself. Manual fallback + mechanism: `bridge/hermes/engine-onboarding-message.md`. |
| OpenClaw | **Automatic, at boot.** Irises sends it over the gateway `agent` RPC whenever `OPS_BACKEND=openclaw`. Mirror + full mechanism: `bridge/openclaw/engine-onboarding-message.md`. |

Each send is keyed to a **content hash** of that engine's message — `HERMES_ONBOARDING_MESSAGE` in
`src/agents/ops/hermesDoctrine.ts` and `OPENCLAW_ONBOARDING_MESSAGE` in
`src/agents/ops/openclawDoctrine.ts` are the canonical texts. Delivery state lives in
`~/.irises/engine-onboarding.json`, keyed by engine name, so an unchanged message never sends twice
and editing one word re-sends on the next boot. A failed send retries at 30s / 2min / 10min and then
waits for the next boot. `ENGINE_ONBOARDING=off` disables the send entirely (for operators curating
the engine's instructions by hand); to send or read one by hand,
`npx tsx scripts/print-engine-doctrine.ts hermes|openclaw`. To remove the discipline, tell the agent
by chat to delete the section — same door out as in.

Duplicate protection differs by transport: OpenClaw's `agent` RPC takes a version-keyed
`idempotencyKey`, while the hermes API server has none — so the hermes message itself asks the engine
to **replace** any section with the same heading rather than append a second one.

**None of it is load-bearing.** Both adapters prepend a compact engine-mode header to *every*
delegated task — the invitation, the hard limits, the reply shape — so an engine that never got
onboarded, or forgot, still gets the essentials on every single run. Degraded, not broken.

## Bridge mode — Irises on EVERY engine channel

The engine already speaks WhatsApp, Signal, Discord, Slack, LINE, email, … Bridge mode puts
Irises's voice in front of any of those chats **without the engine giving anything up**: a tiny
plugin (shipped in this repo, installed through the engine's own official plugin system — engine
code stays byte-for-byte untouched) forwards each fronted inbound message to Irises and suppresses
the engine's own reply; Irises answers back out **through the engine's connection**. New platforms
the engine gains later are fronted the same way — the plugin is platform-agnostic.

```
 user on WhatsApp/Signal/Discord/LINE/… ──▶ ENGINE gateway (owns the connection)
                                                │ inbound
                                     [irises-bridge plugin]        ← ships in bridge/,
                                       fronted chat?                 installed by
                                        │yes          │no            engine-setup.sh
                                        ▼             ▼
                          forward to Irises      fall through →
                          suppress engine reply  engine answers itself
                                        │
                  POST /api/bridge/inbound  (x-bridge-token = ENGINE_PUSH_TOKEN)
                                        ▼
                    Irises: Convo (instant voice) → engine seam (deep work)
                                        ▼
                    outbound, back through the engine:
                      hermes  → POST :8655/send → gateway.adapters[platform].send()
                      openclaw→ gateway WS `send` RPC (the client Irises already holds)
                                        ▼
                          engine delivers on the SAME channel → user
```

**Mechanisms** (both are documented, public plugin surfaces): hermes — the `pre_gateway_dispatch`
hook (fires for every non-internal inbound message on every platform before auth/dispatch;
returning `skip` suppresses the reply; exceptions fall through to normal dispatch). OpenClaw —
the `before_dispatch` hook (global claiming hook consumed before model dispatch; `{handled: true}`
completes the turn with no agent run; slash commands are explicitly passed through so `/status`
etc. stay with the operator).

### Choosing what Irises fronts

Fronting is **opt-in per chat/platform** and lives in the ENGINE's environment (the plugin must
decide instantly, without calling home):

```
IRISES_FRONT=telegram:*,whatsapp:+1555*,discord:12345
```

Comma-separated glob patterns matched (case-insensitively) against `<platform>:<chat_id>`
(hermes) / `<channel>:<conversation>` (OpenClaw). **Unset or empty = front nothing** — the plugin
is inert and the engine behaves exactly as before. Never pattern your operator/control chats
unless you mean it: a fronted chat talks to Irises, not to the engine.

### Failure policy

**Fail-open by default**: if Irises is unreachable (down, deploying, network), the engine answers
fronted chats itself — the user gets a reply in the engine's persona rather than silence. Set
`IRISES_BRIDGE_FAIL=closed` in the engine's environment to prefer silence over a persona glitch.

The hermes plugin decides that from a reachability verdict it keeps live: a `GET /health` probe every
15s plus the outcome of every inbound forward (3 attempts, 0.5s/2s backoff). A confirmed-unreachable
Irises makes the hook return the turn to hermes; anything else — including a gateway that has just
started and tried nothing yet — fronts as normal. So the first message after Irises dies mid-forward
can still be lost (it is logged at ERROR), and everything after it goes to hermes.

### Engine-side environment (set where the GATEWAY runs)

| Key | Default | Meaning |
|---|---|---|
| `IRISES_FRONT` | *(empty — front nothing)* | comma-separated glob patterns choosing fronted chats |
| `IRISES_BRIDGE_TOKEN` | — | shared secret; must equal Irises's `ENGINE_PUSH_TOKEN`. Required: unset, the hermes listener still binds but refuses every send with a 403 naming the missing variable (a misconfiguration you can read, instead of anonymous sends on loopback) |
| `IRISES_URL` | `http://127.0.0.1:3000` | where the plugin POSTs inbound messages |
| `IRISES_BRIDGE_FAIL` | `open` | `open` = engine answers on bridge failure; `closed` = silence |
| `IRISES_BRIDGE_PORT` | `8655` | hermes only: loopback listener for Irises's outbound sends |
| `IRISES_BRIDGE_WORKERS` | `2` | hermes only: forward workers / queue shards (a chat is pinned to one, so its messages stay ordered) |

On the Irises side, `HERMES_BRIDGE_URL` (default `http://127.0.0.1:8655`) points at that hermes
loopback listener; OpenClaw needs nothing extra (outbound rides the existing gateway WS client).

### Caveats you should actually read

- **Engine admission filters run BEFORE the bridge hook.** hermes `require_mention` /
  `allowed_chats` / `ignored_channels` and OpenClaw `dmPolicy` / `groupPolicy` / `requireMention`
  drop messages before the plugin ever sees them. For "Irises sees every message in this chat",
  widen those per-channel gates — and understand what that means: **`IRISES_FRONT` (plus Irises's
  own behavior) becomes the gate** for those chats. Widen admission only for chats you front.
- **hermes**: `HERMES_SAFE_MODE=1` disables all plugins — the bridge silently stops fronting
  (fail-open: hermes answers). The skipped inbound is not written to hermes's own chat history.
- **OpenClaw**: registering `before_dispatch` changes restart-recovery chat admission (the gateway
  defers `before_agent_reply` until after its durable checkpoint — upstream-documented behavior).
  Turns claimed by the bridge are recorded as `before_dispatch_handled`.
- **Media on split hosts**: hermes forwards media as LOCAL cached paths — fine when Irises and the
  engine share a box (the engine re-reads them during deep work); cross-host media is a v2 item.
- **Plugin API stability**: hook names/payloads are public plugin surfaces but less contractual
  than the OpenAI-compat API. Each plugin is ~150 lines pinned to the engine version in this repo;
  if an upstream rename ever lands, it's a small fix — and Irises's own channels keep working
  regardless.
- **Loops**: the bridge only ever forwards *inbound* user messages; Irises's replies leave through
  the engine's outbound path, which does not re-enter the inbound hooks.

### Install / remove

`bash ./scripts/engine-setup.sh --engine hermes|openclaw --bridge` sets bridge mode up (it copies
the plugin via `~/.hermes/plugins/` or `openclaw plugins install`, wires the token, and prints every
change); an interactive run without the flag offers it, and a non-interactive one skips it. Remove:
blank `IRISES_FRONT` (instant), or disable the plugin
(`hermes plugins disable irises-bridge` / `openclaw plugins disable irises-bridge`) and restart
the gateway; `--revert` prints the same steps.

## Where to talk to what

```
 TERMINAL
 ├── hermes                    → your engine, directly (unchanged)
 │   openclaw dashboard / tui  → your engine, directly (unchanged)
 └── npm run chat              → Irises (the same brain, from your shell)

 BROWSER   http://localhost:3000        → Irises web chat (DEBUG_TOKEN-gated)
 ANY ENGINE CHANNEL matching IRISES_FRONT → Irises (bridge mode; engine keeps the connection)
```

## Proactive messages (reminders, watched email)

Scheduling lives ON THE ENGINE (its cron), not in Irises. When you ask Irises for a reminder,
it creates an engine cron job whose prompt ends with "deliver the result to Irises"; when the job
fires, the engine does any work needed and POSTs to Irises, which voices it to your chat:

```
 engine cron fires ──▶ engine agent run ──▶ POST /api/engine/push ──▶ Composer/Fallfirm
                        (tools, email,       (x-engine-token)          voice it → your chat
                         research)
```

- `ENGINE_PUSH_TOKEN` guards that endpoint — it can make Irises speak, treat it as a credential.
- Engine-side email watching (the old "flag important mail" feature) is configured on the engine
  (hermes: its email skills + a cron job that ends with the same POST) — see the prompt templates
  the script prints, or write your own; the body contract is
  `{"chatId": "...", "kind": "reminder"|"email"|"memo", "text": "..."}`.
- **v1 gap:** reminders require the hermes engine — the OpenClaw cron wiring is pending (its
  `cron.add` RPC payload needs live verification). On the OpenClaw lane the three reminder tools
  are **not offered to the model at all**, so Irises never confirms a reminder that can't fire; ask
  for one and she says honestly that it isn't hers to set yet. Everything else works on OpenClaw —
  deep work there runs **full-reach**: real code, its own skills, parallel subagents, artifacts.

## Memory boundary (Irises ↔ engine)

Two memories exist side by side, on purpose, with a one-way contract:

- **Irises's own memory** — the short/medium/long tiers, profiles and prefs under
  `IRISES_HOME` (default `~/.irises`): SQLite for machine data, per-handle markdown under
  `memories/` for the curated tiers. Private to Irises and its agents (`0700` dirs);
  it is **never** inside the engine's workspace, and no engine code path can write it.
- **The engine's memory** — whatever the engine keeps for its own sessions (hermes
  `memories/MEMORY.md`/`USER.md`, OpenClaw's workspace + memory index). Irises never
  writes engine storage directly. It **asks**: the `update_memory` tool and `/forget me`
  both send a natural-language request through the chat's engine session (`remember()` in
  `src/agents/ops/engineBackend.ts`), and the engine's own memory loop decides what to
  keep, change, or drop.

The one sanctioned reverse flow is *influence, not access*: engine task results land in
Irises's short tier (and can be promoted by Irises's own tools), but the content passes
through Irises's pipeline and injection defenses first — Irises decides and writes.

## Environment reference

All of these are **auto-derived at boot** when an engine is present (see *Zero-config discovery*
above) — set one only to override it.

| Key | Mode | Meaning |
|---|---|---|
| `OPS_BACKEND` | both | `hermes` \| `openclaw` — **auto-detected**; set to force one. Unset + none found = deep work offline (Convo still chats) |
| `ENGINE_MODEL_INHERIT` | both | `off` to stop Irises's voice inheriting the engine's model (default on) |
| `HERMES_BASE_URL` | hermes | default `http://127.0.0.1:8642` |
| `HERMES_API_KEY` | hermes | the `API_SERVER_KEY` from `~/.hermes/.env` — auto-reused |
| `HERMES_CAPABILITIES` | hermes | optional comma list from `web,inbox,files,code,media,scheduling` — the operator's declaration of what this engine can do. Live discovery (`/v1/toolsets`) **overrides** it; the declaration covers the cold cache at boot and an engine that is down. Unset = unknown |
| `OPENCLAW_URL` | openclaw | default `ws://127.0.0.1:18789` |
| `OPENCLAW_TOKEN` | openclaw | `gateway.auth.token` from the OpenClaw config — auto-reused |
| `OPENCLAW_AGENT_ID` | openclaw | default `main` (also picks which agent's model is inherited) |
| `OPENCLAW_CAPABILITIES` | openclaw | same closed vocabulary as `HERMES_CAPABILITIES`. OpenClaw has no discovery path yet, so this is the ONLY source there. Unset = unknown |
| `ENGINE_ONBOARDING` | openclaw, hermes | `off` disables the boot onboarding send (see *Engine onboarding* above) |
| `ENGINE_PUSH_TOKEN` | both | guards `POST /api/engine/push` AND `POST /api/bridge/inbound` (generated by setup) |
| `HERMES_BRIDGE_URL` | hermes | bridge mode outbound: the plugin's loopback listener (default `http://127.0.0.1:8655`) |
| `ENGINE_TIMEOUT_MS` | both | per-engine-call budget (default: `OPS_TASK_TIMEOUT_MS` − 15s) |
| `ENGINE_MAX_CONCURRENT` | both | engine-call semaphore (default 2) |
| `IRISES_FRONT` | bridge | engine-side glob list choosing fronted chats (e.g. `telegram:*`) — set where the gateway runs |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | — | Irises's own voice models (setup reuses the engine's when present) |

## Security notes (read before exposing anything)

- **The engine credential is operator-grade.** `API_SERVER_KEY` / the gateway token grant the
  engine's FULL toolset — on default engine configs that includes a real shell on the host. Keep
  both engines loopback-only (the defaults) and never expose :8642 / :18789 publicly.
- **Prompt injection reaches a capable agent.** Whatever users text Irises is distilled into
  engine prompts. If people other than you can reach a fronted chat, consider your engine's
  sandboxing options and keep `IRISES_FRONT` tight.
- **Engine memory scope:** hermes scopes per-chat memory via session keys. OpenClaw's curated
  memory files are per-agent — all Irises chats share one engine-side user model there. The
  onboarding leans into that rather than fighting it: it instructs OpenClaw to keep a SINGLE
  per-agent model of the user, because Irises fronts one person.
- The engine can only make Irises SPEAK via the push endpoint with the right token; it can never
  read Irises state or act as a user.

## Troubleshooting

- *"ran into a problem completing that" on every deep question* — the engine is unreachable.
  Hermes: is `hermes gateway` running, and was it restarted after `API_SERVER_ENABLED=true`?
  Check `curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/capabilities`.
  OpenClaw: is the gateway up (`openclaw gateway status`)? Is `@openclaw/gateway-client` installed?
- *Reminders never fire* — hermes engine only (v1); check `GET /api/jobs` on the hermes API for
  the job, and that `ENGINE_PUSH_TOKEN` in the job's environment matches Irises's `.env`.
- *The engine ignores the output contract / narrates its process* — check the onboarding actually
  landed: the `engine:openclaw:onboarded` / `engine:hermes:onboarded` trace event in `/debug`, and a
  record under that engine's key in `~/.irises/engine-onboarding.json`. Re-send by deleting that file
  and rebooting Irises. On hermes you can also confirm by hand: grep its SOUL.md for
  `## Engine mode`, and re-send with
  `npx tsx scripts/print-engine-doctrine.ts hermes` (the curl is in
  `bridge/hermes/engine-onboarding-message.md`).
- *Irises says it can't look at their email, or won't take a file* — read the capability line it is
  working from. hermes discovery reads `GET /v1/toolsets`; a stock hermes has **no email tool at
  all**, so `inbox` can only come from a plugin toolset or from an explicit `HERMES_CAPABILITIES`
  declaration. Check `curl -H "Authorization: Bearer $HERMES_API_KEY" http://127.0.0.1:8642/v1/toolsets`
  and confirm the toolset you expect is `enabled` **and** `configured`.
- *Deep answers time out* — engines can take minutes on hard tasks. Raise `OPS_TASK_TIMEOUT_MS`
  (and `ENGINE_TIMEOUT_MS` follows it) if your engine's typical runs exceed 4 minutes.
- *Bridge mode: engine still answers a chat I fronted* — pattern mismatch (check the gateway log:
  the hermes plugin logs its active patterns at registration) or the plugin isn't enabled
  (`hermes plugins list` / `openclaw plugins list`), or `HERMES_SAFE_MODE=1` is set. Patterns match
  the FULL `<platform>:<chat_id>` string, lowercase.
- *Bridge mode: nobody answers a fronted chat* — Irises can't deliver back. hermes: is the loopback
  listener up (plugin logs "outbound listener on 127.0.0.1:8655") and does `HERMES_BRIDGE_URL`
  point at it? OpenClaw: is the gateway WS reachable with `OPENCLAW_TOKEN`? Also check that
  `IRISES_BRIDGE_TOKEN` on the engine equals `ENGINE_PUSH_TOKEN` in Irises's `.env` — the inbound
  door 403s on mismatch (`bridge:inbound` events appear in `/debug` traces when forwarding works).

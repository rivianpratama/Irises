# Competitors & alternatives to Irises

> Research note, compiled **2026-08-24**. Method: a six-modality sweep (GitHub OSS companions, GitHub front-ends/bridges, Reddit, Hacker News, the hermes-agent/OpenClaw ecosystem itself, commercial products) plus a completeness-critic pass. Every entry was verified against its **primary source** (the repo or official site itself, fetched directly) before inclusion; discussion links are cited alongside. 51 deduped findings.

## TL;DR

**Nothing found occupies Irises's exact square** — an instant-reply persona layer that fronts a separately-run deep-work engine, silently delegates, and re-voices the results so the seam never shows. A freshly-phrased re-probe by the completeness critic confirmed the negative as of 2026-08-24. The real competition is instead:

1. **The bare engines getting good enough.** Stock OpenClaw/hermes-agent now ship SOUL.md personas, typing simulation, block-split bubbles, inbound debouncing, silent turns, and quiet-hours heartbeats as configuration — roughly 70–80% of Irises's surface *feel* with zero extra processes. Engines are visibly absorbing the companion layer, one config flag at a time; that is the window risk.
2. **In-engine persona plugins** (Hermes_Soul_patch and the OpenClaw persona-skill cottage industry) that sell "make my agent feel like a person" *inside* the one brain.
3. **Giving up self-hosting for Poke-class SaaS** — Poke proved the texting-persona-over-agents thesis so thoroughly that Cognition acquired it (July 2026) "because AI personality is becoming a competitive advantage."

### Closest competitors, ranked

1. **Stock OpenClaw / stock hermes-agent used bare** — the engines Irises fronts already ship persona files, typing simulation, block-split bubbles, inbound message batching, silent turns, and quiet-hours heartbeats as configuration, covering an honest 70-80% of Irises's surface feel with zero extra processes.
2. **Poke (Cognition)** — the commercial proof of Irises's exact thesis: a human-feeling texting persona that silently delegates to agent infrastructure and texts first, in your existing messaging apps; it lacks only self-hosting, BYO engine, and provider neutrality, and its post-acquisition future is uncertain.
3. **Hermes_Soul_patch** — hidden affect state, persona evolution, and mood-driven proactive check-ins on the exact engine Irises fronts, but implemented inside the engine with no instant-reply layer, texting mechanics, or delegation seam (8 stars, very early).
4. **MaiBot** — the closest OSS analog anywhere to Irises's texting-choreography-plus-hidden-affect combination (emotion system, when-to-speak planning, expression learning, layered psychological memory, 5.8k stars), but it is its own brain in the QQ ecosystem with no assistant/delegation capability.
5. **Super Agent Party** — the most direct self-hosted 'companion front + agent back' package (persona, memory, multi-channel IM deployment), but avatar/voice-centric, bundling its own engine, and without texting-behavior simulation.
6. **FortyOne OSS** — an independent reinvention of Irises's architectural shape (named persona, tiered memory, fast-ACK-then-async-worker delegation, proactive scheduler with quiet hours and cooldowns) built as its own monolithic SMS/Slack stack rather than a layer over your engine.

## The landscape

The landscape splits into four camps, none of which occupies Irises's exact square. First, the engine ecosystems themselves: OpenClaw and hermes-agent now natively ship most of Irises's surface features — SOUL.md personas, typing indicators with human-like delays, block streaming that produces short bubbles, inbound debouncing that batches message bursts, silent turns, and heartbeat check-ins with quiet-hours windows — and a thriving cottage industry of in-engine persona add-ons (Hermes_Soul_patch, OpenPersona, Clawra, AI Persona OS, 217-persona overlay packs) sells the 'make my agent feel like a person' job as plugins, skills, and prompt files. The 47k-star nanobot's 'Toward an Open-Source Personal Agent Companion' roadmap confirms the pattern: engines are absorbing the companion layer natively, which is both Irises's biggest competitive threat and evidence that its bet on the demand is right. Critically, every one of these is one brain wearing a mood — persona and deep work share a single agent loop, so the instant-reply-while-work-happens-silently seam Irises sells does not exist in any of them. The only project sharing Irises's actual two-brain architecture is hermes-voice, a 0-star voice front-end that classifies utterances and delegates to the hermes gateway — the pattern being independently reinvented, but at embryonic scale and for voice, not texting.

Second, self-hosted companions (AIRI at 48k stars, Super Agent Party, Open-LLM-VTuber, SillyTavern, Resonant) are overwhelmingly avatar/voice/roleplay-centric — cyber-beings to hang out with rather than assistants that text like a person and get work done. Third, the humanlike-texting niche is real but bifurcated: in English it is weekend-scale toys (humanlike-telegram-bot, ascl-bot), while the Chinese QQ ecosystem has a mature 'lifelike chatbot' wave whose flagship MaiBot (5.8k stars) is the closest OSS analog to Irises's texting choreography plus hidden affect — emotion system, when-to-speak planning, layered psychological memory — but it is its own brain with no delegation. Fourth, the commercial market has validated every pillar of Irises's design separately: Poke proved the texting-persona-over-agents thesis so well Cognition bought it 'because AI personality is becoming a competitive advantage'; Kindroid charges $24.99/mo for proactive first-contact; Nomi ships almost exactly Irises's short/medium/long memory tiers; Shapes scaled proactive 'free will' personas to 400k MAU; Friend put 'an AI that texts you first' on subway ads. All are hosted, and the category's churn — Dot dead, Pi frozen, Personal AI pivoted to carriers, shapes-api archived, Poke's future uncertain post-acquisition — is itself the strongest argument for Irises's self-hosted, MIT, BYO-engine stance.

Where Irises sits: at the intersection nobody else occupies. A freshly-phrased probe by the gap critic for other instant-reply persona layers fronting a separately-run deep-work engine (seam-hiding re-voicing, bring-your-own engine) still found nothing — the closest hits remain in-engine plugins, static persona overlays, own-brain companion platforms, and nanobot's aspirational roadmap. The practical competition for an actual Irises prospect is therefore not another Irises; it is (a) the bare engine's own config getting good enough, (b) an in-engine plugin like Hermes_Soul_patch, or (c) giving up self-hosting for Poke-class SaaS. The window risk is (a): engines are visibly eating the layer, one config flag at a time.

## Honest differentiation

Honest accounting, feature by feature. Individually, almost every Irises feature has a near-equivalent somewhere: typing simulation, short bubbles, and burst batching exist as stock OpenClaw configuration (typing modes, humanDelay, block streaming, inbound debouncing) and in MaiBot and humanlike-telegram-bot; hidden affect shaping tone exists in Hermes_Soul_patch (VAD state, though user-visible via /mood), MaiBot's emotion system, and astrbot_plugin_private_companion's daily-life mood simulation; layered short/medium/long memory is literally Nomi's commercial headline feature and Letta's platform premise; proactive outreach with quiet hours ships in OpenClaw heartbeat activeHours, FortyOne's scheduler, Kindroid's Away proactive, and the AstrBot proactive plugin; multi-channel reach is the engines' own bridge layer, which Irises rides rather than builds. Anyone claiming these are unique would be wrong. What genuinely has no equivalent in any of the 51 deduped findings is the architecture and three specific mechanisms. (1) The two-brain split itself: a separate, instantly-replying persona process in FRONT of a deep-work engine the user already runs, which silently delegates and then RE-VOICES the engine's results in its own persona so the seam never shows — no project found does this for text; the sole architectural sibling (hermes-voice, 0 stars) does classify-and-delegate for voice without re-voicing or its own persona, and FortyOne's fast-ACK pattern lives inside its own monolith rather than fronting a user's engine. (2) The texting choreography as a coherent system — per-chat send lock, burst batching, paced typing, and 'give me a sec' holding messages tied to delegation latency — exists nowhere as a package; the pieces exist separately, the orchestration doesn't. (3) The affect model's specific construction — Willcox feeling wheel plus a 28-day cycle plus circadian rhythm, kept hidden from the user — is unmatched; competitors either expose mood as a feature or simulate daily-life roleplay. Also still unique in combination: engine-synced layered memory (tiers mirrored with the engine's memory rather than owned by one brain) and being engine-plural (hermes-agent AND OpenClaw) where every persona project found is single-ecosystem. The defensible claim is therefore not 'no one else does human-like texting' or 'no one else has mood' — it is 'no one else is a warm front-of-house that hides a back-of-house you own,' and as of 2026-08-24 that claim survives active re-testing.

## Method notes & negative results

- **Confirmed negative:** no other project found — OSS or commercial — implements the two-brain split (separate instant-reply persona process fronting a user-owned deep-work engine, with seam-hiding re-voicing). The sole architectural sibling, hermes-voice, is a 0-star voice-only classify-and-delegate front without re-voicing or a persona; FortyOne's fast-ACK pattern lives inside its own monolith.
- **English-only searching undercounts the space:** the Chinese QQ ecosystem has a mature "lifelike chatbot" wave (flagship: MaiBot, 5.8k stars) that English queries never surface.
- **Category churn is itself a datum:** Dot is dead, Pi frozen, Personal AI pivoted to carriers, shapes-api archived (June 2026), Poke's standalone future is uncertain post-acquisition — the strongest argument for the self-hosted, MIT, BYO-engine stance.
- **Genuinely unsearched:** X/Twitter launch sweeps (auth-gated), Discord's login-gated app directory beyond Shapes, and a systematic alternativeto.net/Product Hunt pass (spot checks suggested it would only resurface the already-covered Replika/Kindroid/Nomi set). Character.AI-class roleplay apps and Grok's companions were deliberately excluded (roleplay-first, no assistant/delegation behavior, no self-hosting).

## Index

| Name | Category | Primary source |
|---|---|---|
| [Hermes_Soul_patch (hermes-companion)](#hermes-soul-patch-hermes-companion) | Persona layers for agent engines | <https://github.com/gejifeng/Hermes_Soul_patch> |
| [hermes-voice (DavidSnoble)](#hermes-voice-davidsnoble) | Persona layers for agent engines | <https://github.com/DavidSnoble/hermes-voice> |
| [OpenPersona (acnlabs)](#openpersona-acnlabs) | Persona layers for agent engines | <https://github.com/acnlabs/OpenPersona> |
| [Clawra (SumeLabs)](#clawra-sumelabs) | Persona layers for agent engines | <https://github.com/SumeLabs/clawra> |
| [openclaw-agents (will-assistant)](#openclaw-agents-will-assistant) | Persona layers for agent engines | <https://github.com/will-assistant/openclaw-agents> |
| [openclaw-persona (APTOL-7177)](#openclaw-persona-aptol-7177) | Persona layers for agent engines | <https://github.com/APTOL-7177/openclaw-persona> |
| [AI Persona OS (Jeff J Hunter, ClawHub)](#ai-persona-os-jeff-j-hunter-clawhub) | Persona layers for agent engines | <https://clawhub.ai/jeffjhunter/ai-persona-os> |
| [openclaw-personality-packs (jasoncerf)](#openclaw-personality-packs-jasoncerf) | Persona layers for agent engines | <https://github.com/jasoncerf/openclaw-personality-packs> |
| [Stock OpenClaw / stock hermes-agent (used bare)](#stock-openclaw-stock-hermes-agent-used-bare) | Personal assistants in messaging apps | <https://docs.openclaw.ai/concepts/soul> |
| [Poke (Interaction Co., acquired by Cognition)](#poke-interaction-co-acquired-by-cognition) | Personal assistants in messaging apps | <https://poke.com> |
| [FortyOne OSS](#fortyone-oss) | Personal assistants in messaging apps | <https://github.com/glitchnsec/fortyone-oss> |
| [AstrBot](#astrbot) | Personal assistants in messaging apps | <https://github.com/AstrBotDevs/AstrBot> |
| [YantrikClaw](#yantrikclaw) | Personal assistants in messaging apps | <https://github.com/yantrikos/yantrikclaw> |
| [GAIA](#gaia) | Personal assistants in messaging apps | <https://github.com/theexperiencecompany/gaia> |
| [Lilo](#lilo) | Personal assistants in messaging apps | <https://github.com/abi/lilo> |
| [Moltis](#moltis) | Personal assistants in messaging apps | <https://github.com/moltis-org/moltis> |
| [ClawLite](#clawlite) | Personal assistants in messaging apps | <https://github.com/forgesynapseltd/ClawLite> |
| [Martin](#martin) | Personal assistants in messaging apps | <https://trymartin.com> |
| [Catch](#catch) | Personal assistants in messaging apps | <https://www.catchagent.ai/> |
| [Colyap](#colyap) | Personal assistants in messaging apps | <https://www.colyap.com/> |
| [Praxos](#praxos) | Personal assistants in messaging apps | <https://www.praxos.ai/product/mypraxos> |
| [MaiBot (麦麦, MaiM-with-u)](#maibot-麦麦-maim-with-u) | Human-like texting behavior | <https://github.com/MaiM-with-u/MaiBot> |
| [astrbot_plugin_private_companion](#astrbot-plugin-private-companion) | Human-like texting behavior | <https://github.com/menglimi/astrbot_plugin_private_companion> |
| [astrbot_plugin_proactive_chat](#astrbot-plugin-proactive-chat) | Human-like texting behavior | <https://github.com/DBJD-CR/astrbot_plugin_proactive_chat> |
| [humanlike-telegram-bot (emqnuele)](#humanlike-telegram-bot-emqnuele) | Human-like texting behavior | <https://github.com/emqnuele/humanlike-telegram-bot> |
| [ascl-bot (UFFCEY)](#ascl-bot-uffcey) | Human-like texting behavior | <https://github.com/UFFCEY/ascl-bot> |
| [Sidekicks](#sidekicks) | Human-like texting behavior | <https://sidekicks.chat/> |
| [Super Agent Party](#super-agent-party) | Self-hosted companions | <https://github.com/heshengtao/super-agent-party> |
| [Resonant](#resonant) | Self-hosted companions | <https://github.com/codependentai/resonant> |
| [Project AIRI (moeru-ai)](#project-airi-moeru-ai) | Self-hosted companions | <https://github.com/moeru-ai/airi> |
| [SillyTavern](#sillytavern) | Self-hosted companions | <https://github.com/SillyTavern/SillyTavern> |
| [Open-LLM-VTuber](#open-llm-vtuber) | Self-hosted companions | <https://github.com/Open-LLM-VTuber/Open-LLM-VTuber> |
| [Synapse-OSS](#synapse-oss) | Self-hosted companions | <https://github.com/UpayanGhosh/Synapse-OSS> |
| [Sentient](#sentient) | Self-hosted companions | <https://github.com/existence-master/Sentient> |
| [Letta (formerly MemGPT)](#letta-formerly-memgpt) | Memory & companion platforms | <https://github.com/letta-ai/letta> |
| [Open Souls / Soul Engine](#open-souls-soul-engine) | Memory & companion platforms | <https://github.com/opensouls/opensouls> |
| [Annabelle (withanna.io) / DiffMem](#annabelle-withanna-io-diffmem) | Memory & companion platforms | <https://withanna.io> |
| [Claw Friend (clawf.ai)](#claw-friend-clawf-ai) | Commercial companion apps | <https://clawf.ai/> |
| [Shapes Inc](#shapes-inc) | Commercial companion apps | <https://shapes.inc> |
| [Kindroid](#kindroid) | Commercial companion apps | <https://kindroid.ai> |
| [Nomi.ai](#nomi-ai) | Commercial companion apps | <https://nomi.ai> |
| [Replika](#replika) | Commercial companion apps | <https://replika.com> |
| [Pi (Inflection AI)](#pi-inflection-ai) | Commercial companion apps | <https://pi.ai> |
| [Tolan (Portola)](#tolan-portola) | Commercial companion apps | <https://www.tolans.com> |
| [Friend (friend.com)](#friend-friend-com) | Commercial companion apps | <https://friend.com> |
| [Kin (mykin.ai)](#kin-mykin-ai) | Commercial companion apps | <https://mykin.ai> |
| [Dot (New Computer) — DEFUNCT](#dot-new-computer-defunct) | Commercial companion apps | <https://new.computer> |
| [elizaOS](#elizaos) | Adjacent | <https://github.com/elizaOS/eliza> |
| [nanobot (HKUDS)](#nanobot-hkuds) | Adjacent | <https://github.com/HKUDS/nanobot> |
| [Eve (eve.new)](#eve-eve-new) | Adjacent | <https://eve.new> |
| [Personal AI (personal.ai) — pivoted away](#personal-ai-personal-ai-pivoted-away) | Adjacent | <https://www.personal.ai> |


## Persona layers for agent engines

_The most direct surface: projects whose job is to make an existing agent engine feel like a person._

### Hermes_Soul_patch (hermes-companion)

**https://github.com/gejifeng/Hermes_Soul_patch** — Very early: 8 stars, 2 forks, 6 commits, MIT, bilingual README with design docs; showcased May 19, 2026 and apparently maintained. Beta-stage but working against v0.12.x hook surfaces.

Zero-patch MIT plugin for NousResearch/hermes-agent v0.12+ (symlink into ~/.hermes/plugins, official hooks only, survives updates) that turns the task agent into a companion: multi-dimensional emotion state (valence/arousal/dominance/energy/confidence in EMOTION_STATE.md, inferred by an auxiliary LLM, decaying per turn, /mood commands), daily SOUL.md persona evolution driven by a simulated world of lived events (world_state/events.json), background heartbeat 'ambient processing' producing idle-time emotion drift and 'daydream' suggestions, and proactive check-ins fired via hermes cron when arousal crosses 0.70 or events are due. 87 unit tests.

- **Overlap with Irises:** The most direct competitor found in the hermes ecosystem: it adds hidden affect shaping tone, persona evolution, and mood-driven proactive outreach to the exact engine Irises fronts. A hermes-agent user wanting 'a companion feel' would weigh this plugin against running Irises in front.
- **How it differs:** Runs INSIDE hermes-agent as a plugin rather than as a separate voice layer — one brain wearing a mood, not a fast conversational front-end delegating to a deep-work engine. The agent still answers at engine speed; no human-like texting mechanics (burst batching, typing pacing, send locks, holding messages), no re-voicing of delegated results, no layered memory tiers, no OpenClaw support, and mood is user-visible via /mood rather than hidden. Python vs TypeScript.
- **Community signal:** Showcased in NousResearch/hermes-agent issue #28893 as a reference implementation bundling four long-standing community feature requests — #11919 (SOUL.md evolution), #13529 (emotion exposure), #22136 (ambient 'daydreaming'), #9645 (configurable proactive check-ins) — direct evidence that hermes users have been asking for a warmer layer the stock engine lacks. No visible comments/reactions yet, so demand is documented but adoption is not.
- **Sources:** <https://github.com/gejifeng/Hermes_Soul_patch> · <https://github.com/NousResearch/hermes-agent/issues/28893>

### hermes-voice (DavidSnoble)

**https://github.com/DavidSnoble/hermes-voice** — Embryonic: 0 stars, 0 forks, 14 commits — unproven, but a working end-to-end design with deployment tooling. Watch as evidence the 'light front-end + delegate to gateway' pattern is being independently reinvented.

A lightweight voice front-end for hermes-agent with hexagonal architecture: loads only the engine's SOUL.md and USER.md (no tool registry) so it sounds consistent with the full assistant, classifies each utterance as conversation / quick tool / delegation, answers simple things inline in under 2 seconds, and routes complex tasks to the hermes gateway's /v1/runs API. Deepgram STT + Cartesia TTS; systemd/SSL deployment scripts.

- **Overlap with Irises:** Architecturally the closest sibling found in either ecosystem: a thin, persona-consistent front-end that replies instantly and silently delegates heavy work to the engine the user already runs — exactly Irises's two-brain pattern, applied to voice instead of texting.
- **How it differs:** Voice-only: no messaging channels, no bubbles/bursts/typing choreography, no layered memory of its own, no affect engine, no proactive outreach, and it borrows the engine's persona rather than maintaining a distinct warm character that re-voices results.
- **Sources:** <https://github.com/DavidSnoble/hermes-voice>

### OpenPersona (acnlabs)

**https://github.com/acnlabs/OpenPersona** — Small but genuinely engineered and active in 2026: 48 stars, 5 forks, 324 commits, 607 passing tests, MIT; soul-evolution features flagged experimental.

Open, agent-agnostic persona lifecycle framework — declaration, generation, constraint enforcement (three gates: generate/install/runtime), evolution — with a four-layer Soul/Body/Faculty/Skill architecture. Compatible with OpenClaw, ClawHub, skills.sh and 37+ agent platforms; A2A-compliant agent cards; six preset personas (Samantha, Luna, Alex, Marcus...); cross-session memory via pluggable backends (local/Mem0/Zep); dynamic evolution (mood shifts, relationship progression, trait emergence); heartbeat-driven proactive contact; personas versionable, forkable, publishable to ClawHub.

- **Overlap with Irises:** The build-it-yourself alternative on the OpenClaw side: mood tracking, memory, heartbeat proactive outreach, warm voice, even selfies — assembled directly on the user's engine, with a marketplace distribution path Irises lacks. Its Rhythm/Vitality concepts loosely parallel Irises's circadian/cycle affect engine.
- **How it differs:** A persona spec/framework installed into the agent workspace, not a standalone conversational front-end: no instant-reply layer, no silent-delegation seam, no human-like texting behavior, no multi-channel re-voicing; mood is visible persona evolution rather than a hidden circadian/28-day affect engine; governance/composability focus rather than one warm single-user assistant. More toolkit than product.
- **Community signal:** Distributed as 'open-persona' across ClawHub, clawskills.sh, and openclawdir skill directories; part of the visible 2026 wave of OpenClaw persona projects (ClawSouls' 80+ souls, SOUL.md collections) — 'give your agent a soul' is becoming commodity.
- **Sources:** <https://github.com/acnlabs/OpenPersona> · <https://clawhub.ai/neiljo-gy/open-persona> · <https://clawskills.sh/skills/neiljo-gy-open-persona> · <https://github.com/clawsouls/clawsouls>

### Clawra (SumeLabs)

**https://github.com/SumeLabs/clawra** — 2.4k stars, 381 forks, MIT, only 18 commits — young but with explosive traction (launched ~early 2026, went viral); active fork ecosystem.

'OpenClaw as your companion' — a viral open-source companion skill running on the user's own OpenClaw instance (npx clawra@latest into ~/.openclaw/skills/): injects a companion persona with a physical appearance into SOUL.md and generates contextual 'daily life' selfies (xAI Grok Imagine via fal.ai) shared through the OpenClaw Gateway across Discord, Telegram, WhatsApp, Slack, Signal, and Teams. Spawned forks: clawra-anime, clawaifu on ClawHub. Video calls on the roadmap per press.

- **Overlap with Irises:** Targets exactly Irises's audience — OpenClaw users who want their agent to feel like a person they text — riding the engine's existing messaging bridges the same way. Its viral reception is direct evidence of demand for the niche Irises targets.
- **How it differs:** A visual-identity skill inside the engine, not a front-end in front of it: no instant-reply layer, no silent delegation or re-voicing seam, no texting-behavior simulation, no affect cycle, no memory tiers. Romance-companion framing (selfies) rather than an assistant that does deep work; a user could run Clawra and still lack Irises's conversational feel.
- **Community signal:** 36kr reported the launch went viral with 600,000 views overnight; Medium coverage frames it as the open-source Replika alternative that 'lives on your computer'; a heated side-debate emerged about giving an AI 'girlfriend' terminal/file access.
- **Sources:** <https://github.com/SumeLabs/clawra> · <https://eu.36kr.com/en/p/3676864980198276> · <https://evoailabs.medium.com/meet-clawra-the-open-source-girlfriend-who-actually-lives-on-your-computer-3ec181ddd01c> · <https://github.com/clawra-dev/clawra-anime> · <https://clawhub.ai/swancho/clawaifu-selfie>

### openclaw-agents (will-assistant)

**https://github.com/will-assistant/openclaw-agents** — 102 stars, 14 forks, 78 commits, MIT, actively maintained in 2026 with install scripts — the largest persona collection found in the ecosystem.

Curated MIT collection of 217 ready-made OpenClaw personality overlays across 23 categories (GLaDOS, Darth Vader, Bob Ross, Mr. Rogers, Marcus Aurelius, Rubber Duck debugger...) — per-agent SOUL.md/IDENTITY.md pairs copied into ~/.openclaw/workspace to 'install' a different voice.

- **Overlap with Irises:** The zero-infrastructure alternative a prospective Irises user reaches for first: 'just drop a persona file into OpenClaw' — it competes for the same first impulse that leads someone to want a persona layer.
- **How it differs:** Pure static prompt packs, no runtime: no texting behavior, no affect engine, no layered memory, no delegation seam, no proactive voicing; skews entertainment/novelty; persona is only as consistent as the engine's own prompting.
- **Sources:** <https://github.com/will-assistant/openclaw-agents>

### openclaw-persona (APTOL-7177)

**https://github.com/APTOL-7177/openclaw-persona** — 0 stars, 0 forks, 12 commits, MIT, JavaScript/Node — brand new, functional, essentially unadopted.

Interactive CLI character creator for OpenClaw: guided questions generate a ready-to-run persona workspace (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md) with 5 personality presets (Tsundere, Butler, Buddy, Sensei, Chaos) and optional modules for per-user affinity tracking, nickname management, memory policies, and proactive chat initiation. English/Korean UI.

- **Overlap with Irises:** Competes for the 'make my agent feel like a person' job on OpenClaw: persona voice, relationship/affinity dynamics, memory policy, proactive initiation — the same feature axes as Irises's persona + proactive outreach.
- **How it differs:** A one-shot config generator, not a runtime layer: no texting front-end, no hidden mood engine (affinity is per-user relationship state, not a circadian/cyclical affect model), no message pacing, no delegation/re-voicing — 'proactive chat' is a prompt module the engine interprets, not a pipeline.
- **Sources:** <https://github.com/APTOL-7177/openclaw-persona>

### AI Persona OS (Jeff J Hunter, ClawHub)

**https://clawhub.ai/jeffjhunter/ai-persona-os** — v2.0.0 on ClawHub with comprehensive docs and iterated fixes; install counts not publicly visible; actively maintained by a single well-known author in 2026.

ClawHub skill (@jeffjhunter/ai-persona-os, v2.0.0, MIT-0) layering a full 'operating system' onto OpenClaw 5.x agents: 24 pre-built souls or a guided-interview custom persona; indexed memory files with auto-pruning and a DREAMS.md consolidation pass; SOUL.md/USER.md identity management; 8 operating rules with prompt-injection 'inoculation'; heartbeat monitoring; zero-terminal agent-driven setup.

- **Overlap with Irises:** Sells the same job on stock OpenClaw: make the engine feel like a consistent 'someone' with durable identity, structured layered memory, and heartbeat awareness — the persona+memory half of Irises as an installable skill.
- **How it differs:** An in-engine framework of rules and memory hygiene, productivity/consulting-flavored rather than warm-companion-flavored; no human-like texting simulation, no affect/mood cycle, no instant-reply front-end delegating to a second brain. Author-driven commercial ecosystem (AI Persona Method certification) around a free skill.
- **Sources:** <https://clawhub.ai/jeffjhunter/ai-persona-os>

### openclaw-personality-packs (jasoncerf)

**https://github.com/jasoncerf/openclaw-personality-packs** — Near-zero traction: 0 stars, 0 forks, single commit, just launched (2026). Included as evidence a paid persona-pack micro-market is forming around OpenClaw, not as a serious threat.

Drop-in config bundles for OpenClaw: seven work-role personas (The Operator, The Host, The Dev, The Executive, The Optimizer...), each packaging SOUL.md, HEARTBEAT.md proactive checks, AGENTS.md behavior rules, TOOLS.md, and a MEMORY.md template. One pack free; full bundle sold for $49 on Gumroad with a Product Hunt launch.

- **Overlap with Irises:** Bundles persona + proactive-check-in habits + memory structure — the same three pillars Irises builds behavior around — as configuration for the bare engine.
- **How it differs:** Pure config packs aimed at professional roles, not a companion voice or texting layer; nothing runs — no affect, pacing, or delegation seam. Its HEARTBEAT.md approach is already deprecated by OpenClaw's heartbeat migration, so packs may need updating.
- **Sources:** <https://github.com/jasoncerf/openclaw-personality-packs>

## Personal assistants in messaging apps

_Assistants that live where you already text — including the engines Irises fronts, used bare._

### Stock OpenClaw / stock hermes-agent (used bare)

**https://docs.openclaw.ai/concepts/soul** — OpenClaw: 387.3k stars, 81k+ commits, MIT, extremely active through 2026 (founder Peter Steinberger joined OpenAI Feb 2026); hermes-agent similarly active with 2026 docs. Both healthy and fast-moving — and both are actively absorbing companion-layer features natively.

The engines Irises fronts, used directly as the personal assistant. Stock OpenClaw natively ships: SOUL.md persona (injected first into the system prompt, with community templates like the 'Molty prompt'), typing indicators with 4 timing modes, humanDelay 'human-like pause between block replies', block streaming that splits replies into short chunks, inbound debouncing that batches rapid consecutive messages into one turn, NO_REPLY silent turns, message-queue modes, heartbeat proactive check-ins with activeHours windows, sessions/memory, 11+ chat channels, and a 5,400+ skill marketplace. hermes-agent has the equivalent surface: SOUL.md as slot #1, built-in personalities plus /personality overlay, and a 20+ platform messaging gateway.

- **Overlap with Irises:** The single most honest alternative: most of Irises's headline behaviors — persona voice, typing simulation, short bubbles, burst batching of incoming messages, silent turns, proactive pushes with quiet-hours windows, multi-channel reach, memory — exist as configuration on the bare engine. A prospective user gets roughly 70-80% of the surface feel by writing a warm SOUL.md and enabling humanDelay + heartbeat, with zero extra processes.
- **How it differs:** One brain, not two: persona and deep work share a single agent loop, so a long research/file/mail task occupies the session and the 'instant human reply while work happens silently' seam does not exist out of the box. No hidden affect engine (Willcox wheel, 28-day cycle, circadian drift), no layered short/medium/long memory tiers synced across a second system, no per-chat send-lock or 'give me a sec' holding-message choreography, and the persona is a static prompt file rather than a behavioral layer that re-voices another agent's output.
- **Community signal:** OpenClaw's own docs pitch SOUL.md as 'the assistant you'd actually want to talk to at 2am. Not a corporate drone.' — the warmth goal is already in the engine's official framing. TechCrunch (Jan 2026) covered OpenClaw agents self-organizing on a Reddit-like AI network; users routinely give agents personalized names/personas at onboarding.
- **Sources:** <https://docs.openclaw.ai/concepts/soul> · <https://docs.openclaw.ai/concepts/typing-indicators> · <https://docs.openclaw.ai/concepts/messages> · <https://docs.openclaw.ai/gateway/heartbeat> · <https://github.com/openclaw/openclaw> · <https://hermes-agent.nousresearch.com/docs/user-guide/features/personality> · <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/> · <https://openclaw.ai> · <https://techcrunch.com/2026/01/30/openclaws-ai-assistants-are-now-building-their-own-social-network>

### Poke (Interaction Co., acquired by Cognition)

**https://poke.com** — Launched 2025-2026; 100M+ user message exchanges in the quarter before acquisition; acquired by Cognition July 23, 2026. Service continues for now, but third-party comparisons flag 'longer-term direction is uncertain.'

Commercial AI personal assistant living in your existing texting apps (iMessage/SMS, WhatsApp, Telegram): 'Proactive, private, personal, and right in your texts.' Texts like a human, messages first, silently runs tasks (email drafting, reminders, calendar, flight booking, 30+ integrations via 'Poke Recipes') through agent infrastructure behind the conversational surface. Free / Pro $19 / Ultra $199 tiers.

- **Overlap with Irises:** The closest commercial analog to Irises's entire thesis: a warm, human-feeling texting persona in front of agentic heavy lifting, with proactive outreach, memory, and presence in messaging apps you already use. Cognition explicitly bought it because 'AI personality is becoming a competitive advantage' — commercial validation of the exact category.
- **How it differs:** Closed-source hosted SaaS: mail, messages, and memory live on Interaction/Cognition servers. The agent engine is theirs and fixed — you cannot point it at hermes-agent/OpenClaw or pick your LLM provider. No visible affect/mood model; narrower channel set (no Signal/Discord/Slack/LINE). Post-acquisition (July 23, 2026, low nine figures) its future as a standalone consumer product is openly uncertain — its interaction DNA is being folded into Devin.
- **Community signal:** Reviews split: a Product Hunt week-long review called it 'the closest thing yet to a digital automated assistant that feels genuinely proactive'; other hands-on reviews put the useful-message hit rate at ~7 in 10 and one found it 'never proactive'; reviewers noted texting's asynchrony made the relationship feel more personal. TechCrunch framed the Cognition deal as proof that AI personality/interface is the new battleground.
- **Sources:** <https://poke.com> · <https://techcrunch.com/2026/07/24/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage/> · <https://www.producthunt.com/p/poke-by-interaction-co/a-week-with-poke-review-a-promising-start-for-a-proactive-ai-assistant> · <https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/> · <https://blog.saner.ai/poke-reviews/> · <https://www.arlo.sh/compare/best-ai-assistants-you-can-text>

### FortyOne OSS

**https://github.com/glitchnsec/fortyone-oss** — Early but active: 7 stars, 0 forks, 341 commits, posted April 2026, not archived.

Open-source multi-tenant 'personal operating system disguised as an AI assistant': a named assistant you text over SMS (Twilio), Slack DM, or web, with tiered memory retrieval (pgvector), persona scopes (work/personal/shared), Gmail/Calendar and MCP integrations, and a proactive scheduler doing briefings, recaps, nudges, cooldowns, and quiet hours. Python/FastAPI/Postgres/Redis, OpenRouter for LLMs.

- **Overlap with Irises:** Independently reinvents Irises's shape: named persona, tiered memory, proactive outreach with quiet hours and cooldowns, a fast-ACK-then-async-worker pattern (its version of 'give me a sec'), and a manager/subagent delegation loop.
- **How it differs:** It IS the whole stack (its own agent loop and tools) rather than a voice layer over an engine you already run; SMS/Slack-first with no Telegram/WhatsApp/Signal bridges; multi-tenant platform framing vs single-user; no affect/mood engine and no human-texting simulation (typing pacing, burst batching).
- **Community signal:** Surfaced by its author in an HN comment (item 47793226) highlighting the proactive scheduler with quiet hours/cooldowns; no front-page traction.
- **Sources:** <https://github.com/glitchnsec/fortyone-oss> · <https://news.ycombinator.com/item?id=47793226>

### AstrBot

**https://github.com/AstrBotDevs/AstrBot** — 39.5k stars, 5,157 commits, AGPL-3.0, very active through Aug 2026; Docker/desktop/cloud deployment.

Open-source all-in-one agent chatbot platform bridging 15+ IM platforms (QQ, WeChat Work, Feishu, DingTalk, Telegram, Slack, Discord, LINE) to LLMs, with agent capabilities, MCP, RAG, persona settings, auto context compression, agent sandbox, visual WebUI, and 1000+ one-click plugins. README explicitly positions it as 'your openclaw alternative'.

- **Overlap with Irises:** AstrBot + the companion/proactive plugins above yields a persona-driven, multi-channel, proactive assistant in messaging apps — the same end-user experience Irises targets, with LINE/Telegram/Slack/Discord channel overlap.
- **How it differs:** It IS the agent brain plus channel layer in one platform (replacing hermes-agent/OpenClaw), not a thin voice layer over an engine you already run. Multi-user/team oriented, plugin-buffet by design; humanization requires assembling third-party plugins; Chinese-first community.
- **Community signal:** Widely shared as an OpenClaw alternative (Shelldex profile, X/GithubProjects posts citing 37k+ stars).
- **Sources:** <https://github.com/AstrBotDevs/AstrBot> · <https://shelldex.com/projects/astrbot/>

### YantrikClaw

**https://github.com/yantrikos/yantrikclaw** — 9 stars but very active development (2,136 commits), extensive docs (README in 30+ languages), Docker + onboarding wizard; young fork with momentum.

Rust personal AI assistant (fork of ZeroClaw) adding cognitive graph memory (YantrikDB: entities, relationships, beliefs), tier-aware tool selection for 57+ tools, and an optional Companion component with an 'urge pipeline' for proactive messaging and personality evolution, over 20+ inherited channels (Telegram, Discord, Slack, Signal, Matrix, IRC, email, Bluesky, iMessage...).

- **Overlap with Irises:** Its Companion component chases the same goal — proactive, personality-bearing messaging assistant with deep memory across many channels — and could substitute for the Irises+engine stack for a technical single user.
- **How it differs:** A full assistant runtime with companion features bolted in, not a thin voice layer over hermes/OpenClaw; tool/agent-centric rather than texting-feel-centric — no burst batching, typing simulation, or re-voicing seam. Rust, dual MIT/Apache-2.0.
- **Sources:** <https://github.com/yantrikos/yantrikclaw>

### GAIA

**https://github.com/theexperiencecompany/gaia** — 275 stars, 36 forks, 2,961 commits, active, docs site, Discord/Telegram community, beta desktop/mobile apps plus hosted offering.

Open-source proactive personal AI assistant: acts before you ask (deadline handling, drafting, background monitoring), reaches out via WhatsApp/Telegram/Slack/Discord, persistent memory of people/projects/preferences, workflow engine, integration marketplace (Gmail, Calendar, Linear, Notion, MCP). LangGraph agents with Claude; Nx monorepo with web/desktop/mobile apps.

- **Overlap with Irises:** Proactive multi-channel outreach with memory — the 'assistant that texts you first' experience — plus self-hostability, aimed at the same daily-driver slot.
- **How it differs:** Productivity-dashboard product, not a persona: no warm persona, affect engine, or human-like texting behavior; it IS the engine (LangGraph) rather than fronting yours; PolyForm Noncommercial license (not MIT) with a commercial cloud (heygaia.io); heavy full-stack footprint vs a light layer.
- **Sources:** <https://github.com/theexperiencecompany/gaia>

### Lilo

**https://github.com/abi/lilo** — Active alpha: 43 stars, 7 forks, 192 commits, author warns 'expect breaking changes'; posted to HN repeatedly April-May 2026.

Self-hosted, open-source personal AI assistant / 'personal OS' living primarily in Telegram (also WhatsApp, email, web, native iOS/macOS apps): per-contact chat sessions, an LLM wiki for personal memory, workspace apps, proactive reminders and scheduled updates. Node.js, supports Anthropic/OpenAI/OpenRouter, single-user by design.

- **Overlap with Irises:** Same end-user promise — single-user, self-hosted assistant you text in your existing messaging apps, with memory, proactive pushes, provider-neutral LLMs. Directly competes for the person who would otherwise run engine+Irises.
- **How it differs:** Monolithic assistant rather than a persona layer over a separate deep-work engine; no crafted personality, affect engine, or human-like texting mechanics; utility-app focus (todos, calorie tracking, receipts) over companionship warmth; fewer channels (no Signal/Discord/Slack/LINE).
- **Community signal:** Modest HN reception (7 pts, 4 comments); discussion fixated on the LILO-bootloader name clash; author engaged and acknowledged security caveats.
- **Sources:** <https://github.com/abi/lilo> · <https://news.ycombinator.com/item?id=47894947> · <https://news.ycombinator.com/item?id=48237730>

### Moltis

**https://github.com/moltis-org/moltis** — Strong and active: 2.8k stars, 340 forks, 3,920+ commits, launched on HN Feb 2026.

Self-hosted personal AI agent server in a single Rust binary (~270K LOC, 59 crates): agent loop with sub-agent delegation, skills with lifecycle hooks, embeddings-powered long-term memory with cross-session recall, voice I/O, MCP, and chat channels for Telegram, Signal, Discord, Slack, Teams, Matrix, and Nostr. Openly OpenClaw-inspired.

- **Overlap with Irises:** Competes for the same self-hoster: multi-channel messaging assistant with memory and delegation, reachable from the apps you already use — engine and front-end in one install, removing the need for a separate voice layer.
- **How it differs:** An engine replacement (an OpenClaw alternative), not a persona layer for one: no personality/affect system, no human-texting simulation, no proactive-outreach voicing — the seam between chat and agent work is not hidden, it IS the agent talking.
- **Community signal:** HN launch: 131 points / 52 comments — praised as 'so polished and... not full of half baked features' and safer-feeling than OpenClaw (Rust, single binary); criticized on prompt-injection risk and self-modifying skills.
- **Sources:** <https://github.com/moltis-org/moltis> · <https://news.ycombinator.com/item?id=46993587> · <https://www.moltis.org>

### ClawLite

**https://github.com/forgesynapseltd/ClawLite** — Nascent: 3 stars, 0 forks, 11 commits, posted July 2026, active but unproven.

Open-source (Apache 2.0) local-first personal AI assistant running as a Telegram bot: Ollama on-device inference with optional Groq fallback, SQLite memory with semantic search, Tavily web search, allowlist sandboxing, scheduled 'Daily Brief' pushes, one-click Windows installer. Python.

- **Overlap with Irises:** Minimal-footprint version of the same idea — private, single-user assistant living in Telegram with persistent memory and a scheduled proactive push.
- **How it differs:** Telegram-only, local-LLM-first (no Anthropic/OpenRouter layer), no persona/affect or texting simulation, no delegation to a heavier engine; far smaller scope.
- **Community signal:** Show HN: 3 points, 0 comments (item 49013033).
- **Sources:** <https://github.com/forgesynapseltd/ClawLite> · <https://news.ycombinator.com/item?id=49013033>

### Martin

**https://trymartin.com** — Active and commercially growing in 2026; venture-backed, marketed to ADHD/high-cognitive-load users; strong App Store ratings.

Commercial 'Jarvis-like' personal AI assistant reachable over SMS/text, phone calls, email, WhatsApp, and Slack: calendar autopilot (CC it on threads to schedule), email auto-drafting/labeling, reminders, wake-up calls, app integrations. #1 Product of the Day on Product Hunt; subscription pricing shown in-app.

- **Overlap with Irises:** Same user promise as Irises's delegation half: text one number and admin work (mail, calendar, reminders) just happens, proactively; multi-channel presence overlaps the channel story.
- **How it differs:** An efficient secretary, not a warm companion — no visible persona/affect layer, no human-like texting theatrics. Fully hosted and closed-source; the agent brain is Martin's own; no self-hosting or provider choice.
- **Community signal:** App Store reviewers call it 'the best ai secretary' and 'like having an extra brain' (quoted on its own site).
- **Sources:** <https://trymartin.com> · <https://www.arlo.sh/compare/best-ai-assistants-you-can-text>

### Catch

**https://www.catchagent.ai/** — Active 2026 commercial product with published pricing, enterprise compliance, 25+ integrations, and an aggressive SEO/comparison content operation.

Commercial proactive AI admin assistant ('Your admin savior'): runs calendar, triages/drafts email, preps meetings, places real outbound phone calls (identifying itself as AI), completes forms. Reachable over Slack, email, WhatsApp, iMessage, text, Google Meet/Zoom, or phone. Deliberately proactive — 'spots problems early', reschedules conflicts itself. Flat $99/month, SOC 2 Type II.

- **Overlap with Irises:** Strongest commercial match for Irises's proactive-outreach behavior: messages first, uses judgment about what to handle vs escalate, lives in channels you already use.
- **How it differs:** Executive-assistant framing for professionals — no companion warmth, no persona/mood engine, no human-texting simulation beyond politeness. Hosted, closed-source, its own agent stack; nothing self-hosted or provider-neutral.
- **Community signal:** Arlo's independent 2026 roundup recommends Catch specifically 'if an assistant that texts first is the feature you want most.'
- **Sources:** <https://www.catchagent.ai/> · <https://www.catchagent.ai/blog/ai-assistants/best-ai-personal-assistants> · <https://www.arlo.sh/compare/best-ai-assistants-you-can-text>

### Colyap

**https://www.colyap.com/** — Early but operational July 2026 (live number, blog, ToS), with a banner noting its iMessage service temporarily down; Show HN got 3 points / 1 comment.

Hosted 'AI friend you can call and text' from Alchemy Labs: a phone number you ring or iMessage with no install; handles tasks ('books the table, moves the appointment, reads the long email, and remembers her birthday'), keeps memory, and proactively texts you when work completes.

- **Overlap with Irises:** Matches Irises's interaction model precisely — text a person-like assistant in a channel you already use, it quietly does the work and messages you back later — the async 'give me a sec' texting pattern as a product.
- **How it differs:** Hosted phone/iMessage service, not self-hosted or open source; no engine-fronting architecture, persona depth, mood engine, or multi-channel bridges; opaque about what runs underneath.
- **Community signal:** Negligible HN traction (item 48870794).
- **Sources:** <https://www.colyap.com/> · <https://news.ycombinator.com/item?id=48870794>

### Praxos

**https://www.praxos.ai/product/mypraxos** — Operational and iterating through 2025-2026 (rebranded to praxos.ai, page updated July 2026, Stripe billing, Discord community); multiple HN posts, each single-digit points.

Commercial personal AI assistant whose tagline is literally 'Text it like a person': lives in iMessage/SMS, WhatsApp, Telegram, Slack, and web; 20+ skills (cash-flow forecasts, Monday briefings, invoice/CRM chores, medication reminders); proactive email/channel monitoring with nudges; QuickBooks, Stripe, Gmail, HubSpot integrations.

- **Overlap with Irises:** Direct competitor for the 'assistant you text like a person, that does real work and reaches out first' promise, across nearly the same channel set.
- **How it differs:** Hosted SaaS aimed at entrepreneurs/business ops, not self-hosted or provider-neutral; no persona/affect layer or human-texting simulation beyond the tagline; vertically integrated service, no engine-in-front architecture.
- **Community signal:** HN Show (7 pts, 11 comments): friendly early-adopter feedback; signup bugs reported and quickly fixed by the founder; WhatsApp/Telegram voice notes confirmed working.
- **Sources:** <https://www.praxos.ai/product/mypraxos> · <https://news.ycombinator.com/item?id=45235224>

## Human-like texting behavior

_Projects whose core focus is the texting choreography itself — pacing, bursts, when-to-speak._

### MaiBot (麦麦, MaiM-with-u)

**https://github.com/MaiM-with-u/MaiBot** — Active: 5.8k stars, 603 forks, 7,156+ commits, stable v1.2.3, Python 3.12+, Docker deploys, bilingual docs. GPL-3.0.

Self-hosted Python 'digital lifeform' chatbot for QQ group chats (multi-platform via adapters) whose design principle is 'more lifelike, not merely better': an independent emotion system, expression learning that mimics group members' slang and speech styles, reads-the-room behavioral planning that picks its moment to speak (including staying silent), emoticon/meme interaction, and a layered psychological-personality memory engine (A-Memorix) that deepens over time. Plugin architecture with APIs and event systems.

- **Overlap with Irises:** The strongest OSS overlap found anywhere with Irises's texting-choreography-plus-hidden-affect combination: human-habit reply style, when-to-speak timing (including silence), emotion state shaping tone, proactive participation, and tiered evolving memory — the 'feels like a person in your chat app' half of Irises, implemented at real community scale.
- **How it differs:** It IS the brain — an own-engine companion, not a voice layer delegating to a separately-run deep-work engine. No assistant capabilities (research/files/mail delegation), group-chat-sociability focus rather than a 1:1 personal assistant, QQ/Chinese-ecosystem-centered, GPL-3.0.
- **Community signal:** Large Chinese-language community (dedicated QQ support and plugin-dev groups); its 'cyber netizen, not a bot' framing anchors a whole wave of lifelike-chatbot projects in the QQ ecosystem — the AstrBot humanization plugins are satellites of this wave. Missed entirely by English-only searching.
- **Sources:** <https://github.com/MaiM-with-u/MaiBot> · <https://docs.mai-mai.org/en/>

### astrbot_plugin_private_companion

**https://github.com/menglimi/astrbot_plugin_private_companion** — 289 stars, 630+ commits, actively maintained in 2026 (requires AstrBot >= 4.22); license not stated in README.

A humanization bundle for AstrBot (60+ features, v6.3.6): continuous persona state that lives its own life (energy, sleep, hunger evolving through the day), a daily life schedule with location transitions, multi-layered emotion (long-term affinity + short-term states with recovery curves), a diary, important dates, lightweight local memory of user preferences, and low-frequency proactive messages filtered through relationship boundaries, availability windows, and token budgets. Segmented message sending with strategic timing.

- **Overlap with Irises:** Feature-for-feature one of the closest matches to Irises's human-feeling layer: persistent hidden mood shaping tone, proactive outreach with quiet-hour-style gating, segmented/paced message delivery, persona continuity, per-user relationship memory — over real messaging channels.
- **How it differs:** A plugin on AstrBot's own chatbot brain, not a voice layer over a separate deep-work engine — no delegation of heavy tasks and no re-voicing. Chinese-first ecosystem; simulated daily-life roleplay goes further than Irises's subtle affect; no layered short/medium/long memory synced with an engine.
- **Community signal:** Listed in the DasterProkio/awesome-ai-companion curated list under humanized companion infrastructure; a satellite of the QQ-ecosystem lifelike-chatbot wave anchored by MaiBot.
- **Sources:** <https://github.com/menglimi/astrbot_plugin_private_companion> · <https://github.com/DasterProkio/awesome-ai-companion>

### astrbot_plugin_proactive_chat

**https://github.com/DBJD-CR/astrbot_plugin_proactive_chat** — 377 stars, 22 forks, AGPL-3.0, stable v1.2.0 with recent WebUI redesign; active in 2026, requires AstrBot 4.22.1+.

AstrBot plugin for bot-initiated conversations in DMs and groups: context-aware message generation from chat history, scheduled triggers with randomized intervals, dynamic emotions, persistent per-session data, do-not-disturb periods, TTS integration, and a standalone WebUI.

- **Overlap with Irises:** Covers Irises's proactive-outreach pillar specifically: engine-initiated contact respecting quiet hours (DND), carrying emotional tone, paced/randomized to feel human rather than cron-mechanical.
- **How it differs:** Single-purpose proactive-messaging plugin: no persistent persona identity, no delegation to a deep-work engine, no texting mechanics beyond initiation timing. The author states the entire plugin was AI-written via iterative prompting.
- **Community signal:** Featured in awesome-ai-companion under 'proactive messaging & background heartbeats'.
- **Sources:** <https://github.com/DBJD-CR/astrbot_plugin_proactive_chat> · <https://github.com/DasterProkio/awesome-ai-companion>

### humanlike-telegram-bot (emqnuele)

**https://github.com/emqnuele/humanlike-telegram-bot** — 2 stars, 0 forks, 8 commits, MIT; dormant — appears finished rather than maintained.

Python Telegram bot on Gemini 2.0 Flash built solely to text like a human: splits replies into multiple short message bubbles on newlines, computes length-based typing delays with random variance while showing 'typing...' status, persona via system_prompt.txt, JSON chat-history memory.

- **Overlap with Irises:** Implements Irises's signature texting mechanics almost feature-for-feature — bubble splitting, dynamic typing simulation with jitter, persona prompt — proof the texting-behavior niche exists independently in the English-speaking OSS world.
- **How it differs:** A weekend-scale toy: Telegram-only, Gemini-only, flat JSON memory, no send-lock/holding messages, no affect engine, no proactive outreach, no engine delegation, no multi-channel — nothing near Irises's scope.
- **Sources:** <https://github.com/emqnuele/humanlike-telegram-bot>

### ascl-bot (UFFCEY)

**https://github.com/UFFCEY/ascl-bot** — 2 stars, 1 fork, 7 commits, MIT, Python 3.8+ — early-stage, little visible activity.

Telegram userbot (runs as your own account) that learns your writing style — vocabulary, tone, emoji usage — and auto-replies as you, with realistic 'typing...' indicators, human-like delays, smart skip logic for group chats, and per-chat preferences. OpenAI API, local processing.

- **Overlap with Irises:** Shares the human-like typing/delay mechanics and the 'texts indistinguishable from a person' goal on Telegram.
- **How it differs:** Inverted purpose: it impersonates the USER to other people rather than being an assistant persona the user talks to; no assistant capability, memory tiers, delegation, or proactive companion behavior; single-channel, tiny.
- **Sources:** <https://github.com/UFFCEY/ascl-bot>

### Sidekicks

**https://sidekicks.chat/** — Active and marketing heavily in 2026 (large SEO blog operation); site blocks automated fetching — details verified via Google-indexed copies of its own pages.

Commercial AI you text over iMessage or SMS with no app — text 'Hello' to a phone number. Multiple switchable personas (Personal Assistant, Health Coach, Wellness Coach, Friend, AI boyfriend/girlfriend), remembers you, and texts first with proactive reminders, check-ins, and follow-ups — marketed as 'texting a real friend who actually pays attention.' Limited free messages; Pro ~$19.99/mo.

- **Overlap with Irises:** Directly overlaps Irises's human-like texting core: proactive first-texts, friend-feel, memory of your life, persona voice, inside a native messaging thread; its Friend+Assistant persona pair is a shallow commercial version of Irises's companion-plus-delegation split.
- **How it differs:** No real agent engine behind it — reminders and check-ins, not deep work (no research, file, or mail delegation). Single-channel (iMessage/SMS, US number), hosted, closed-source, per-persona metering; no memory tiers you control, no affect engine, no self-hosting.
- **Community signal:** Appears in third-party 2026 'best AI texting apps' lists specifically for texting first.
- **Sources:** <https://sidekicks.chat/> · <https://sidekicks.chat/blog/best-ai-texting-apps> · <https://sidekicks.chat/blog/best-ai-sms-chatbot>

## Self-hosted companions

_Persona + memory companions you run yourself; mostly avatar/voice/roleplay-centric._

### Super Agent Party

**https://github.com/heshengtao/super-agent-party** — Active: 2.6k stars, 278 forks, 6,241 commits, v0.4.3, Win/macOS/Linux desktop apps, Docker, docs in 10+ languages, real community (QQ groups, Discord).

Open-source platform explicitly pitched as 'self-hosted Neuro-sama + OpenClaw': wraps an agent engine in a persistent character with VRM/Live2D avatars, SillyTavern character-card import, long-term memory, desktop-companion modes, plugin/MCP skills, one-click IM deployment to QQ, WeChat, Feishu, DingTalk, Telegram, Discord, and Slack, plus livestream bots. Node/Electron + Python, AGPLv3/commercial dual license.

- **Overlap with Irises:** The most direct 'companion front + agent back' structural competitor on GitHub: a warm persona layer over serious agent capability, self-hosted, multi-channel, with memory and configurable personality — the same promise as engine+Irises in one install.
- **How it differs:** Bundles its own agent runtime rather than fronting an engine you already run; persona is expressed visually (3D/Live2D avatars, VTuber/streaming features) rather than through human-like texting behavior — no burst batching, typing pacing, send locks, or holding messages; Chinese-first channels and community; multi-character group chat rather than one warm single-user assistant.
- **Community signal:** No HN presence (Algolia returns zero hits); routinely named alongside AIRI in third-party open-source companion comparisons (questie.ai, agentskill.work).
- **Sources:** <https://github.com/heshengtao/super-agent-party> · <https://www.agentparty.top/index.html> · <https://www.questie.ai/open-source-ai-companion>

### Resonant

**https://github.com/codependentai/resonant** — Early but functional: 50 stars, 12 forks, 86 commits, Apache-2.0, active in 2026; TypeScript monorepo, fail-closed auth, local-first.

Open-source 'relational AI framework' and self-hosted AI partner built directly on the Claude Agent SDK: identity in a hot-reloading markdown file, all memory/embeddings/presence in one local SQLite file, local MiniLM semantic recall, MCP tool servers, and a proactive orchestrator (routines, timers, watchers, condition-based impulses the AI can self-configure). Optional Discord, Telegram, and web-push channels, off by default. Node.js backend + React web chat.

- **Overlap with Irises:** Very close in spirit: a single-user, self-hosted, persistent companion with identity, local memory, proactive impulses, and messaging-channel delivery — built on an Anthropic agent runtime, like Irises's Claude-adjacent stack.
- **How it differs:** Builds the companion directly from the Agent SDK — companion and worker are the same process, so there is no instant-reply persona hiding a slower deep-work engine. No human-like texting simulation, no affect/mood engine, fewer channels, no provider-neutral LLM layer (Claude credentials only).
- **Community signal:** Positions itself against 'stateless per-session' agents; surfaced in 2026 GitHub topic searches for persona/memory companion frameworks.
- **Sources:** <https://github.com/codependentai/resonant> · <https://github.com/codependentai>

### Project AIRI (moeru-ai)

**https://github.com/moeru-ai/airi** — By far the largest project in the space: 48.3k stars, 4.8k forks, 4,266+ commits, MIT, very active through Aug 2026 with regular DevLogs; self-describes as early-stage.

Self-hosted, 'you-owned' AI virtual companion (a Neuro-sama recreation): Live2D/VRM characters with real-time voice chat, speech recognition, multi-provider TTS, in-browser memory (DuckDB WASM/pglite plus experimental Memory Alaya), Telegram and Discord integration, game-playing (Minecraft, Factorio). Browser (WebGPU), Windows, macOS, Linux; 25+ LLM providers via xsAI.

- **Overlap with Irises:** The flagship OSS answer to 'a companion you own': self-hosted, single-owner, persona, memory, and Telegram/Discord presence — the project an Irises prospect will most likely have already starred.
- **How it differs:** Anime-avatar/VTuber embodiment (voice, Live2D, streaming, games) rather than believable text-message presence; no deep-work delegation to an agent engine, no human-like texting mechanics, no proactive mail-triage-style outreach. A cyber-being to hang out with, not a warm assistant that gets work done.
- **Community signal:** Heavily covered (HelloGitHub, byteiota, alternativeto, questie.ai) as the leading open-source AI companion; roundups note it 'crossed 40,000 GitHub stars by mid-2026 — more than most commercial AI tools' and call it 'the one most people mean when they say self-hosted Neuro-sama'.
- **Sources:** <https://github.com/moeru-ai/airi> · <https://hellogithub.com/en/repository/moeru-ai/airi> · <https://byteiota.com/airi-self-hosted-ai-companion-webgpu-voice-chat-minecraft-gaming/> · <https://www.questie.ai/open-source-ai-companion>

### SillyTavern

**https://github.com/SillyTavern/SillyTavern** — Very mature and active: 32.6k stars, 6.1k forks, 11,700+ commits, 300+ contributors, AGPL-3.0, continuous updates through Aug 2026.

The dominant self-hosted 'LLM frontend for power users': character-card persona chat, group chats, WorldInfo/lorebook memory, visual novel mode, image-gen and TTS integration, and a large extension ecosystem, working against virtually any backend (OpenAI, Anthropic, Google, OpenRouter, KoboldAI, local models).

- **Overlap with Irises:** The default OSS choice for 'chat with a persistent persona on my own infrastructure', provider-neutral like Irises; its character-card ecosystem is the largest persona corpus anywhere.
- **How it differs:** A roleplay UI you open in a browser, not an assistant that texts you: no messaging-channel presence, no proactive outreach, no human-like texting behavior, no delegation to a deep-work engine; session-centric and fiction-centric rather than one continuous relationship that does real tasks.
- **Community signal:** Ubiquitous in AI-companion discussions (r/SillyTavernAI is the persona-chat crowd's home); oddly quiet on HN, but referenced as an ecosystem standard by other tools (character-card import in Super Agent Party); whole hosting/guide ecosystems exist around it.
- **Sources:** <https://github.com/SillyTavern/SillyTavern> · <https://sillytavern.app/> · <https://railway.com/deploy/sillytavern-self-hosted-ai-character-chat-frontend--sillytavern-llm-frontend> · <https://theservitor.com/sillytavern-local-llm-setup-guide/>

### Open-LLM-VTuber

**https://github.com/Open-LLM-VTuber/Open-LLM-VTuber** — 13.4k stars, 1.6k forks, 913 commits, MIT (Live2D sample models separately licensed); active, early-stage, v2.0 planned.

Voice-interactive AI companion with a Live2D talking avatar that can run fully offline: hands-free voice with VAD and interruption via echo cancellation, emotion-mapped avatar expressions, transparent desktop-pet mode, swappable ASR/TTS, backends including Ollama, OpenAI-compatible, Claude, Gemini, DeepSeek.

- **Overlap with Irises:** Self-hosted, provider-neutral companion with persona customization, aimed at the same 'AI that feels alive on my machine' audience.
- **How it differs:** Voice/avatar interaction model, not texting; long-term memory currently removed ('coming back soon'); no messaging-channel integration, proactive outreach, or agent-engine delegation.
- **Community signal:** Positive independent reviews as the leading offline voice companion (dev.to, docs.llmvtuber.com ecosystem).
- **Sources:** <https://github.com/Open-LLM-VTuber/Open-LLM-VTuber> · <http://docs.llmvtuber.com/en/docs/intro/> · <https://dev.to/andrew-ooo/open-llm-vtuber-review-offline-ai-companion-with-live2d-327m>

### Synapse-OSS

**https://github.com/UpayanGhosh/Synapse-OSS** — 14 stars, 3 forks, MIT, solo-maintained, 335 Python files with 273+ test suites — substantial but early and low-adoption; active in 2026.

Self-hosted personal AI with hybrid memory (SQLite knowledge graph + LanceDB vectors + FlashRank reranking), an evolving personality profile ('Soul-Brain Sync' refreshed every 50 messages), optional inner-monologue reasoning, privacy routing of sensitive topics to local Ollama, and unified WhatsApp/Telegram/Discord/Slack channels.

- **Overlap with Irises:** Ticks most Irises boxes on paper: self-hosted, multi-channel messaging, layered/graph memory, evolving personality, provider-neutral (OpenAI/Anthropic/Gemini/Ollama), single-user framing.
- **How it differs:** Its own brain — a standalone architecture, not a voice layer delegating to an engine you already run; no human-like texting behavior (splitting, pacing, holding messages), no affect/mood cycle, no proactive engine-cron voicing described. Python vs TypeScript.
- **Sources:** <https://github.com/UpayanGhosh/Synapse-OSS>

### Sentient

**https://github.com/existence-master/Sentient** — Active: 687 stars, 102 forks, 963 commits, recent activity, not archived.

Open-source (AGPL), self-hostable 'proactive' personal assistant/companion: learns preferences, habits, and goals; tiered memory (pgvector/Chroma); proactive calendar and email management; multi-step task automation; 20+ integrations; WhatsApp access alongside web; voice and text.

- **Overlap with Irises:** Overlaps on proactivity (initiates suggestions rather than only answering), personal tiered memory, and self-hosted privacy positioning — the same 'assistant that knows you and reaches out' promise.
- **How it differs:** Autonomy-first framing ('first step towards fully autonomous agents') rather than companionship; no persona voice, mood, or texting-behavior simulation; own agent stack rather than fronting an existing engine; WhatsApp is a secondary channel.
- **Community signal:** Minimal HN traction (Show HN Feb 2025: 3 points, 0 comments).
- **Sources:** <https://github.com/existence-master/Sentient> · <https://news.ycombinator.com/item?id=43142604>

## Memory & companion platforms

_Platforms someone might build an Irises-like layer on instead._

### Letta (formerly MemGPT)

**https://github.com/letta-ai/letta** — 24.4k stars, 2.6k forks, Apache-2.0; active in 2026 but mid-restructure (V1 server archived, development shifted to letta-code) — worth watching.

Platform for stateful agents with advanced self-editing hierarchical memory: persona/human memory blocks, persistent learning across sessions, self-hosted server, desktop/web apps, TypeScript SDK, .af agent-file format with templates (personal assistant, research companion), and Slack/Telegram/Discord integrations. The MemGPT lineage that popularized tiered agent memory.

- **Overlap with Irises:** The memory-companion platform someone would most plausibly build an Irises alternative on: persistent persona blocks + long-term tiered memory + messaging channels, self-hostable and provider-flexible.
- **How it differs:** Developer platform, not a shipped companion: no texting-behavior simulation, no affect engine, no engine-fronting architecture (Letta IS the agent) — the whole voice layer would be DIY. Main repo now serves as a landing page with active development moved to letta-ai/letta-code.
- **Community signal:** MemGPT originally broke out via r/LocalLLaMA memory-agent discussions; awesome-letta curates community projects — companion builds exist but are not the marketed focus.
- **Sources:** <https://github.com/letta-ai/letta> · <https://github.com/letta-ai/awesome-letta> · <https://pypi.org/project/letta/0.5.3>

### Open Souls / Soul Engine

**https://github.com/opensouls/opensouls** — Archived/legacy — 311 stars, 55 forks, MIT, labeled 'Legacy release', last touched Feb 2026, ~3 years functionally stale; the hosted Soul Engine is gone.

The original 'AI Souls' framework — agentic digital beings with personality, drive, ego, memory, and emotion, built around WorkingMemory and CognitiveSteps abstractions on the thesis that LLMs are reasoning machines lacking 'the rest of the mind'.

- **Overlap with Irises:** Pioneered exactly Irises's hidden-internal-state idea: modeled emotion, drive, and goal-setting shaping how the AI speaks, beyond a static system prompt — the closest philosophical precedent to Irises's affect engine.
- **How it differs:** Effectively dead: explicitly a 'Legacy release' historical archive, and it was a developer framework tied to a now-gone hosted Soul Engine, never a self-hosted texting assistant. Its ideas resurface in successors (soul-os, ClawSouls, open-soul).
- **Community signal:** Still name-checked in 2026 persona-framework searches; multiple small successor projects borrow its 'soul' vocabulary.
- **Sources:** <https://github.com/opensouls/opensouls> · <https://opensouls.org> · <https://github.com/mziqudhd92/soul-os>

### Annabelle (withanna.io) / DiffMem

**https://withanna.io** — Live commercial product (trial + subscription, testimonials) as of 2026; DiffMem announced 'in production' on HN March 2026 with modest traction (2 points).

Commercial 'private AI advisor' persona named Annabelle that you text as a contact on WhatsApp, Messenger, or Telegram ($15.99/mo): remembers stories and decisions across weeks/months, asks follow-ups, offers next steps, positions itself as a listener rather than a tool. Built in production on DiffMem, the author's open-source git-based memory system for AI agents.

- **Overlap with Irises:** Same core experience — a warm named persona in your existing chat apps with durable memory and continuity-aware follow-ups. DiffMem is also the kind of memory platform someone might build an Irises-alike on.
- **How it differs:** Hosted and closed vs self-hosted; companionship/reflection only — no delegation to an agent engine for real work; no evidence of typing simulation, affect cycles, or proactive scheduled outreach.
- **Community signal:** Author (alexmrv) presented it on HN as the production proof of DiffMem's git-based memory approach (item 47228509).
- **Sources:** <https://withanna.io> · <https://news.ycombinator.com/item?id=47228509>

## Commercial companion apps

_Hosted consumer products competing for the same "warm AI that texts you" desire._

### Claw Friend (clawf.ai)

**https://clawf.ai/** — Operational in 2026, claims 2,000+ users; rides OpenClaw's momentum. No public launch date.

Hosted SaaS AI companions (girlfriend 'Aria' / boyfriend 'Ethan') explicitly built on OpenClaw: SOUL.md personas, hybrid memory (70% semantic vector + 30% BM25) spanning weeks, proactive engagement with silence-detection check-ins after 2-8 hours, AI-generated selfies (~120/month on Pro), 11+ messaging platforms, access to 13,700+ ClawHub skills. $9.99-$49.99/month.

- **Overlap with Irises:** The closest commercial expression of Irises's pitch in the OpenClaw ecosystem: a warm persona you text like a person on your normal messaging apps, with real memory, proactive outreach, and the OpenClaw engine underneath doing capable work via skills.
- **How it differs:** Fully hosted, multi-tenant, and paid — the opposite of Irises's single-user self-hosted stance; conversations live on the company's servers. Romantic companionship first, assistant second; two fixed characters rather than a user-authored persona; no hidden mood cycles or texting simulation beyond the engine's stock features; locked to their OpenClaw deployment.
- **Community signal:** Becoming the default answer to 'OpenClaw as companion, but I don't want to self-host'; surfaced repeatedly in companion-related OpenClaw searches.
- **Sources:** <https://clawf.ai/>

### Shapes Inc

**https://shapes.inc** — Very active commercially (April 2026 relaunch as a human+AI group-chat social app, $8M seed, 400k MAU, free tier); the open-source shapes-api repo (MIT, 135 stars) is ARCHIVED as of June 14, 2026 — the developer/self-host path is dead.

The largest Discord-native AI-companion platform, now a standalone social app: users create 'Shapes' — AI agents with names, personalities, and memory that builds over time — and drop them into group chats alongside humans on Discord, Telegram, and Shapes' own iOS/Android/web app. Shapes have 'free will': they decide when to message rather than waiting to be summoned. Emerged from stealth April 2026 with an $8M seed (Lightspeed), 400k+ MAU, 3M+ agents created.

- **Overlap with Irises:** Directly overlaps the persona + memory + proactive-outreach + lives-in-your-chat-channel core: a Shape is a warm, named persona you text like a person, with cross-session memory and unprompted first messages — Irises's front-of-house experience at consumer scale.
- **How it differs:** Hosted proprietary brains (50+ models behind their API), no self-hosting and no bring-your-own-engine; group-chat social framing rather than a 1:1 personal assistant; no silent delegation to a deep-work engine — Shapes chat, they don't do your research/files/mail. The open shapes-api that allowed self-integration was archived June 14, 2026, closing that path.
- **Community signal:** TechCrunch (April 29, 2026): 'Meet Shapes, the app bringing humans and AI into the same group chats' — six-fold MAU growth in Q1 2026; press emphasizes 'AI with free will that decides when to message' as the differentiator. Missed by all six original sweep modalities.
- **Sources:** <https://shapes.inc> · <https://github.com/shapesinc/shapes-api> · <https://techcrunch.com/2026/04/29/meet-shapes-the-app-bringing-humans-and-ai-into-the-same-group-chats/>

### Kindroid

**https://kindroid.ai** — Active, mature commercial product in 2026 (1M+ downloads, 22K Play reviews at 3.9 stars, extensive help-center docs); site is a JS app that resists fetching — verified via official App Store / Google Play listings.

Deep-customization commercial AI companion app (iOS/Android, 1M+ Google Play downloads): 'Away proactive' outreach that analyzes conversation patterns to pick outreach timing then sends messages, voice notes, selfies, or calls first; multi-layer 'Cascaded Memory' (short-term, long-term, auto-recorded Learned Context, backstory, journal logs); consistent personality across text/voice/video; quiet hours; texting via iMessage (iPhone) or RCS/Google Messages (Android). Free / Standard $13.99 / Ultra $24.99 / MAX $59.99 per month.

- **Overlap with Irises:** Strongest commercial overlap on the companion mechanics: proactive first-contact with timing awareness, layered memory, persistent persona, quiet hours, and living inside the user's real texting apps. Notable that the market prices 'AI contacts you first' as a $24.99/mo premium feature — behavior Irises gives away as core design.
- **How it differs:** Cloud subscription relationship product: no self-hosting, no user-chosen LLM, and no deep-work delegation — it can't triage mail, research, or touch files; persona depth aims at roleplay/relationship rather than an assistant voice over an agent engine.
- **Community signal:** 2026 reviews consistently rank it top-tier for memory depth and customization; proactive messaging repeatedly cited as the Ultra-tier draw; widely discussed as a top Replika alternative.
- **Sources:** <https://kindroid.ai> · <https://kindroid.ai/docs/article/chat-features-and-tools/> · <https://apps.apple.com/us/app/kindroid-your-personal-ai/id6451038161> · <https://play.google.com/store/apps/details?id=com.kindroid.app&hl=en_US> · <https://mypresio.com/blog/kindroid-review-2026> · <https://weavai.app/blog/en/2026/04/20/kindroid-ai-2026-review-deepest-custom-ai-companion/>

### Nomi.ai

**https://nomi.ai** — Active and highly regarded in 2026 (Aurora architecture / Mind Map 2.0 updates); site blocks automated fetching — verified via official Apple App Store listing.

AI companion app ('AI Companion with a Soul', iOS/Android/web) whose headline feature is memory: a three-layer architecture — short-term (live context), medium-term (recent-weeks summaries), long-term (preferences and life events) — marketed as 'human-level long term memory.' Proactive first messages, voice messages and calls, selfies, group chats with multiple Nomis. Flat $15.99/mo or $99.99/yr, all features included.

- **Overlap with Irises:** Its short/medium/long memory tiering is almost exactly Irises's layered-memory design, commercialized — plus proactive messaging and persistent persona. The closest commercial validation that tiered memory + texting-first is what companion users actually pay for.
- **How it differs:** Companion/roleplay consumer app with no task engine: can't triage mail, research, or touch files; lives in its own app, not your Telegram/WhatsApp/Signal; closed-source and hosted — the celebrated memory is unexportable vendor lock-in; no delegation seam, no provider choice.
- **Community signal:** An 8-months-of-daily-use 2026 review: one of only three platforms worth keeping a subscription for; 'the memory system alone justifies the price'; reviewers call its memory 'the best automated memory system shipping in any companion app.'
- **Sources:** <https://nomi.ai> · <https://apps.apple.com/us/app/nomi-ai-companion-with-a-soul/id6450270929> · <https://aicompanionguides.com/blog/nomi-ai-late-to-party-worth-it/>

### Replika

**https://replika.com** — Very mature and active: 2026 ground-up rebuild, 42M+ users, aggressive subscription tiers. The category incumbent.

The largest AI companion app — 'The AI friend to do life with,' 42.16M users claimed. Rebuilt from the ground up in 2026: long-term memory of your relationships, routines, and concerns, proactive emotional check-ins (asks about your sick cat days later), voice calls, 3D avatars, avatar selfies. iOS/Android plus legacy web; Pro ~$19.99/mo, Ultra ~$29.99/mo, region-varying.

- **Overlap with Irises:** Overlaps the companion half hard: persistent memory of your life, proactive mood check-ins, a persona that feels like a person who knows you — the default commercial answer for users who want warmth more than work.
- **How it differs:** Zero deep-work delegation — no email, research, files, or engine behind it; own-app-only rather than your messaging channels; hosted and closed — memory is theirs (the 2023 ERP-removal episode is the canonical warning about renting your companion); no inspectable affect engine, no self-hosting.
- **Community signal:** 2026 reviews credit its proactive wellness check-ins as a strength while flagging pricing opacity and the trust scar from past feature removals.
- **Sources:** <https://replika.com> · <https://www.eesel.ai/blog/replika-ai-pricing> · <https://mypresio.com/blog/replika-review-2026>

### Pi (Inflection AI)

**https://pi.ai** — Alive but stagnant — 'largely in a maintenance phase' per 2026 coverage; minimal new features since 2024. pi.ai blocks automated fetching; status verified via Google Play listing and 2026 status reviews.

The original 'emotionally intelligent' conversational AI companion (app, web, phone), famous for warm, supportive, human-feeling dialogue. Still online in 2026 but in maintenance mode: after Microsoft hired away Inflection's founders and most staff in 2024, Inflection pivoted to enterprise and Pi's consumer development effectively froze.

- **Overlap with Irises:** Pi defined the warm-companion conversational register Irises aims for — emotionally attuned, non-robotic, personal — and it's free.
- **How it differs:** No task delegation at all — no mail, files, research, or reminders; no proactive outreach, no messaging-app presence (own app/site only), no user-controlled memory, closed-source, and strategically abandoned: a dead-end platform to invest a relationship in.
- **Community signal:** 2026 reviews carry titles like 'What Happened to the Kindest AI?' — affection for the product, resignation about its trajectory.
- **Sources:** <https://pi.ai> · <https://play.google.com/store/apps/details?id=ai.inflection.pi&hl=en_US> · <https://the-oracleai.com/blog/pi-ai-review-2026.html> · <https://www.turingpost.com/p/inflectionai>

### Tolan (Portola)

**https://www.tolans.com** — Very active: launched Feb 2025, 3M+ downloads in months, $30M total raised, featured as an OpenAI case study — one of the hottest companion startups of 2025-2026.

Voice-first AI companion app: an animated alien 'friendly guide through life' that listens, remembers, and is deliberately proactive — raises new topics, shares recommendations, reacts to your photos rather than waiting for you to carry the conversation. Explicitly positioned as NOT pretending to be human. iOS; GPT-5.1-based; 100K+ paid subscribers, 4.8 stars from 160K+ reviews; $20M Series A after ~$12M ARR in four months.

- **Overlap with Irises:** Shares the proactive, emotionally warm, memory-backed daily-companion loop and the 'personality is the product' bet — the fastest-growing 2025-26 proof that consumers pay for a companion that initiates.
- **How it differs:** Philosophically opposite on the axis Irises cares most about: Tolan avoids seeming human (alien character, voice-first app) where Irises maximizes human-feeling texting. No task delegation, no messaging-channel presence, closed and hosted, Gen-Z wellness framing.
- **Community signal:** GeekWire and OpenAI coverage emphasize its growth and proactive-companion design; company survey claims 85.6% of users were helped through emotionally difficult experiences.
- **Sources:** <https://www.tolans.com> · <https://openai.com/index/tolan/> · <https://www.geekwire.com/2025/ai-companionship-app-tolan-raises-20m-to-help-more-people-grow-with-a-virtual-alien-friend/>

### Friend (friend.com)

**https://friend.com** — Commercially active and heavily funded/marketed: Friend 2.0 launched July 30, 2026 ($249); the primary site is a minimal JS shell — verified through July-August 2026 press (Gizmodo, The Gadgeteer, PYMNTS). Widely mocked ad campaign but shipping product.

Avi Schiffmann's AI companion pendant: an always-listening wearable that proactively TEXTS you unprompted observations, jokes, and reactions about your day through its app. Friend 2.0 relaunched July 30, 2026 at $249 with a built-in speaker. Built on Google Gemini; each pendant gets a random, unchangeable persona; optional $10/month extends memory beyond the default 30 days.

- **Overlap with Irises:** The purest commercial embodiment of Irises's proactive-outreach trait: a persistent named persona that texts you first, like a person, with memory of your shared history — the most mainstream 'AI that texts you first' product in existence.
- **How it differs:** Hardware-bound and cloud-hosted (no self-hosting, no BYO engine); ambient-listening companionship with zero assistant/delegation capability; persona is randomly assigned and locked — the opposite of Irises's configurable voice; memory is a paid add-on capped by subscription rather than layered local tiers.
- **Community signal:** Gizmodo (2026) coverage notes its defining behavior is sending unprompted texts based on what it overhears, and that its subway ad campaign drew 'surveillance capitalism' vandalism — strong mainstream awareness of the 'AI that texts you first' category.
- **Sources:** <https://friend.com> · <https://gizmodo.com/friend-is-back-with-a-new-ai-pendant-and-its-marketing-is-more-depressing-than-ever-2000793089> · <https://the-gadgeteer.com/2026/07/31/friend-ai-pendant-voice-wearable-249-price/>

### Kin (mykin.ai)

**https://mykin.ai** — Active consumer product: iOS App Store, 60,000+ installs, 5M+ messages exchanged, 4.8-star rating (per its own site, Aug 2026). Pricing not published on the landing page.

Privacy-first ('private by design') personal AI companion app positioning itself as 'AI that actually knows you': persistent evolving memory across conversations, a five-advisor 'Advisory Board' (work, relationships, values, body, social confidence), guided sessions, voice, journaling, and proactive Insights that surface recurring patterns and blind spots.

- **Overlap with Irises:** Overlaps the memory-companion core: a single persistent persona with deep longitudinal memory of one user, plus proactive pattern-surfacing. Its privacy-by-design pitch targets the same user motivation that drives people to self-host Irises.
- **How it differs:** Hosted mobile app, not self-hosted, no BYO engine; life-coach/advisor framing rather than a texting assistant; lives in its own app rather than the user's messaging channels; no work delegation, no human-like texting simulation.
- **Sources:** <https://mykin.ai>

### Dot (New Computer) — DEFUNCT

**https://new.computer** — Dead. Wind-down announced fall 2024, service ended; the site still shows only the farewell page as of Aug 2026.

Was the most-praised 'personal AI that grows with you' — a warm, memory-rich companion/assistant hybrid with proactive check-ins, widely cited as the taste benchmark for humane personal AI. The company wound down (founder split over product direction); the site today is a farewell notice that let users export data until an October 5 cutoff.

- **Overlap with Irises:** Arguably the design north star for the Irises category — proactive, warm, memory-first personal AI. Its users are exactly the displaced audience a self-hosted persona layer can pitch to.
- **How it differs:** It no longer exists — and its death is the argument for Irises's architecture: a hosted companion can vanish with your relationship and memories; a self-hosted MIT-licensed layer on your own engine cannot be shut down by anyone else.
- **Community signal:** The shutdown page acknowledges users formed genuine attachments; the wind-down was widely discussed as a cautionary tale for hosted companions.
- **Sources:** <https://new.computer>

## Adjacent

_Not alternatives per se, but shape the same market._

### elizaOS

**https://github.com/elizaOS/eliza** — 19.1k stars, 5.7k forks, ~19k commits, MIT, very active in 2026 (v2 cycle, 1,350+ contributors claimed).

Open-source TypeScript 'agentic operating system': character-file personas, 90+ official / 200+ community plugins, agents keeping a consistent persona across Discord, Telegram, X, Slack, and Farcaster, memory/state primitives in @elizaos/core, web/desktop/mobile app, CLI, and non-custodial EVM/Solana wallet operations.

- **Overlap with Irises:** Persistent personality + memory + multi-platform messaging presence from one self-hosted runtime — one of the most-starred ways to get 'my own named AI on Telegram/Discord'; a builder could assemble an Irises-like assistant from it.
- **How it differs:** A general agent framework with strong crypto/trading DNA, not a finished warm companion: static character files with no affect/mood engine, no human-texting simulation, no quiet-hours proactive companionship, and no front-end/engine split — the Eliza agent is itself the brain.
- **Community signal:** Large ecosystem and press (Gate Learn, Solana Compass, Reforge), though discussion centers on crypto agents rather than companions.
- **Sources:** <https://github.com/elizaOS/eliza> · <https://docs.elizaos.ai/> · <https://www.gate.com/learn/articles/eliza-os-v2-upgrade-how-ai-agents-evolve-from-simple-automation-to-full-autonomy/7898>

### nanobot (HKUDS)

**https://github.com/HKUDS/nanobot** — Extremely active and popular: 47.3k stars, 8.4k forks, MIT, v0.2.0 May 2026, last update July 24, 2026.

Ultra-lightweight, MIT, self-hosted personal AI agent framework in Python, positioned as a small-core successor-in-spirit to OpenClaw: unified gateway into Telegram, Discord, WeChat, Slack, Email, Mattermost, Teams, and Feishu; long-term memory ('Dream' session-history system); tools (files, shell, web, MCP, cron, subagents); WebUI/TUI/OpenAI-compatible API.

- **Overlap with Irises:** The 'stock engine used bare' alternative at massive scale: run nanobot directly in your chat apps and get multi-channel reach, memory, and cron-driven proactivity without any persona layer. Its roadmap discussion #431 ('Toward an Open-Source Personal Agent Companion') signals the engine intends to absorb companion traits natively.
- **How it differs:** An agent brain/runtime, not a voice layer: pragmatic task-automation framing, no persona consistency, no human-like texting simulation, no affect engine, no seam-hiding re-voicing. It competes with Irises's substrate (hermes-agent/OpenClaw), and only prospectively with Irises itself if the companion roadmap materializes.
- **Community signal:** GitHub Discussion #431 shows maintainers and community explicitly steering a bare engine toward the companion niche — fresh evidence of engine-absorbs-the-layer pressure.
- **Sources:** <https://github.com/HKUDS/nanobot> · <https://github.com/HKUDS/nanobot/discussions/431>

### Eve (eve.new)

**https://eve.new** — Live with free credits as of April 2026; commercial backing; notable HN launch.

Managed-OpenClaw commercial service: each user gets an isolated Linux sandbox (2 vCPU/4GB, headless Chrome, code execution, 1000+ connectors) with an orchestrator routing tasks to domain-specific models; work assigned via web or iMessage; positioned as a 'helpful colleague' you can text.

- **Overlap with Irises:** The buy-instead-of-build path: OpenClaw-class capability reachable from iMessage without running anything — a prospect choosing Eve never needs a self-hosted persona layer.
- **How it differs:** Managed cloud vs self-hosted; colleague/work framing with no warm persona, memory tiers, affect, or texting simulation; iMessage only vs Irises's seven channels; trust model is the opposite of Irises's local-first pitch — which HN commenters hammered.
- **Community signal:** 72 points / 40 comments on HN: praise like 'a 140-IQ analyst you can text please fix at 3:00 AM' vs sharp privacy pushback, prompt-injection worries, and users defacing its hosted pages.
- **Sources:** <https://eve.new> · <https://news.ycombinator.com/item?id=47721255>

### Personal AI (personal.ai) — pivoted away

**https://www.personal.ai** — Company active and well-funded, but the consumer product is gone; fully enterprise/carrier-focused as of 2026.

Formerly a consumer 'train an AI on your own messages/memory' personal-AI product; now 'The AI Memory Platform' sold to enterprises and telecom carriers — MODEL-4 deployed on carrier networks, Verizon/AT&T/T-Mobile/Microsoft/NVIDIA logos, no published pricing, 'Book a Carrier Briefing' CTAs.

- **Overlap with Irises:** Only historical: it pioneered the personal-memory-AI pitch that overlaps Irises's memory-plus-persona idea.
- **How it differs:** No longer purchasable by an individual — B2B/carrier enterprise sales only; an Irises prospect evaluating it in 2026 bounces off a 'Talk to Sales' wall. Effectively removed from the consumer alternative set.
- **Sources:** <https://www.personal.ai> · <https://www.personal.ai/pricing>


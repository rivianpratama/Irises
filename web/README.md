# Irises

Irises is a private, bring-your-own-key humane chat and liaison. Irises responds only
after the user sends a message and can return one to four validated chat
bubbles per turn.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, choose a provider, then add the matching API key
in Settings. Supported providers are OpenAI, Anthropic, Google, DeepSeek, GLM,
Kimi, MiniMax, Qwen, and custom OpenAI-compatible endpoints.

Each provider can optionally use a custom API endpoint and custom model ID.
Custom endpoints keep the selected provider's wire protocol. Remote endpoints
must use HTTPS; loopback development endpoints may use HTTP.

`Custom / 9Router` defaults to `http://localhost:20128/v1` with model
`kr/claude-sonnet-4.5`. Its endpoint and model ID remain editable in Settings.

Irises keeps one continuous local thread. The prompt console shows the provider
request payload, exposed thinking/reasoning content, and parsed provider
response chunks. Credentials, headers, URL query parameters, and HTTP/SSE
framing are not included.

## Conversation behavior

Irises uses the latest five user messages as evidence for language, register,
urgency, brevity, and sensitive-topic support mode. Explicit guidance in the
current message takes priority, and Irises does not inject preset slang or
language-specific vocabulary. Durable persona changes still require repeated
evidence or an explicit preference.

Older conversation is compacted into source-linked memory nodes and narrative
threads. The current request selects the most relevant nodes while preserving
precise identifiers, dates, URLs, decisions, and source message IDs.

For missing low-impact preferences, Irises uses reversible defaults and keeps
moving. Consequential actions still require confirmation. When a provider or
external system is unavailable, Irises explains the failure category and recovery
step without claiming that an action succeeded.

## OpenClaw liaison

OpenClaw is optional. Enable it in Settings, enter a loopback Gateway URL such
as `ws://127.0.0.1:18789`, and provide a pairing token. Remote Gateways must use
`wss://`. After pairing, Irises stores the device token in this browser and clears
the bootstrap token.

Connected turns are classified as direct conversation or external execution.
Irises sends OpenClaw one typed objective with an idempotency key and uses one
dedicated Gateway session per local thread. Local fallback history is never
replayed into that session. OpenClaw remains responsible for agents, tools,
sandboxing, execution policy, and task memory.

Exec and plugin approvals display the exact reviewed payload. Irises sends only
the original approval ID and the selected decision. A dropped connection is
observed through the existing session after reconnect; Irises does not submit the
objective again. Successful, failed, cancelled, and interrupted results are
synthesized into Irises's voice without changing their factual status.

## Adaptive documents

Irises publishes baseline templates at `/PERSONA.md`, `/ARCHETYPE.md`, and
`/JOURNAL.md`. After each completed turn, a separate reflection request may
update only Irises's allowed adaptive behavior lines, revisable user hypotheses,
and a rolling journal organized by 1-hour, 3-hour, 12-hour, 24-hour, and 7-day
windows with high, medium, and low importance.

Live documents are visible and downloadable from the Documents panel. On a
single-user Node.js deployment they are stored under the ignored `.irises/`
directory. The browser retains a complete fallback copy when server files are
unavailable. Clearing the thread also resets learned context.

## Data and keys

- Provider keys, settings, the thread, and memory summaries are stored in
  versioned browser `localStorage`.
- Gateway URLs, paired device tokens, dedicated session keys, and bounded
  delegation records are also stored in browser `localStorage`. Pairing requests
  only `operator.read`, `operator.write`, and `operator.approvals`.
- Adaptive documents may contain inferred preferences and conversation
  summaries. They are private live state, not the public baseline templates.
- Server document storage is designed for one trusted user. Do not expose one
  deployment to multiple users without adding authentication and per-user
  isolation.
- Keys are sent in a private request header only to Irises's stateless API route,
  which creates the selected provider client for chat, memory, and reflection
  requests.
- API responses use `no-store`. The server does not log request headers,
  prompts, messages, or provider responses.
- Browser storage is readable by scripts on the same origin. Irises states this
  limitation in Settings and provides clear-key and clear-all controls.

## Verification

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

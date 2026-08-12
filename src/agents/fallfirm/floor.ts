// The irreducible floor — the ONLY hardcoded user-facing copy left in the codebase.
//
// Fallfirm (client.ts) re-voices every failure and confirmation through the LLM so the user never
// sees dev copy. But Fallfirm is itself an LLM call, and "never go silent" is absolute — so when even
// Fallfirm's call throws or comes back empty (provider down, timeout), we still have to say SOMETHING.
// That backup-to-the-backup lives here: a tiny, generic, in-character line per outcome kind, all in
// one audited place. If you're adding a hardcoded user-facing string anywhere else, don't — route it
// through voiceOutcome() instead. Output is the legacy `\n---\n` bubble wire format the send path
// consumes; the per-bubble guardrails (redactInternalTools / stripOpsScaffolding) still run downstream.

import { pick } from '../textVariants.js';
import type { TaskKind } from '../types.js';

/** What happened, from the user's point of view — the thing Fallfirm (or this floor) must relay. */
export type OutcomeKind = 'confirmed' | 'failed' | 'needs_auth' | 'nothing_found';

export interface Outcome {
  kind: OutcomeKind;
  /** Plain description of what happened, for Fallfirm to VOICE (never shown to the user verbatim). */
  summary: string;
  /** Hard facts that must be relayed EXACTLY if voiced (a time, an amount) — fidelity. */
  facts?: string;
  /** A read-only consent URL, relayed verbatim on its own line (needs_auth). */
  consentUrl?: string;
  /** Optional steer for the failure ("ask them for the timing again"). */
  nextStep?: string;
  /** What the user originally asked, for seamless continuity. */
  originalRequest?: string;
}

/**
 * Last-resort line for when Fallfirm's own LLM call fails. Generic and in-voice; carries the one
 * fidelity-critical datum (the consent URL) but never fabricates specifics. Returns legacy bubble text.
 */
export function fallfirmFloor(o: Outcome): string {
  switch (o.kind) {
    case 'confirmed':
      return o.facts ? `done 👍\n---\n${o.facts}` : 'done 👍';
    case 'needs_auth':
      return o.consentUrl
        ? `that one needs your gmail\n---\ntap to connect, read-only:\n${o.consentUrl}`
        : 'that one needs your gmail connected first';
    case 'nothing_found':
      return "couldn't track that one down\n---\ni can come at it another way though";
    case 'failed':
    default:
      return "hit a snag on that just now\n---\ngive me a nudge in a bit and i'll sort it";
  }
}

// ── Static command reference (deterministic, deliberately NOT voiced) ─────────────────────────
// `/help` is a fixed reference card, not a failure or confirmation, so it does NOT route through
// voiceOutcome: Fallfirm's anchor is told to "never name a tool, a system," but the whole point of
// this text is to expose the slash-commands verbatim. It's hardcoded user-facing copy, so it lives
// HERE — the one audited home for such copy — rather than inline in convo/client.ts. One bubble
// (internal newlines, no `---` splits). Keep the command names byte-exact with the real handlers.
export function helpText(): string {
  return [
    'commands:',
    '/clear - reset our conversation',
    '/forget me - erase what i know about you',
    '/help - this message',
  ].join('\n');
}

// ── Instant progress/reassurance floor (no model turn to voice it) ────────────────────────────
// These are sent the INSTANT Convo delegates but wrote no line of its own (rare — the model normally
// writes one), or mid-run. Unlike a failure/confirmation, they precede a background Ops run and must
// go out immediately, so — like the long-wait heartbeat — they are NOT routed through Fallfirm's model
// call (that latency would defeat the reassurance). Centralized here so no instant copy is scattered.
//
// Every line below is a small POOL, not a single string — one hardcoded phrase repeated verbatim
// across a conversation reads like a bot. `pick()` (textVariants.ts) picks a variant at random each
// call; nobody awaits or persists which ones already fired, so this stays a synchronous, zero-latency
// lookup, same as before.

const HOLDING: Partial<Record<TaskKind, readonly string[]>> = {
  web_research: ['looking that up now', 'digging into that, one sec', 'checking on that, hang on'],
  document_read: ['checking your inbox, one sec', 'searching your email now', 'digging through your inbox, hang on'],
  draft: ['drafting that now', 'writing that up now', 'putting that draft together'],
  // MM read — deliberately a tiny human beat (not a "pulling records" line), matching the minimal
  // holding register for a media delegation. Fallback-only; the LLM voicer usually writes its own.
  media_read: ['one sec, looking at that', 'lemme open this up', 'taking a look at that now'],
};

const HOLDING_DEFAULT: readonly string[] = ['on it, give me a sec', 'on it, one sec', 'give me a sec on that'];

/** Instant holding line when the model delegated without writing one. */
export function holdingFloor(kind: TaskKind): string {
  return pick(HOLDING[kind] ?? HOLDING_DEFAULT);
}

const STILL_ON_IT_POOL: readonly string[] = ['still on that, hang tight', 'still working on that one', 'still on it, one sec more'];

/** Instant "still working" reassurance when a duplicate delegation was suppressed (nothing new to pull). */
export function stillOnItText(): string {
  return pick(STILL_ON_IT_POOL);
}

const GMAIL_CONNECT_POOL: readonly string[] = [
  'tap the link to connect your gmail (read-only) and i can dig in',
  'connect your gmail there, read-only, and i can get into it',
  "that link connects your gmail, read-only, then i'm in",
];

/** Instant prompt when a consent link was generated but the model wrote no text of its own. */
export function gmailConnectPrompt(): string {
  return pick(GMAIL_CONNECT_POOL);
}

// Plain, no-context heartbeat variants — used when the task carries no address/deal hint, or on the
// (roughly 40%) rolls that skip the hint even when one's available, so leaning on the hint never
// becomes its own predictable pattern.
const HEARTBEAT_GENERIC: readonly string[] = [
  "still on it, this one's a bigger pull",
  "still digging, this one's taking a bit longer",
  "not done yet, there's more to this one than usual",
  'still working through it, hang tight',
  "give me a bit more, this one's got some layers",
];

// Hint-aware variants — used when the task names an address/deal, so the reassurance names the
// actual thing it's stuck on instead of a generic "it".
const HEARTBEAT_WITH_HINT: readonly ((hint: string) => string)[] = [
  hint => `still digging on ${hint}, bigger pull than usual`,
  hint => `${hint}'s turning out to be a bigger pull`,
  hint => `still on ${hint}, taking a little longer than usual`,
  hint => `more to dig through on ${hint} than i expected`,
];

interface HeartbeatHint { addressHint?: string; dealHint?: string }

/** The one long-wait heartbeat, fired by a timer mid-Ops-run (progress, not a failure/confirmation).
 *  Picks a fresh variant each call, and leans on the task's address/deal hint when there is one so
 *  it names what it's actually stuck on instead of reading as one fixed canned line. */
export function heartbeatText(task?: HeartbeatHint): string {
  const hint = task?.addressHint || task?.dealHint;
  if (hint && Math.random() < 0.6) return pick(HEARTBEAT_WITH_HINT)(hint);
  return pick(HEARTBEAT_GENERIC);
}

// "Taking a harder look" beat — sent when a first Ops pass came up short and the orchestrator kicks
// off a second, deeper look. Frames it as thoroughness, never as a failure (the user never learns a
// pass came up empty). Hint-aware like the heartbeat so it names the actual thing when there is one.
const DEEPER_LOOK_GENERIC: readonly string[] = [
  "this one's taking more digging than usual, staying on it",
  'taking a closer look at this one, hang tight',
  'going a little deeper on this one, give me a bit',
  "still on it, this one needs a closer look",
];
const DEEPER_LOOK_WITH_HINT: readonly ((hint: string) => string)[] = [
  hint => `taking a closer look at ${hint}, hang tight`,
  hint => `going a bit deeper on ${hint}, give me a sec`,
  hint => `${hint}'s taking more digging than usual, staying on it`,
];

/** Floor for the deeper-look ping fired when a first Ops pass came up short and a second look starts. */
export function deeperLookText(task?: HeartbeatHint): string {
  const hint = task?.addressHint || task?.dealHint;
  if (hint && Math.random() < 0.6) return pick(DEEPER_LOOK_WITH_HINT)(hint);
  return pick(DEEPER_LOOK_GENERIC);
}

/** Label floor for the whimsical text that accompanies an iMessage effect, when the tiny classifier
 *  that writes it fails. Mostly the effect's own name — no model turn worth spending on the fallback. */
export const effectLabelFloor = (effectName: string): string => `${effectName}!`;

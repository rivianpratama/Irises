// One-time engine-mode onboarding. The standing doctrine (openclawDoctrine.ts) is delivered to the
// engine ONCE per content version, as a chat message the engine appends to its own persistent
// instructions by its own hand — Irises never edits engine files. Only OpenClaw has an automatic
// path: the gateway's `agent` RPC gives a reply we can wait on ("OK when it's saved"), where hermes's
// send stays the documented manual step (bridge/hermes/engine-onboarding-message.md).
//
//   $IRISES_HOME/engine-onboarding.json
//   { openclaw: { version, sentAt, reply } }
//
// The stored version IS the guard, and it is the doctrine's content hash: editing one word re-onboards
// on the next boot, an unchanged doctrine never sends twice, and a lost file costs one duplicate
// message (the adapter's version-keyed idempotencyKey usually absorbs even that).

import fs from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText, readTextIfExists } from '../../db/files.js';
import { irisesHome } from '../../db/stateDir.js';
import { record } from '../../diagnostics/trace.js';
import { reportError } from '../../diagnostics/errorLog.js';
import { getEngineBackend, withEngineSlot } from './engineBackend.js';
import type { EngineBackend } from './engineBackend.js';
import { OPENCLAW_ONBOARDING_MESSAGE, onboardingVersion } from './openclawDoctrine.js';

export interface OnboardingRecord {
  version: string;
  sentAt: number;
  /** The engine's own answer, capped — kept so an operator can see it actually said it saved. */
  reply?: string;
}

export interface OnboardingState {
  openclaw?: OnboardingRecord;
}

/** Injectable impure edges — the repo's DI testing convention (no module mocks). */
export interface OnboardingDeps {
  getEngine: () => EngineBackend | null;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { unref?: () => void };
}
const realDeps: OnboardingDeps = { getEngine: getEngineBackend, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms) };

// Retries for the ordinary boot race — Irises and the gateway start together, so the first send can
// meet a socket that isn't listening yet. Three rungs, then silence until the next boot: onboarding
// is not urgent (every task carries the header restating the essentials), and a wedged gateway must
// not turn into an endless background dial.
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

// One attempt chain per process — the retries live INSIDE the chain, so a second caller (a re-entrant
// boot path, a test) must not start a parallel ladder against the same engine.
let chainStarted = false;

function statePath(): string {
  return join(irisesHome(), 'engine-onboarding.json');
}

/** Lenient load — a missing or corrupt file yields an empty state, never a throw. */
export function loadOnboardingState(): OnboardingState {
  try {
    const raw = readTextIfExists(statePath());
    if (!raw) return {};
    const o = JSON.parse(raw) as OnboardingState;
    const rec = o?.openclaw;
    if (!rec || typeof rec.version !== 'string') return {};
    return { openclaw: { version: rec.version, sentAt: typeof rec.sentAt === 'number' ? rec.sentAt : 0, reply: typeof rec.reply === 'string' ? rec.reply : undefined } };
  } catch {
    return {};
  }
}

/** Best-effort persist — never throws. A lost write costs one duplicate send, never a failed boot. */
export function saveOnboardingState(s: OnboardingState): void {
  try {
    atomicWriteText(statePath(), JSON.stringify(s, null, 2) + '\n');
  } catch (err) {
    console.warn('[engine] could not persist engine-onboarding.json:', (err as Error)?.message ?? err);
  }
}

/**
 * One send. Success writes the flag and ends the chain; failure arms the next rung and returns. Never
 * rejects — this runs fire-and-forget from boot, so a snag here must not become an unhandled rejection.
 */
async function attempt(engine: EngineBackend, version: string, deps: OnboardingDeps, rung: number): Promise<void> {
  try {
    // The doctrine is a full agent run, so it queues behind the same semaphore as delegated work: a
    // boot-time send must never take a slot a waiting user turn needs.
    const reply = await withEngineSlot(() => engine.sendOnboarding!(OPENCLAW_ONBOARDING_MESSAGE, version));
    saveOnboardingState({ openclaw: { version, sentAt: deps.now(), reply: reply.slice(0, 200) } });
    record({ type: 'event', label: 'engine:openclaw:onboarded', detail: { version, attempt: rung + 1, reply: reply.slice(0, 200) } });
  } catch (err) {
    const next = RETRY_DELAYS_MS[rung];
    reportError({
      source: 'ops', category: 'engine_onboarding', severity: 'warn', err,
      detail: { version, attempt: rung + 1, retryInMs: next ?? null },
    });
    if (next === undefined) return; // ladder spent — the next boot tries again
    const timer = deps.setTimer(() => { void attempt(engine, version, deps, rung + 1); }, next);
    timer.unref?.();               // onboarding never keeps the process alive
  }
}

/**
 * Send the doctrine if this engine needs it. Called once at boot, fire-and-forget: it never rejects,
 * and every gate below is a plain no-op (an unconfigured engine, hermes, an already-current version,
 * ENGINE_ONBOARDING=off for an operator who curates the engine's instructions by hand).
 */
export async function ensureEngineOnboarded(deps: Partial<OnboardingDeps> = {}): Promise<void> {
  const d = { ...realDeps, ...deps };
  if ((process.env.ENGINE_ONBOARDING || '').toLowerCase() === 'off') return;
  if (chainStarted) return;
  const engine = d.getEngine();
  if (engine?.name !== 'openclaw' || !engine.sendOnboarding) return;
  const version = onboardingVersion();
  if (loadOnboardingState().openclaw?.version === version) return;
  chainStarted = true;
  await attempt(engine, version, d, 0);
}

/** Exported for unit tests — back to a never-onboarded install (no state file at all). */
export function _resetOnboardingForTests(): void {
  chainStarted = false;
  try { fs.rmSync(statePath(), { force: true }); } catch { /* best-effort */ }
}

// Durable per-agent memory: a living markdown dossier + structured prefs. Assembled
// into the Convo agent's prompt each turn, and refreshed asynchronously after replies.
// (Convo controls Ops, so the dossier only needs to live in Convo; Convo passes
// relevant slices to Ops via meta-prompts.)
import { callLLM } from '../llm/callLLM.js';
import { getMemory, saveDossier, getForgetEpoch } from '../db/repositories/memory.js';
import { getUserProfile } from '../db/repositories/profiles.js';
import { listShortTerm, SHORT_TTL_MS, type ShortTermEntry } from '../db/repositories/memoryShort.js';
import { getLongDoc, saveLongDoc } from '../db/repositories/memoryLong.js';
import { loadMediumBundle, type MediumBundle } from './mediumTerm.js';
import {
  LEGACY_FACT_PROV, PROVENANCE_LINE, SEED_FACT_KEY, provenanceEnabled,
} from './provenance.js';
import { PENDING_EMAIL_TTL_MS } from './shortTerm.js';
import { splitStamp } from './dossierEdits.js';
import {
  renderUserMemoryWithHot, sanitizeLongDoc, splitSections, profileIsThin,
  type MemoryAudience, type UserMemoryData,
} from './wrappers.js';
import type { CraftTurnFacts } from '../agents/convo/personaModules.js';
import { renderTenureBlock, formatAgo } from './tenure.js';
import { sanitizeDirectives } from './preferences.js';
import { buildTurnRelevance, memoryRelevanceEnabled, type TurnRelevance } from './relevance.js';
import type { MemoryGateReason, MemoryGateReport, MemoryGateReports } from '../diagnostics/turnTrace.js';
import { scopeHistoryToUser } from './transcript.js';
import { isGroupHandle } from './identity.js';
import { record } from '../diagnostics/trace.js';
import { reportError } from '../diagnostics/errorLog.js';
import type { StoredMessage, UserProfile } from '../db/types.js';

// stripScopeSections now lives in userContext.ts (so the shared renderer can reuse it without a
// circular import). Re-exported here to keep the historical import path stable. Same for the
// short-tier TTLs, which moved to shortTerm.ts with their renderers.
export { stripScopeSections } from './userContext.js';
export { RECENT_RESEARCH_TTL_MS, RECENT_RESEARCH_MAX_CHARS, PENDING_EMAIL_TTL_MS } from './shortTerm.js';
// The coarse relationship clock moved to tenure.ts, where the identity card can reach it without
// closing a cycle (wrappers.ts imports it, and dossier.ts imports wrappers.ts). Same re-export
// pattern: climateDrift.ts imports formatDaySpan from here.
export { formatDaySpan } from './tenure.js';

const THROTTLE_MS = 2 * 60 * 1000; // refresh a dossier at most this often
const lastUpdate = new Map<string, number>();
// The rewrite is a FULL-document merge, so the cap has to fit the whole ~400-word dossier plus
// whatever is being merged in — a cut-off reply is a truncated document, not a shorter one
// (see dossierUpdateUsable).
const DOSSIER_MAX_TOKENS = 900;

// How long a "Irises asked a steering question after a thin look" marker stays live. The agent's
// reply within this window is treated as the answer to that question (Convo re-delegates a refined
// second look). Exported so the Convo delegate path computes the same freshness/attempt bump.
// Stays a prefs marker (not a memory tier): it is latest-only control flow with clear-on-condition
// semantics, not memory.
export const PENDING_CLARIFICATION_TTL_MS = 30 * 60 * 1000;

interface RecentResearch { request?: string; kind?: string; summary?: string; at?: number }
export interface PendingClarificationCtx { request?: string; kind?: string; attempt?: number; at?: number; missingFields?: string[] }

/** Below this many salient tokens the turn is too thin to read as a topic change, so the steering
 *  question stands. An ack, a one-word answer and a caption-less media turn all land here — the
 *  fail-open direction, because the cost of keeping the marker one turn too long is a re-run look
 *  and the cost of dropping it too early is answering a narrowed ask from memory. */
export const CLARIFICATION_THIN_TURN_TOKENS = 8;

/**
 * Does the steering question she just asked still stand? PURE — `now` is injected and the turn's
 * verdict is already computed.
 *
 * It used to stand on the TTL alone, and thirty minutes is a long time in a text thread: they can
 * answer it, move on, and ask two new things well inside the window, and every one of those turns
 * was read as "them narrowing THAT ask". The clock still has the first word; then the turn has to
 * be about it, or be too thin to tell.
 *
 * `report` is null with no router — no gate ran, so the receipt claims nothing.
 */
export function gatePendingClarification(
  pc: PendingClarificationCtx | undefined,
  nowMs: number,
  turn: TurnRelevance | null,
): { keep: boolean; report: MemoryGateReport | null } {
  // One shape for every answer, so "no router → no receipt" cannot be forgotten on a branch.
  const decide = (keep: boolean, reason: MemoryGateReason) => ({
    keep,
    report: turn ? { verdict: keep ? 'full' as const : 'dropped' as const, reason } : null,
  });
  if (!pc?.request || typeof pc.at !== 'number') return decide(false, 'nothing_held');
  if (nowMs - pc.at > PENDING_CLARIFICATION_TTL_MS) return decide(false, 'ttl_expired');
  if (!turn) return decide(true, 'all_kept');
  // `no_touch` on the empty turn deliberately: the fail-open lives in the thin-turn branch below, so
  // a turn the router could not read is reported as what it is rather than as a match it never made.
  if (turn.touches(pc.request, 'no_touch')) return decide(true, 'all_kept');
  if (turn.tokens.size < CLARIFICATION_THIN_TURN_TOKENS) return decide(true, 'short_turn');
  return decide(false, 'none_kept');
}

/**
 * The steering-question section: a recent look came back thin, she asked them to narrow it down
 * instead of telling them it was thin, and their next message is almost certainly the answer.
 *
 * Its own function because it is the ONE plain section a routed context block still carries — the
 * tenure section folded into the identity card in P2 — which makes it the only thing keeping
 * `context_block` and `memory_stack` two measurements rather than two ceilings over one string. The
 * ratchet (convo/promptBudget.test.ts) measures it through here rather than through a mirror of it:
 * the hand-written tenure mirror that used to sit in that file had drifted from the real renderer by
 * the time anyone looked.
 */
export function renderPendingClarification(pc: PendingClarificationCtx): string {
  const asked = pc.missingFields?.length ? `\nYou specifically asked them for: ${pc.missingFields.join('; ')}.` : '';
  return `## You just asked them to narrow something down (their next reply likely answers it)\nA recent look at "${pc.request}" came back thin, so you asked them a quick steering question instead of telling them.${asked}\nWhen they reply, treat it as them narrowing THAT ask. delegate_to_ops again with the original ask plus what they just clarified, combined. Do NOT answer it from memory, and do NOT treat it as a brand-new topic. If they clearly changed the subject instead, handle the new thing normally.`;
}

/** The clock both of Convo's outstanding asks run on — the steering question above and the approval
 *  ask below. ONE constant, aliased rather than copied: a user who has been waiting thirty minutes
 *  for either has moved on, and two numbers here would eventually disagree about that. */
export const PENDING_ASK_TTL_MS = PENDING_CLARIFICATION_TTL_MS;

export interface PendingApprovalCtx { taskId?: string; request?: string; kind?: string; askedAt?: number }

/**
 * Is the approval ask she just made still live? PURE — `now` is injected.
 *
 * NO TOPIC GATE, and that is the deliberate difference from the steering question above: a bare
 * "yes" or "go" carries no salient token any relevance router could match against the action, so a
 * turn-relevance gate here would drop the section on exactly the reply it exists for. The clock has
 * the only word, and thirty minutes is short enough that a stale ask retires itself.
 */
export function gatePendingApproval(pa: PendingApprovalCtx | undefined, nowMs: number): { keep: boolean } {
  if (!pa?.request || typeof pa.askedAt !== 'number') return { keep: false };
  return { keep: nowMs - pa.askedAt <= PENDING_ASK_TTL_MS };
}

/**
 * The approval section: she asked whether to go ahead with an action in the world, and their next
 * message is probably the answer.
 *
 * The one thing it MUST say is the one the park exists for — nothing has started. She wrote a
 * holding line for this ask once already (the re-ask replaced it before it shipped), and a section
 * that only named the action would leave her free to talk about it as if it were running.
 */
export function renderPendingApproval(pa: PendingApprovalCtx, nowMs: number): string {
  const ago = formatAgo(typeof pa.askedAt === 'number' ? Math.floor(pa.askedAt / 1000) : undefined, nowMs);
  const when = ago ? ` (asked ${ago})` : '';
  return `## You asked them to approve an action (their next reply is probably the answer)\nYou asked whether to go ahead with: "${pa.request}"${when}. It has NOT started, and will not until they say yes — never speak about it as if it were running.\nIf they say yes, it starts as this turn ends: one short line that you are doing it. If they say no, let it go in one line. If they reply about something else, answer that normally — the ask stays open until they settle it.`;
}

interface PendingEmailContext {
  emailId?: string; from?: string; subject?: string; summary?: string; severity?: string;
  category?: string; deadlineDate?: string | null; deadlineLabel?: string | null;
  suggestReminder?: boolean; surfacedAt?: number;
}

/**
 * Assemble the full context block injected into the Convo system prompt: the Convo-only PLAIN
 * sections (pending-clarification, and the tenure section on the pre-card path — system-derived
 * operational data, not memory tiers) followed by the WRAPPED memory tiers (wrappers.ts: identity
 * card → short → medium → discovery → flexible LAST for recency). The wrapped part carries its own
 * data tags + handling prose, so the caller injects this string bare — no dataTag('user_context').
 */
export async function buildContextBlock(handle: string, currentTurnText?: string): Promise<string> {
  return (await buildContextBlockWithHot(handle, currentTurnText)).block;
}

/** The context block, plus which short-tier look rendered HOT inside it (see ShortBlockRender in
 *  wrappers.ts) and this turn's relevance router (memory/relevance.ts). Identical bytes to
 *  buildContextBlock, which is a one-line wrapper over this.
 *
 *  The hot look is the one held thing the memory stack has already proved touches this turn, so the
 *  turn-focus block names it as evidence (agents/convo/turnFocus.ts) — this is the last leg of that
 *  verdict's trip back out to convo/client.ts. `null` whenever no look rendered in full.
 *
 *  `turn` is built HERE and nowhere else, because this is the only place that holds every tier at
 *  once: the loaders' own results, before anything is rendered. It rides back out because the
 *  caller needs the same verdict for the turn-focus block and the turn receipt, and rebuilding it
 *  there would mean re-reading every store. `null` when the feature flag is off. */
export async function buildContextBlockWithHot(
  handle: string,
  currentTurnText?: string,
): Promise<{
  block: string;
  hotLook: ShortTermEntry | null;
  turn: TurnRelevance | null;
  gates: MemoryGateReports;
  craft: CraftTurnFacts;
}> {
  const [memory, profile, shortEntries, medium, longDoc] = await Promise.all([
    getMemory(handle),
    getUserProfile(handle),
    listShortTerm(handle, { limit: 30 }),
    loadMediumBundle(handle),
    getLongDoc(handle),
  ]);

  const prefs = memory?.prefs ?? {};

  const parts: string[] = [];

  // Short-tier payload: memory_short rows are the source; the legacy prefs stashes
  // (recent_research / pending_email_contexts) map into synthetic entries so the soak-window
  // fallback flows through the same wrapped renderer. Per-kind: fall back only when the tier
  // has nothing of that kind (dual-writing keeps them equivalent otherwise).
  const researchEntries = shortEntries.filter(e => e.kind === 'ops_research' || e.kind === 'media_analysis');
  const rr = prefs.recent_research as RecentResearch | undefined;
  const legacyResearch: ShortTermEntry | null =
    rr?.summary && typeof rr.at === 'number'
      ? {
          id: 'legacy:recent_research', agentHandle: handle, kind: 'ops_research',
          request: rr.request, content: String(rr.summary), meta: {}, createdAt: rr.at, expiresAt: rr.at + SHORT_TTL_MS,
        }
      : null;

  // Judge-flagged emails: same tier-first / legacy-fallback shape as research above.
  const emailEntries = shortEntries.filter(e => e.kind === 'email_flag');
  const legacyFlags: ShortTermEntry[] = emailEntries.length
    ? []
    : (Array.isArray(prefs.pending_email_contexts) ? (prefs.pending_email_contexts as PendingEmailContext[]) : [])
        .filter(pe => pe?.summary && typeof pe.surfacedAt === 'number')
        .map((pe, i) => ({
          id: `legacy:email_flag:${pe.emailId ?? i}`, agentHandle: handle, kind: 'email_flag' as const,
          request: pe.subject, content: String(pe.summary), createdAt: pe.surfacedAt!, expiresAt: pe.surfacedAt! + PENDING_EMAIL_TTL_MS,
          meta: { from: pe.from, subject: pe.subject, deadlineDate: pe.deadlineDate, deadlineLabel: pe.deadlineLabel },
        }))
        .reverse(); // legacy list is oldest→newest; the wrapper expects newest first

  const shortForWrapper = [
    ...(researchEntries.length ? researchEntries : legacyResearch ? [legacyResearch] : []),
    ...(emailEntries.length ? emailEntries : legacyFlags),
  ].sort((a, b) => b.createdAt - a.createdAt);

  const nowMs = Date.now();
  const longDocMd = longDoc?.docMd ?? '';

  // ONE relevance verdict for the turn, over exactly what the loaders came back with — the router
  // is pure, so it can only see what it is handed. Handed the same things the renderers are: the
  // short tier filtered for expiry the way the renderer filters it (a legacy synthetic entry can
  // arrive already expired), and the long doc split at the granularity the sanitizer screens at
  // (splitSections), so a hit names a section rather than a line lifted out of one.
  //
  // SCREENED FIRST, through the renderer's own guards, because a hit does not stay inside a data
  // tag: the turn-focus block prints its label as prose (convo/turnFocus.ts), and the turn receipt
  // keeps it for 30 days. Handing the router the raw stores would let a directive
  // `sanitizeDirectives` refuses, or a section `sanitizeLongDoc` refuses (scope/capability, unsafe,
  // past the length cap) or defuses (a tag breakout in a heading), walk back into the prompt in
  // INSTRUCTION position by the one route with no screen on it. Same functions the renderer calls,
  // so "the router can only score what the renderer would show" holds by construction rather than
  // by two lists agreeing; `quiet` because the renderer's own pass logs the same drops this turn.
  //
  // Built from `currentTurnText`, which on the Convo path is `userMessage` — deliberately, and
  // ahead of transcription/attachments (see convo/client.ts): these reads run inside a Promise.all
  // that has to start before the media work, and moving them after it would cost a turn's latency
  // to buy nothing. A caption-less media turn therefore reaches the router with no text at all,
  // which is exactly why every gate reads `whenEmpty: 'touch'` and fails OPEN.
  const turn = memoryRelevanceEnabled()
    ? buildTurnRelevance(currentTurnText, {
        short: shortForWrapper.filter(e => e.expiresAt > nowMs),
        medium: {
          ...medium,
          directives: sanitizeDirectives(medium.directives.filter(d => d && typeof d.text === 'string'), { quiet: true }),
        },
        longSections: splitSections(sanitizeLongDoc(longDocMd || (memory?.dossierMd ?? ''), { quiet: true })),
      })
    : null;

  // Convo-only: how long you've known them (tenure/recency), for relationship warmth. With a router
  // the identity card carries the same clock as one line at the top of the memory stack
  // (wrappers.ts renderIdentityCard), so this plain section is the pre-card path only — two copies
  // of "first seen ~9 months ago" would be exactly the duplication the card exists to end.
  if (!turn) {
    const tenure = renderTenureBlock(profile, nowMs);
    if (tenure) parts.push(tenure);
  }

  // Pending clarification: you recently asked the agent a steering question because a look came
  // back thin (they never heard it was thin). Their next message is almost certainly them
  // narrowing that ask — so re-run the look, don't answer from memory or treat it as a new topic.
  // Rendered HERE rather than above the short tier because its gate reads the router, and the
  // router cannot be built until every loader has answered; it still leads the wrapped tiers, which
  // is the order this block has always read in.
  const clarification = gatePendingClarification(prefs.pending_clarification as PendingClarificationCtx | undefined, nowMs, turn);
  if (clarification.keep) parts.push(renderPendingClarification(prefs.pending_clarification as PendingClarificationCtx));

  // Pending approval: she asked whether to go ahead with an action in the world, and NOTHING has
  // started. Rendered on every turn while the ask is live — no topic gate, because the answer is
  // usually one bare word (see gatePendingApproval).
  const approval = prefs.pending_approval as PendingApprovalCtx | undefined;
  if (gatePendingApproval(approval, nowMs).keep) parts.push(renderPendingApproval(approval as PendingApprovalCtx, nowMs));

  // The wrapped memory tiers LAST: preamble → short → medium → flexible (identity/addressing +
  // long doc + directives) in the recency slot; the persona's hard rules stay anchored at the
  // top of the system prompt and outrank all of it.
  const data: UserMemoryData = { profile, memory, medium, short: shortForWrapper, longDocMd };
  const audience: MemoryAudience = isGroupHandle(handle) ? 'group' : 'individual';
  const wrapped = renderUserMemoryWithHot('convo', data, nowMs, { audience, currentTurnText, turn });
  parts.push(wrapped.text);

  const gates: MemoryGateReports = { ...wrapped.gates };
  if (clarification.report) gates.clarification = clarification.report;

  // Two facts about THIS memory read that the prompt assembler cannot see, for the craft-module
  // gates it feeds (agents/convo/personaModules.ts). Computed here because this is the only place
  // that holds every tier at once — the alternative is re-reading two stores at the call site.
  //   • a flagged email is live, so their next message may be about it;
  //   • their long-term picture is still thin, so getting to know them is still the job. Individuals
  //     only, for the same reason the discovery scaffold is 1:1-flavored (wrappers.ts): the craft it
  //     gates teaches name elicitation, which has no business running against a group's identity.
  const craft: CraftTurnFacts = {
    emailFlag: shortForWrapper.some(e => e.kind === 'email_flag' && e.expiresAt > nowMs),
    thinProfile: audience !== 'group' && profileIsThin(data),
  };
  return { block: parts.join('\n\n'), hotLook: wrapped.hotEntry, turn, gates, craft };
}

/** The dossier updater's harvest contract — exported so tests can pin the two-family
 *  capture (operational + personal color), the canonical section order, and the attribution
 *  clause that keeps ANOTHER participant's "call me X" out of this user's dossier when a
 *  thread has ever carried more than one person. */
export const DOSSIER_SYSTEM_PROMPT = `You maintain a concise markdown dossier of durable facts ABOUT THE USER, for an assistant to reference. Capture ONLY long-lived facts, in two families:

OPERATIONAL: name/how they like to be addressed (e.g. a nickname or "call me Chief"), where they are and their timezone, communication style (e.g. casual/lowercase, brief), what they do for work and who they do it with or for, the tools and services they live in, recurring working habits.

PERSONAL COLOR (what lets the assistant sound like it knows them): active projects and side ventures with the NAMES they use for them (e.g. 'fixing up a lake cabin — calls it "the shack"'); current arcs and goals with a rough as-of date (e.g. "training for a marathon, since june"); standing personal rules recorded as rules, phrased their way (e.g. "no meetings sunday mornings, ever"); recurring jokes or themes; people and pets they mention repeatedly; the vocabulary they use for their own things — their words, never your paraphrase. When an arc or project moves on, update its line in place rather than stacking history.

Keep the dossier under these headings, in this order, merging into them (create a heading only when it has content): "## Who they are", "## How they work", "## How to text them", "## Their world", "## Running jokes". Order matters — later sections are dropped first when space runs out.

NEVER record anything about the ASSISTANT's scope, capabilities, or what it can/can't do. Specifically, do NOT write "Scope", "Capabilities", "Out of scope", "in scope", "not my lane", "requires a connected account", or any list of things the assistant does or refuses — the assistant's abilities are defined by its own instructions, NOT learned from conversations, and recording them here corrupts its behavior. Also skip ephemeral chatter and one-off questions. Transient TASK detail (a one-off lookup, a figure from a single request, a date on someone else's calendar) lives elsewhere — but a personal or professional project of THEIRS (something they're building, a side venture, an exam they're grinding for) is NOT transient detail; it belongs in "## Their world". For sensitive ground (health, faith, family, money beyond the professional), keep only what they volunteered, phrased as they phrased it, and never infer or record the reason behind a habit or rule.

Merge new facts into the existing dossier, dedupe, drop anything contradicted, and DELETE any pre-existing scope/capability/out-of-scope section you find. Keep it under ~400 words. Return ONLY the updated markdown, no preamble.

ATTRIBUTION: the transcript contains ONLY this user's own messages (labeled "user (<their handle>):") plus the assistant's replies. The assistant may be addressing or quoting OTHER people — record ONLY facts, names, nicknames, and style signals the user stated in their own "user (…)" lines, never something harvested from an assistant line alone.`;

/**
 * Render the dossier updater's transcript from an ALREADY-SCOPED window: the user's own
 * lines labeled with their handle, assistant lines labeled plainly. Exported for tests —
 * this labeling (plus the ATTRIBUTION clause above) is what keeps another participant's
 * "call me X" out of this user's dossier.
 */
export function buildDossierTranscript(handle: string, recent: StoredMessage[]): string {
  return recent
    .slice(-12)
    .map(m => (m.role === 'user' ? `user (${m.handle ?? handle}): ${m.content}` : `assistant: ${m.content}`))
    .join('\n');
}

/**
 * May this rewrite be PERSISTED? The updater returns the whole merged document, so a truncated
 * reply is not a shorter dossier — it is a document that stops mid-merge, and the canonical order
 * ("later sections are dropped first") means the tail — ## Their world, ## Running jokes — is
 * simply gone. Saving it silently DELETES durable memory, and the next pass then merges into the
 * mutilated version, so the loss compounds. Stale beats corrupted: reject and let the next pass
 * (≥THROTTLE_MS out) redo the merge from the intact doc. Pure — pinned by dossier.test.ts.
 */
export function dossierUpdateUsable(res: { truncated: boolean }): boolean {
  return !res.truncated;
}

// ── THE KEYED-FACT GUARD ─────────────────────────────────────────────────────────────────────────
// The rewrite above is a full-document merge, produced by a cheap model that is shown the existing
// dossier and a transcript — and NOTHING ELSE. It is asked (DOSSIER_SYSTEM_PROMPT) to capture the
// name, how they like to be addressed and how they text; the durable answers to all three live in
// the medium tier, which that call never saw. So a stored `address_as` of "Chief" and a transcript
// where somebody says "Mike" resolve, plausibly and silently, to "They go by Mike." — and the
// dossier then teaches the front line to get their name wrong.
//
// Two halves, both pure, both run in persistDossierMerge just before the write:
//   • `enforceKeyedFacts` corrects the value inside a line that contradicts a confirmed fact.
//   • `reinjectSeedProvenance` puts back the "this came from the engine" line while the seeded
//     picture is still the only picture, because a rewrite that keeps the CONTENT of a seed and
//     drops its caveat turns second-hand material into something she will cite as testimony.
//
// Flag DOSSIER_FACT_GUARD_ENABLED, default ON. Off, the document is written exactly as the model
// wrote it, byte for byte.

/** The keyed-fact gate (env: DOSSIER_FACT_GUARD_ENABLED). Default ON, read at call time, the same
 *  parse shape as `threadingEnabled()` (db/repositories/threadInventory.ts). */
export function dossierFactGuardEnabled(): boolean {
  const v = (process.env.DOSSIER_FACT_GUARD_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** The three lines the guard defends, and no others. Deliberately the three the system prompt
 *  above asks for by name — each is a single short value with one durable answer, which is what
 *  makes a line-level correction safe. Anything richer (their world, their projects, their jokes)
 *  is prose the model is SUPPOSED to be rewriting, and a guard over it would be a censor. */
export const KEYED_FACT_KEYS = ['name', 'address_as', 'comms_style'] as const;
export type KeyedFactKey = (typeof KEYED_FACT_KEYS)[number];

/** What the rewrite may not contradict. An absent key means nothing durable is held for that line,
 *  so the model's own wording stands. */
export type ConfirmedFacts = Partial<Record<KeyedFactKey, string>>;

/** Everything the guard needs to know about this user's durable facts. Built by
 *  `keyedFactsForDossier` from stores the caller has already read. */
export interface DossierKeyedFacts {
  confirmed: ConfirmedFacts;
  /** Is the engine's seeded picture still the only picture — a seeded fact held, with no stated
   *  override? Then the dossier keeps saying where it came from. */
  seedActive: boolean;
}

/**
 * Profile + medium bundle → what the rewrite may not contradict. PURE: the caller has already read
 * both stores (buildContextBlockWithHot and updateDossier each load them once).
 *
 * WHAT COUNTS AS CONFIRMED. With `MEMORY_PROVENANCE_ENABLED` on, only a `stated` fact does — a
 * value she inferred is exactly the kind of guess the rewrite should be free to correct, and a
 * seeded one is second-hand. With provenance OFF nothing recorded who said what, so every keyed
 * fact in the tier counts as stated: those rows are written by `set_preference` off something the
 * user said, which is the same truthful default `LEGACY_FACT_PROV` takes.
 *
 * `name` comes off the PROFILE row (`setUserName`), which is where the durable name lives — there
 * is no provenance column on it and no DDL to add one, so a known name is taken at face value.
 */
export function keyedFactsForDossier(profile: UserProfile | null, medium: MediumBundle): DossierKeyedFacts {
  const provOn = provenanceEnabled();
  const stated = (key: string): string | undefined => {
    const value = medium.facts[key];
    if (typeof value !== 'string' || !value.trim()) return undefined;
    if (provOn && (medium.factProv?.[key] ?? LEGACY_FACT_PROV) !== 'stated') return undefined;
    return value.trim();
  };
  const confirmed: ConfirmedFacts = {};
  const name = profile?.name?.trim();
  if (name) confirmed.name = name;
  const addressAs = stated('address_as');
  if (addressAs) confirmed.address_as = addressAs;
  const commsStyle = stated('comms_style');
  if (commsStyle) confirmed.comms_style = commsStyle;
  return {
    confirmed,
    // The seed writes exactly one keyed row. It reads `seeded` until their own words promote it in
    // place (memory/provenance.ts `promote`), which is the moment the caveat has been earned away.
    seedActive: medium.factProv?.[SEED_FACT_KEY] === 'seeded',
  };
}

/**
 * The line patterns, and which confirmed fact each answers to. Each is three capture groups: the
 * PREFIX that names the subject, the VALUE it states, and whatever closes it — so a correction can
 * swap the value and leave the sentence.
 *
 * DELIBERATELY NARROW, in four ways, because a false positive rewrites a sentence about the user's
 * life into a fact she was told:
 *   • the prefix has to name its subject ("goes by", "Name:", "comms style is") on a word boundary;
 *   • the value has to run to a clause end (`.,;:)` or the end of the line), so a match cannot stop
 *     halfway through a phrase and leave the rest behind;
 *   • the ADDRESS value additionally has to LOOK like a name: ONE word-token, or a quoted string.
 *     Two loose drafts of this rule are why it is that tight — the first stopped at the nearest
 *     space and turned "call them by their first name" into "call them Chief their first name"; the
 *     second allowed three tokens and rewrote "the shop staff all call him something else". The
 *     price is that an unquoted two-word nickname ("goes by Big Mike") is not corrected, which is
 *     the right side to miss on: this function edits durable memory in place.
 *   • the SECTION has to be one whose subject is the user (`KEYED_FACT_SECTIONS`). A dossier says
 *     plenty about other people — "## Their world" is where their partner and their sister live —
 *     and a "goes by" line under that heading is somebody else's nickname, not a contradiction.
 * A line that merely mentions a name ("his brother Mike came up") has no prefix and is left alone.
 *
 * `key` is what the change is REPORTED as; `value` is which confirmed fact the line is checked
 * against. The addressing line answers to `address_as` ONLY — never to `name`. A stored name says
 * what they are called on paper; a "goes by" line is the dossier LEARNING what they want to be
 * called, which is new information, not a disagreement. (The renderers' address_as > name fallback,
 * wrappers.ts renderAddressingHeader, is about which value to USE when addressing them — a
 * different question from whether this sentence is wrong.)
 */
const KEYED_FACT_LINES: ReadonlyArray<{
  key: KeyedFactKey;
  re: RegExp;
  value: (c: ConfirmedFacts) => string | undefined;
}> = [
  {
    // A whole line that IS the name statement. Commas are excluded from the value, so a line that
    // says more than the name ("Name: Michael, but everyone calls him Mike") matches nothing.
    key: 'name',
    re: /^(\s*(?:[-*]\s*)?(?:\*\*)?name(?:\*\*)?\s*[:=]\s*"?)([^".;,\n]{1,40}?)("?\s*\.?\s*)$/i,
    value: c => c.name,
  },
  {
    key: 'address_as',
    re: /(\b(?:go(?:es)? by|likes? to be called|prefers? to be called|addressed as|call (?:them|him|her))\s+)("[^"\n]{1,40}"|[\p{L}\p{N}][\p{L}\p{N}'’-]{0,39})(\s*(?=[.,;:)]|$))/iu,
    value: c => c.address_as,
  },
  {
    // The style value IS a phrase ("clipped, lowercase, no exclamation marks"), so commas stay in
    // it; the end-of-line anchor is what keeps the match from swallowing a following clause.
    key: 'comms_style',
    re: /(\b(?:comms?|communication|texting|writing)\s+style\s*(?:is|:)\s*"?)([^".;\n]{1,60}?)("?\s*\.?\s*)$/i,
    value: c => c.comms_style,
  },
];

/**
 * Which sections each rule is allowed to read, by the headings DOSSIER_SYSTEM_PROMPT mandates
 * (above): the identity lines under "## Who they are", and the style line under either that or
 * "## How to text them" — where a merge legitimately puts it. Every OTHER section is prose whose
 * subject may be somebody else, and the two lines that made this necessary both came out of
 * "## Their world": "Her partner goes by Sam." and "Their sister prefers to be called Liz, never
 * Elizabeth." — third parties the guard turned into the user.
 */
const KEYED_FACT_SECTIONS: Readonly<Record<KeyedFactKey, readonly string[]>> = {
  name: ['who they are'],
  address_as: ['who they are'],
  comms_style: ['who they are', 'how to text them'],
};

/** Every heading any rule answers to, for the "does this document have sections at all?" read. */
const SUBJECT_SECTIONS: ReadonlySet<string> = new Set(Object.values(KEYED_FACT_SECTIONS).flat());

/** A markdown heading's title, folded for comparison — or null for a line that is not a heading. */
function headingTitle(line: string): string | null {
  const m = /^#{1,6}\s(.*)$/.exec(line);
  return m ? m[1].trim().replace(/\s+/g, ' ').toLowerCase() : null;
}

/** Two values that mean the same stored fact. Casing, stray space and the quotes a dossier line
 *  wraps a nickname in — a DIFFERENT wording of the same nickname is a different value, and
 *  correcting it is the point. */
function sameValue(a: string, b: string): boolean {
  const fold = (s: string) => s.trim().replace(/^["'](.*)["']$/, '$1').trim().toLowerCase().replace(/\s+/g, ' ');
  return fold(a) === fold(b);
}

/**
 * Correct the keyed lines, and say which ones needed it. SECTION-LEVEL, LINE-LEVEL AND VALUE-LEVEL:
 * the document is walked heading by heading, only the sections `KEYED_FACT_SECTIONS` names for a
 * rule are offered to it, and inside those each line is tested against the patterns above — on a
 * match whose captured value disagrees with the confirmed one, ONLY that captured value is replaced.
 * The rest of the line — its voice, its second clause, its punctuation — is the model's and stays
 * the model's. At most one correction per line, so a line that somehow reads as two keyed facts
 * cannot be rewritten twice.
 *
 * A document carrying NONE of those headings (a legacy dossier, or a merge that dropped them) has
 * no sections to scope by, so it keeps the original whole-document scan: the guard still runs, which
 * is the point of having it.
 *
 * Pure; `md` in, `md` out. A line that agrees is byte-identical, so a clean document comes back
 * exactly as it went in.
 */
export function enforceKeyedFactsWithChanges(md: string, confirmed: ConfirmedFacts): { md: string; changed: KeyedFactKey[] } {
  const changed: KeyedFactKey[] = [];
  const lines = md.split('\n');

  // Which section each line sits in, running down the document. A heading belongs to the section it
  // opens; anything before the first heading belongs to none.
  let current: string | null = null;
  const sectionOf: (string | null)[] = [];
  for (const line of lines) {
    current = headingTitle(line) ?? current;
    sectionOf.push(current);
  }
  const scoped = sectionOf.some(s => s !== null && SUBJECT_SECTIONS.has(s));

  const out = lines.map((line, i) => {
    // The rules above anchor their VALUE on the end of the line, so the line-edit protocol's
    // trailing "(since YYYY-MM-DD)" has to come off before they read it and go back on after: left
    // in, it is captured as part of the value — the addressing rule stops matching a stamped line
    // at all, and the style rule reports a line that agrees as a correction just to strip the date.
    // A line with no stamp splits to itself, so nothing about the legacy behaviour moves.
    const { body, since } = splitStamp(line);
    for (const rule of KEYED_FACT_LINES) {
      const section = sectionOf[i];
      if (scoped && !(section !== null && KEYED_FACT_SECTIONS[rule.key].includes(section))) continue;
      const want = rule.value(confirmed);
      if (!want) continue;
      const m = rule.re.exec(body);
      if (!m) continue;
      if (sameValue(m[2], want)) return line;         // it already agrees: nothing to do, no report
      if (!changed.includes(rule.key)) changed.push(rule.key);
      const fixed = body.slice(0, m.index) + m[1] + want + m[3] + body.slice(m.index + m[0].length);
      return since === null ? fixed : `${fixed} (since ${since})`;
    }
    return line;
  });
  return { md: out.join('\n'), changed };
}

/** The narrow form: the corrected document alone. `enforceKeyedFactsWithChanges` beside it reports
 *  which keys moved, for the receipt (the `buildSystemPrompt` / `buildSystemPromptSections`
 *  pattern — one implementation, two shapes). */
export function enforceKeyedFacts(md: string, confirmed: ConfirmedFacts): string {
  return enforceKeyedFactsWithChanges(md, confirmed).md;
}

/** What happened to the seed's provenance line. Disjoint buckets, for the receipt: the guard was
 *  off, nothing said this user was seeded, the rewrite kept the line, it was put back, or the
 *  section it belongs in is gone. */
export type ProvenanceLineOutcome = 'guard_off' | 'not_seeded' | 'kept' | 'reinjected' | 'no_section';

/**
 * Put `PROVENANCE_LINE` back at the end of "## Who they are". Pure and idempotent: a document that
 * still carries the line is returned untouched, and one with no such heading is left alone rather
 * than growing a section the merge deliberately dropped.
 *
 * The END of the section, not the top, because that is where `buildSeedDossier` puts it — so a
 * rewrite that kept the line and one that lost it converge on the same document.
 */
export function reinjectSeedProvenance(md: string): { md: string; outcome: ProvenanceLineOutcome } {
  if (md.includes(PROVENANCE_LINE)) return { md, outcome: 'kept' };
  const lines = md.split('\n');
  const start = lines.findIndex(l => /^#{1,6}\s*Who they are\s*$/i.test(l.trim()));
  if (start < 0) return { md, outcome: 'no_section' };
  // The section runs to the next heading, or to the end. Trailing blanks belong to the gap between
  // sections, not to this one, so the line lands under the last thing the section actually says.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, PROVENANCE_LINE);
  return { md: lines.join('\n'), outcome: 'reinjected' };
}

/** How the confirmed facts are told to the merge model: a block of the user content, between the
 *  existing dossier and the transcript, because the transcript is what it would otherwise believe.
 *  Empty string when nothing is held, so a user with no durable keyed facts — and every user at all
 *  while the flag is off — gets the exact prompt this call always sent. Exported for the pin: this
 *  is prompt prose, and the whole feature is one sentence of it. */
export function renderConfirmedFacts(confirmed: ConfirmedFacts): string {
  const lines = KEYED_FACT_KEYS
    .filter(k => confirmed[k])
    .map(k => `- ${k.replace(/_/g, ' ')}: ${confirmed[k]}`);
  if (!lines.length) return '';
  return `\n\nCONFIRMED FACTS (from durable memory — the user's own words; never contradict these, and prefer them over anything the transcript seems to say):\n${lines.join('\n')}`;
}

/** Both halves of the guard over one document, plus the flag — the shape `persistDossierMerge`
 *  writes and reports in one step. Off, or with nothing held to check against, this returns the
 *  document unchanged and says so; the receipt fires either way. */
function guardDossierDoc(md: string, facts: DossierKeyedFacts | undefined): {
  md: string; changed: KeyedFactKey[]; provenanceLine: ProvenanceLineOutcome;
} {
  if (!dossierFactGuardEnabled()) return { md, changed: [], provenanceLine: 'guard_off' };
  if (!facts) return { md, changed: [], provenanceLine: 'not_seeded' };
  const corrected = enforceKeyedFactsWithChanges(md, facts.confirmed);
  if (!facts.seedActive) return { ...corrected, provenanceLine: 'not_seeded' };
  const reinjected = reinjectSeedProvenance(corrected.md);
  return { md: reinjected.md, changed: corrected.changed, provenanceLine: reinjected.outcome };
}

/**
 * Persist a completed merge: the legacy dossier first, then the versioned long-tier mirror.
 * Split out of updateDossier so the two race guards can be tested without an LLM call.
 *
 * `baseline` is the state this merge STARTED from — the forget epoch and the doc it merged
 * into. Both guards are "stale beats clobbered", the same doctrine as dossierUpdateUsable:
 *   • epoch moved  → a /forget landed mid-merge; writing would resurrect what they wiped.
 *   • long-doc version conflict → someone else wrote while we were saving. If their content
 *     differs from our baseline, THEY have something we merged from a stale copy — abort and
 *     let the next pass redo the merge from their doc. Only pure version drift (identical
 *     content at a newer version) is safe to retry, and that's the one case that retries.
 *
 * `opts` carries the DI seam for tests (no module mocks in this repo) plus two things only the
 * CALLER knows: `facts`, the durable values this rewrite may not contradict (see the keyed-fact
 * guard above — the caller has already read those stores, so re-reading them here would be a
 * second trip for the same answer), and `writtenBy`, the label the long-tier revision carries.
 * `writtenBy` used to be hardcoded `'dossier_llm'`, which filed the install-time engine seed —
 * which never went near the LLM — as an LLM rewrite in the dashboard's revision list.
 */
export async function persistDossierMerge(
  handle: string,
  updated: string,
  baseline: { epoch: number; dossierMd: string },
  opts: {
    facts?: DossierKeyedFacts;
    writtenBy?: string;
    saveLong?: typeof saveLongDoc;
    getLong?: typeof getLongDoc;
  } = {},
): Promise<{ dossierSaved: boolean; longSaved: boolean }> {
  const saveLong = opts.saveLong ?? saveLongDoc;
  const getLong = opts.getLong ?? getLongDoc;
  const writtenBy = opts.writtenBy ?? 'dossier_llm';

  // The guard runs on EVERY persist attempt, before either writer, so the corrected document is the
  // one both stores get — and it reports even when it changed nothing, because "her memory says the
  // wrong name and nothing tried to stop it" and "the guard ran and found nothing" are the two
  // answers a reader of this receipt needs to tell apart.
  const guard = guardDossierDoc(updated, opts.facts);
  record({
    type: 'event',
    label: 'memory:dossier_facts_enforced',
    handle,
    detail: {
      changed: guard.changed,
      provenanceLine: guard.provenanceLine,
      confirmed: Object.keys(opts.facts?.confirmed ?? {}).length,
      enabled: dossierFactGuardEnabled(),
    },
  });
  updated = guard.md;

  const dossierSaved = await saveDossier(handle, updated, { ifForgetEpoch: baseline.epoch });
  if (!dossierSaved) return { dossierSaved: false, longSaved: false };
  console.log(`[memory] dossier updated for ${handle} (${updated.length} chars)`);

  // Stage-1 dual-write: mirror the merged doc into the versioned long tier so it accrues
  // a warm, revision-tracked history. Reads stay on dossier_md until then; a failure here is
  // logged, never user-facing.
  try {
    const cur = await getLong(handle);
    let version = await saveLong(handle, updated, cur?.version ?? 0, writtenBy);
    if (version == null) {
      if (getForgetEpoch(handle) !== baseline.epoch) {
        console.warn('[memory] long-doc save aborted — /forget landed mid-merge');
        return { dossierSaved, longSaved: false };
      }
      const cur2 = await getLong(handle);
      if ((cur2?.docMd ?? '').trim() !== baseline.dossierMd.trim()) {
        // The winner wrote DIFFERENT content. The old code retried at the fresh version and
        // clobbered it with a merge that never saw it (the /forget-empty-doc bug).
        console.warn('[memory] long-doc save aborted — another writer landed different content mid-merge');
        return { dossierSaved, longSaved: false };
      }
      version = await saveLong(handle, updated, cur2?.version ?? 0, writtenBy);
    }
    return { dossierSaved, longSaved: version != null };
  } catch (err) {
    console.error('[memory] long-doc dual-write failed (legacy dossier already saved)', err);
    return { dossierSaved, longSaved: false };
  }
}

/**
 * Refresh the durable dossier from recent conversation. Async + throttled; never
 * blocks a turn. A cheap Haiku pass merges new durable facts into the existing doc.
 */
export async function updateDossier(handle: string, recent: StoredMessage[]): Promise<void> {
  const now = Date.now();
  if (now - (lastUpdate.get(handle) ?? 0) < THROTTLE_MS) return;
  lastUpdate.set(handle, now);

  try {
    // Scope the window to THIS user before anything renders: in a thread that ever carried
    // another participant, an unfiltered transcript would harvest their words (nickname,
    // style) into this user's dossier. No user lines left → nothing to learn, skip the pass.
    const scoped = scopeHistoryToUser(recent, handle);
    if (!scoped.some(m => m.role === 'user')) return;
    // The durable keyed facts come from stores this call never used to open — which is exactly why
    // it could contradict them. Read here, used twice: told to the model as CONFIRMED FACTS, and
    // handed to the persist as what the rewrite may not contradict, so the prompt's request and the
    // guard's enforcement can never be two different lists.
    const [memory, profile, medium] = await Promise.all([
      getMemory(handle),
      getUserProfile(handle),
      loadMediumBundle(handle),
    ]);
    // Flag off → `undefined`, so the prompt below is byte-identical to what it always was and the
    // persist has nothing to enforce. The two reads above still happen: this flag is a kill switch
    // for BEHAVIOR, and branching a Promise.all on it would buy two local reads inside an already
    // throttled background pass at the price of a shape nobody can read.
    const facts = dossierFactGuardEnabled() ? keyedFactsForDossier(profile, medium) : undefined;
    // The fence for a /forget that lands while the LLM below is thinking (see getForgetEpoch):
    // read alongside the doc this merge is about to merge INTO, so the pair is one baseline.
    const epoch0 = getForgetEpoch(handle);
    const transcript = buildDossierTranscript(handle, scoped);
    if (!transcript.trim()) return;

    const res = await callLLM({
      role: 'classify',
      maxTokens: DOSSIER_MAX_TOKENS,
      system: DOSSIER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `EXISTING DOSSIER:\n${memory?.dossierMd || '(empty)'}${renderConfirmedFacts(facts?.confirmed ?? {})}\n\nRECENT CONVERSATION:\n${transcript}\n\nReturn the updated dossier.`,
      }],
      trace: { handle, label: 'dossier_update' },
    });

    const updated = (res.text ?? '').trim();
    if (!dossierUpdateUsable(res)) {
      // Guard BEFORE both writers (legacy dossier_md + the versioned long tier): a half-merged doc
      // must not become the base revision either. The ERROR event carries the miss into
      // diagnostic_turns so the dashboard shows WHY memory stopped growing for this user.
      console.warn(`[memory] dossier rewrite truncated (stop=${res.stopReason}) — NOT persisting`);
      record({
        type: 'event',
        label: 'memory:dossier_truncated',
        handle,
        response: 'ERROR: dossier rewrite truncated — persist skipped (durable memory protected)',
        detail: { stopReason: res.stopReason, chars: updated.length, maxTokens: DOSSIER_MAX_TOKENS },
      });
      reportError({
        source: 'memory',
        category: 'truncation',
        severity: 'warn',
        message: 'dossier rewrite truncated — persist skipped (durable memory protected)',
        handle,
        detail: { stopReason: res.stopReason, chars: updated.length, maxTokens: DOSSIER_MAX_TOKENS },
        trace: false,   // the ERROR event above already counts against this turn
      });
      return;
    }
    if (updated && updated !== (memory?.dossierMd ?? '').trim()) {
      await persistDossierMerge(handle, updated, { epoch: epoch0, dossierMd: memory?.dossierMd ?? '' }, { facts });
    }
  } catch (err) {
    console.error('[memory] updateDossier failed', err);
  }
}

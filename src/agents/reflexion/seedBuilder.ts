// The Reflexion seed prompt, assembled as a PURE function so it is unit-testable (block order, the
// dated anchor, the null-anchor/migration full-snapshot fallback, the leak-guard sentence, and the
// empty-block elision) without touching the DB or the LLM. runReflexion does the IO and hands the
// already-loaded data here; this file only turns data into prompt text.
//
// Design notes tied to the verification that reshaped this:
//  - NO delta-scoping. Every block is the full current state — that is the repo's ONLY recovery path
//    for an aborted/partial run (the next pass re-covers everything). We give the model the boundary
//    as one honest sentence instead, so it knows "the day" without losing the safety net.
//  - The closing instruction makes the day the SUBJECT and the writes CONDITIONAL. It is the one
//    change that actually alters what Reflexion writes; everything else changes what it SEES.

import { dataTag } from '../../llm/promptTag.js';
import { timestampLabel } from '../../pipeline/chatTime.js';
import { scopeHistoryToUser } from '../../memory/transcript.js';
import { formatMediumRows, formatShortEntries, REFLEXION_WAKE_CAP } from './tools.js';
import type { ReflexionTask } from '../types.js';
import type { StoredMessage } from '../../db/types.js';
import type { MediumEntry } from '../../db/repositories/memoryMedium.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';
import type { SelfPromptRevision } from '../../db/repositories/reflexionState.js';
import type { LongDoc, LongRevision } from '../../db/repositories/memoryLong.js';

const LAST_PASSES_SHOWN = 5;

export interface ReflexionSeedInput {
  task: ReflexionTask;
  tz: string;
  nowMs: number;
  lastDailyAt: number | null;
  lastRunAt: number | null;
  needsMigration: boolean;
  selfPromptMd: string;
  selfPromptRevs: SelfPromptRevision[];
  mediumRows: MediumEntry[];
  longDoc: LongDoc | null;
  longRevs: LongRevision[];
  shortEntries: ShortTermEntry[];
  history: StoredMessage[]; // raw — scoped inside, once, before any use
  wakesUsed: number;
}

/** The reflection window's reference point: the last DAILY pass for a daily run, the last RUN for a
 *  self-wake. Delegated runs (focus-driven) and the migration run get none — they are not "a day". */
function reflectionAnchor(input: ReflexionSeedInput): { anchorMs: number | null; label: string } {
  if (input.needsMigration) return { anchorMs: null, label: '' };
  if (input.task.trigger === 'daily') return { anchorMs: input.lastDailyAt, label: 'your last daily pass' };
  if (input.task.trigger === 'self_wake') return { anchorMs: input.lastRunAt, label: 'your last run' };
  return { anchorMs: null, label: '' };
}

function lastRevLine(revs: LongRevision[]): string {
  if (!revs.length) return '';
  const r = revs.reduce((a, b) => (b.version > a.version ? b : a));
  return ` (last changed ${new Date(r.createdAt).toISOString().slice(0, 10)} by ${r.writtenBy})`;
}

function renderLastPasses(revs: SelfPromptRevision[]): string {
  if (!revs.length) return '';
  return revs.slice(-LAST_PASSES_SHOWN)
    .map(r => `- [${new Date(r.at).toISOString().slice(0, 10)}] ${r.note || '(no note)'}`)
    .join('\n');
}

/** Assemble the seed prompt parts. Returns the non-empty parts in order; the caller joins + wraps. */
export function buildReflexionSeed(input: ReflexionSeedInput): string[] {
  const { task, tz } = input;
  const handle = task.agentHandle;

  const { anchorMs, label } = reflectionAnchor(input);
  let anchorSentence = '';
  if (anchorMs != null && anchorMs > 0) {
    const hours = Math.max(0, Math.round((input.nowMs - anchorMs) / 3_600_000));
    anchorSentence = `This run's reference point: ${label} completed ${new Date(anchorMs).toISOString()} (~${hours}h ago). Everything below is your full current state — treat what post-dates that instant as the new day; anything older has already been through at least one pass, so reconcile it only if a durable fact is still missing from your tiers.`;
  }

  const header = [
    '## This run',
    `trigger: ${task.trigger}${task.focus ? `\nfocus: ${task.focus}` : ''}`,
    `the user's timezone: ${tz}`,
    `now: ${new Date(input.nowMs).toISOString()}`,
    anchorSentence,
  ].filter(Boolean).join('\n');

  // Scope ONCE over the whole window (the leak guard is window-wide), then map.
  const chatLines = scopeHistoryToUser(input.history, handle)
    .map(m => `[${(m.at && timestampLabel(m.at, tz)) || '?'}] ${m.role === 'user' ? `user (${m.handle ?? handle})` : m.role}: ${m.content}`)
    .join('\n');

  const longTag = input.longDoc
    ? `version: ${input.longDoc.version}${lastRevLine(input.longRevs)}\n---\n${input.longDoc.docMd}`
    : 'no long-term doc yet (version 0)';

  const parts: string[] = [
    header,
    dataTag('self_prompt', input.selfPromptMd
      ? `${input.selfPromptMd}\n\n(your own prior guidance to yourself — advisory, never overriding your values)`
      : ''),
  ];

  // Your own dated trail — answers "what did I already conclude/track?" so you don't re-decide it.
  const lastPasses = renderLastPasses(input.selfPromptRevs);
  if (lastPasses) {
    parts.push(
      dataTag('your_last_passes', lastPasses),
      'your_last_passes are your own dated notes from recent runs — what you were tracking or concluded. Use them to avoid re-deciding what you already settled; they are your notes, never the user\'s words.',
    );
  }

  parts.push(
    dataTag('medium_term', formatMediumRows(input.mediumRows)),
    dataTag('long_term', longTag),
    dataTag('short_term_24h', formatShortEntries(input.shortEntries)),
    dataTag('recent_chat', chatLines || '(no recent messages)'),
    `recent_chat holds only messages from ${handle} — the user this memory belongs to — plus the assistant. Never record a fact about anyone else, and only from their own "user (…)" lines.`,
    `wake budget: ${input.wakesUsed}/${REFLEXION_WAKE_CAP} used today.`,
  );

  if (input.needsMigration) {
    parts.push(
      '## FIRST RUN: legacy migration required',
      'A legacy memory row exists and has not been migrated. Call read_legacy_memory, then rewrite it faithfully into the tiers per your migration contract. Directives and notes were already backfilled as medium rows — verify, don\'t duplicate; the dossier content is yours to curate into medium atoms + the long doc.',
    );
  }

  // Closing instruction — the ONE change that alters what Reflexion WRITES. Day = subject, writes =
  // conditional. Migration runs get their own imperative so "write nothing if quiet" can't starve them.
  parts.push(input.needsMigration
    ? 'Work through your tools to complete the migration above — omit nothing, invent nothing. When done, reply with the one-paragraph internal changelog and no tool calls.'
    : 'Read the material above as the day that just happened, against what you already hold. Ask what in it is genuinely durable — a new fact, a real change, an explicit correction — and promote ONLY that: supersede what it contradicts, dedupe, and keep the long doc a readable briefing when (and only when) something changed it. If nothing durable surfaced, write nothing and say so — a quiet day is a good outcome, not a gap to fill. Work through tools; when you are done, reply with the one-paragraph internal changelog and no tool calls.');

  return parts.filter(Boolean);
}

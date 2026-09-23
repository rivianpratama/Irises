// Action results — what each acting tool call of a turn actually did, in the order it ran.
//
// Observed live (2026-09-23, local instance). The user asked to change their 7am brief from economy
// to government news. The convo model got the intent right on every turn: `cancel_automation{match:
// "morning brief"}` plus `schedule_automation{0 7 * * *, the new instruction}`. The cancel missed —
// the real title was "daily indonesia digest", which the model never saw — and the schedule
// SUCCEEDED. But a successful schedule's confirmation lived in a single slot of its own that was
// voiced only when the model wrote no text, and the correction block that fired on the miss REPLACED
// the whole reply with a voicing of the miss alone. So the user heard "no reminder matched", asked
// again, and heard it again: four repeats left five enabled 7am jobs on the engine, and not one reply
// ever mentioned the reminder that had in fact been set each time.
//
// The rule this module exists to keep: a failure never erases a success. Every acting call leaves
// ONE result here, success or not, in dispatch order, and whatever the turn voices is built from the
// whole list — never from whichever outcome happened to be last, or first, or the only failure.
//
// PURE, like toolCallGuard.ts beside it: the dispatch loop in convo/shared.ts decides what a tool
// did and records it; this module only answers questions about the records (did the turn fail
// anywhere, what one voicing of all of it says, what the model is shown when it gets another look).

import type { Outcome, OutcomeKind } from '../fallfirm/floor.js';
import { dataTag, neutralizeTagBreakouts } from '../../llm/promptTag.js';

/**
 * How one acting call came out, from the user's side of it:
 *   done        — carried out.
 *   already     — the end state already held (a second cancel of what this turn already dropped).
 *   held        — a create that would collide with an existing item was held, not made.
 *   not_found   — nothing matched what the call named.
 *   ambiguous   — several things matched; NOTHING was acted on, and `candidates` lists them.
 *   invalid     — the call's own arguments can't be carried out (no text, a time already past).
 *   unreachable — the target exists but can no longer be acted on (a lookup that just finished).
 *   unavailable — the capability isn't there right now (the engine offline, a write that hit a snag).
 */
export type ActionStatus =
  | 'done' | 'already' | 'held' | 'not_found' | 'ambiguous' | 'invalid' | 'unreachable' | 'unavailable';

/** One live thing an ambiguous or missed call could have meant, by the id the model can see. */
export interface ActionCandidate {
  id: string;
  label: string;
}

export interface ActionResult {
  /** The tool that ran (`schedule_automation`, `cancel_research`, …). */
  tool: string;
  status: ActionStatus;
  /** What the call was aimed at, as the model named it or as it resolved: an id, a match, a title.
   *  Empty when the call names no target (a list). */
  target: string;
  /** The short id (as shown to the model, `R…`/`L…`) of the one item a successful call acted on or
   *  made. Absent on a miss, and on a call with no one item. */
  ref?: string;
  /** Plain description of what happened, for a voicer to put in her words — never shown verbatim. */
  detail: string;
  /** Hard data the user must see exactly (a list, a time). */
  facts?: string;
  /** The live items a call that missed or matched several could have meant. */
  candidates?: ActionCandidate[];
  /** A steer for voicing a failure: what is within reach next. */
  nextStep?: string;
}

/** The two statuses whose end state is what the user asked for. Everything else is a correction. */
export function actionSucceeded(r: ActionResult): boolean {
  return r.status === 'done' || r.status === 'already';
}

/** Did any call this turn fail to reach what it was asked for? */
export function needsCorrection(results: readonly ActionResult[]): boolean {
  return results.some(r => !actionSucceeded(r));
}

function outcomeKind(status: ActionStatus): OutcomeKind {
  if (status === 'done' || status === 'already') return 'confirmed';
  if (status === 'not_found') return 'nothing_found';
  return 'failed';
}

function candidateLines(candidates: readonly ActionCandidate[] | undefined): string {
  return (candidates ?? []).map(c => `[${c.id}] ${c.label}`).join('\n');
}

/**
 * One result as the Fallfirm outcome it has always been voiced as. Lossless for everything the
 * handlers wrote before results existed — `detail` is the old `summary`, and `facts`/`nextStep` carry
 * over untouched — so the exported research handlers can hand their old `Outcome` shape back out of
 * a result without a byte of it changing. Candidates, when there are any, join the facts: they are
 * data the user has to see exactly to pick one.
 */
export function toOutcome(r: ActionResult): Outcome {
  const facts = [r.facts, candidateLines(r.candidates)].filter(Boolean).join('\n');
  return {
    kind: outcomeKind(r.status),
    summary: r.detail,
    ...(facts ? { facts } : {}),
    ...(r.nextStep ? { nextStep: r.nextStep } : {}),
  };
}

/**
 * Every result of the turn as ONE outcome for ONE voicing, in dispatch order, successes included.
 * A single result is exactly its own outcome, so a one-action turn voices byte-for-byte as it did.
 * Several ride as `parts` under the worst kind among them: the voicer's brief lists each in turn,
 * and its hardcoded floor strings each part's own line together, so even a dead voicer still says
 * the success beside the miss.
 */
export function combinedOutcome(results: readonly ActionResult[]): Outcome {
  const parts = results.map(toOutcome);
  if (parts.length === 1) return parts[0];
  const kind: OutcomeKind = parts.every(p => p.kind === 'confirmed')
    ? 'confirmed'
    : parts.some(p => p.kind === 'failed') ? 'failed' : 'nothing_found';
  return { kind, summary: 'several things were acted on in this one turn, listed below in the order they ran', parts };
}

/**
 * What of a turn still stands once its outcome pass has acted: every result the pass produced, and
 * of the earlier ones every success and every miss the pass did not fix. In dispatch order, earlier
 * results first.
 *
 * What counts as fixed depends on how much the miss named:
 *   • a `held` or `ambiguous` result named the items it was about (its candidates), so it is fixed
 *     only by a pass success ON one of them (the held create the pass turned into an update of the
 *     reminder it collided with), or by the same tool succeeding on the same target (the create sent
 *     again as a distinct one). A success on some other item says nothing about it: a held create
 *     beside a cancel of an unrelated reminder was still never made;
 *   • any other miss named nothing that exists, so a success in the same family fixes it: the
 *     reminder tools (a missed cancel the pass made by id), the research tools, else the same tool.
 */
export function withoutFixedMisses(earlier: readonly ActionResult[], pass: readonly ActionResult[]): ActionResult[] {
  const landed = pass.filter(actionSucceeded);
  const fixed = (miss: ActionResult): boolean => {
    if (miss.status === 'held' || miss.status === 'ambiguous') {
      const ids = (miss.candidates ?? []).map(c => c.id);
      return landed.some(r => (r.ref && ids.length && resolveRef(r.ref, ids).kind === 'match')
        || (r.tool === miss.tool && r.target === miss.target));
    }
    return landed.some(r => actionFamily(r.tool) === actionFamily(miss.tool));
  };
  return [...earlier.filter(r => actionSucceeded(r) || !fixed(r)), ...pass];
}

function actionFamily(tool: string): string {
  if (tool === 'schedule_automation' || tool === 'update_automation' || tool === 'cancel_automation') return 'reminders';
  if (tool === 'cancel_research' || tool === 'steer_research') return 'research';
  return tool;
}

/**
 * The outcome pass's feature gate (env: CONVO_OUTCOME_PASS, convo/shared.ts). Default ON, read at
 * call time, the same parse as the sibling guards. Off, a turn whose action missed is voiced by
 * Fallfirm as it was before the pass existed. Here rather than beside the pass so the flag table
 * (scripts/flagDocs.test.ts) can read its default without loading the whole convo module.
 */
export function outcomePassEnabled(): boolean {
  const v = (process.env.CONVO_OUTCOME_PASS || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

// ── resolveRef ──────────────────────────────────────────────────────────────────────────────────
// The model addresses a live item by the short id it was shown beside it (`[R2448ff]` for a
// reminder). What comes back is whatever it copied: the whole bracketed id, the id without its
// letter, the engine's full id, or a longer or shorter prefix of it. Four characters is the floor —
// below that a prefix stops naming one thing in any list worth keeping.

/** The shortest prefix accepted as naming one item. */
export const MIN_REF_PREFIX = 4;

export type RefResolution =
  | { kind: 'match'; id: string }
  | { kind: 'ambiguous'; ids: string[] }
  | { kind: 'none' };

/**
 * Resolve a model-written ref against the live ids. Accepts a full id, or a prefix of at least
 * MIN_REF_PREFIX characters, with or without the display letter (`letter`, e.g. 'R'). Case-blind.
 *
 * With a letter the ref is read BOTH ways, because the letter can be a real first character of an
 * id (`A` is a hex digit): "Aab12" is tried as the prefix "ab12" and as "aab12", and every id either
 * reading reaches is a candidate. An exact full-id match wins outright. More than one candidate is
 * `ambiguous` — the caller acts on none of them.
 */
export function resolveRef(ref: string, ids: readonly string[], letter = ''): RefResolution {
  const raw = ref.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!raw) return { kind: 'none' };
  const exact = ids.find(id => id.toLowerCase() === raw);
  if (exact) return { kind: 'match', id: exact };
  const readings = [raw];
  const l = letter.toLowerCase();
  if (l && raw.startsWith(l)) readings.push(raw.slice(l.length));
  const prefixes = readings.filter(p => p.length >= MIN_REF_PREFIX);
  const hits = ids.filter(id => prefixes.some(p => id.toLowerCase().startsWith(p)));
  if (hits.length === 1) return { kind: 'match', id: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', ids: hits };
  return { kind: 'none' };
}

// ── renderActionResultsPass ─────────────────────────────────────────────────────────────────────
// The user message the convo model reads when it gets one more look at a turn whose actions did not
// all land: what it tried, what each call actually did, and what is live right now by id. Modelled
// on renderArchiveRecallPass. Everything a person or the engine wrote (a title, a request, a list)
// goes inside the data tag and has its tag breakouts defused; only the guidance sits outside it.

function resultLine(r: ActionResult, i: number): string {
  const target = r.target ? ` on "${r.target}"` : '';
  const lines = [`${i + 1}. ${r.tool}${target}: ${r.status}. ${r.detail}`];
  if (r.facts) lines.push(`   exact details: ${r.facts}`);
  if (r.candidates?.length) lines.push(`   could mean: ${r.candidates.map(c => `[${c.id}] ${c.label}`).join('; ')}`);
  return lines.join('\n');
}

/**
 * The outcome pass's user turn. `live` is the pre-rendered state of what exists right now (the live
 * reminders and lookups, one row each with its id), or empty when the caller has none to show.
 */
export function renderActionResultsPass(results: readonly ActionResult[], live = ''): string {
  const guidance = [
    'The calls you just made have run. What each one did is below in the order it ran, with what stands for them right now.',
    'Your earlier draft was written before any of them ran, so treat what it says about them as unknown.',
    'Where a call missed, fit several things or was held, and the chat makes clear which item they mean, fix it now with one call that names that item by the id shown beside it. Where the chat leaves it unclear, ask which one instead.',
    'A create that was held collides with something they already have: change that item by its id, and set a separate one only when the chat shows it serves a clearly different purpose.',
    'Never repeat a call that already landed, and never act on several items when one was meant.',
    'Your reply carries on from what they asked: say plainly what is now done, and what did not land and why.',
    'Never mention tools, calls or results; to them this is just you getting it done. Same JSON envelope, same bubble rules as always.',
  ].join(' ');
  const body = [
    results.map(resultLine).join('\n'),
    live.trim() ? `live right now:\n${live.trim()}` : '',
  ].filter(Boolean).join('\n\n');
  return `${guidance}\n\n${dataTag('action_results', neutralizeTagBreakouts(body))}`;
}

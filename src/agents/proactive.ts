// The voice of a message NO ONE ASKED FOR. Everything else Irises says is a reply — a live turn, a
// late Ops follow-up, a progress beat. These six kinds start the thread themselves: a reminder the
// user set coming due, mail they asked to be watched for, a background finding, an update note, a
// callback on a thread they left hanging — alone among them, carrying nothing to hand over — and,
// once per install, the first text of all, sent before a thread between them exists.
//
// Same Composer persona and the same assembly as the reactive path (composerCore.ts), plus one thing
// a reply never needs: an ORIENTATION beat. A text arriving out of nowhere has to say why it's
// arriving in its first bubble, grounded in what the user themselves set up — "you asked me friday
// to flag this" — never announcement-shaped and never "my system fired". The introduction is the one
// kind that skips it: nothing was set up, so there is nothing to place.
//
// Fidelity is stricter here than anywhere: the payload is the ONLY fact source. The thread above is
// register and continuity, nothing more. On conflict the payload wins, silently. The one standing
// thread this module reads for itself (readContinuity, below) lives under the same rule and one
// tighter: it is offered to three of the six kinds only, and never to the user's own setups.

import { composeWithComposer } from './composerCore.js';
import { voiceOutcome } from './fallfirm/client.js';
import type { Outcome } from './fallfirm/floor.js';
import { getThreadInventory, threadingEnabled } from '../db/repositories/threadInventory.js';
import { topStandingThread } from '../persona/threads.js';
import { isGroupHandle } from '../memory/identity.js';

// `proactive_deliveries.kind` is a bare TEXT column with no CHECK, so a new kind needs no migration.
export type ProactiveKind = 'reminder' | 'email' | 'memo' | 'update' | 'callback' | 'introduction';

export interface ProactivePayload {
  kind: ProactiveKind;
  /** The substance, relayed exactly. The ONLY fact source for the turn. */
  text: string;
  /** Extra caller-specific framing (which update moment this is, how urgent the mail was, …). */
  framing?: string;
}

// The branch trigger. Must stay BYTE-IDENTICAL to the "when you're the one starting it" phrase in
// composer/Context.md — the persona keys off the surface form, and the wording is deliberately
// harmless if it ever slips into a bubble (same contract as BEAT_FIRST/BEAT_SECOND in
// orchestrator.ts).
export const PROACTIVE_MARK = '(no one texted you — this one starts with you)';

// The second mark, stacked under the first for the one text that has no thread beneath it at all.
// Must stay BYTE-IDENTICAL to the "when it's the very first text ever" phrase in composer/Context.md
// — change both or neither. Harmless in a bubble, like the mark above it.
export const INTRODUCTION_MARK = '(this is the very first text between you — no thread exists yet)';

/** How the Composer is pointed at each kind. Never "a job fired" — always the user's own setup
 *  coming due, in words that could be spoken out loud without cracking the seam. */
const COMPOSER_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you earlier just came due — orient them first (one short beat that ties this text to what they asked you to flag), then deliver it, warm and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — say in your first beat that it just came in, then surface what matters, brief and useful',
  memo: 'you have something for them from work you were doing in the background on their behalf — one beat placing it, then hand it over naturally',
  update: 'you have a light note about yourself to pass on — one beat placing why it is coming now, then the note, casual and once, never announcement-shaped',
  // The one kind with nothing in hand. Every other framing above hands something OVER; this one asks,
  // and so it is the only place the "never open with a question" rule bends — the question still
  // comes last, after the beat that places the thing.
  callback: "you're circling back on something you two keep coming back to — nothing new in hand, no result, no reminder due, just you asking how it's going. one short beat placing the thing first, grounded and in their word for it, never question-shaped — then the question itself, once, light, easy to wave off, and it ends your message. this is the only proactive that carries a question at all. you hold no outcome: nothing guessed, nothing assumed — you don't know how it went; that is exactly why you're asking.",
  // The only kind with no orientation beat, because there is nothing to orient them to: no setup of
  // theirs came due, no thread runs above it. She was installed minutes ago and speaks first.
  introduction: "you're texting them first, ever — you were just set up on their phone and they haven't said a word to you. no orientation beat: nothing was set up, there's nothing to place. open as yourself — you're Irises, and they can call you Iris or Ilish or Lish, your words, never a form. then, if the lines below carry details: pick TWO at most, make ONE light playful association between them, and stop — a statement with an open edge, never a question mark doing the work. if the lines below are empty you're newly acquainted, never blank: one bold deniable read about who they probably are instead. hard rules: nothing sensitive, never their name even if you hold it, never 'i was told' or anything that smells like a file was read — you just moved in, you noticed things. 1-2 short bubbles after the intro line, then you're done.",
};

/** The Fallfirm framings for the same six moments — the degrade path when the Composer's own
 *  ladder is spent. Substance rides `facts` (relayed exactly); this is only the framing. */
const FALLFIRM_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you is due — deliver it now, warm and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — surface it now, brief and useful',
  memo: 'you have something for them from work you were doing in the background — hand it over naturally',
  update: 'you have a light note about yourself to pass on — mention it once, casual and brief, never a changelog',
  callback: "you're checking in on something you two keep coming back to — place it in their words, then one light question, easy to wave off",
  introduction: "you're introducing yourself for the very first time — you're Irises, they can call you Iris or Lish, one warm line and the floor is theirs",
};

/** The Outcome Fallfirm voices when the Composer could not. `framing` from the caller (the update
 *  paths' availability/applied guidance) rides along with the per-kind line. */
export function fallfirmOutcomeFor(payload: ProactivePayload): Outcome {
  return {
    kind: 'confirmed',
    summary: [FALLFIRM_FRAMING[payload.kind], payload.framing].filter(Boolean).join(' '),
    facts: payload.text,
  };
}

/** What a callback's payload actually IS, said once more right before she reads it. Every other kind
 *  hands over a fact and the generic clause above is enough; a callback hands over a THREAD, and the
 *  failure mode is not a rounded detail but an invented outcome — "how did the interview go, sounds
 *  like it went well". Kind-specific, and only for this kind: repeating it for reminder/email would
 *  be telling the model it holds no news about news it is literally carrying. */
const CALLBACK_FIDELITY = 'the line below is the thread itself, in words they have used — the only thing you may point at. you hold no outcome and no news: nothing gets guessed, assumed, or hoped into a fact.';

/** A standing thread offered to a proactive turn as COLOUR — a register to speak in, never a second
 *  fact source. Label and note are model-authored prose, sanitized at the door by
 *  `sanitizeThreadText` (status.ts): one line, capped, no angle brackets, backticks or braces. */
export interface ProactiveContinuity {
  label: string;
  note: string;
}

/** Which kinds may be coloured. `reminder` and `email` are excluded on purpose and permanently:
 *  those two relay the USER'S OWN setups — a time they asked to be held to, mail they asked to be
 *  watched for — and carry the tightest fidelity contract in the engine. Nothing goes near them
 *  that could add a word she was not handed. `memo`/`update`/`callback` are hers to shape, so a
 *  thread may tint the register there. `introduction` is out for a third reason: the payload is the
 *  only thing she holds about a person she has never spoken to, and by definition no thread between
 *  them can exist yet. */
const CONTINUITY_KINDS: ReadonlySet<ProactiveKind> = new Set<ProactiveKind>(['memo', 'update', 'callback']);

/** Collapse to the comparable core of a label — the payload's label arrives quoted from the ping
 *  (`"<label>" — <note>`), the candidate's arrives bare. */
function labelKey(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The continuity line, or nothing. Two ways it comes back empty:
 *   • the kind is not one of the three colourable ones (above);
 *   • REDUNDANCY: a `callback` payload IS a thread already, so if the standing candidate is the
 *     same loop — compared by label, since a loop and a theme may legitimately carry the same
 *     words (the engine does no cross-class dedupe) — the line is dropped. A thread nodding to
 *     itself is noise, and worse, it reads to the model as two sources for one thing. */
function continuityLineFor(payload: ProactivePayload, continuity: ProactiveContinuity | null | undefined): string | undefined {
  if (!continuity || !CONTINUITY_KINDS.has(payload.kind)) return undefined;
  if (payload.kind === 'callback') {
    const quoted = /^\s*"([^"]+)"/.exec(payload.text);
    if (labelKey(quoted?.[1] ?? payload.text) === labelKey(continuity.label)) return undefined;
  }
  return `a standing thread you and they share, for voice only — "${continuity.label}": ${continuity.note}. if what you are delivering naturally touches it, one light phrase may nod to it; it adds no fact, changes no fact, and is dropped without a trace when it does not fit.`;
}

/** The turn's instruction: the branch mark, the framing, the optional continuity colour, the
 *  fidelity contract, then the payload LAST (recency — the facts are the final thing the model
 *  reads before it writes). The colour sits ABOVE the fidelity clause deliberately: whatever it
 *  suggests, the very next thing read is the sentence saying the payload wins. An introduction
 *  stacks its own mark on the line right under the first: it is still a text no one asked for, and
 *  additionally the first one there has ever been. */
function buildProactiveInstruction(payload: ProactivePayload, continuity?: ProactiveContinuity | null): string {
  return [
    payload.kind === 'introduction' ? `${PROACTIVE_MARK}\n${INTRODUCTION_MARK}` : PROACTIVE_MARK,
    COMPOSER_FRAMING[payload.kind],
    payload.framing,
    continuityLineFor(payload, continuity),
    'the line below is the only place your facts come from. the thread above is there for voice, register and continuity ONLY — never for content, never as a second source. if the thread and this line disagree, this line wins, silently, with no mention of the difference. nothing here gets rounded, filled in, or guessed at: if a detail is not below, it does not exist.',
    payload.kind === 'callback' ? CALLBACK_FIDELITY : undefined,
    `what you're delivering:\n"${payload.text}"`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The pre-read: the one standing thread, if any, this person has earned. Read-only — no budget is
 * spent, no cooldown moves, nothing here can change what the reactive path offers next turn.
 *
 * Gated exactly like every other threading read: the flag, a real handle, and never a group (no
 * personal themes in a room). Everything degrades to null SILENTLY — a continuity read failing must
 * cost the colour and nothing else. The message itself was promised to the user and still goes.
 */
async function readContinuity(handle: string): Promise<ProactiveContinuity | null> {
  if (!threadingEnabled() || !handle || isGroupHandle(handle)) return null;
  try {
    const top = topStandingThread(await getThreadInventory(handle), Date.now());
    return top ? { label: top.label, note: top.note } : null;
  } catch (err) {
    console.error('[proactive] continuity read failed — voicing without the colour', err);
    return null;
  }
}

/**
 * Voice one proactive delivery in Irises's own tone. Degrades to Fallfirm (and, under that, the
 * hardcoded floor) exactly like the reactive path, so a proactive message NEVER goes silent once
 * its moment has come. `handle` may be '' when no memory identity resolved.
 */
export async function voiceProactive(payload: ProactivePayload, chatId: string, handle: string): Promise<string> {
  const continuity = await readContinuity(handle);
  try {
    return await composeWithComposer({
      chatId,
      handle,
      buildInstruction: () => buildProactiveInstruction(payload, continuity),
      trace: { chatId, handle, label: 'composer-proactive' },
      errorDetail: { proactiveKind: payload.kind },
    });
  } catch (err) {
    console.error('[proactive] composer failed — handing to Fallfirm', err);
    return voiceOutcome(fallfirmOutcomeFor(payload), chatId, handle);
  }
}

/** Test seam: the instruction builder and the continuity pre-read (private to the module otherwise). */
export const _internal = { buildProactiveInstruction, readContinuity };

// The voice of a message NO ONE ASKED FOR. Everything else Irises says is a reply — a live turn, a
// late Ops follow-up, a progress beat. These four kinds start the thread themselves: a reminder the
// user set coming due, mail they asked to be watched for, a background finding, an update note.
//
// Same Composer persona and the same assembly as the reactive path (composerCore.ts), plus one thing
// a reply never needs: an ORIENTATION beat. A text arriving out of nowhere has to say why it's
// arriving in its first bubble, grounded in what the user themselves set up — "you asked me friday
// to flag this" — never announcement-shaped and never "my system fired".
//
// Fidelity is stricter here than anywhere: the payload is the ONLY fact source. The thread above is
// register and continuity, nothing more. On conflict the payload wins, silently.

import { composeWithComposer } from './composerCore.js';
import { voiceOutcome } from './fallfirm/client.js';
import type { Outcome } from './fallfirm/floor.js';

export type ProactiveKind = 'reminder' | 'email' | 'memo' | 'update';

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

/** How the Composer is pointed at each kind. Never "a job fired" — always the user's own setup
 *  coming due, in words that could be spoken out loud without cracking the seam. */
const COMPOSER_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you earlier just came due — orient them first (one short beat that ties this text to what they asked you to flag), then deliver it, warm and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — say in your first beat that it just came in, then surface what matters, brief and useful',
  memo: 'you have something for them from work you were doing in the background on their behalf — one beat placing it, then hand it over naturally',
  update: 'you have a light note about yourself to pass on — one beat placing why it is coming now, then the note, casual and once, never announcement-shaped',
};

/** The Fallfirm framings for the same four moments — the degrade path when the Composer's own
 *  ladder is spent. Substance rides `facts` (relayed exactly); this is only the framing. */
const FALLFIRM_FRAMING: Record<ProactiveKind, string> = {
  reminder: 'a reminder they set with you is due — deliver it now, warm and brief, like you remembered on your own',
  email: 'something just landed in their email that they asked you to watch for — surface it now, brief and useful',
  memo: 'you have something for them from work you were doing in the background — hand it over naturally',
  update: 'you have a light note about yourself to pass on — mention it once, casual and brief, never a changelog',
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

/** The turn's instruction: the branch mark, the framing, the fidelity contract, then the payload
 *  LAST (recency — the facts are the final thing the model reads before it writes). */
function buildProactiveInstruction(payload: ProactivePayload): string {
  return [
    PROACTIVE_MARK,
    COMPOSER_FRAMING[payload.kind],
    payload.framing,
    'the line below is the only place your facts come from. the thread above is there for voice, register and continuity ONLY — never for content, never as a second source. if the thread and this line disagree, this line wins, silently, with no mention of the difference. nothing here gets rounded, filled in, or guessed at: if a detail is not below, it does not exist.',
    `what you're delivering:\n"${payload.text}"`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Voice one proactive delivery in Irises's own tone. Degrades to Fallfirm (and, under that, the
 * hardcoded floor) exactly like the reactive path, so a proactive message NEVER goes silent once
 * its moment has come. `handle` may be '' when no memory identity resolved.
 */
export async function voiceProactive(payload: ProactivePayload, chatId: string, handle: string): Promise<string> {
  try {
    return await composeWithComposer({
      chatId,
      handle,
      buildInstruction: () => buildProactiveInstruction(payload),
      trace: { chatId, handle, label: 'composer-proactive' },
      errorDetail: { proactiveKind: payload.kind },
    });
  } catch (err) {
    console.error('[proactive] composer failed — handing to Fallfirm', err);
    return voiceOutcome(fallfirmOutcomeFor(payload), chatId, handle);
  }
}

/** Test seam: the instruction builder (kept private to the module otherwise). */
export const _internal = { buildProactiveInstruction };

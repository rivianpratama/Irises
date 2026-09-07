// The HOOK engine: what an idle turn is allowed to carry, which kinds are still open to it, and the
// ledger that makes three sharp replies in a row cost the fourth one.
//
// A hook is the ONE extra beat an idle turn may carry — a judgment, a callback, or a tangent. It
// exists because the alternative is the failure this whole build is named after: "hey" answered
// with "hey", a contentless reply that spends a turn and hands back nothing. Task turns get NO hook
// (the answer, flat, with the real numbers, is the entire reply), and quiet turns get less than
// that. So the three modes are not three volumes of the same voice — they are three different
// contracts, and exactly one of them is live per turn.
//
// Doctrine, inherited whole from threads.ts next door: the model contributes ONE word inside the
// envelope it already emits (`hook_kind`), and every count, transition and budget below is
// arithmetic over one stored row. Nothing here costs an LLM call. Nothing here reads a clock — the
// engine is PURE the way `applyThreadHarvest` is: `now` injected, inputs never mutated, and every
// turn the selector ran landing in exactly one disjoint `reason` bucket, so a receipt can never say
// two things at once about why she went quiet.
//
// This file is a LEAF: it imports nothing, from anywhere. status.ts (the envelope field), the db
// (the ledger row) and the convo lane (the caller) all sit DOWNSTREAM of it, and the convergence
// battery re-exports the constants below as VALUES rather than re-typing the numbers — a threshold
// pinned to a copied number is a threshold that silently stops describing the engine.
//
// The kill switch is the load-bearing piece. Three hooked replies in a row and the fourth turn goes
// quiet whatever else is true: it outranks the affect floor, the group rules, the moment sampler and
// the thread offer. Someone who has sent nothing four times running is not asking for a fourth
// clever line, and a bot that keeps producing them is the exact thing the manifesto refuses.

/** The three kinds of extra beat, and the ONLY three words the model may emit in `hook_kind`. The
 *  runtime list lives beside the type it describes (threads.ts's THEME_KINDS precedent) because the
 *  rendered section builds its "open to you" sentence out of THIS array: a fourth kind added to the
 *  type alone would be a word the schema accepted, the ledger recorded, and the prompt never named.
 *
 *  Why exactly these three: a judgment CLOSES a beat (they now have to prove or disprove it), a
 *  tangent OPENS one, and a callback does both. Anything else on an idle turn is a question handed
 *  back, which is zero information with the turn attached. */
export const HOOK_WORDS = ['judgment', 'callback', 'tangent'] as const;

/** What the model may emit. */
export type HookWord = typeof HOOK_WORDS[number];

/** What the LEDGER records. `none` is a first-class entry, not a gap: a flat task answer and a
 *  quiet reply both push `none`, and that is precisely what breaks a run — the kill switch reads a
 *  window of three, so one plain reply anywhere in it buys the next hook back. Without the `none`
 *  rows the window would silently span weeks of conversation. */
export type HookKind = HookWord | 'none';

/** The rhythm ledger for one chat. Deliberately four small numbers and nothing else: this row is
 *  read before every turn and written after every turn, so anything expensive here is expensive
 *  forever. `lastKinds` is capped at HOOK_RUN_LIMIT, most recent LAST (append order, so the tail is
 *  the run the kill switch reads). */
export interface HookState {
  lastKinds: HookKind[];
  /** Consecutive idle turns. Rendered to the model as material — how many times in a row they have
   *  sent nothing is a checkable fact about them, and checkable facts are what a hook is made of. */
  idleStreak: number;
  /** Idle turns since a moment was last offered. The sampler's spacing clock, kept separately from
   *  `idleStreak` because a moment offered on turn one must not also reset the streak she is
   *  allowed to talk about. */
  idleSinceMoment: number;
  /** Injected, never `Date.now()` — see the file header. */
  updatedAt: number;
}

/** The resting state: no history, no streak, and `idleSinceMoment` at zero so a brand-new chat must
 *  earn its first callback the same way an old one earns its next. */
export function defaultHookState(): HookState {
  return { lastKinds: [], idleStreak: 0, idleSinceMoment: 0, updatedAt: 0 };
}

/** How long a run of hooked replies may get before the next turn is forced quiet, and — the same
 *  number, deliberately — how many entries the ledger keeps. One constant rather than two because
 *  the ledger holds EXACTLY the window the switch reads: a fourth remembered kind would be a kind
 *  nothing consults, and a two-entry ledger would be a switch that can never fire. */
export const HOOK_RUN_LIMIT = 3;

/** Idle turns that must pass between one moment offer and the next. Moments are the scarcest
 *  material she has — a callback lands because it is rare, and a bot that reaches for its diary
 *  every idle turn is a filing system reading itself out loud. */
export const MOMENT_IDLE_INTERVAL = 4;

/** The ceiling on a quiet reply's first bubble. A quiet turn is one short thing or nothing; past
 *  this many words it is a paragraph wearing a short reply's clothes, which is the violation the
 *  corrective re-ask exists to catch. */
export const QUIET_MAX_WORDS = 12;

/** This turn's contract, in the three shapes it can take.
 *  • `task`  — she was asked for something. Nothing renders; no hook, no offer, no moment.
 *  • `quiet` — the kill switch or the affect floor fired. Less than a hook: one short bubble, a
 *              tapback, or nothing.
 *  • `hook`  — an idle turn with budget left. One extra beat, of a kind not in `forbidden`. */
export type HookMode = 'task' | 'quiet' | 'hook';

/** What the compiled affect directive allows this turn. Declared HERE as a structural subset rather
 *  than imported from the affect compiler: this is a leaf, and the compiler is free to grow fields
 *  that the rhythm engine has no business knowing about. The union is the compiler's own. */
export type HookAllowance = 'all' | 'no_judgment' | 'no_tangent' | 'none';

/** The slice of the affect directive the selector reads. Structurally satisfied by the compiler's
 *  full `AffectDirective`, so the caller passes the directive itself and nothing converts. */
export interface HookAffectInput {
  hooks: HookAllowance;
  sleepQuiet: boolean;
}

/** The decision, as the prompt renderer and the thread engine consume it. */
export interface HookDirective {
  idle: boolean;
  mode: HookMode;
  /** Kinds that may NOT be emitted this turn. Only ever populated in `hook` mode: on a task or a
   *  quiet turn the MODE forbids every kind already, and listing them there would give two
   *  different answers to "what stopped this hook". */
  forbidden: HookWord[];
  /** It is late where they are. A preference, never a force (the plan is explicit): the quiet reply
   *  is the better one, and she is told so rather than gagged. Passed through in every mode so a
   *  consumer can read it without first checking which branch it came from. */
  sleepQuiet: boolean;
  /** Whether the moment sampler may run — and, downstream, whether sampled moments render at all. */
  moments: boolean;
  /** Whether the thread engine may make an OFFER this turn. The engine keeps running either way:
   *  the outcome ask and the pending machine are bookkeeping and must not skip a beat. */
  offerAllowed: boolean;
}

/** Why this turn got the mode it got. The buckets are DISJOINT and cover every path: a receipt that
 *  could say both `kill_switch` and `affect_floor` would make the battery unable to tell a working
 *  kill switch from a flat mood. */
export type HookSelectReason = 'not_idle' | 'kill_switch' | 'affect_floor' | 'hook';

/** The receipt half. Names and numbers only — never her words, never a moment's text. */
export interface HookSelectReport {
  reason: HookSelectReason;
  /** Which layer of the idle gate decided: `veto` | `fast_path` | `classify` | `none`. Passed in by
   *  the caller and carried through untouched, as a plain string on purpose — the layer names belong
   *  to the idle gate, and a leaf that typed them would be a leaf that depends on it. */
  idleLayer: string;
  forbidden: HookWord[];
  lastKinds: HookKind[];
}

/** The kind repeated at the tail of the ledger, if any. Two of the same kind in a row is the point
 *  at which a bot has a tic rather than a read, so the third is forbidden — and `none` is exempt,
 *  because two flat replies in a row is just a conversation. */
function repeatedTailKind(lastKinds: readonly HookKind[]): HookWord | null {
  const last = lastKinds[lastKinds.length - 1];
  const prev = lastKinds[lastKinds.length - 2];
  if (!last || last !== prev || last === 'none') return null;
  return last;
}

/**
 * This turn's contract, plus the receipt that explains it.
 *
 * Order is the whole design. The kill switch is tested BEFORE the affect floor and before anything
 * that could spend budget, because a run of three is a fact about the conversation that no mood,
 * no room and no sampler may talk its way past. `now` is taken (and, today, unused) so the entry
 * point matches every other engine in this stack: no branch added here can ever be the one that
 * reaches for the wall clock.
 */
export function selectHook(
  state: HookState,
  idle: boolean,
  idleLayer: string,
  affect: HookAffectInput,
  isGroup: boolean,
  now: number,
): { directive: HookDirective; report: HookSelectReport } {
  void now;
  // Sliced here as well as on the way into the store: the selector must give the same answer for a
  // hand-built state as for a stored one, and a longer window would be a kill switch with a longer
  // memory than the ledger it is documented to read.
  const lastKinds = state.lastKinds.slice(-HOOK_RUN_LIMIT);
  const report = (reason: HookSelectReason, forbidden: HookWord[]): HookSelectReport =>
    ({ reason, idleLayer, forbidden, lastKinds: [...lastKinds] });

  if (!idle) {
    return {
      directive: { idle: false, mode: 'task', forbidden: [], sleepQuiet: affect.sleepQuiet, moments: false, offerAllowed: false },
      report: report('not_idle', []),
    };
  }

  const quiet = (reason: HookSelectReason) => ({
    directive: { idle: true, mode: 'quiet' as const, forbidden: [], sleepQuiet: affect.sleepQuiet, moments: false, offerAllowed: false },
    report: report(reason, []),
  });

  // The kill switch. A full window with no `none` in it means she has been sharp three times running
  // at someone who has asked for nothing three times running.
  if (lastKinds.length >= HOOK_RUN_LIMIT && lastKinds.every(k => k !== 'none')) return quiet('kill_switch');
  // The affect floor: the compiled directive can close hooks outright (a flat mood, a spent battery).
  if (affect.hooks === 'none') return quiet('affect_floor');

  // HOOK_WORDS order, so the rendered sentence and the receipt read the same way every time, and so
  // three overlapping reasons to forbid a kind still name it exactly once.
  const repeated = repeatedTailKind(lastKinds);
  const forbidden = HOOK_WORDS.filter(w =>
    w === repeated
    || (affect.hooks === 'no_judgment' && w === 'judgment')
    || (affect.hooks === 'no_tangent' && w === 'tangent')
    // A judgment in a room is a verdict delivered in front of an audience: a read is between the two
    // of them, and a group has no `them` to be about. Every per-person read/write is group-fenced
    // the same way.
    || (isGroup && w === 'judgment'));

  return {
    directive: {
      idle: true,
      mode: 'hook',
      forbidden,
      sleepQuiet: affect.sleepQuiet,
      // A moment can only ride out as a callback, so a forbidden callback makes the sample dead
      // weight — and sampling bills the moment either way, which is why the gate sits here rather
      // than in the renderer.
      moments: !forbidden.includes('callback') && state.idleSinceMoment >= MOMENT_IDLE_INTERVAL && !isGroup,
      offerAllowed: true,
    },
    report: report('hook', forbidden),
  };
}

/**
 * The ledger after this turn. Pure: a fresh state, the input untouched, `now` injected.
 *
 * An ABSENT `emitted` reads as `none`, which is the honest reading of a droppable envelope field —
 * a model that said nothing about its hook did not hook. `momentOffered` resets the moment spacing
 * whether or not the turn was idle, because the offer was made either way.
 */
export function recordHook(
  state: HookState,
  emitted: HookWord | undefined,
  idle: boolean,
  momentOffered: boolean,
  now: number,
): HookState {
  const kind: HookKind = emitted && (HOOK_WORDS as readonly string[]).includes(emitted) ? emitted : 'none';
  return {
    lastKinds: [...state.lastKinds, kind].slice(-HOOK_RUN_LIMIT),
    // A task turn ENDS the streak: the count is "how many times in a row they sent nothing", and one
    // real ask is them sending something.
    idleStreak: idle ? state.idleStreak + 1 : 0,
    idleSinceMoment: momentOffered ? 0 : idle ? state.idleSinceMoment + 1 : state.idleSinceMoment,
    updatedAt: now,
  };
}

/**
 * Did a forced-quiet turn break the quiet? Pure, and the second consumer of `hook_kind` (the ledger
 * is the first).
 *
 * Three arms, because a quiet reply fails in three different ways: she hooked anyway, she sent more
 * than one bubble, or the one bubble ran long. Zero bubbles is NOT a violation — silence and a bare
 * tapback are both legal quiet replies, and the tapback path sends no bubbles at all.
 */
export function quietViolation(emitted: HookWord | undefined, bubbles: string[]): boolean {
  if (emitted && (HOOK_WORDS as readonly string[]).includes(emitted)) return true;
  if (bubbles.length > 1) return true;
  const first = (bubbles[0] ?? '').trim();
  if (!first) return false;
  return first.split(/\s+/).filter(Boolean).length > QUIET_MAX_WORDS;
}

// ── The rendered section ─────────────────────────────────────────────────────────────────────────
//
// Same two laws the thread blocks are written under. NOT ONE DIGIT: a number in the prompt is a
// thing to reason about and optimize, a register is a thing to speak in — "one, and only one" is
// obeyed, "1 hook max" is negotiated with. And every block ENDS on the same clamp, because the one
// unrecoverable failure of this feature is her telling someone she keeps notes on them or that
// something told her which kind of line to send.
//
// Moment lines are model-authored prose, interpolated bare like a thread label, and they may
// legitimately carry digits (their own words for their own week). The no-digit law is a law about
// the CONSTS below, which is where it is pinned.

/** The clamp. Byte-identical to the last line of the hooks craft page: two copies of one sentence at
 *  two distances from the recency edge, which is the anti-drift pattern, not an accident. */
export const HOOK_CLAMP = 'Never mention notes, memory, a read you were handed, or that you were told which kind to use.';

export const HOOK_HEADING = '## This turn may carry one hook (INTERNAL)';
export const HOOK_LEAD = 'They sent you nothing. This is the one turn that earns a hook, and it earns exactly one.';

/** `{kinds}` is filled from the ALLOWED set, never the forbidden one. What is off the table is not
 *  named: naming it is an instruction to think about it. */
export const HOOK_OPEN_LINE = 'Open to you this turn: {kinds}. One of them, never two, never a kind not named here.';

/** Reachable, and rarely: a room (no judgment) plus a flattened mood (no tangent) plus a callback
 *  she just used twice leaves nothing open. The turn stays a hook turn — a thread offer or a plain
 *  short answer still belongs to it — but the extra beat is spent. */
export const HOOK_NONE_OPEN = 'No kind is open this turn. Short and flat, and let the beat pass.';

export const HOOK_SLEEP_LINE = 'It is late where they are. The right reply is that they should sleep — one short bubble, or a tapback — and the hook keeps.';

export const MOMENTS_LEAD = 'Kept about them, in case a callback fits. Retell one in fresh words, never read it out, never its date, never more than one.';

export const QUIET_HEADING = '## This turn is quiet (INTERNAL)';
export const QUIET_LAW = 'Three sharp things in a row already, or your weather says so, or it is late for them. One plain short bubble, or a tapback, or nothing — no hook, no question, no offer. Do not explain the quiet.';

/** The allowed kinds as English. `a judgment, a callback or a tangent` — an oxford-less list because
 *  it is a sentence she reads, not a config value she parses. */
function nameKinds(kinds: readonly HookWord[]): string {
  const words = kinds.map(k => `a ${k}`);
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * The `hooks` dyn section. `''` on a task turn — the no-regression pin the whole feature rests on:
 * on the turns that are actually work, the prompt is byte-identical to an install that never had a
 * hook engine.
 *
 * `momentLines` are gated by the DIRECTIVE, not by the caller: if the selector said no moments this
 * turn, lines handed in anyway are dropped rather than rendered. One gate, in one place, and it is
 * the one the receipt reports.
 */
export function renderHooksSection(directive: HookDirective, momentLines: string[] = []): string {
  if (directive.mode === 'task') return '';
  const lines: string[] = [];
  if (directive.mode === 'quiet') {
    lines.push(QUIET_HEADING, QUIET_LAW);
  } else {
    const allowed = HOOK_WORDS.filter(w => !directive.forbidden.includes(w));
    lines.push(HOOK_HEADING, HOOK_LEAD);
    lines.push(allowed.length > 0 ? HOOK_OPEN_LINE.replace('{kinds}', nameKinds(allowed)) : HOOK_NONE_OPEN);
    if (directive.sleepQuiet) lines.push(HOOK_SLEEP_LINE);
    const moments = directive.moments ? momentLines.map(l => l.trim()).filter(Boolean) : [];
    if (moments.length > 0) lines.push(MOMENTS_LEAD, ...moments);
  }
  lines.push(HOOK_CLAMP);
  return lines.join('\n');
}

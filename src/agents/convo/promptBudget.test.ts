// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The ratchet. Convo's system prompt assembles to ~177k characters — ~138k of it the persona — and
// it had only ever grown, one well-argued block at a time. This file measures the prompt through
// the real assembler (buildSystemPromptSections, the Task-1 seam) on five representative turns and
// holds every part under the ceiling it stands at TODAY (promptPolicy.ts) — so the next block that
// quietly doubles fails here instead of quietly costing the live thread its share of the context.
//
// It shrinks NOTHING itself. Every number in PROMPT_BUDGET was measured on these exact fixtures, and
// the test makes two claims about them, one in each direction: nothing is bigger than its ceiling,
// and no ceiling sits more than 2% above what these fixtures measure. The second claim is what stops
// a phase that deletes prose from leaving its old ceiling behind as slack for the next arrival — the
// phases tighten the numbers, not the test.
//
// Two things every fixture must do, both learned from Task 1:
//   • pass `agentTz: 'UTC'` (argsFor does it for all of them, so it cannot be forgotten) — the
//     conversation-timing and current-time sections render wall-clock text, so a fixture that
//     inherited the host zone would measure a different string outside npm test's TZ=UTC;
//   • run under the frozen clock installed below, for the same reason ("9:59" and "10:00" are not
//     the same length).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPromptSections, formatHistory, type ChatContext } from './shared.js';
import { SECTION_IDS, sectionsTotalChars, type SectionId } from './promptSections.js';
import { PROMPT_BUDGET, MIN_TRANSCRIPT_SHARE, type BudgetKey } from './promptPolicy.js';
import { buildTurnTraceDraft, type MeasuredPrompt, type TranscriptMessage } from '../../diagnostics/turnTrace.js';
import {
  REACTION_TOOL, REMEMBER_USER_TOOL, delegateToOpsTool, SET_PREFERENCE_TOOL, SCHEDULE_AUTOMATION_TOOL,
  LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL, CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL,
  UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL, RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL,
} from './tools.js';
import { INTRO_WEAVE_BLOCK } from '../ops/firstMove.js';
import { renderUserMemory } from '../../memory/wrappers.js';
import { coerceStatus, mergeStatus, type AffectState, type ComputedState } from '../../persona/status.js';
import { computeCycle } from '../../persona/cycle.js';
import { computeCircadian } from '../../persona/circadian.js';
import { defaultClimate, type RelationshipClimate } from '../../persona/climate.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { ThreadTurn } from '../../memory/threadHarvest.js';
import type { TurnFocusInput } from './turnFocus.js';
import type { ActiveOps } from '../../state/opsCoordination.js';
import type { CapabilitySummary } from '../ops/engineBackend.js';
import type { MediumBundle } from '../../memory/mediumTerm.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';
import type { AgentMemory } from '../../db/repositories/memory.js';
import type { LlmToolDef } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// ── a frozen clock ───────────────────────────────────────────────────────────
// Same pin as promptSections.test.ts, and for the same reason: the assembler reads the wall clock
// (`new Date()` for the clock + timing sections, `Date.now()` for the active-ops elapsed labels), so
// a measured size is only reproducible against a stored ceiling with the clock held still. Pinned by
// hand rather than with node:test's MockTimers, which prints an ExperimentalWarning.
const FROZEN_MS = Date.UTC(2026, 0, 6, 2, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const MINUTE = 60_000;
const HANDLE = '+15550001111';

// ── the turn, as a named thing ───────────────────────────────────────────────

/** Everything a fixture varies. Deliberately NOT the 15-argument tuple: a positional list of that
 *  length is where a fixture silently measures the wrong section. */
interface TurnSpec {
  chatContext?: ChatContext;
  contextBlock?: string;
  activeOps?: ActiveOps[];
  extraSection?: string;
  tools?: LlmToolDef[];
  history?: StoredMessage[];
  incomingText?: string;
  affect?: AffectState;
  computed?: ComputedState;
  capability?: CapabilitySummary | null;
  climate?: RelationshipClimate;
  thread?: ThreadTurn;
  introWeave?: string | null;
  turnFocus?: TurnFocusInput;
}

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** The spec as the assembler's argument tuple. `agentTz` is hard-wired to UTC here so no fixture can
 *  forget it (see the file header). */
function argsFor(s: TurnSpec): BuildArgs {
  return [
    s.chatContext, s.contextBlock ?? '', s.activeOps ?? [], s.extraSection, s.tools, s.history,
    s.incomingText, 'UTC', s.affect, s.computed, s.capability ?? null, s.climate, s.thread,
    s.introWeave, s.turnFocus,
  ];
}

// ── the real tool list ───────────────────────────────────────────────────────
// Exactly the list convo/client.ts:228-241 assembles on the hermes lane (the richer of the two: the
// three reminder tools are gated out on openclaw), so the tool_docs ceiling is a production size and
// not a one-tool sketch. The two group tools are appended for the group fixture, as the client does.

const TOOLS_1TO1: LlmToolDef[] = [
  REACTION_TOOL, REMEMBER_USER_TOOL, delegateToOpsTool('hermes'), SET_PREFERENCE_TOOL,
  SCHEDULE_AUTOMATION_TOOL, LIST_AUTOMATIONS_TOOL, CANCEL_AUTOMATION_TOOL,
  CANCEL_RESEARCH_TOOL, UPDATE_DIRECTIVES_TOOL, UPDATE_MEMORY_TOOL, RECALL_MEMORY_TOOL,
];
const TOOLS_GROUP: LlmToolDef[] = [...TOOLS_1TO1, RENAME_CHAT_TOOL, REMOVE_MEMBER_TOOL];

// ── memory stacks, rendered by the real renderer ─────────────────────────────
// The memory stack is the wrapped tier block (preamble → short → medium → discovery → flexible) that
// buildContextBlock puts LAST inside the context block, and it is the fastest-growing part of the
// prompt — hence its own budget line. Rendered here through renderUserMemory (the same pure function
// dossier.ts calls) so `memory_stack` is a measured production string, and spliced into the context
// block exactly the way buildContextBlockWithHot splices it: plain Convo sections first, joined
// with a blank line.

const EMPTY_MEDIUM: MediumBundle = { directives: [], notes: [], facts: {} };

const MATURE_PROFILE: UserProfile = {
  handle: HANDLE,
  name: 'Sam',
  facts: [
    'runs a plant nursery outside bend',
    'has a daughter who plays saturday soccer',
    'fixing up a lake cabin, calls it "the shack"',
    'hard rule: no calls before 10am',
  ],
  firstSeen: Math.floor(FROZEN_MS / 1000) - 270 * 86_400,
  lastSeen: Math.floor(FROZEN_MS / 1000) - 20 * 60,
};

const MATURE_MEDIUM: MediumBundle = {
  directives: [
    { id: 'd1', text: 'keep replies short unless i ask for the detail', createdAt: FROZEN_MS - 90 * 86_400_000 },
    { id: 'd2', text: 'never put anything on a weekday before 10am', createdAt: FROZEN_MS - 40 * 86_400_000 },
    { id: 'd3', text: 'call the nursery "the yard", never "the business"', createdAt: FROZEN_MS - 12 * 86_400_000 },
  ],
  notes: [
    'the cedar order from the north supplier is late and the invoice is disputed',
    'her sister visits the last weekend of every month',
    'the irrigation permit renewal is due before spring',
  ],
  facts: {
    address_as: 'Sam',
    timezone: 'America/Los_Angeles',
    work: 'owns a plant nursery, wholesale and retail',
    style: 'casual, lowercase, short',
  },
};

const MATURE_LEGACY: AgentMemory = { handle: HANDLE, dossierMd: '', prefs: { address_as: 'Sam' } };

/** A dossier at the size the updater is told to keep it ("under ~400 words"), under the canonical
 *  headings — so the flexible tier is measured at its documented ceiling rather than empty. */
const MATURE_LONG_DOC = `## Who they are
Sam. Runs a wholesale-and-retail plant nursery outside Bend, Oregon; six seasonal staff, two vans.
Pacific time. Calls the nursery "the yard".

## How they work
Mornings are for the yard, desk work lands after four. Never wants a call or a slot before 10am on a
weekday — a hard rule, stated twice. Prefers a number and a source over a summary, and will say
"just the number" when a reply runs long. Keeps every supplier thread in one email account and hates
being asked to re-explain a thread she has already forwarded.

## How to text them
Casual, lowercase, short. Reads on the phone between rows, so a wall of text gets skimmed. Fine with
a blunt answer; asks for the reasoning when she wants it. Dislikes exclamation marks and anything
that reads like a newsletter.

## Their world
The cedar order from the north supplier has been late twice this season and the invoice is disputed —
live, and she checks on it most weeks. Fixing up a lake cabin she calls "the shack"; the dock is the
current project. Daughter plays saturday soccer, home games most weeks. Sister visits the last
weekend of every month. An irrigation permit renewal is due before spring and she has been putting
off the paperwork.

## Running jokes
The "budget committee" — her own phrase for the third round of price comparisons. The shack's dock,
which has been "one weekend away" since august.`;

/** The freshest look, hot: ≤45 min old and topically related to the incoming message, so the short
 *  tier renders it in FULL (capped at SHORT_ENTRY_CHARS = 600 by the renderer). Its sibling is older
 *  and collapses to a digest line — the realistic mature shape. */
const MATURE_SHORT: ShortTermEntry[] = [
  {
    id: 's1', agentHandle: HANDLE, kind: 'ops_research', request: 'cedar lead times from the north supplier',
    content: 'The north supplier lists 6-8 weeks on cedar right now, up from 4 in the spring; two of the three regional yards quote the same window and the third is quoting 10. The delay is a mill scheduling backlog rather than raw stock, so partial shipments are possible on request. Freight has not moved. If the order was placed in the first week of december the earliest realistic arrival is mid february, and the disputed invoice line is the expedite fee from the last late shipment, which the supplier has waived twice before when asked in writing.',
    meta: { topicKey: 'cedar' }, createdAt: FROZEN_MS - 12 * MINUTE, expiresAt: FROZEN_MS + 20 * 3600_000,
  },
  {
    id: 's2', agentHandle: HANDLE, kind: 'ops_research', request: 'irrigation permit renewal window',
    content: 'The county renews agricultural irrigation permits between january and march; the form is two pages plus the previous season usage figures, and the fee is unchanged from last year.',
    meta: {}, createdAt: FROZEN_MS - 9 * 3600_000, expiresAt: FROZEN_MS + 14 * 3600_000,
  },
  {
    id: 's3', agentHandle: HANDLE, kind: 'email_flag', request: 'invoice dispute — north supplier',
    content: 'The supplier replied on the disputed expedite fee and wants an answer before the next shipment leaves the mill; they name friday as the cutoff.',
    meta: { from: 'accounts@northsupplier.example', subject: 'RE: invoice 4471', deadlineLabel: 'friday' },
    createdAt: FROZEN_MS - 5 * 3600_000, expiresAt: FROZEN_MS + 18 * 3600_000,
  },
];

/** The turn text the hot look above is measured against — the short tier only renders a look in full
 *  when it shares a salient token with what they just said (memory/topicality.ts). */
const MATURE_TURN_TEXT = 'so are the cedars coming or not';

const MATURE_STACK = renderUserMemory('convo', {
  profile: MATURE_PROFILE, memory: MATURE_LEGACY, medium: MATURE_MEDIUM,
  short: MATURE_SHORT, longDocMd: MATURE_LONG_DOC,
}, FROZEN_MS, { audience: 'individual', currentTurnText: MATURE_TURN_TEXT });

/** Nothing on file at all — the cold install. Renders the biggest version of the discovery scaffold
 *  and the default operating stance, which is the point: a thin profile is not a small prompt. */
const COLD_STACK = renderUserMemory('convo', {
  profile: null, memory: null, medium: EMPTY_MEDIUM, short: [], longDocMd: '',
}, FROZEN_MS, { audience: 'individual', currentTurnText: 'hey' });

const MEDIA_SHORT: ShortTermEntry[] = [
  {
    id: 'm1', agentHandle: HANDLE, kind: 'media_analysis', request: 'the lease pdf they just sent',
    content: 'A 9-page commercial lease for the second yard. Term is five years from march 1 with one five-year option, notice ninety days. Base rent 4,200/month with a 3% annual escalator, plus a triple-net share of taxes and insurance estimated at 900/month. The option period rent is "market as agreed", which is the line worth pushing on. Personal guarantee on page 7 covers the first two years only. No exclusivity clause; the landlord may lease the adjacent bay to another nursery.',
    meta: { topicKey: 'lease' }, createdAt: FROZEN_MS - 3 * MINUTE, expiresAt: FROZEN_MS + 23 * 3600_000,
  },
];

const MEDIA_STACK = renderUserMemory('convo', {
  profile: MATURE_PROFILE, memory: MATURE_LEGACY, medium: MATURE_MEDIUM,
  short: MEDIA_SHORT, longDocMd: MATURE_LONG_DOC,
}, FROZEN_MS, { audience: 'individual', currentTurnText: 'the lease pdf, can you read it' });

const GROUP_STACK = renderUserMemory('convo', {
  profile: { handle: 'group:nursery', name: null, facts: [], firstSeen: MATURE_PROFILE.firstSeen, lastSeen: MATURE_PROFILE.lastSeen },
  memory: null, medium: { directives: [], notes: ['the crew agreed no yard photos in the chat'], facts: {} },
  short: [], longDocMd: '## Who they are\nThe nursery crew: Sam (owner), Ada (deliveries), Theo (weekends).',
}, FROZEN_MS, { audience: 'group', currentTurnText: 'did the cedars land' });

/** The plain Convo section that leads the context block ("## How long you've known them" — dossier.ts
 *  renderTenure). Written out because renderTenure is module-private; the stack below it is what the
 *  memory_stack budget line covers. */
const TENURE = `## How long you've known them\nYou've been talking with them for about 9 months, and you last spoke earlier today.\nThis is soft context for warmth only — a long-time contact is a regular, a brand-new one gets a lighter touch. Don't recite these dates back to them.`;

const contextBlockWith = (stack: string) => `${TENURE}\n\n${stack}`;

// ── the rest of the per-turn inputs ──────────────────────────────────────────

const COMPUTED: ComputedState = {
  cycle: computeCycle(Date.UTC(2026, 0, 1), FROZEN_MS),
  circadian: computeCircadian(FROZEN_MS, 'UTC'),
};

function affect(): AffectState {
  const emitted = coerceStatus({
    mood_core: 'joyful', mood_label: 'hopeful', mood_level: 72,
    anxiety: 30, warmth: 80, social_battery: 65, rapport: 55, conviction: 60,
    engagement: 70, patience: 75, intent_mode: 'sharing_update', epistemic_trigger: 'logic_valid',
    meta_prompt: 'they seem upbeat, keep it light and follow their lead',
    profile_note: 'warm, forward-looking', terminal_closure: false,
  })!;
  return { last: mergeStatus(emitted, COMPUTED, 0), moodHistory: [{ level: 72, core: 'joyful', label: 'hopeful', at: 0 }] };
}

/** A climate that has actually moved — at defaults the weather block renders no climate lines. */
const MOVED_CLIMATE: RelationshipClimate = {
  ...defaultClimate(), dials: { ease: 70, candor: 80, playfulness: 60 }, evalCount: 30,
};

const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft',
  note: 'they keep landing back on shipping fast versus doing it right, and it comes up whenever a supplier slips',
};

const ACTIVE_OPS: ActiveOps[] = [
  {
    taskId: 'op1', kind: 'media_analysis', request: 'read the lease pdf they just sent',
    startedAt: FROZEN_MS - 40_000, firstStartedAt: FROZEN_MS - 40_000,
    lastMilestone: 'engine', estimateMs: 120_000, estimatePhrase: 'a couple minutes',
  },
  {
    taskId: 'op2', kind: 'web_research', request: 'commercial lease option-period norms in bend',
    startedAt: FROZEN_MS - 8_000, firstStartedAt: FROZEN_MS - 8_000,
    lastMilestone: 'queued', estimateMs: 180_000, estimatePhrase: 'a few minutes',
  },
];

/** The caller addendum the live turn actually passes: the one-off version note
 *  (update/announce.ts claimPendingUpdateNote — private to that module, so the text is mirrored
 *  here with a stand-in build sha of the same length). */
const UPDATE_NOTE = `## Passing note — you have an upgrade waiting\nA new version of you (build 4f2a91c) is ready for the server you run on. Somewhere natural in THIS reply, mention it once — your own words, one short bubble at most: you've got an upgrade ready, and they can apply it by running \`bash scripts/update.sh\` in your install folder and then restarting you (relay that command exactly, in backticks). Never frame it as a system announcement or read it like a changelog. If this exact moment is the wrong time — they're mid-crisis or asking something urgent — skip it; this note won't come back.`;

/** The media note convo/client.ts folds into the turn text when a file arrives (describeAttachments,
 *  private to that module — mirrored here for the photo case). */
const MEDIA_NOTE = `[they attached a document — the contents aren't unpacked into this note. to see/read what's inside, open it with delegate_to_ops (media_scope "this_turn"); that IS you looking. never guess at what's inside before opening it, and NEVER tell them you can't see/open it.]`;

// ── histories ────────────────────────────────────────────────────────────────

/** A real texting exchange, cycled to whatever length a fixture asks for, so a 40-row history is a
 *  plausible transcript rather than forty copies of one line — the transcript's SIZE is the thing
 *  under measurement, and it has to be an honest size. Alternating and even-length, so the roles
 *  keep alternating across the seam when it repeats. */
const TEXTS: Array<[StoredMessage['role'], string]> = [
  ['user', 'morning, any word on the cedars'],
  ['assistant', 'nothing new since yesterday'],
  ['user', 'the north supplier said two weeks three weeks ago'],
  ['assistant', 'i know. want me to chase the mill schedule instead?'],
  ['user', 'yeah do that'],
  ['assistant', 'on it'],
  ['user', 'also the dock boards came in warped'],
  ['assistant', 'the whole pallet or a few?'],
  ['user', 'maybe six of them'],
  ['assistant', 'that is a return, not a sanding job'],
  ['user', 'ok. soccer is at ten on saturday btw'],
  ['assistant', 'noted, nothing before eleven then'],
  ['user', 'thanks'],
  ['assistant', 'the mill says the backlog is scheduling, not stock'],
  ['user', 'so partial shipments are possible'],
  ['assistant', 'they will do it if you ask in writing'],
  ['user', 'draft that for me later'],
  ['assistant', 'sure. after four?'],
  ['user', 'perfect'],
  ['assistant', 'and the expedite fee is the disputed line, not the freight'],
];

function history(rows: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  // Built newest-first and unshifted, so the finished array is in send order with the freshest row
  // last — the shape the store returns, and the shape both timing reads assume. It therefore ends on
  // one of HER bubbles, which is what gives the reply-order read a run of her own sends to point at.
  for (let i = 0; i < rows; i++) {
    const [role, content] = TEXTS[TEXTS.length - 1 - (i % TEXTS.length)];
    out.unshift({
      role, content,
      handle: role === 'user' ? HANDLE : undefined,
      at: FROZEN_MS - (20 + i * 7) * MINUTE,
    });
  }
  return out;
}

const HISTORY_40 = history(40);
const HISTORY_6 = history(6);
const HISTORY_12 = history(12);

// ── the five fixtures ────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  spec: TurnSpec;
  /** The wrapped memory tiers inside this fixture's context block (the `memory_stack` budget line),
   *  or null for a turn that carries no memory block at all. */
  memoryStack: string | null;
  /** Every section this turn is expected to assemble, in order — so a fixture that silently stops
   *  exercising a section (and stops measuring its ceiling) fails instead of passing quietly. */
  sections: SectionId[];
}

const FIXTURES: Fixture[] = [
  {
    // 1. COLD, thin profile: her first reply ever to this person. No name, nothing on file, the
    // install introduction riding their own opener.
    name: 'cold thin profile',
    spec: {
      chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE },
      contextBlock: COLD_STACK,
      tools: TOOLS_1TO1,
      history: [],
      incomingText: 'hey',
      introWeave: INTRO_WEAVE_BLOCK,
      turnFocus: { text: 'hey', hits: [] },
    },
    memoryStack: COLD_STACK,
    sections: [
      'persona', 'tool_docs', 'model_map', 'name_nudge', 'intro_weave', 'context_block',
      'current_time', 'conversation_timing', 'turn_focus', 'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 2. MATURE profile, plain question: nine months of history, a full memory stack, a hot look,
    // her weather — and the 40-row transcript window the live turn actually sends. This is the
    // fixture MIN_TRANSCRIPT_SHARE is measured on.
    name: 'mature profile, plain question',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      tools: TOOLS_1TO1,
      history: HISTORY_40,
      incomingText: MATURE_TURN_TEXT,
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      turnFocus: { text: MATURE_TURN_TEXT, hits: [{ label: 'cedar lead times from the north supplier', source: 'research' }] },
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'context_block', 'current_time',
      'weather', 'status_contract', 'conversation_timing', 'reply_order', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 3. MEDIA turn: a file arrived, two looks are already running, and their message queued behind
    // the chat lock while she was sending — so the reply-order read is the backward-order variant.
    name: 'media turn with research already running',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
        arrivals: [{ receivedAt: FROZEN_MS - 90_000, sendsAfterArrival: 2 }],
      },
      contextBlock: contextBlockWith(MEDIA_STACK),
      activeOps: ACTIVE_OPS,
      tools: TOOLS_1TO1,
      history: HISTORY_6,
      incomingText: `the lease pdf, can you read it ${MEDIA_NOTE}`,
      computed: COMPUTED,
      capability: { classes: ['web', 'files', 'media'], complete: false },
      turnFocus: {
        text: `the lease pdf, can you read it ${MEDIA_NOTE}`,
        hits: [{ label: 'the lease pdf they just sent', source: 'research' }],
      },
    },
    memoryStack: MEDIA_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'context_block', 'active_ops',
      'current_time', 'weather', 'status_contract', 'conversation_timing', 'reply_order', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 4. BURST + tapped reply, in a group: three texts this turn, and one of them taps an old bubble
    // of hers from before the visible window (the largest tapped-reply variant — it carries the
    // beyond-recall note).
    name: 'burst plus tapped reply in a group',
    spec: {
      chatContext: {
        isGroupChat: true, participantNames: ['Sam', 'Ada', 'Theo'], chatName: 'nursery crew',
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
        repliedTo: {
          kind: 'assistant',
          text: 'the mill quoted six to eight weeks on cedar, and they will split the shipment if you ask in writing',
          sentAtMs: FROZEN_MS - 40 * 86_400_000,
          viaLiveFetch: true,
        },
        burstManifest: [
          { text: 'wait', handle: HANDLE },
          { text: 'this the one you meant?', handle: HANDLE },
          { text: 'ada says the pallet is here', handle: '+15550002222' },
        ],
      },
      contextBlock: contextBlockWith(GROUP_STACK),
      tools: TOOLS_GROUP,
      history: HISTORY_12,
      incomingText: 'this the one you meant?',
      computed: COMPUTED,
      capability: { classes: ['web', 'code'], complete: true },
      turnFocus: { text: 'this the one you meant?', hits: [] },
    },
    memoryStack: GROUP_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'context_block', 'group', 'tapped_reply',
      'burst', 'current_time', 'weather', 'status_contract', 'conversation_timing', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
  },
  {
    // 5. THREAD-OFFER turn: her weather carries one standing theme to (maybe) tag, last turn's offer
    // is still owed a bookkeeping answer, and a version note is riding along as the caller addendum.
    name: 'thread offer with an outcome ask',
    spec: {
      chatContext: {
        isGroupChat: false, participantNames: [], chatName: null,
        senderHandle: HANDLE, senderProfile: MATURE_PROFILE,
      },
      contextBlock: contextBlockWith(MATURE_STACK),
      extraSection: UPDATE_NOTE,
      tools: TOOLS_1TO1,
      history: HISTORY_12,
      incomingText: 'honestly i just want it done right this time',
      affect: affect(),
      computed: COMPUTED,
      capability: { classes: ['web', 'inbox', 'files', 'code', 'media', 'scheduling'], complete: true },
      climate: MOVED_CLIMATE,
      thread: { offer: THEME, outcomeAsk: { label: 'the dock boards', material: 'loop' } },
      turnFocus: {
        text: 'honestly i just want it done right this time',
        hits: [{ label: 'speed vs craft', source: 'thread' }, { label: 'cedar lead times from the north supplier', source: 'research' }],
      },
    },
    memoryStack: MATURE_STACK,
    sections: [
      'persona', 'tool_docs', 'capability', 'model_map', 'context_block', 'current_time',
      'weather', 'status_contract', 'thread', 'conversation_timing', 'reply_order', 'extra', 'turn_focus',
      'behavior_anchor', 'json_anchor',
    ],
  },
];

/** The messages array the live turn sends alongside the prompt: the stored window as the model sees
 *  it, plus this turn's own text (convo/client.ts:248-252). */
function messagesFor(f: Fixture): TranscriptMessage[] {
  const { history: rows = [], incomingText, chatContext } = f.spec;
  return [
    ...formatHistory(rows, chatContext?.isGroupChat ?? false),
    { content: incomingText || '...' },
  ];
}

/** The transcript's share of everything the model read, computed by the SAME code that reports it on
 *  a live turn (diagnostics/turnTrace.ts) rather than by a second copy of the formula. The other
 *  inputs are inert — this reads one number off the prompt measurement. */
function transcriptShare(prompt: MeasuredPrompt, messages: readonly TranscriptMessage[]): number {
  return buildTurnTraceDraft({
    turn: { prompt, messages, gates: { threads: null, memory: { shortHotLook: 'none' }, extras: { updateNote: false, introWeave: false, activeOps: 0 } }, hits: [] },
    affect: { raw: null, coerced: null },
    outcome: { wasEnvelope: true, retried: false, silent: false, toolCalls: [] },
  }).prompt.transcriptShare;
}

// ── the assertions ───────────────────────────────────────────────────────────

test('the fixtures assemble the sections they claim to, and nothing is left unmeasured', () => {
  for (const f of FIXTURES) {
    const names = buildSystemPromptSections(...argsFor(f.spec)).sections.map(s => s.name);
    assert.deepEqual(names, f.sections, f.name);
  }
});

test('the measured sections still account for every character of the prompt', () => {
  // Task 1's arithmetic, reused rather than re-derived: if this fails, the budget below is measuring
  // a prompt whose parts no longer add up, and the ceilings mean nothing.
  for (const f of FIXTURES) {
    const { system, sections } = buildSystemPromptSections(...argsFor(f.spec));
    assert.equal(sectionsTotalChars(sections), system.length, f.name);
  }
});

test('every section of every fixture is inside its budget', () => {
  for (const f of FIXTURES) {
    for (const s of buildSystemPromptSections(...argsFor(f.spec)).sections) {
      const ceiling = PROMPT_BUDGET[s.name];
      assert.ok(
        s.chars <= ceiling,
        `${f.name}: the ${s.name} section is ${s.chars} chars, over its ${ceiling}-char budget (promptPolicy.ts). It grew — shrink it, or ratchet the ceiling deliberately.`,
      );
    }
  }
});

test('the memory stack is inside its budget on every fixture that carries one', () => {
  for (const f of FIXTURES) {
    if (f.memoryStack === null) continue;
    const block = f.spec.contextBlock ?? '';
    assert.ok(block.includes(f.memoryStack), `${f.name}: the stack is really inside the context block`);
    assert.ok(
      f.memoryStack.length <= PROMPT_BUDGET.memory_stack,
      `${f.name}: the memory stack is ${f.memoryStack.length} chars, over its ${PROMPT_BUDGET.memory_stack}-char budget (promptPolicy.ts)`,
    );
  }
});

/** The largest each budget line reaches across the five fixtures — the number its ceiling is meant to
 *  be a rounded-up copy of. `memory_stack` comes off the fixtures' own stacks because it is a part of
 *  `context_block` rather than a section of its own. */
function measuredMaxima(): Map<BudgetKey, number> {
  const max = new Map<BudgetKey, number>();
  const bump = (key: BudgetKey, chars: number) => max.set(key, Math.max(max.get(key) ?? 0, chars));
  for (const f of FIXTURES) {
    for (const s of buildSystemPromptSections(...argsFor(f.spec)).sections) bump(s.name, s.chars);
    if (f.memoryStack !== null) bump('memory_stack', f.memoryStack.length);
  }
  return max;
}

/** How much a ceiling may sit above its measurement: enough to round to a tidy number, not enough to
 *  hide a new block. Stated as a fraction so the big prose lines are held tightest in absolute terms,
 *  which is where an unnoticed arrival would cost the most. */
const MAX_HEADROOM = 0.02;

test('no ceiling carries more than 2% of headroom over what the fixtures measure', () => {
  // The other half of the ratchet, and the half that had no test: the budget above only fails when a
  // section GROWS past its ceiling, so a phase that deletes 3k characters of prose leaves the ceiling
  // where it was and the next arrival lands in the slack for free. This fails instead — a deletion
  // now has to pull its own number down in the same commit, which is the "tightening is a one-line
  // diff" the module was built for.
  //
  // `model_map` is exempt, for the reason promptPolicy.ts gives beside it: its text is built from the
  // host's resolved model map, so a bare checkout and a configured install measure different sizes and
  // a tight ceiling would fail on somebody else's machine. Every other line is deterministic here —
  // fixture data, repo prose, or the frozen clock.
  const measured = measuredMaxima();
  const rows: string[] = [];
  const loose: string[] = [];
  for (const [key, chars] of [...measured].sort((a, b) => b[1] - a[1])) {
    const ceiling = PROMPT_BUDGET[key];
    const headroom = (ceiling - chars) / chars;
    rows.push(`  ${key}: measured ${chars}, ceiling ${ceiling} (+${(headroom * 100).toFixed(1)}%)`);
    if (key === 'model_map') continue;
    if (headroom > MAX_HEADROOM) loose.push(key);
  }
  assert.deepEqual(
    loose, [],
    `these ceilings are cushions rather than measurements — ratchet them down in promptPolicy.ts:\n${rows.join('\n')}`,
  );
});

test('the live conversation keeps its share of the context on a mature turn', () => {
  const f = FIXTURES[1];
  assert.equal(f.name, 'mature profile, plain question');
  const prompt = buildSystemPromptSections(...argsFor(f.spec));
  const messages = messagesFor(f);
  assert.equal(messages.length, 41, 'the 40-row window plus this turn');
  const share = transcriptShare(prompt, messages);
  assert.ok(
    share >= MIN_TRANSCRIPT_SHARE,
    `the transcript is ${share} of the prompt, under the ${MIN_TRANSCRIPT_SHARE} floor (promptPolicy.ts) — the scaffolding grew around the conversation`,
  );
});

test('the transcript floor sits a hair under the measured share, not a phase behind it', () => {
  // The ratchet running the other way, and the same argument as the 2% above: a floor left at an old
  // measurement no longer notices the scaffolding creeping back, because the share can fall by
  // everything the last phase won and still clear it. Same band, read downwards.
  const f = FIXTURES[1];
  assert.equal(f.name, 'mature profile, plain question');
  const share = transcriptShare(buildSystemPromptSections(...argsFor(f.spec)), messagesFor(f));
  assert.ok(
    MIN_TRANSCRIPT_SHARE >= share * (1 - MAX_HEADROOM),
    `the transcript measures ${share} on ${f.name} but the floor stands at ${MIN_TRANSCRIPT_SHARE} — raise it (promptPolicy.ts) so the share the last phase bought is the share that is held`,
  );
});

test('every budget line was measured on a fixture, so no ceiling is invented', () => {
  const seen = new Set<BudgetKey>(FIXTURES.flatMap(f => buildSystemPromptSections(...argsFor(f.spec)).sections.map(s => s.name)));
  if (FIXTURES.some(f => f.memoryStack !== null)) seen.add('memory_stack');
  for (const key of Object.keys(PROMPT_BUDGET) as BudgetKey[]) {
    assert.ok(seen.has(key), `PROMPT_BUDGET.${key} has a ceiling but no fixture renders it — measure it or drop the line`);
  }
  for (const id of SECTION_IDS) {
    assert.ok(id in PROMPT_BUDGET, `the ${id} section has no budget line`);
  }
});

test('a default install adds no weather and no thread — the no-regression pin', () => {
  // The two features that render nothing until something has actually happened: no computed state
  // (so no internal weather), a default climate, and an empty thread inventory. That is the shape an
  // install where neither feature ever engaged assembles — and the pin is stronger than "no section
  // was pushed": handing the assembler a default climate and an empty inventory must produce the
  // SAME BYTES as never passing them at all, which is what makes both features free until used.
  const base: TurnSpec = {
    chatContext: { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: MATURE_PROFILE },
    contextBlock: contextBlockWith(MATURE_STACK),
    tools: TOOLS_1TO1,
    history: HISTORY_12,
    incomingText: MATURE_TURN_TEXT,
    turnFocus: { text: MATURE_TURN_TEXT, hits: [] },
  };
  const dormant = buildSystemPromptSections(...argsFor({
    ...base, climate: defaultClimate(), thread: { offer: null, outcomeAsk: null },
  }));
  const names = dormant.sections.map(s => s.name);
  assert.ok(!names.includes('weather'), 'no computed state and a default climate render no weather block');
  assert.ok(!names.includes('thread'), 'an empty thread inventory renders no thread block');

  const neverHadThem = buildSystemPromptSections(...argsFor(base));
  assert.equal(dormant.system, neverHadThem.system, 'a dormant climate and inventory cost the prompt nothing');
});


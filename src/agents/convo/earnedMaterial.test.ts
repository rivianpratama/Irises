// The earned material, WIRED. persona/moments.test.ts and memory/thesisEngine.test.ts own the
// arithmetic; memory/momentsHarvest.test.ts and memory/thesisRewrite.test.ts own the two passes;
// this file owns what happens around them on a real turn — which store is read before the prompt is
// built, which section the read lands in, when a moment is allowed out and what it costs, and what
// `/forget` takes with it.
//
// Two seams, two shapes of test. The assembler is pure, so the section cases are argument tuples.
// The pre-read that decides what the assembler is handed lives in convo/client.ts, so those cases
// drive `chat` itself through its own injected lane (the hookWiring/forgetEngine precedent).
process.env.TZ = 'UTC';
process.env.DATA_BACKEND = 'memory';

import fs from 'node:fs';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildSystemPromptSections, type ChatContext, type PersonaTurn } from './shared.js';
import { chat } from './client.js';
import { clearIdleClassifyCache } from './idleClassify.js';
import { HOOK_HEADING, MOMENTS_LEAD, MOMENT_IDLE_INTERVAL, type HookDirective } from '../../persona/hooks.js';
import { saveHookState, getHookState } from '../../db/repositories/hookState.js';
import { readMoments, writeMoments } from '../../db/repositories/moments.js';
import { bumpForgetEpoch, withHandleLock } from '../../db/repositories/memory.js';
import { memoriesDir } from '../../db/stateDir.js';
import { getThesis, saveThesis, appendThesisEvidence, THESIS_REWRITE_WRITER } from '../../db/repositories/thesis.js';
import { THESIS_SECTION_HEADING, splitThesisDoc, renderThesisSection } from '../../memory/thesisEngine.js';
import { resetStorageForTests } from '../../db/sqlite.js';
import { emptyMedia } from '../../webhook/types.js';
import { __resetOpsCoordination } from '../../state/opsCoordination.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import type { MomentEntry } from '../../persona/moments.js';
import type { LlmRequest, LlmResult } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// A frozen clock, for the reason hookWiring.test.ts installs one: the assembler reads the wall clock,
// and the sampler's seed is `now`.
//
// TUESDAY AFTERNOON rather than 2am, and the hour is load-bearing here only in what it keeps OUT of
// the assembled prompt. Two of the files that drive `chat` end to end pin 02:00, which
// `computeCircadian` reads as `dead_night` and `compileAffect` turns into `lateNight` — a register
// flag that adds one line about the size of the reply and changes nothing the sampler does
// (persona/hooks.ts `selectHook` has no clock branch at all). On that clock every rendered hooks
// section here would carry the late line, which is prose this file is not about. Every age band
// below is computed off differences from this instant (`FROZEN_MS - 10 * DAY`), so moving the hour
// moves nothing else.
const FROZEN_MS = Date.UTC(2026, 0, 6, 14, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...((args.length ? args : [FROZEN_MS]) as unknown as [number]));
  }
  static now(): number { return FROZEN_MS; }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

// NO LANE. Every model call here is injected at the seam or must fail: the idle classifier is a real
// `callLLM`, and with blank keys it throws instantly and the gate reads `unclear` → a task turn,
// which is the failing-toward-task behaviour the design rests on. File-local (one process per file).
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.OPENROUTER_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const SENDER = '+15550002222';

beforeEach(() => {
  resetStorageForTests();
  __resetOpsCoordination();
  clearTraces();
  clearIdleClassifyCache();
  delete process.env.CONVO_HOOKS_ENABLED;
  delete process.env.MEMORY_MOMENTS_ENABLED;
  delete process.env.MEMORY_THESIS_ENABLED;
});

// ── the two sections through the assembler ───────────────────────────────────

const PROFILE: UserProfile = {
  handle: SENDER, name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2,
};
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: SENDER, at: Date.UTC(2026, 0, 6, 1, 40) },
  { role: 'assistant', content: 'six to eight weeks from the north supplier', at: Date.UTC(2026, 0, 6, 1, 42) },
];
const READ = 'They decide fast on things that cost money and slowly on things that cost a conversation. They would rather re-do a job than ask anyone to fix it.';
const MOMENT_LINE = '- (habit, last week) checked the volcano dashboard again and decided nothing';

const HOOK: HookDirective = {
  idle: true, mode: 'hook', forbidden: [], lateNight: false, moments: true, offerAllowed: true,
};

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

function build(personaTurn?: PersonaTurn): BuildArgs {
  return [
    { isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, senderProfile: PROFILE },
    '## Who you are talking to\nSam, three months in.', [], undefined, undefined, HISTORY, 'hmm', 'UTC',
    undefined, undefined, null, undefined, undefined, undefined,
    { text: 'hmm', hits: [] }, undefined, personaTurn,
  ];
}

test('the rendered read lands in the thesis section, and the evidence tail never does', () => {
  // The caller hands in the section already rendered, and `renderThesisSection` splits the document
  // again on its way through — the tail is the weekly pass's private input.
  const withNotes = `${READ}\n\n## evidence\n- a note the nightly pass left`;
  const section = renderThesisSection(withNotes);
  const { system } = buildSystemPromptSections(...build({ hooks: null, moments: [], thesis: section }));
  assert.ok(system.includes(THESIS_SECTION_HEADING));
  assert.ok(system.includes(READ));
  assert.ok(!system.includes('a note the nightly pass left'), 'the notes are not prompt material');
});

test('a moment line rides inside the hooks block ONLY when the directive opened the lead', () => {
  const open = buildSystemPromptSections(...build({ hooks: HOOK, moments: [MOMENT_LINE], thesis: '' }));
  assert.ok(open.system.includes(MOMENTS_LEAD));
  assert.ok(open.system.includes(MOMENT_LINE));

  // The gate is the DIRECTIVE, not the sample: a closed lead makes the sample dead weight, which is
  // why `selectHook` decides it and the renderer only obeys.
  const shut = buildSystemPromptSections(...build({ hooks: { ...HOOK, moments: false }, moments: [MOMENT_LINE], thesis: '' }));
  assert.ok(shut.system.includes(HOOK_HEADING), 'still a hook turn');
  assert.ok(!shut.system.includes(MOMENTS_LEAD));
  assert.ok(!shut.system.includes(MOMENT_LINE));

  // …and a task turn renders neither, whatever it was handed.
  const task = buildSystemPromptSections(...build({
    hooks: { ...HOOK, idle: false, mode: 'task', offerAllowed: false }, moments: [MOMENT_LINE], thesis: '',
  }));
  assert.ok(!task.system.includes(MOMENT_LINE));
});

// ── the client seam: a REAL turn ─────────────────────────────────────────────

function fakeLane(res: LlmResult): { seen: LlmRequest[]; call: (req: LlmRequest) => Promise<LlmResult> } {
  const seen: LlmRequest[] = [];
  return { seen, call: async (req: LlmRequest) => { seen.push(req); return res; } };
}

const clientCtx = (over: Partial<ChatContext> = {}): ChatContext => ({
  isGroupChat: false, participantNames: [], chatName: null, senderHandle: SENDER, ...over,
});

/** One reply as the lane hands it back under `toolsViaJson`. */
function envelope(bubbles: string[]): LlmResult {
  return {
    text: JSON.stringify({
      confidence_level: 85,
      tool_calls: null,
      bubbles: bubbles.map(text => ({ text, re: null })),
      status: {
        mood_label: 'content', mood_shift: 'steady', intent_mode: 'sharing_update',
        terminal_closure: false, epistemic_trigger: 'none', meta_prompt: 'let it be quiet',
      },
    }),
    toolCalls: [], stopReason: 'end_turn', truncated: false, provider: 'anthropic', model: 'test',
  };
}

const receipt = (label: string) =>
  getTraces().find(e => e.type === 'event' && e.label === label)?.detail as Record<string, unknown> | undefined;

function moment(over: Partial<MomentEntry> = {}): MomentEntry {
  return {
    id: 'mo-1', text: 'checked the volcano dashboard again and decided nothing', tag: 'habit',
    // Ten days back: the 7–14 day band `momentAgeWords` renders as "last week", and inside
    // `MOMENT_OLD_MS`, so this row is drawn from the recency half of the sample.
    at: FROZEN_MS - 10 * DAY, count: 2, offered: 0, lastOfferedAt: 0, ...over,
  };
}

/** The ledger row an idle turn needs before the sampler is allowed to offer anything: the spacing
 *  interval spent, so `selectHook` opens `moments`. */
async function primeSpacing(chatId: string): Promise<void> {
  await saveHookState(chatId, SENDER, {
    lastKinds: ['none'], idleStreak: 2, idleSinceMoment: MOMENT_IDLE_INTERVAL, updatedAt: FROZEN_MS - 1000,
  });
}

test('her read reaches the prompt on a real turn, off the store, behind the dossier', async () => {
  assert.equal(await saveThesis(SENDER, READ, 0, THESIS_REWRITE_WRITER), 1);
  assert.notEqual(await appendThesisEvidence(SENDER, 'a note nobody but the weekly pass may read'), null);

  const { seen, call } = fakeLane(envelope(['six to eight weeks, same as last time']));
  await chat(randomUUID(), 'any word on the cedars', emptyMedia(), clientCtx(), call);

  const system = seen[0].system ?? '';
  assert.ok(system.includes(THESIS_SECTION_HEADING), 'the section rendered');
  assert.ok(system.includes(READ));
  assert.ok(!system.includes('a note nobody but the weekly pass may read'));
  assert.ok(system.indexOf('## Who you are talking to') < system.indexOf(THESIS_SECTION_HEADING),
    'what she THINKS follows what she knows');
});

test('with the thesis flag OFF the store is never read and nothing renders', async () => {
  process.env.MEMORY_THESIS_ENABLED = 'off';
  assert.equal(await saveThesis(SENDER, READ, 0, THESIS_REWRITE_WRITER), 1);
  const { seen, call } = fakeLane(envelope(['six to eight weeks']));
  await chat(randomUUID(), 'any word on the cedars', emptyMedia(), clientCtx(), call);
  const system = seen[0].system ?? '';
  assert.ok(!system.includes(THESIS_SECTION_HEADING));
  assert.ok(!system.includes(READ));
});

test('an idle turn with the spacing spent is OFFERED a moment, and the offer is billed', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  assert.equal(await writeMoments(SENDER, [moment()], FROZEN_MS - DAY, []), true);

  const { seen, call } = fakeLane(envelope(['still no volcano?']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  const system = seen[0].system ?? '';
  assert.ok(system.includes(MOMENTS_LEAD), 'the lead reached the prompt');
  assert.ok(system.includes('- (habit, last week) checked the volcano dashboard again and decided nothing'));
  assert.deepEqual(receipt('moments:offer'), { offered: 1, rendered: 1, held: 1, excluded: 0 });

  // Billed on the OFFER, not on the use: the model may decline every moment it was handed, and
  // billing only what she reached for would let the same one ride out on every idle turn.
  const file = await readMoments(SENDER);
  assert.equal(file.entries[0].offered, 1);
  assert.equal(file.entries[0].lastOfferedAt, FROZEN_MS);
  assert.equal(file.lastHarvestAt, FROZEN_MS - DAY, 'the harvest clock is not the offer\'s to move');
  // …and the ledger's spacing counter resets off the same answer, so the next four idle turns carry
  // no moment at all.
  assert.equal((await getHookState(chatId)).idleSinceMoment, 0);
});

test('a moment offered in the last day is held back, and the turn renders no lead at all', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  assert.equal(await writeMoments(SENDER, [moment({ offered: 1, lastOfferedAt: FROZEN_MS - 3600_000 })], 0, []), true);

  const { seen, call } = fakeLane(envelope(['mm']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  const system = seen[0].system ?? '';
  assert.ok(system.includes(HOOK_HEADING), 'still an idle hook turn');
  assert.ok(!system.includes(MOMENTS_LEAD), 'the same callback twice in a day is a bot with one anecdote');
  // THE HEALTHY NO-OP, receipted. The sampler ran, drew nothing, and says so in numbers: the one
  // episode on file was held out by the 24-hour window. A sampler that stopped running and a sampler
  // that keeps finding nothing are otherwise the same silence from the ring, and they are fixed in
  // different places.
  assert.deepEqual(receipt('moments:offer'), { offered: 0, rendered: 0, held: 1, excluded: 1 });
  assert.equal((await getHookState(chatId)).idleSinceMoment, MOMENT_IDLE_INTERVAL + 1, 'the counter keeps climbing');
});

test('a moment that renders to nothing is not an offer, and is billed for nothing', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  // What the store hands back from a segment that is only an annotation line — a hand edit, or a
  // half-written file: `parseSegment` keeps the id, the tag and the clock, which are the three
  // things it refuses to guess, and gives back an empty text. The sampler draws it like any other
  // row and `renderMomentLines` then drops it, so NOTHING was put in front of her this turn.
  assert.equal(await writeMoments(SENDER, [moment({ text: '' })], FROZEN_MS - DAY, []), true);
  assert.equal((await readMoments(SENDER)).entries[0].text, '', 'the empty row really does round-trip');

  const { seen, call } = fakeLane(envelope(['mm']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  const system = seen[0].system ?? '';
  assert.ok(system.includes(HOOK_HEADING), 'still an idle hook turn');
  assert.ok(!system.includes(MOMENTS_LEAD), 'no lead, because there was no line to lead with');
  // Drawn but not rendered, and the two numbers say exactly that — which is the reading a bare
  // "there was no offer" could not give. Nothing is billed either way (below).
  assert.deepEqual(receipt('moments:offer'), { offered: 1, rendered: 0, held: 1, excluded: 0 });
  const file = await readMoments(SENDER);
  assert.equal(file.entries[0].offered, 0, 'and nothing was billed');
  assert.equal(file.entries[0].lastOfferedAt, 0);
  // The counter keeps climbing, so the next real moment is not four idle turns away.
  assert.equal((await getHookState(chatId)).idleSinceMoment, MOMENT_IDLE_INTERVAL + 1);
});

test('an unreadable MOMENTS.md offers nothing, writes nothing, and says which silence it is', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  // A directory where the file should be: present, and unreadable in a way no ENOENT check catches
  // (db/repositories/moments.test.ts uses the same fixture). A degraded read is NOT an empty file,
  // and this branch would WRITE — billing what a mangled file happened to parse would rewrite it
  // from that fragment, in the one tier that archives nothing.
  fs.mkdirSync(path.join(memoriesDir(SENDER), 'MOMENTS.md'), { recursive: true });
  const realError = console.error;
  console.error = () => {};
  let system: string;
  try {
    const lane = fakeLane(envelope(['mm']));
    await chat(chatId, 'hey', emptyMedia(), clientCtx(), lane.call);
    system = lane.seen[0].system ?? '';
  } finally {
    console.error = realError;
  }
  assert.ok(system.includes(HOOK_HEADING), 'still an idle hook turn');
  assert.ok(!system.includes(MOMENTS_LEAD));
  // Its OWN skip, not the four numbers: "the file would not read" and "the file had nothing to give"
  // are the same silence in the prompt and completely different problems on the box.
  assert.deepEqual(receipt('moments:offer'), { skipped: 'degraded' });
  assert.ok(fs.statSync(path.join(memoriesDir(SENDER), 'MOMENTS.md')).isDirectory(),
    'and the unreadable thing is left exactly as it was');
});

test('a /forget landing between the read and the bill refuses the bill', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  assert.equal(await writeMoments(SENDER, [moment()], FROZEN_MS - DAY, []), true);

  // The bill is fire-and-forget and takes the handle lock, so holding that lock is what makes this
  // race a test rather than a coin flip: `chat` reads the epoch and the file, renders the lead,
  // issues the write — and the write queues behind us. The wipe lands while it waits.
  //
  // What the fence compares is the epoch read BEFORE the file, which is the whole reason it is a
  // fence at all: an epoch read after the file would be compared against itself and could only ever
  // match, and a wipe landing in that window would be undone by a bill built from the pre-forget
  // file — in the one tier with no archive to get anything back from.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const lock = withHandleLock(SENDER, async () => {
    await held;
    bumpForgetEpoch(SENDER);
  });

  const { seen, call } = fakeLane(envelope(['still no volcano?']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);
  assert.ok((seen[0].system ?? '').includes(MOMENTS_LEAD), 'the offer really was made this turn');

  const realWarn = console.warn;
  console.warn = () => {};
  try {
    release();
    await lock;
    // One more trip through the lock: the queued bill runs before anything we enqueue after it.
    await withHandleLock(SENDER, async () => {});
  } finally {
    console.warn = realWarn;
  }

  const file = await readMoments(SENDER);
  assert.equal(file.entries[0]?.offered, 0, 'the bill was refused, so nothing was stamped');
  assert.equal(file.entries[0]?.lastOfferedAt, 0);
});

test('a TASK turn is offered nothing, whatever the file holds', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  assert.equal(await writeMoments(SENDER, [moment()], 0, []), true);

  const { seen, call } = fakeLane(envelope(['six to eight weeks, same as last time']));
  await chat(chatId, 'deploy the cedars order', emptyMedia(), clientCtx(), call);

  assert.ok(!(seen[0].system ?? '').includes(MOMENTS_LEAD));
  assert.equal(receipt('moments:offer'), undefined);
  assert.equal((await readMoments(SENDER)).entries[0].offered, 0, 'nothing was billed');
});

test('with the moments flag OFF the file is never read and nothing is billed', async () => {
  process.env.MEMORY_MOMENTS_ENABLED = 'off';
  const chatId = randomUUID();
  await primeSpacing(chatId);
  assert.equal(await writeMoments(SENDER, [moment()], 0, []), true);

  const { seen, call } = fakeLane(envelope(['mm']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx(), call);

  assert.ok(!(seen[0].system ?? '').includes(MOMENTS_LEAD));
  assert.equal(receipt('moments:offer'), undefined);
  assert.equal((await readMoments(SENDER)).entries[0].offered, 0);
});

test('a GROUP room is offered no moment and gets no read — every per-person store is fenced off a room', async () => {
  const chatId = randomUUID();
  await primeSpacing(chatId);
  // Written under the SENDER's own handle; a room reads the group pseudo-handle and must not see it.
  assert.equal(await writeMoments(SENDER, [moment()], 0, []), true);
  assert.equal(await saveThesis(SENDER, READ, 0, THESIS_REWRITE_WRITER), 1);

  const { seen, call } = fakeLane(envelope(['mm']));
  await chat(chatId, 'hey', emptyMedia(), clientCtx({ isGroupChat: true, participantNames: ['Sam', 'Jo'] }), call);

  const system = seen[0].system ?? '';
  assert.ok(!system.includes(MOMENTS_LEAD));
  assert.ok(!system.includes(THESIS_SECTION_HEADING));
  assert.equal((await readMoments(SENDER)).entries[0].offered, 0);
});

test('/forget wipes both stores', async () => {
  assert.equal(await writeMoments(SENDER, [moment()], FROZEN_MS - DAY, []), true);
  assert.equal(await saveThesis(SENDER, READ, 0, THESIS_REWRITE_WRITER), 1);

  const { call } = fakeLane(envelope(['done']));
  await chat(randomUUID(), '/forget me', emptyMedia(), clientCtx(), call);

  const file = await readMoments(SENDER);
  assert.deepEqual(file.entries, [], 'the diary is gone, and nothing archived it');
  // The wipe STAMPS the harvest clock rather than resetting it: /forget does not clear the
  // transcript, so an open window would re-mint the same moments before morning.
  assert.equal(file.lastHarvestAt, FROZEN_MS);
  assert.equal(splitThesisDoc((await getThesis(SENDER))?.docMd ?? '').thesis, '', 'the read is gone');
});

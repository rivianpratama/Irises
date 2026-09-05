// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The craft modules: eight pages of Convo's persona that only some turns need.
//
// Until P4a/P4b every one of them was a section of Context.md, which means every one of them was in
// front of the model on every turn — the send-order read on a turn with no history, the burst
// tradecraft on a single message, nine thousand characters of onboarding craft nine months into a
// relationship, nine thousand more on how to tag a thread on a turn with no thread on offer. They
// are now files under convo/craft/, each behind a STRUCTURAL gate (a fact about this turn, never a
// judgement about it), and this file holds two very different claims about them.
//
// The first is the relocation itself: not one byte of that prose changed. The golden below
// reconstructs the pre-change Context.md from what is on disk now — the shrunken Context.md with
// every module spliced back where it came from — and compares its length and its sha256 against the
// numbers measured before the move. A rewrite dressed as a move fails there.
//
// P4b's delegate shrink DID delete prose, which is why that reconstruction also puts back an
// enumerated list of deletions before it hashes. The two lists are what keeps the golden readable as
// evidence: what moved is pinned byte for byte, and what left is written down sentence by sentence.
//
// The second is the gates: which modules a turn loads, and that the ones it doesn't are reported
// with the fact they read. Those are unit assertions over `renderCraftModules`, plus the placement
// check through the real assembler at the bottom.
process.env.TZ = 'UTC';
// The last test runs a whole turn through the front door, which reads and writes the stores.
process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  CRAFT_MODULES, renderCraftModules, craftModuleText, convoPersonaWithCraft, personaModulesEnabled,
  type CraftModuleId, type ModuleGateInput,
} from './personaModules.js';
import { buildSystemPromptSections, convoPersonaChars, type ChatContext } from './shared.js';
import { chat } from './client.js';
import { addShortTerm } from '../../db/repositories/memoryShort.js';
import { emptyMedia } from '../../webhook/types.js';
import { loadContext } from '../loadContext.js';
import { SCHEDULE_AUTOMATION_TOOL, REACTION_TOOL, REMEMBER_USER_TOOL } from './tools.js';
import type { ThreadCandidate } from '../../persona/threads.js';
import type { LlmResult, LlmToolDef } from '../../llm/types.js';
import type { StoredMessage, UserProfile } from '../../db/types.js';

// ── the relocation golden ────────────────────────────────────────────────────

/**
 * Context.md as it stood the moment before P4a cut it up: 137,923 characters, and the sha256 of
 * exactly the string `loadContext('convo')` returned then (the file's contents, trimmed).
 *
 * Measured on the pre-change file, not derived from anything in this commit — which is what makes
 * the reconstruction below evidence rather than a tautology.
 */
const PRE_CHANGE_CHARS = 137_923;
const PRE_CHANGE_SHA256 = 'ac0faa6f9ce66afa216f860327b12a6b0567c3b606831912b1c29a8dd884cfc1';

/**
 * Where each module's prose sat, so the golden can put it back: the FIRST LINE of whatever followed
 * it (a section heading for P4a's seven pages, the paragraph that came next for P4b's threading
 * craft — each unique in the file, which the reconstruction re-checks), and whether a `---` rule sat
 * between the two. Three modules were consecutive ahead of "When to delegate", two ahead of "Quick
 * math", which is why the reconstruction walks this list in order.
 *
 * `slice` is for a page assembled out of MORE than one home. P4b cut two runs out of "Connect the
 * dots": the long run of thread paragraphs, which became craft/threading.md, and the automations
 * paragraph eighteen lines further down — which reads on reminder-edit turns, not thread turns, and
 * so lives at the end of craft/reminders.md instead. That page therefore has a row each: its
 * original section, and this tail.
 *
 * This table exists for ONE commit's worth of evidence. It is not part of the registry: nothing at
 * runtime needs to know where a module used to live (personaModules.ts), and the day this test is
 * the only reader left is the day the relocation is finished being checked.
 */
const RELOCATION: ReadonlyArray<{ id: CraftModuleId; before: string; rule: boolean; slice?: 'head' | 'tail' }> = [
  { id: 'threading', before: "**When unsure, don't — that's the default, not a fallback.**", rule: false },
  { id: 'reminders', before: '**What you never do with what you know:**', rule: false, slice: 'tail' },
  { id: 'tapped_reply', before: '## When to delegate (and how)', rule: true },
  { id: 'send_order', before: '## When to delegate (and how)', rule: true },
  { id: 'burst_re', before: '## When to delegate (and how)', rule: true },
  { id: 'reminders', before: '## Learning how they want you to work (preferences)', rule: true },
  { id: 'email_flag', before: "## When they reference something you don't remember (forgot → re-ask → flag)", rule: true },
  { id: 'onboarding', before: '## Quick math and definitions (inline)', rule: true },
  { id: 'attachments', before: '## Quick math and definitions (inline)', rule: false },
];

/**
 * Prose ADDED to Context.md by the relocations, and the reason this golden has an addition list at
 * all. Each is removed before hashing, so the pin measures the relocation and nothing else.
 *
 * 1. P4a: the modules render inside `<prompt>`, where the persona's own trust boundary says plain
 *    guidance is her system talking to her — so the boundary section now says out loud that a craft
 *    page is one of those, arriving only on the turns that need it.
 * 2. P4b: the one-line pointer left standing where the playful-thread paragraph was, because the
 *    thread craft is now gated and the BANTER craft below it is not. It has to say both things: the
 *    threading page comes with a thread, and the bend itself is always hers.
 * 3. Run control: the delegate section is where the persona names what can be DONE to a look, and
 *    until steer_research there was only one thing (drop it). NOT a relocation — the only addition
 *    here that isn't — so it is listed for the same reason the other two are: this golden measures
 *    the relocation, and prose that arrived for another reason must be taken back out before it can.
 * 4. The reply-language slot: §Language's two bullets became three, because the language she replies
 *    in is no longer a directive the model may or may not remember to rewrite — it is a code-owned
 *    standing setting (memory/standingSettings.ts) that renders as the Reply language line in the
 *    addressing header, and the section has to say which memory sets it, that an explicit ask beats
 *    it, and that it is saved the same turn through set_preference. The two bullets it replaced are
 *    in DELETED_PROSE below, which is what keeps this a net measurement rather than an assertion.
 * 5. …and one sentence in the preferences section, because the write route it teaches now has an
 *    exception: everything durable still goes through update_directives, a language does not.
 */
const ADDED_PROSE: readonly string[] = [
  ' A few of those plain blocks are your own craft pages: the guidance on one specific move — reading send order, answering a burst, an attachment, getting to know someone new — arrives only on the turns that need it, and it carries the same weight as this file.',
  '**A thread can wear the joke — when you are carrying one.** The whole craft of picking a thread up — which material, how a fact callback sounds, the ladder, the tag and its shorthand, and how a tease and a thread ride in one line — arrives as its own page on the turns a thread is actually on offer. The bend itself is always yours: "Roasts and teasing" is right below.\n\n',
  '**A look already running can still be reached.** `cancel_research` drops it when they say stop; steer_research is its sibling: when they add to or correct a lookup that\'s already running, pass the addition along instead of starting over — the run keeps going with it folded in.\n\n',
  "- **Mirror the moment, when nothing is set.** With no Reply language line in your memory, a message that arrives fully in another language gets its reply in that language for that exchange — snapping back to English on someone who just texted you in Spanish is rude. A borrowed word or two inside an English message is not a switch. Once a Reply language is set, it wins: you stay in it until they ask for another.\n- **An explicit ask sets the standing default — and you save it the same turn, every time.** \"can we do spanish\" / \"háblame en español\" / \"reply in Tagalog from now on\" / \"back to english\" → say sure (in that language) and call `set_preference` with key `reply_language` and the language named in English (e.g. \"Spanish\", \"English\"). That one setting replaces whatever language was set before, everywhere you reach them — reminders, email flags, and the answers you send after a longer look included. Never save a language as a rule with `update_directives`; never leave the old language standing.\n- **The Reply language line is the only memory that sets your language.** On the turn they ask, also fill `status.language_request` with the language they named (null on every other turn). Until the save lands, their ask in this conversation beats the stored line. What the long-term doc says about how THEY write — they code-switch, they text in two languages — is a fact about them, never an instruction to you.\n",
  " The one exception is language: a language ask is a standing setting, saved with `set_preference` key `reply_language`, never a directive.",
];

/**
 * Prose DELETED from the persona by P4b's delegate-section shrink, and where each row goes back.
 *
 * "When to delegate (and how)" taught the delegate tool's own doc back to the model in longer words.
 * That doc (tools.ts DELEGATE_TO_OPS_TOOL) is not optional and not conditional: client.ts puts
 * delegate_to_ops in the tool list on EVERY turn, so its description, its `kind` enum and its
 * `meta_prompt` skeleton reach the model every turn whatever the persona says. Every row below is a
 * sentence — or a contiguous run of them — whose content that doc already ships; the task's report
 * lists each sentence beside its twin.
 *
 * Each row carries the exact bytes that left the file plus a surviving ANCHOR and the side of it they
 * sat on, which is what lets the golden below put them back and keep measuring the relocation. So
 * this list is not documentation of the shrink, it IS the shrink: a sentence deleted and not listed
 * here makes the reconstruction come up short, and a row listed but not deleted makes it come up
 * long. Restored in file order — each anchor is unique in the file at the moment its row is reached.
 */
const DELETED_PROSE: ReadonlyArray<{ id: string; gone: string; at: string; side: 'after' | 'before' }> = [
  {
    id: 'language_two_bullets',
    gone: "- **Mirror the moment.** If their message arrives in another language, reply in that language for that exchange — snapping back to English on someone who just texted you in Spanish is rude. Same texting voice, same bubble rules, same texture calibration, just their language.\n- **An explicit ask sets the standing default.** \"can we do spanish\" / \"háblame en español\" / \"reply in Tagalog from now on\" → say sure (in that language) and save it with `update_directives` (op `add`, e.g. \"always reply in Spanish\") so every future conversation — and every other way you reach them, reminders and email flags included — honors it. If they switch back or ask for English again, `update` or `remove` that directive.\n",
    at: "English is your default. Two rules on top of it:\n\n",
    side: 'after',
  },
  {
    id: 'when_to_delegate_opener',
    gone: [
      'Only delegate when the answer needs the web, their own email, a file they sent, a drafted message, or genuinely deeper reasoning. Otherwise answer yourself.',
      '',
      '',
    ].join('\n'),
    at: [
      '## When to delegate (and how)',
      '',
      '',
    ].join('\n'),
    side: 'after',
  },
  {
    id: 'holding_text_specific',
    gone: 'The text should reflect the real request: the specific thing, the message they mentioned, the question they asked. Let that drive the wording. ',
    at: 'It can be 1--3 bubbles:',
    side: 'before',
  },
  {
    id: 'holding_text_examples',
    gone: [
      '',
      '',
      '  Example range (illustrative, not a menu, generate fresh every time):',
      '  1 bubble: "looking up those reviews now"',
      '  2 bubbles: "let me dig into that" / "checking the latest on it now"',
      '  2 bubbles: "lemme find that email" / "scanning your inbox now"',
      '  3 bubbles: "okay that\'s a real question" / "thinking that through now" / "back in a bit"',
      '  3 bubbles: "on the case" / "pulling options, prices, and reviews" / "won\'t take long"',
    ].join('\n'),
    at: 'not from a formula.',
    side: 'after',
  },
  {
    id: 'meta_prompt_skeleton_rule',
    gone: '**Write the `meta_prompt` as a skeleton of labeled lines** — plain prose, in the order below, and OMIT any line that doesn\'t apply. It is not fill-in-the-blank boilerplate: drop what\'s irrelevant, never pad, and keep it a clear brief to a sharp colleague, not Irises\'s texting voice. ',
    at: 'Ops runs with real tools',
    side: 'before',
  },
  {
    id: 'meta_prompt_labeled_lines',
    gone: [
      ' The lines:',
      '  - `objective:` the outcome in one sentence — what a GREAT answer IS, not the user\'s words re-quoted (the `request` field already carries those).',
      '  - `context:` every disambiguator you hold — the thing in THEIR words plus the alias you know ("the monster" = their thesis), the person\'s full name and role, the budget, the city, the airline, the timeframe. One line of context you already hold saves Ops minutes of guessing and the user a wrong answer.',
      '  - `sources:` the source plan in priority order. **If the answer lives in something THEY sent or own, that outranks the web** — their own email, a thread, a message they showed you — and don\'t let a generic web fact override it. The web is for current or external facts (products, places, prices, how-to, news); their inbox is for their own mail; a draft is a message written for them.',
      '  - `actions:` what Ops should DO beyond reading — parse the file they attached, run code over the data, iterate a chain, set itself a follow-up check — PLUS the hard limits: read-only on their inbox, never send or post anything anywhere, and the deliverable comes back in ANSWER.',
      '  - `depth/eta:` whether this is a quick single-source check or a thorough sweep, and any ETA you already promised the user ("they\'re expecting this in a few minutes — converge fast"). A right-sized run comes back faster and cleaner than an open-ended one.',
      '  - `success:` what the answer must contain and its shape.',
      '  - `forks:` where the ask could split (two Daves, two trips), which reading you chose and why — and the comeback protocol: if the data contradicts it, come back empty-handed with NO RESULT NAMING the candidates rather than answering the wrong one. A named fork comes back as one crisp question to the user; a silent wrong guess comes back as a confident wrong answer.',
    ].join('\n'),
    at: 'so the brief is where you hand it everything you hold.',
    side: 'after',
  },
  {
    id: 'kind_lanes',
    gone: [
      'Intent and kind (these are the five lanes; `media_read` is a sixth — the media mode, covered under "One hand" below):',
      '- `web_research`, current or external facts from the web plus reasoning: products, places, prices, how-to, news, definitions you can\'t just state, anything that needs a real look at the world. Carries web search + reading a specific page. Never their private data.',
      '- `document_read`, read or search the user\'s OWN connected email and its attachments ("what did that email say", "did the reply come in", "find the PDF she sent"). Read-only, their inbox only.',
      '- `draft`, write a message, note, or letter for THEM to send (you relay the draft, you never send it).',
      '- `compute`, the answer needs work DONE, not just found: run code over real data, crunch or convert the contents of a file, produce a table or artifact, or drive a multi-step execution chain. Ops carries the full toolset; your meta_prompt is the spec for the work. NEVER for head-math or a definition — you answer those yourself.',
      '- `general`, any substantive, obscure, or comprehensive request that doesn\'t map cleanly to one kind above, including reasoning across SEVERAL sources combined (the web + their email in one look). Ops carries the full toolset on this kind. Your meta-prompt drives it, always write a strong one (tell Ops what\'s needed, the context, and what a good answer looks like).',
      '',
      '',
    ].join('\n'),
    at: [
      'maybe some options they could think about."',
      '',
      '',
    ].join('\n'),
    side: 'after',
  },
  {
    id: 'media_scope_and_file_reach',
    gone: '`media_scope` says which files ride along: `"this_turn"` for file(s) on this very message (the normal case — a new file goes with the look that reads it), `"earlier"` for a file they sent before this turn that the ask refers back to, `"none"` when no file is involved. It\'s your own eyes and reach: an internal step, never a handoff you name, never a thing you tell them about. The file\'s contents aren\'t unpacked in front of you until the look opens them, so anything whose answer lives INSIDE a file — "what\'s in this?", "read the fine print", a photo of a form, a screenshot to pull numbers off — goes to delegate_to_ops with the file attached, always. ',
    at: 'You never guess at what\'s inside',
    side: 'before',
  },
  {
    id: 'one_call_reads_and_answers',
    gone: 'A message carrying a NEW file plus a question gets ONE delegate_to_ops (`media_scope: "this_turn"`) that reads the file and answers the ask together. ',
    at: '**One delegation per turn.** ',
    side: 'after',
  },
  {
    id: 'source_by_kind',
    gone: 'Current or external facts -> `web_research`. The user\'s own emails, threads, or attachments -> `document_read`. ',
    at: 'Pick the source by where the answer lives. ',
    side: 'after',
  },
  {
    id: 'answer_yourself',
    gone: 'Answer YOURSELF (no delegation): quick math, definitions you know, onboarding, casual talk, and harmless off-topic. Head-math and a definition you know stay YOURS — a quick sum or "what does X mean" is NEVER a `compute` delegation; `compute` is only for work that genuinely needs doing over real data, a file, or a multi-step chain. ',
    at: 'Anything inside a photo or file',
    side: 'before',
  },
];

/** craft/onboarding.md carries a second half that never lived in Context.md: the texture coaching P2
 *  took out of the discovery scaffold (memory/wrappers.ts), which used to render on every turn of a
 *  thin profile. It starts at this line, and the reconstruction stops there. */
const ONBOARDING_LOCAL_HALF = '# Getting to know a new person (the onboarding craft)';

/** craft/threading.md's own heading, which no section of Context.md ever had (the prose lived under
 *  "Connect the dots"), and the paragraph craft/reminders.md carries at its end — the second run
 *  P4b cut out of that same section. */
const THREADING_HEADING = '## Picking up a thread of theirs (you are carrying one this turn)\n\n';
const AUTOMATIONS_TAIL = '**Tweaking automations — their history is the spec.**';

/** The part of a module that came out of Context.md: all of it for the six single-home pages, and
 *  the named half for the two that are assembled out of more than their relocated prose. */
function relocatedPart(id: CraftModuleId, slice?: 'head' | 'tail'): string {
  const text = craftModuleText(id);
  if (id === 'onboarding') {
    const at = text.indexOf(ONBOARDING_LOCAL_HALF);
    assert.ok(at > 0, 'craft/onboarding.md still marks where its second half begins');
    return text.slice(0, at).trimEnd();
  }
  if (id === 'threading') {
    // The heading is the page's own; everything under it is relocated prose.
    assert.ok(text.startsWith(THREADING_HEADING), 'craft/threading.md still opens on its own heading');
    return text.slice(THREADING_HEADING.length);
  }
  if (id === 'reminders') {
    const at = text.indexOf(AUTOMATIONS_TAIL);
    assert.ok(at > 0, 'craft/reminders.md still ends on the automations paragraph it took from further up');
    return slice === 'tail' ? text.slice(at) : text.slice(0, at).trimEnd();
  }
  return text;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('the persona plus every craft module is the pre-change Context.md, byte for byte', () => {
  let rebuilt = loadContext('convo');

  for (const added of ADDED_PROSE) {
    const without = rebuilt.replace(added, '');
    assert.notEqual(without, rebuilt, `this addition is no longer in the persona: ${JSON.stringify(added.slice(0, 60))}…`);
    rebuilt = without;
  }

  for (const { id, gone, at, side } of DELETED_PROSE) {
    const seen = rebuilt.split(at).length - 1;
    assert.equal(seen, 1, `${id}: its restore anchor is in the persona ${seen} times, not once (${JSON.stringify(at.slice(0, 50))}…)`);
    const found = rebuilt.indexOf(at);
    const cut = side === 'after' ? found + at.length : found;
    rebuilt = `${rebuilt.slice(0, cut)}${gone}${rebuilt.slice(cut)}`;
  }

  for (const { id, before, rule, slice } of RELOCATION) {
    const anchor = `\n${before}`;
    const at = rebuilt.indexOf(anchor);
    assert.ok(at > 0, `${id}: what it used to sit above is gone from Context.md (${before})`);
    assert.equal(rebuilt.indexOf(anchor), rebuilt.lastIndexOf(anchor), `${id}: its anchor line is not unique any more`);
    rebuilt = `${rebuilt.slice(0, at + 1)}${relocatedPart(id, slice)}${rule ? '\n\n---\n\n' : '\n\n'}${rebuilt.slice(at + 1)}`;
  }

  assert.equal(
    rebuilt.length, PRE_CHANGE_CHARS,
    `the relocation gained or lost ${rebuilt.length - PRE_CHANGE_CHARS} characters. A relocation moves prose and edits none of it — if a module was really edited, that is a deliberate change, and it belongs in one of the three enumerated lists above.`,
  );
  assert.equal(
    sha256(rebuilt), PRE_CHANGE_SHA256,
    'the reconstruction is the right LENGTH but not the right bytes — something in a moved section was reworded',
  );
});

test('every deleted sentence is really gone, and gone from the craft pages too', () => {
  // The corpus, not Context.md: a sentence "deleted" from the core and quietly carried into a craft
  // page has not been deleted, it has been hidden behind a gate, and the shrink's whole claim is that
  // the delegate tool's own doc already says these things every turn.
  const corpus = convoPersonaWithCraft();
  for (const { id, gone } of DELETED_PROSE) {
    assert.ok(!corpus.includes(gone), `${id}: still in the persona corpus, so it was never deleted`);
  }
  const ids = DELETED_PROSE.map(d => d.id);
  assert.deepEqual([...new Set(ids)], ids, 'two deletion rows share an id');
});

test('the off path puts the same bytes in the cached prefix instead of the block', () => {
  const corpus = convoPersonaWithCraft();
  const persona = loadContext('convo');
  assert.ok(corpus.startsWith(`${persona}\n\n`), 'Context.md still leads the concatenation');
  let expected = persona.length;
  for (const m of CRAFT_MODULES) {
    const text = craftModuleText(m.id);
    assert.equal(corpus.split(text).length - 1, 1, `${m.id} appears exactly once in the concatenation`);
    expected += 2 + text.length; // the `\n\n` join, then the module
  }
  assert.equal(corpus.length, expected, 'the concatenation is the persona plus every module and nothing else');
});

// ── the registry ─────────────────────────────────────────────────────────────

test('the registry is a usable table — unique ids, unique files, every file loads', () => {
  assert.equal(CRAFT_MODULES.length, 8, 'the seven sections P4a relocated, plus P4b\'s threading craft');
  assert.equal(CRAFT_MODULES[0].id, 'threading', 'canonical order: the threading craft came from Context.md ahead of the other seven');
  const ids = CRAFT_MODULES.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
  const files = CRAFT_MODULES.map(m => m.file);
  assert.equal(new Set(files).size, files.length, 'no file is registered twice');
  for (const m of CRAFT_MODULES) {
    assert.match(m.file, /^craft\/[a-z-]+\.md$/, `${m.id}: lives under craft/`);
    const text = craftModuleText(m.id);
    assert.ok(text.startsWith('## '), `${m.id}: opens on its own section heading, so the block reads as one page`);
    assert.ok(text.length > 300, `${m.id}: really loaded (${text.length} chars)`);
    assert.ok(m.gateName.length > 0, `${m.id}: names the structural fact it reads`);
  }
});

// ── the gates ────────────────────────────────────────────────────────────────

const TOOLS_HERMES = [REACTION_TOOL, REMEMBER_USER_TOOL, SCHEDULE_AUTOMATION_TOOL].map(t => t.name);
const TOOLS_OPENCLAW = [REACTION_TOOL, REMEMBER_USER_TOOL].map(t => t.name);

/** Every fact false — the turn that needs no craft at all. */
const NO_FACTS: ModuleGateInput = {
  threadSection: false, replyOrderSection: false, attachmentNote: false, burstSize: 1, toolNames: [],
  tappedReply: false, emailFlag: false, thinProfile: false,
};

const rendered = (ctx: Partial<ModuleGateInput>): CraftModuleId[] =>
  renderCraftModules({ ...NO_FACTS, ...ctx }).modules.filter(m => m.rendered).map(m => m.id);

test('a turn with no structural need loads no craft at all', () => {
  const render = renderCraftModules(NO_FACTS);
  assert.equal(render.text, '', 'nothing rendered, so the section is not pushed');
  assert.deepEqual(render.modules.map(m => m.rendered), Array(CRAFT_MODULES.length).fill(false));
  for (const m of render.modules) assert.equal(m.chars, 0, `${m.id}: a module that did not load costs no characters`);
});

test('each gate turns on exactly its own module', () => {
  assert.deepEqual(rendered({ threadSection: true }), ['threading']);
  assert.deepEqual(rendered({ tappedReply: true }), ['tapped_reply']);
  assert.deepEqual(rendered({ replyOrderSection: true }), ['send_order']);
  assert.deepEqual(rendered({ burstSize: 2 }), ['burst_re']);
  assert.deepEqual(rendered({ toolNames: TOOLS_HERMES }), ['reminders']);
  assert.deepEqual(rendered({ emailFlag: true }), ['email_flag']);
  assert.deepEqual(rendered({ thinProfile: true }), ['onboarding']);
  assert.deepEqual(rendered({ attachmentNote: true }), ['attachments']);
});

test('the burst gate reads a real burst, not a single message', () => {
  assert.deepEqual(rendered({ burstSize: 0 }), []);
  assert.deepEqual(rendered({ burstSize: 1 }), []);
  assert.deepEqual(rendered({ burstSize: 2 }), ['burst_re']);
});

test('the reminder craft follows the reminder tools, so OpenClaw is not taught a tool it lacks', () => {
  // The three reminder tools are gated out on the openclaw lane (convo/client.ts) because they
  // throw there. Teaching the craft of them anyway is how a model promises a reminder that can
  // never fire.
  assert.deepEqual(rendered({ toolNames: TOOLS_OPENCLAW }), []);
  assert.deepEqual(rendered({ toolNames: TOOLS_HERMES }), ['reminders']);
});

test('a skipped module still reports the fact it read', () => {
  const render = renderCraftModules({ ...NO_FACTS, tappedReply: true });
  const gates = new Map(render.modules.map(m => [m.id, m.gate] as const));
  assert.equal(gates.size, CRAFT_MODULES.length, 'every module is on the receipt, loaded or not');
  assert.equal(new Set(gates.values()).size, CRAFT_MODULES.length, 'each module names a different fact — disjoint buckets');
  const skipped = render.modules.filter(m => !m.rendered);
  assert.equal(skipped.length, CRAFT_MODULES.length - 1);
  for (const m of skipped) assert.ok(m.gate.length > 0, `${m.id}: says why it stayed out`);
});

// ── five turns, as a set ─────────────────────────────────────────────────────

test('five representative turns load the craft they structurally need', () => {
  // 1. plain 1:1: a live thread to read the arriving message against, reminders available.
  assert.deepEqual(
    rendered({ replyOrderSection: true, toolNames: TOOLS_HERMES }),
    ['send_order', 'reminders'],
  );
  // 2. media: a file arrived, so the attachment page comes with it.
  assert.deepEqual(
    rendered({ replyOrderSection: true, attachmentNote: true, toolNames: TOOLS_HERMES }),
    ['send_order', 'reminders', 'attachments'],
  );
  // 3. burst + tapped reply: the tapped target suppresses the order read (shared.ts), so send-order
  //    stays out and the two pointer pages come in.
  assert.deepEqual(
    rendered({ tappedReply: true, burstSize: 3, toolNames: TOOLS_HERMES }),
    ['tapped_reply', 'burst_re', 'reminders'],
  );
  // 4. cold thin profile, first ever turn: no history to order, everything still to learn.
  assert.deepEqual(
    rendered({ thinProfile: true, toolNames: TOOLS_HERMES }),
    ['reminders', 'onboarding'],
  );
  // 5. an openclaw install with a flagged email waiting.
  assert.deepEqual(
    rendered({ replyOrderSection: true, emailFlag: true, toolNames: TOOLS_OPENCLAW }),
    ['send_order', 'email_flag'],
  );
  // 6. the thread the engine really offered her this turn — the one turn in five where the tagging
  //    craft has something to tag.
  assert.deepEqual(
    rendered({ threadSection: true, replyOrderSection: true, toolNames: TOOLS_HERMES }),
    ['threading', 'send_order', 'reminders'],
  );
});

test('the rendered text is the loaded modules joined in canonical order, and nothing else', () => {
  const render = renderCraftModules({ ...NO_FACTS, tappedReply: true, burstSize: 2 });
  assert.deepEqual(render.modules.filter(m => m.rendered).map(m => m.id), ['tapped_reply', 'burst_re']);
  assert.equal(render.text, `${craftModuleText('tapped_reply')}\n\n${craftModuleText('burst_re')}`);
  for (const m of render.modules) {
    assert.equal(m.chars, m.rendered ? craftModuleText(m.id).length : 0, `${m.id}: its size on the receipt`);
  }
});

// ── in the assembled prompt ──────────────────────────────────────────────────

const HANDLE = '+15550001111';
const PROFILE: UserProfile = { handle: HANDLE, name: 'Sam', facts: ['runs a nursery'], firstSeen: 1, lastSeen: 2 };
const TOOL: LlmToolDef = SCHEDULE_AUTOMATION_TOOL;
/** One standing theme of theirs, at the rung the thread engine would really hand over. */
const THEME: ThreadCandidate = {
  material: 'theme', rungCeiling: 'pattern', kind: 'tension', id: 't1',
  label: 'speed vs craft', note: 'they keep landing back on shipping fast versus doing it right',
};
const HISTORY: StoredMessage[] = [
  { role: 'user', content: 'any word on the cedars', handle: HANDLE, at: Date.now() - 40 * 60_000 },
  { role: 'assistant', content: 'checking now', at: Date.now() - 38 * 60_000 },
];

type BuildArgs = Parameters<typeof buildSystemPromptSections>;

/** A turn that renders the reply-order read (so send-order loads) and offers the reminder tools. */
const args = (): BuildArgs => [
  { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: PROFILE },
  '', [], undefined, [TOOL], HISTORY, 'so are they coming or not', 'UTC',
  undefined, undefined, null, undefined, undefined, undefined, undefined,
  { attachmentNote: false, emailFlag: false, thinProfile: false },
];

test('the craft section sits right after the tool docs, once, inside the block', () => {
  const { system, sections, craft } = buildSystemPromptSections(...args());
  const names = sections.map(s => s.name);
  assert.equal(names[names.indexOf('tool_docs') + 1], 'craft_modules', 'the craft pages follow the tool docs');

  const text = `${craftModuleText('send_order')}\n\n${craftModuleText('reminders')}`;
  assert.equal(sections.find(s => s.name === 'craft_modules')?.chars, text.length);
  assert.equal(system.split(text).length - 1, 1, 'the craft text is in the prompt exactly once');
  const at = system.indexOf(text);
  // lastIndexOf on both tags: the persona TALKS about `<prompt>`/`</prompt>` in its trust-boundary
  // section, so the first occurrence of either is prose, not the wrapper.
  assert.ok(at > system.lastIndexOf('<prompt>\n'), 'it renders inside the per-turn block');
  assert.ok(at < system.lastIndexOf('\n</prompt>'), 'and before the block closes');
  assert.ok(at > loadContext('convo').length, 'and NOT in the cached persona prefix');

  assert.deepEqual(
    craft.filter(m => m.rendered).map(m => m.id), ['send_order', 'reminders'],
    'the result carries the receipt rows the turn trace reports',
  );
  assert.equal(craft.length, CRAFT_MODULES.length, 'including the six modules this turn did not need');
});

test('the threading craft follows the thread section the engine really rendered, not the mere fact of a thread', () => {
  // The gate is the assembler's own thread block (persona/threads.ts renderThreadForPrompt), so this
  // is the one page whose fact only a build can show: hand the same turn a candidate and the page
  // arrives with the section, hand it none and both stay out together.
  const withThread = args();
  withThread[12] = { offer: THEME, outcomeAsk: null };
  const offered = buildSystemPromptSections(...withThread);
  assert.ok(offered.sections.some(s => s.name === 'thread'), 'the thread section rendered');
  assert.ok(offered.system.includes(craftModuleText('threading')), 'so the tagging craft came with it');
  assert.deepEqual(
    offered.craft.filter(m => m.rendered).map(m => m.id), ['threading', 'send_order', 'reminders'],
  );

  const quiet = buildSystemPromptSections(...args());
  assert.ok(!quiet.sections.some(s => s.name === 'thread'), 'no candidate, no section');
  assert.ok(!quiet.system.includes(craftModuleText('threading')), 'and nine thousand characters of tagging craft stay out');
});

test('an outcome ask alone is enough — the craft is for reading how they took it, too', () => {
  const askOnly = args();
  askOnly[12] = { offer: null, outcomeAsk: { label: 'the dock boards', material: 'loop' } };
  const built = buildSystemPromptSections(...askOnly);
  assert.ok(built.system.includes(craftModuleText('threading')));
});

test('a turn that needs no craft assembles no craft section', () => {
  const { sections } = buildSystemPromptSections(
    { isGroupChat: false, participantNames: [], chatName: null, senderHandle: HANDLE, senderProfile: PROFILE },
    '', [], undefined, [REACTION_TOOL], [], undefined, 'UTC',
  );
  assert.ok(!sections.map(s => s.name).includes('craft_modules'), 'nothing structural, nothing loaded');
});

test('with the flag off the prose is back in the cached prefix and no section is pushed', () => {
  assert.equal(personaModulesEnabled(), true, 'the flag defaults ON');
  process.env.CONVO_PERSONA_MODULES = 'off';
  try {
    assert.equal(personaModulesEnabled(), false);
    const { system, sections, personaChars, craft } = buildSystemPromptSections(...args());
    assert.ok(!sections.map(s => s.name).includes('craft_modules'), 'the section is not pushed on the off path');
    assert.deepEqual(craft, [], 'no registry ran, so there is nothing to report');

    const corpus = convoPersonaWithCraft();
    assert.ok(system.startsWith(`${corpus}\n\n`), 'every module is in the cached prefix instead');
    assert.equal(personaChars, corpus.length, 'the reported persona size is the prefix that is really there');
    assert.equal(convoPersonaChars(), corpus.length, 'and so is the cache-prefix length the lane is told');
    assert.equal(sections.find(s => s.name === 'persona')?.chars, corpus.length);
    for (const m of CRAFT_MODULES) {
      assert.equal(system.split(craftModuleText(m.id)).length - 1, 1, `${m.id} reaches the model exactly once`);
    }
  } finally {
    delete process.env.CONVO_PERSONA_MODULES;
  }
  assert.equal(personaModulesEnabled(), true, 'the flag is restored for the rest of the file');
});

test('on the default path the cached prefix is the shrunken Context.md alone', () => {
  const { system, personaChars } = buildSystemPromptSections(...args());
  assert.equal(personaChars, loadContext('convo').length);
  assert.equal(convoPersonaChars(), loadContext('convo').length);
  assert.ok(system.startsWith(`${loadContext('convo')}\n\n`));
  assert.ok(personaChars < PRE_CHANGE_CHARS, 'the persona really shrank — that is what P4a bought');
});

// ── the plumbing, through the front door ─────────────────────────────────────
//
// Four of the seven gates read facts the assembler computes for itself, and a test against
// `renderCraftModules` covers those completely. The other three arrive from the caller — the
// attachment note convo/client.ts folded into the turn text, and the two reads memory/dossier.ts
// answered — and NOTHING above can see that wiring: hand the assembler a `craftFacts` object and it
// will happily gate on it whether or not any live turn ever fills it in. So this runs a real turn
// through `chat` with the model faked at the lane seam (the routingGate.test.ts pattern) and reads
// the system prompt the lane was handed.

/** A schema-valid envelope, so the turn completes without a retry ladder. */
const fakeReply = (text: string): LlmResult => ({
  text: JSON.stringify({ confidence_level: 90, tool_calls: null, bubbles: [{ text, re: null }] }),
  toolCalls: [], stopReason: 'end_turn', provider: 'anthropic', model: 'test',
});

/** The turn as the front door runs it, returning the system prompt the lane got. */
async function systemFromRealTurn(handle: string, message: string, media = emptyMedia()): Promise<string> {
  const ctx: ChatContext = { isGroupChat: false, participantNames: [], chatName: null, senderHandle: handle };
  let system = '';
  await chat(randomUUID(), message, media, ctx, async req => {
    system = system || req.system;
    return fakeReply('one sec');
  });
  assert.ok(system.length > 1000, 'the lane really got a prompt');
  return system;
}

test('a media turn on a cold profile loads the two pages only the caller can gate', async () => {
  const handle = '+15558030001';
  const media = { ...emptyMedia(), images: [{ url: 'https://example.test/lease.jpg', mimeType: 'image/jpeg' }] };
  const system = await systemFromRealTurn(handle, 'whats this say', media);

  assert.ok(
    system.includes(craftModuleText('attachments')),
    'a file arrived and client.ts folded its note into the turn text, so the attachment page should be in front of her',
  );
  assert.ok(
    system.includes(craftModuleText('onboarding')),
    'nothing is on file for this handle, so getting to know them is still the job',
  );
  assert.ok(
    !system.includes(craftModuleText('email_flag')),
    'nothing is flagged in her short tier, so that page stays out',
  );
});

test('a flagged email in the short tier is what loads the email page, on a turn with no file', async () => {
  const handle = '+15558030002';
  await addShortTerm({
    agentHandle: handle, kind: 'email_flag', request: 'invoice 4471',
    content: 'the supplier wants an answer on the disputed expedite fee before friday',
    meta: { from: 'accounts@northsupplier.example', subject: 'RE: invoice 4471' },
  });
  const system = await systemFromRealTurn(handle, 'did anything come in');

  assert.ok(system.includes(craftModuleText('email_flag')), 'a flag is live, so the page comes with it');
  assert.ok(!system.includes(craftModuleText('attachments')), 'and no file arrived, so that one does not');
});

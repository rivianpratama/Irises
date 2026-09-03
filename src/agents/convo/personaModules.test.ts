// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The craft modules: seven pages of Convo's persona that only some turns need.
//
// Until P4a every one of them was a section of Context.md, which means every one of them was in
// front of the model on every turn — the send-order read on a turn with no history, the burst
// tradecraft on a single message, nine thousand characters of onboarding craft nine months into a
// relationship. They are now files under convo/craft/, each behind a STRUCTURAL gate (a fact about
// this turn, never a judgement about it), and this file holds two very different claims about them.
//
// The first is the relocation itself: not one byte of that prose changed. The golden below
// reconstructs the pre-change Context.md from what is on disk now — the shrunken Context.md with
// every module spliced back where it came from — and compares its length and its sha256 against the
// numbers measured before the move. A rewrite dressed as a move fails there.
//
// The second is the gates: which modules a turn loads, and that the ones it doesn't are reported
// with the fact they read. Those are unit assertions over `renderCraftModules`, plus the placement
// check through the real assembler at the bottom.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CRAFT_MODULES, renderCraftModules, craftModuleText, convoPersonaWithCraft, personaModulesEnabled,
  type CraftModuleId, type ModuleGateInput,
} from './personaModules.js';
import { buildSystemPromptSections, convoPersonaChars } from './shared.js';
import { loadContext } from '../loadContext.js';
import { SCHEDULE_AUTOMATION_TOOL, REACTION_TOOL, REMEMBER_USER_TOOL } from './tools.js';
import type { LlmToolDef } from '../../llm/types.js';
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
 * Where each module's prose sat, so the golden can put it back: the heading of the section that
 * FOLLOWED it (unique in the file — clauseInventory.test.ts holds that), and whether a `---` rule
 * sat between the two. Three modules were consecutive ahead of "When to delegate", two ahead of
 * "Quick math", which is why the reconstruction walks this list in order.
 *
 * This table exists for ONE commit's worth of evidence. It is not part of the registry: nothing at
 * runtime needs to know where a module used to live (personaModules.ts), and the day this test is
 * the only reader left is the day the relocation is finished being checked.
 */
const RELOCATION: ReadonlyArray<{ id: CraftModuleId; before: string; rule: boolean }> = [
  { id: 'tapped_reply', before: '## When to delegate (and how)', rule: true },
  { id: 'send_order', before: '## When to delegate (and how)', rule: true },
  { id: 'burst_re', before: '## When to delegate (and how)', rule: true },
  { id: 'reminders', before: '## Learning how they want you to work (preferences)', rule: true },
  { id: 'email_flag', before: "## When they reference something you don't remember (forgot → re-ask → flag)", rule: true },
  { id: 'onboarding', before: '## Quick math and definitions (inline)', rule: true },
  { id: 'attachments', before: '## Quick math and definitions (inline)', rule: false },
];

/**
 * The one sentence P4a ADDED to Context.md, and the reason this golden has an addition list at all:
 * the modules render inside `<prompt>`, where the persona's own trust boundary says plain guidance
 * is her system talking to her — so the boundary section now says out loud that a craft page is one
 * of those, arriving only on the turns that need it. Removed before hashing, so the pin measures the
 * relocation and nothing else.
 */
const ADDED_PROSE = ' A few of those plain blocks are your own craft pages: the guidance on one specific move — reading send order, answering a burst, an attachment, getting to know someone new — arrives only on the turns that need it, and it carries the same weight as this file.';

/** Prose P4a DELETED from the persona. Empty, deliberately: P4a is a relocation, and P4b is where
 *  anything gets shortened. A row appearing here without a decision behind it is the failure. */
const DELETED_PROSE: readonly string[] = [];

/** craft/onboarding.md carries a second half that never lived in Context.md: the texture coaching P2
 *  took out of the discovery scaffold (memory/wrappers.ts), which used to render on every turn of a
 *  thin profile. It starts at this line, and the reconstruction stops there. */
const ONBOARDING_LOCAL_HALF = '# Getting to know a new person (the onboarding craft)';

/** The part of a module that came out of Context.md — all of it, except for onboarding's local half. */
function relocatedPart(id: CraftModuleId): string {
  const text = craftModuleText(id);
  if (id !== 'onboarding') return text;
  const at = text.indexOf(ONBOARDING_LOCAL_HALF);
  assert.ok(at > 0, 'craft/onboarding.md still marks where its second half begins');
  return text.slice(0, at).trimEnd();
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('the persona plus every craft module is the pre-change Context.md, byte for byte', () => {
  let rebuilt = loadContext('convo');

  const withoutAddition = rebuilt.replace(ADDED_PROSE, '');
  assert.notEqual(withoutAddition, rebuilt, `the added sentence is no longer in the persona: ${JSON.stringify(ADDED_PROSE.slice(0, 60))}…`);
  rebuilt = withoutAddition;

  for (const { id, before, rule } of RELOCATION) {
    const anchor = `\n${before}\n`;
    const at = rebuilt.indexOf(anchor);
    assert.ok(at > 0, `${id}: the section it used to sit above is gone from Context.md (${before})`);
    assert.equal(rebuilt.indexOf(anchor), rebuilt.lastIndexOf(anchor), `${id}: its anchor heading is not unique any more`);
    rebuilt = `${rebuilt.slice(0, at + 1)}${relocatedPart(id)}${rule ? '\n\n---\n\n' : '\n\n'}${rebuilt.slice(at + 1)}`;
  }

  assert.equal(
    rebuilt.length, PRE_CHANGE_CHARS,
    `the relocation gained or lost ${rebuilt.length - PRE_CHANGE_CHARS} characters. P4a moves prose and edits none of it — if a module was really edited, that is a P4b change, and this pin moves with a recorded old→new.`,
  );
  assert.equal(
    sha256(rebuilt), PRE_CHANGE_SHA256,
    'the reconstruction is the right LENGTH but not the right bytes — something in a moved section was reworded',
  );
});

test('nothing was deleted on the way out, and the deletion list says so', () => {
  assert.deepEqual(DELETED_PROSE, [], 'P4a deleted nothing; a row here needs a decision behind it, not a test edit');
  const corpus = convoPersonaWithCraft();
  for (const phrase of DELETED_PROSE) assert.ok(!corpus.includes(phrase), `${phrase} was meant to be deleted`);
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
  assert.equal(CRAFT_MODULES.length, 7, 'the seven sections P4a relocated');
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
  replyOrderSection: false, attachmentNote: false, burstSize: 1, toolNames: [],
  tappedReply: false, emailFlag: false, thinProfile: false,
};

const rendered = (ctx: Partial<ModuleGateInput>): CraftModuleId[] =>
  renderCraftModules({ ...NO_FACTS, ...ctx }).modules.filter(m => m.rendered).map(m => m.id);

test('a turn with no structural need loads no craft at all', () => {
  const render = renderCraftModules(NO_FACTS);
  assert.equal(render.text, '', 'nothing rendered, so the section is not pushed');
  assert.deepEqual(render.modules.map(m => m.rendered), Array(7).fill(false));
  for (const m of render.modules) assert.equal(m.chars, 0, `${m.id}: a module that did not load costs no characters`);
});

test('each gate turns on exactly its own module', () => {
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
  assert.equal(gates.size, 7, 'every module is on the receipt, loaded or not');
  assert.equal(new Set(gates.values()).size, 7, 'each module names a different fact — disjoint buckets');
  const skipped = render.modules.filter(m => !m.rendered);
  assert.equal(skipped.length, 6);
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
  assert.equal(craft.length, 7, 'including the five modules this turn did not need');
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

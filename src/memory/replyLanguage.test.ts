// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
// The ONE dual-store write path for the reply-language slot: the fact row and the pref copy move
// together, the language RULES the old design left standing are superseded pointing at the slot,
// and the legacy fold turns the stale `always reply in Indonesian` on the live instance into a
// dated setting without anyone hand-editing a memory file.
process.env.DATA_BACKEND = 'memory';
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setReplyLanguage, clearReplyLanguage, foldLanguageDirectives, __resetLanguageFoldForTests,
} from './replyLanguage.js';
import { REPLY_LANGUAGE_KEY } from './standingSettings.js';
import { loadMediumBundle } from './mediumTerm.js';
import {
  addDirective, listMediumActive, listMediumAll,
} from '../db/repositories/memoryMedium.js';
import { getMemory } from '../db/repositories/memory.js';

let seq = 0;
function freshHandle(): string {
  return `+1555700${(seq++).toString().padStart(4, '0')}`;
}

const AUG30 = Date.UTC(2026, 7, 30, 11, 9, 27);
const SEP4 = Date.UTC(2026, 8, 4, 14, 52, 0);

/** Seed a row the way August seeded it. The tier stamps `Date.now()` itself, and the fold's whole
 *  job is to carry a directive's OWN date into the slot, so a test that cannot age a row cannot
 *  tell a working fold from one that just stamps today. */
async function addDirectiveAt(handle: string, text: string, at: number) {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await addDirective(handle, text);
  } finally {
    Date.now = real;
  }
}

async function slot(handle: string): Promise<{ value?: string; at?: number; id?: string }> {
  const row = (await listMediumActive(handle, ['fact'])).find(e => e.key === REPLY_LANGUAGE_KEY);
  return { value: row?.body, at: row?.createdAt, id: row?.id };
}

test('setReplyLanguage writes both stores and retires only the language rules', async () => {
  const h = freshHandle();
  const indo = await addDirectiveAt(h, 'always reply in Indonesian', AUG30);
  const sarcasm = await addDirective(h, 'full sarcasm mode always');

  const out = await setReplyLanguage(h, 'English', { source: 'convo', via: 'tool' });

  assert.equal(out.changed, true);
  assert.equal(out.retiredDirectiveIds.length, 1);
  assert.deepEqual(out.retiredDirectiveIds, [indo!.id]);

  const fact = await slot(h);
  assert.equal(fact.value, 'English');
  // The render's factView is prefs-wins, so a value in the fact row alone renders stale forever.
  assert.equal((await getMemory(h))?.prefs[REPLY_LANGUAGE_KEY], 'English');

  const all = await listMediumAll(h);
  const retired = all.find(e => e.id === indo!.id)!;
  assert.equal(retired.status, 'superseded');
  assert.equal(retired.supersededBy, fact.id, 'the retired rule points at the slot that replaced it');
  assert.equal(all.find(e => e.id === sarcasm!.id)!.status, 'active', 'another subject is untouched');
  assert.deepEqual(
    (await listMediumActive(h, ['directive'])).map(e => e.body),
    ['full sarcasm mode always'],
  );
});

test('the same language twice is not a change (and retires nothing the second time)', async () => {
  const h = freshHandle();
  await addDirectiveAt(h, 'always reply in Indonesian', AUG30);
  assert.equal((await setReplyLanguage(h, 'English', { source: 'convo', via: 'fast_path' })).changed, true);

  const again = await setReplyLanguage(h, 'English', { source: 'convo', via: 'fast_path' });
  assert.equal(again.changed, false);
  assert.deepEqual(again.retiredDirectiveIds, []);
  assert.equal((await slot(h)).value, 'English');
});

test('the legacy fold carries the old directive into the slot with the directive OWN date', async () => {
  const h = freshHandle();
  const indo = await addDirectiveAt(h, 'always reply in Indonesian', AUG30);
  await addDirective(h, 'always reply in short sentences'); // a style rule, never a language

  await foldLanguageDirectives(h);

  const fact = await slot(h);
  assert.equal(fact.value, 'Indonesian');
  assert.equal(fact.at, AUG30, 'dated when they asked, not when the fold ran');
  assert.equal((await getMemory(h))?.prefs[REPLY_LANGUAGE_KEY], 'Indonesian');
  assert.equal((await listMediumAll(h)).find(e => e.id === indo!.id)!.status, 'superseded');
  assert.deepEqual(
    (await listMediumActive(h, ['directive'])).map(e => e.body),
    ['always reply in short sentences'],
    'a texture rule keeps standing as a rule',
  );

  // Idempotent at the DATA level, not just via the per-process memo: nothing left to fold.
  __resetLanguageFoldForTests();
  await foldLanguageDirectives(h);
  assert.equal((await slot(h)).at, AUG30);
  assert.equal((await listMediumActive(h, ['fact'])).length, 1);
});

test('the fold never walks a newer setting backwards — it only retires the old rule', async () => {
  const h = freshHandle();
  await setReplyLanguage(h, 'English', { source: 'convo', via: 'tool', at: SEP4 });
  const indo = await addDirectiveAt(h, 'always reply in Indonesian', AUG30);

  __resetLanguageFoldForTests();
  await foldLanguageDirectives(h);

  const fact = await slot(h);
  assert.equal(fact.value, 'English');
  assert.equal(fact.at, SEP4);
  assert.equal((await listMediumAll(h)).find(e => e.id === indo!.id)!.status, 'superseded');
});

test('loadMediumBundle folds a legacy language rule on the way past, once', async () => {
  const h = freshHandle();
  await addDirectiveAt(h, 'always reply in Indonesian', AUG30);
  __resetLanguageFoldForTests();

  const bundle = await loadMediumBundle(h);
  assert.equal(bundle.facts[REPLY_LANGUAGE_KEY], 'Indonesian');
  assert.equal(bundle.factAt?.[REPLY_LANGUAGE_KEY], AUG30);
  assert.deepEqual(bundle.directives.map(d => d.text), [], 'the rule is gone from the same read');
});

test('clearReplyLanguage empties both stores', async () => {
  const h = freshHandle();
  await setReplyLanguage(h, 'Spanish', { source: 'convo', via: 'tag' });
  assert.equal((await slot(h)).value, 'Spanish');

  await clearReplyLanguage(h);

  assert.equal((await slot(h)).value, undefined);
  assert.ok(!(REPLY_LANGUAGE_KEY in ((await getMemory(h))?.prefs ?? {})));
  await clearReplyLanguage(h); // nothing to clear is not an error
});

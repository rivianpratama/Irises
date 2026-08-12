// Coverage for the progress-voice brief builder. buildProgressBrief is pure — it turns a waiting
// moment into the <prompt> block the persona reads. The load-bearing invariants: it always steers
// "don't repeat what's already on screen", it carries NO facts and NO url (it's a wait line, not an
// answer), and the gmail_connect variant points at the separately-sent link without ever typing one.
process.env.DATA_BACKEND = 'memory'; // module transitively imports the db layer; keep it off Supabase

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressBrief } from './voiceInstant.js';

const CTX = 'how to address them: boss';

test('every kind wraps in <prompt>, tags the situation, and steers against repeating', () => {
  for (const kind of ['holding', 'still_on_it', 'heartbeat', 'progress', 'gmail_connect'] as const) {
    const brief = buildProgressBrief({ kind, request: 'owner of 412 maple' }, CTX);
    assert.match(brief, /<prompt>[\s\S]*<\/prompt>/, `${kind}: wrapped in <prompt>`);
    assert.match(brief, /<progress>[\s\S]*<\/progress>/, `${kind}: has a <progress> data tag`);
    assert.match(brief, /never repeat a line already on their screen/i, `${kind}: carries the anti-repeat steer`);
    assert.match(brief, /no facts/i, `${kind}: is a wait line, no facts`);
  }
});

test('holding is framed as the FIRST on-it line and names the hint', () => {
  const brief = buildProgressBrief({ kind: 'holding', request: 'owner of 412 maple', addressHint: '412 maple st' }, CTX);
  assert.match(brief, /first "on it" line/i);
  assert.match(brief, /412 maple st/, 'the address hint is surfaced so the line names the real thing');
});

test('still_on_it and heartbeat both say NOT to repeat the earlier "on it"', () => {
  for (const kind of ['still_on_it', 'heartbeat', 'progress'] as const) {
    const brief = buildProgressBrief({ kind, request: 'the cedar deal' }, CTX);
    assert.match(brief, /do NOT repeat/i, `${kind}: explicit not-repeat instruction`);
  }
});

test('gmail_connect points at the separately-sent link and never embeds a url', () => {
  const brief = buildProgressBrief({ kind: 'gmail_connect', request: 'my inbox for martinez' }, CTX);
  assert.match(brief, /own bubble right after your text/i, 'tells it the link comes separately');
  assert.match(brief, /never type the url/i);
  assert.ok(!/https?:\/\//.test(brief), 'the brief itself must not contain a url');
});

test('the user_context is carried through for addressing/style', () => {
  const brief = buildProgressBrief({ kind: 'holding', request: 'x' }, CTX);
  assert.match(brief, /how to address them: boss/);
});

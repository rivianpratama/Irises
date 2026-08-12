// Run with: npm test   (TZ=UTC tsx --test)
// The per-user history scoper that guards every memory writer's transcript: user rows filter
// to the target handle, assistant rows always pass, legacy null-handle rows pass only in
// single-party windows, and group pseudo-handles bypass filtering entirely (a group identity
// is legitimately multi-party).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeHistoryToUser } from './transcript.js';
import { groupHandle } from './identity.js';
import type { StoredMessage } from '../db/types.js';

const A = '+15550001111';
const B = '+15550002222';

const u = (handle: string | undefined, content: string): StoredMessage =>
  handle ? { role: 'user', content, handle } : { role: 'user', content };
const m = (content: string): StoredMessage => ({ role: 'assistant', content });

test('foreign user rows are dropped, target and assistant rows kept in order', () => {
  const out = scopeHistoryToUser([u(A, 'hey'), m('hi!'), u(B, 'call me Chief'), u(A, 'thanks')], A);
  assert.deepEqual(out.map(x => x.content), ['hey', 'hi!', 'thanks']);
});

test('null-handle user rows are kept when the window has NO foreign handle (legacy 1:1)', () => {
  const out = scopeHistoryToUser([u(undefined, 'old row'), m('hi'), u(A, 'new row')], A);
  assert.deepEqual(out.map(x => x.content), ['old row', 'hi', 'new row']);
});

test('null-handle user rows are dropped once ANY foreign handle appears in the window', () => {
  const out = scopeHistoryToUser([u(undefined, 'unattributed'), u(B, 'foreign'), u(A, 'mine')], A);
  assert.deepEqual(out.map(x => x.content), ['mine']);
});

test('a group pseudo-handle returns the window unchanged', () => {
  const win = [u(A, 'hey'), u(B, 'yo'), m('hi both')];
  assert.deepEqual(scopeHistoryToUser(win, groupHandle('chat-1')), win);
});

test('an all-assistant window survives (nothing to misattribute)', () => {
  const out = scopeHistoryToUser([m('ping'), m('still there?')], A);
  assert.equal(out.length, 2);
});

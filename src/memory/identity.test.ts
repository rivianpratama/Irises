// Run with: npm test   (TZ=UTC tsx --test)
// The memory-identity resolver: 1:1 turns keep the sender's handle; group turns get the
// group's own `group:<chatId>` pseudo-handle (fresh shared identity, no member's personal
// memory). The prefix can never collide with a real transport handle (E.164/email — no ':').
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryHandle, groupHandle, isGroupHandle, GROUP_HANDLE_PREFIX } from './identity.js';

test('1:1 context resolves to the sender handle', () => {
  assert.equal(memoryHandle({ isGroupChat: false, senderHandle: '+15550001111' }, 'chat-1'), '+15550001111');
});

test('group context resolves to the group pseudo-handle regardless of sender', () => {
  assert.equal(memoryHandle({ isGroupChat: true, senderHandle: '+15550001111' }, 'chat-1'), 'group:chat-1');
  assert.equal(memoryHandle({ isGroupChat: true, senderHandle: '+15550002222' }, 'chat-1'), 'group:chat-1', 'same group identity for every member');
  assert.equal(memoryHandle({ isGroupChat: true }, 'chat-1'), 'group:chat-1', 'even with no sender');
});

test('missing context / missing sender resolve to undefined, never a default identity', () => {
  assert.equal(memoryHandle(undefined, 'chat-1'), undefined);
  assert.equal(memoryHandle({ isGroupChat: false }, 'chat-1'), undefined);
});

test('isGroupHandle recognizes exactly the pseudo-handles', () => {
  assert.equal(isGroupHandle(groupHandle('chat-1')), true);
  assert.equal(isGroupHandle('+15550001111'), false);
  assert.equal(isGroupHandle('agent@example.com'), false);
  assert.equal(isGroupHandle(undefined), false);
  assert.equal(isGroupHandle(null), false);
});

test('the prefix cannot collide with E.164 or email handles', () => {
  assert.ok(GROUP_HANDLE_PREFIX.includes(':'), "':' appears in no E.164 number or email address");
  assert.ok(!/^[+\d]/.test(GROUP_HANDLE_PREFIX));
});

// Coverage for the read_chat_attachment lane: the canonical manifest flatten (the tool's index arg
// and the prompt manifest MUST agree), the media-gated tool registration, the executor's honest
// no-media / out-of-range strings, and the <chat_attachments> / <media_analysis> prompt rendering.

process.env.DATA_BACKEND = 'memory';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenChatMedia, toolsForKind, runOpsTool, CHAT_ATTACHMENT_TOOL } from './tools.js';
import { buildTaskPrompt } from './client.js';
import { emptyMedia, type IncomingMedia } from '../../webhook/types.js';
import type { OpsTask, TaskKind } from '../types.js';
import type { ShortTermEntry } from '../../db/repositories/memoryShort.js';

const media = (over: Partial<IncomingMedia> = {}): IncomingMedia => ({ ...emptyMedia(), ...over });

const task = (over: Partial<OpsTask> = {}): OpsTask => ({
  id: 't1', chatId: 'c1', agentHandle: '+15551234567', kind: 'general', request: 'is this price fair?', createdAt: 0, ...over,
});

test('flattenChatMedia: canonical order images → video → audio → docs, empty without media', () => {
  const m = media({
    images: [{ url: 'u1', mimeType: 'image/jpeg' }],
    video: [{ url: 'u2', mimeType: 'video/mp4' }],
    audio: [{ url: 'u3', mimeType: 'audio/mp4' }],
    docs: [{ url: 'u4', mimeType: 'application/pdf', filename: 'agreement.pdf' }],
  });
  const flat = flattenChatMedia(m);
  assert.deepEqual(flat.map(f => f.noun), ['photo/image', 'video', 'voice memo/audio', 'document']);
  assert.equal(flat[3].item.filename, 'agreement.pdf');
  assert.deepEqual(flattenChatMedia(undefined), []);
  assert.deepEqual(flattenChatMedia(media()), []);
});

test('toolsForKind: read_chat_attachment registers only when the task carries chat media — every kind', () => {
  const kinds: TaskKind[] = ['general', 'web_research', 'document_read', 'draft'];
  for (const kind of kinds) {
    const without = toolsForKind(kind).map(t => t.name);
    assert.ok(!without.includes('read_chat_attachment'), `${kind}: absent with no media`);
    const withMedia = toolsForKind(kind, { chatMediaCount: 1 }).map(t => t.name);
    assert.ok(withMedia.includes('read_chat_attachment'), `${kind}: present with media`);
  }
  // and it is deliberately NOT part of the general union by name
  assert.ok(!toolsForKind('general').some(t => t.name === CHAT_ATTACHMENT_TOOL.name));
});

test('executor: honest string when the task carries no media', async () => {
  const out = await runOpsTool('read_chat_attachment', { question: 'what does it say?' }, task());
  assert.match(out.result, /no chat attachments/);
  assert.match(out.result, /ask them to send it/);
});

test('executor: honest string on an out-of-range manifest index', async () => {
  const t = task({ media: media({ images: [{ url: 'u1', mimeType: 'image/jpeg' }] }) });
  const out = await runOpsTool('read_chat_attachment', { attachment: 3, question: 'what?' }, t);
  assert.match(out.result, /no attachment #3/);
  assert.match(out.result, /lists 1 file/);
});

test('buildTaskPrompt: numbered <chat_attachments> manifest with recalled-age framing; absent without media', () => {
  const t = task({
    media: media({
      images: [{ url: 'u1', mimeType: 'image/jpeg' }],
      docs: [{ url: 'u2', mimeType: 'application/pdf', filename: 'agreement.pdf' }],
    }),
    recalledAgeMs: 2 * 60 * 60 * 1000,
  });
  const p = buildTaskPrompt(t);
  assert.match(p, /<chat_attachments>/);
  assert.match(p, /1\. photo\/image \(image\/jpeg\)/);
  assert.match(p, /2\. document "agreement\.pdf" \(application\/pdf\)/);
  assert.match(p, /originally sent/); // recalled framing
  assert.match(p, /read_chat_attachment/);
  assert.ok(!buildTaskPrompt(task()).includes('<chat_attachments>'));
});

test('buildTaskPrompt: <media_analysis> block renders truncated prior reads; absent when none', () => {
  const entry: ShortTermEntry = {
    id: 'e1', agentHandle: '+15551234567', chatId: 'c1', kind: 'media_analysis',
    request: 'what is this agreement?', content: 'page 3 of a service agreement; total $310,000. ' + 'x'.repeat(800),
    meta: {}, createdAt: Date.UTC(2026, 6, 20, 15, 30), expiresAt: Date.UTC(2026, 6, 21, 15, 30),
  };
  const p = buildTaskPrompt(task(), { mediaAnalysis: [entry] });
  assert.match(p, /<media_analysis>/);
  assert.match(p, /they asked "what is this agreement\?"/);
  assert.match(p, /\$310,000/);
  assert.ok(!p.includes('x'.repeat(750)), 'entry content is truncated (~700 chars)');
  assert.ok(!buildTaskPrompt(task()).includes('<media_analysis>'));
  assert.ok(!buildTaskPrompt(task(), { mediaAnalysis: [] }).includes('<media_analysis>'));
});

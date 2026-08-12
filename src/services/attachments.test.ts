import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAttachmentKind, roleForAttachment, backupRoleForAttachment,
  readAttachmentBuffer, readChatAttachment, isImageDenial, NO_IMAGE_SENTINEL,
} from './attachments.js';
import type { fetchVerified } from './linqMedia.js';
import type { ExtractedMedia } from '../webhook/types.js';
import type { LlmRequest, LlmResult } from '../llm/types.js';

// The classifier is what decides whether an attachment reaches a model at all, and via which
// lane. Content magic must win over Gmail's reported mime (which routinely lies — PDFs arrive
// as application/octet-stream), and unopenable formats must fail honestly, never silently.

test('PDF by magic bytes, regardless of reported mime', () => {
  const pdf = Buffer.from('%PDF-1.7\n…');
  assert.equal(detectAttachmentKind(pdf, 'application/octet-stream', 'report.pdf').kind, 'pdf');
  assert.equal(detectAttachmentKind(pdf, undefined, undefined).kind, 'pdf');
  // junk prefix before the header still counts
  assert.equal(detectAttachmentKind(Buffer.from('﻿x\n%PDF-1.4'), 'application/octet-stream').kind, 'pdf');
});

test('declared PDF without magic is still attempted as pdf', () => {
  assert.equal(detectAttachmentKind(Buffer.from('mangled body'), 'application/pdf').kind, 'pdf');
});

test('images by magic: png/jpeg/gif/webp', () => {
  const png = detectAttachmentKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'application/octet-stream', 'photo.png');
  assert.deepEqual(png, { kind: 'image', mediaType: 'image/png' });
  const jpg = detectAttachmentKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  assert.deepEqual(jpg, { kind: 'image', mediaType: 'image/jpeg' });
  const gif = detectAttachmentKind(Buffer.from('GIF89a......'));
  assert.deepEqual(gif, { kind: 'image', mediaType: 'image/gif' });
  const webp = detectAttachmentKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]));
  assert.deepEqual(webp, { kind: 'image', mediaType: 'image/webp' });
});

test('audio by magic and by mime', () => {
  assert.deepEqual(detectAttachmentKind(Buffer.from('ID3\x04rest-of-mp3')), { kind: 'audio', mimeType: 'audio/mpeg' });
  assert.deepEqual(detectAttachmentKind(Buffer.from('OggS......')), { kind: 'audio', mimeType: 'audio/ogg' });
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
  assert.deepEqual(detectAttachmentKind(wav), { kind: 'audio', mimeType: 'audio/wav' });
  // ISO container with an audio brand
  const m4a = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(4)]);
  assert.deepEqual(detectAttachmentKind(m4a), { kind: 'audio', mimeType: 'audio/mp4' });
});

test('video: ISO container defaults to video, webm by EBML magic', () => {
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)]);
  assert.deepEqual(detectAttachmentKind(mp4, 'application/octet-stream', 'walkthrough.mp4'), { kind: 'video', mimeType: 'video/mp4' });
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)]);
  assert.deepEqual(detectAttachmentKind(webm), { kind: 'video', mimeType: 'video/webm' });
});

test('text files by mime, extension, and content heuristic', () => {
  const csv = Buffer.from('address,price\n900 Pine,415000\n');
  assert.equal(detectAttachmentKind(csv, 'text/csv').kind, 'text');
  assert.equal(detectAttachmentKind(csv, 'application/octet-stream', 'comps.csv').kind, 'text');
  // no mime, no extension — readable content alone qualifies
  assert.equal(detectAttachmentKind(csv).kind, 'text');
  assert.equal(detectAttachmentKind(Buffer.from('{"a":1}'), 'application/json').kind, 'text');
});

test('office files are recognized for text conversion — by extension and by mime alone', () => {
  const docx = detectAttachmentKind(Buffer.from('PK\x03\x04rest-of-zip'), 'application/octet-stream', 'contract.docx');
  assert.deepEqual(docx, { kind: 'office', format: 'Word document (.docx)' });
  const xlsx = detectAttachmentKind(Buffer.from('PK\x03\x04rest'), undefined, 'comps.xlsx');
  assert.deepEqual(xlsx, { kind: 'office', format: 'Excel spreadsheet (.xlsx)' });
  // no useful extension — the declared office mime is enough
  const byMime = detectAttachmentKind(Buffer.from('PK\x03\x04rest'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck');
  assert.deepEqual(byMime, { kind: 'office', format: 'PowerPoint deck (.pptx)' });
});

test('plain zip archives and legacy OLE Office files are refused honestly', () => {
  const zip = detectAttachmentKind(Buffer.from('PK\x03\x04rest'), 'application/zip', 'photos.zip');
  assert.equal(zip.kind, 'unsupported');
  assert.match((zip as { reason: string }).reason, /zip archive/);
  const doc = detectAttachmentKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/msword', 'old.doc');
  assert.equal(doc.kind, 'unsupported');
  assert.match((doc as { reason: string }).reason, /legacy Office/);
});

test('binary junk is unsupported, not silently misread as text', () => {
  const junk = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x10, 0x80]);
  assert.equal(detectAttachmentKind(junk, 'application/octet-stream', 'blob.bin').kind, 'unsupported');
});

// Lane routing: the STRONG Ops model reads first wherever it can (pdf/text/office/image);
// audio/video can't enter Ops models at all so they go straight to ops_mm. For images, ops_mm is
// the BACKUP: gpt-5.6 endpoints read normal photos fine but silently DROP degenerate ones (the
// demo corpus's 1×1 stub) and then deny any image arrived — the backup lane (gemini) instead
// honestly describes what it sees ("a blank white square").
test('primary lanes: audio/video → ops_mm; image/pdf/text/office → ops (strong model first)', () => {
  assert.equal(roleForAttachment('image'), 'ops');
  assert.equal(roleForAttachment('audio'), 'ops_mm');
  assert.equal(roleForAttachment('video'), 'ops_mm');
  assert.equal(roleForAttachment('pdf'), 'ops');
  assert.equal(roleForAttachment('text'), 'ops');
  assert.equal(roleForAttachment('office'), 'ops');
});

test('backup lane exists ONLY for images', () => {
  assert.equal(backupRoleForAttachment('image'), 'ops_mm');
  assert.equal(backupRoleForAttachment('audio'), null);
  assert.equal(backupRoleForAttachment('video'), null);
  assert.equal(backupRoleForAttachment('pdf'), null);
  assert.equal(backupRoleForAttachment('text'), null);
  assert.equal(backupRoleForAttachment('office'), null);
});

test('isImageDenial matches the sentinel (with trailing noise) but never a real answer', () => {
  assert.equal(isImageDenial(NO_IMAGE_SENTINEL), true);
  assert.equal(isImageDenial(`  ${NO_IMAGE_SENTINEL}.`), true);
  assert.equal(isImageDenial('This is a photo of a signed addendum for 789 Birch Lane.'), false);
  assert.equal(isImageDenial(`The page mentions ${NO_IMAGE_SENTINEL} as a term.`), false);
});

// ── readAttachmentBuffer primary→backup orchestration (injected llm; no network) ───────────────

const PNG_1PX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // magic only — detect() needs no more
const llmResult = (text: string | null): LlmResult =>
  ({ text, toolCalls: [], stopReason: 'end_turn', provider: 'openrouter', model: 'test' });

function scriptedLlm(script: Array<{ expectRole: string; reply: string | null | Error }>) {
  const calls: Array<{ role: string; label?: string }> = [];
  const llm = async (req: LlmRequest): Promise<LlmResult> => {
    const step = script.shift();
    if (!step) throw new Error('unexpected extra llm call');
    calls.push({ role: req.role, label: req.trace?.label });
    assert.equal(req.role, step.expectRole);
    if (step.reply instanceof Error) throw step.reply;
    return llmResult(step.reply);
  };
  return { llm, calls };
}

test('image read: primary ops answer is returned; backup is never called', async () => {
  const { llm, calls } = scriptedLlm([{ expectRole: 'ops', reply: 'A signed addendum for 789 Birch Lane.' }]);
  const res = await readAttachmentBuffer(PNG_1PX, { question: 'what is this?', filename: 'p.png' }, llm);
  assert.equal(res.status, 'ok');
  assert.match(res.answer ?? '', /Birch/);
  assert.equal(calls.length, 1);
});

test('image read: primary denial sentinel → retried on ops_mm, backup answer wins', async () => {
  const { llm, calls } = scriptedLlm([
    { expectRole: 'ops', reply: `${NO_IMAGE_SENTINEL}` },
    { expectRole: 'ops_mm', reply: 'A completely blank white image.' },
  ]);
  const res = await readAttachmentBuffer(PNG_1PX, { question: 'what is this?' }, llm);
  assert.equal(res.status, 'ok');
  assert.match(res.answer ?? '', /blank/);
  assert.deepEqual(calls.map(c => c.label), ['ops:read_attachment', 'ops:read_attachment:backup']);
});

test('image read: primary throw → backup still answers', async () => {
  const { llm } = scriptedLlm([
    { expectRole: 'ops', reply: new Error('provider 500') },
    { expectRole: 'ops_mm', reply: 'A photo of a porch.' },
  ]);
  const res = await readAttachmentBuffer(PNG_1PX, { question: 'what?' }, llm);
  assert.equal(res.status, 'ok');
  assert.match(res.answer ?? '', /porch/);
});

test('image read: both lanes deny → honest error, never a fake read', async () => {
  const { llm } = scriptedLlm([
    { expectRole: 'ops', reply: NO_IMAGE_SENTINEL },
    { expectRole: 'ops_mm', reply: NO_IMAGE_SENTINEL },
  ]);
  const res = await readAttachmentBuffer(PNG_1PX, { question: 'what?' }, llm);
  assert.equal(res.status, 'error');
  assert.equal(res.answer, null);
  assert.match(res.warning ?? '', /blank or corrupt/);
});

test('text read has no backup: an empty reply is an error, with one single call', async () => {
  const { llm, calls } = scriptedLlm([{ expectRole: 'ops', reply: null }]);
  const res = await readAttachmentBuffer(Buffer.from('hello world'), { question: 'what?', filename: 'x.txt' }, llm);
  assert.equal(res.status, 'error');
  assert.equal(calls.length, 1);
});

// ── readChatAttachment (inbound chat lane: verified fetch → same read engine) ───────────────────

const chatRef = (over: Partial<ExtractedMedia> = {}): ExtractedMedia =>
  ({ url: 'https://cdn.linqapp.com/x.jpg', mimeType: 'image/jpeg', attachmentId: 'att1', filename: 'x.jpg', ...over });
const fetchOk = (buffer: Buffer): typeof fetchVerified =>
  async () => ({ ok: true, media: { base64: buffer.toString('base64'), mime: 'image/jpeg', bytes: buffer.byteLength } });
const fetchLost = (reason: 'expired' | 'oversize' | 'unfetchable'): typeof fetchVerified =>
  async () => ({ ok: false, reason });

test('readChatAttachment: fetched image reads on the strong ops lane with the chat trace label + "texted" framing', async () => {
  const seen: Array<{ role: string; label?: string; text: string }> = [];
  const llm = async (req: LlmRequest): Promise<LlmResult> => {
    const content = req.messages[0].content;
    const text = Array.isArray(content) ? content.map(b => (b.type === 'text' ? b.text : '')).join('\n') : String(content);
    seen.push({ role: req.role, label: req.trace?.label, text });
    return llmResult('A porch with visible wood rot on the left post.');
  };
  const res = await readChatAttachment({ media: chatRef(), question: 'condition?' }, { fetch: fetchOk(PNG_1PX), llm });
  assert.equal(res.status, 'ok');
  assert.match(res.answer ?? '', /porch/);
  assert.equal(seen[0].role, 'ops');
  assert.equal(seen[0].label, 'ops:read_chat_attachment');
  assert.match(seen[0].text, /texted image/);
});

test('readChatAttachment: expired link → honest error telling the agent to ask for a resend', async () => {
  const res = await readChatAttachment({ media: chatRef(), question: 'what?' }, { fetch: fetchLost('expired') });
  assert.equal(res.status, 'error');
  assert.equal(res.answer, null);
  assert.match(res.warning ?? '', /resend/);
});

test('readChatAttachment: oversize → too_large with a smaller-version ask', async () => {
  const res = await readChatAttachment({ media: chatRef(), question: 'what?' }, { fetch: fetchLost('oversize') });
  assert.equal(res.status, 'too_large');
  assert.match(res.warning ?? '', /smaller/);
});

test('readChatAttachment: image denial on ops → the ops_mm backup answers, chat labels throughout', async () => {
  const { llm, calls } = scriptedLlm([
    { expectRole: 'ops', reply: NO_IMAGE_SENTINEL },
    { expectRole: 'ops_mm', reply: 'A blank white square.' },
  ]);
  const res = await readChatAttachment({ media: chatRef(), question: 'what?' }, { fetch: fetchOk(PNG_1PX), llm });
  assert.equal(res.status, 'ok');
  assert.match(res.answer ?? '', /blank/);
  assert.deepEqual(calls.map(c => c.label), ['ops:read_chat_attachment', 'ops:read_chat_attachment:backup']);
});

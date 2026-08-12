import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMediaContent, buildMmPrompt, cannotOpenSummary, cannotProcessSummary, describeLost,
  isMediaRejection, toMmResult, withLostNote, CANNOT_OPEN, CANNOT_PROCESS, MM_FORMAT_ANCHOR,
} from './client.js';
import type { VerifiedFetch, LostFile } from './fetchMedia.js';
import type { FetchedMedia } from '../../llm/inlineMedia.js';
import type { ExtractedMedia, IncomingMedia } from '../../webhook/types.js';
import type { MmParsedReply } from '../../pipeline/bubbleJson.js';
import { isMmTask, type MmTask, type OpsTask } from '../types.js';

// Run on Windows via:  $env:TZ='UTC'; npx tsx --test src/agents/mm/client.test.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const empty: IncomingMedia = { images: [], video: [], audio: [], docs: [] };
const task = (media: Partial<IncomingMedia>): MmTask =>
  ({ id: 't1', chatId: 'c1', agentHandle: 'h', kind: 'media_read', request: 'what is this', media: { ...empty, ...media }, createdAt: 0 });
const fm = (mime = 'image/jpeg'): FetchedMedia => ({ base64: 'QUJD', mime, bytes: 3 });

test('buildMediaContent inlines every kind to base64, in order, with no losses', async () => {
  const media: Partial<IncomingMedia> = {
    images: [{ url: 'https://cdn/i.jpg', mimeType: 'image/jpeg' }],
    video: [{ url: 'https://cdn/v.mp4', mimeType: 'video/mp4' }],
    audio: [{ url: 'https://cdn/a.m4a', mimeType: 'audio/mp4' }],
    docs: [{ url: 'https://cdn/d.pdf', mimeType: 'application/pdf' }],
  };
  const fetch = async (m: ExtractedMedia): Promise<VerifiedFetch> => ({ ok: true, media: fm(m.mimeType) });
  const { content, lost } = await buildMediaContent(task(media), fetch);

  assert.equal(lost.length, 0);
  assert.deepEqual(content.map(b => b.type), ['image', 'video', 'audio', 'document']); // canonical order
  const img = content[0] as Any;
  assert.equal(img.url, 'data:image/jpeg;base64,QUJD'); // image is now a data: URL (boundary inliner no-ops)
  const vid = content[1] as Any;
  assert.equal(vid.data, 'QUJD'); assert.equal(vid.url, undefined);
  const aud = content[2] as Any;
  assert.equal(aud.data, 'QUJD'); assert.equal(aud.format, 'm4a'); // audio/mp4 → m4a
  const doc = content[3] as Any;
  assert.equal(doc.data, 'QUJD'); assert.equal(doc.mediaType, 'application/pdf');
});

test('a file that cannot be loaded lands in `lost` (never silently dropped); the rest still render', async () => {
  const media: Partial<IncomingMedia> = {
    images: [{ url: 'https://cdn/i.jpg', mimeType: 'image/jpeg' }],
    docs: [{ url: 'https://cdn/d.pdf', mimeType: 'application/pdf', filename: 'Inspection.pdf' }],
  };
  const fetch = async (m: ExtractedMedia): Promise<VerifiedFetch> =>
    m.mimeType.startsWith('image/') ? { ok: true, media: fm() } : { ok: false, reason: 'expired' };
  const { content, lost } = await buildMediaContent(task(media), fetch);

  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'image');
  assert.deepEqual(lost, [{ kind: 'document', filename: 'Inspection.pdf', reason: 'expired' }]);
});

test('every file failing → empty content + a complete lost list', async () => {
  const media: Partial<IncomingMedia> = { images: [{ url: 'u', mimeType: 'image/png' }] };
  const fetch = async (): Promise<VerifiedFetch> => ({ ok: false, reason: 'unfetchable' });
  const { content, lost } = await buildMediaContent(task(media), fetch);

  assert.equal(content.length, 0);
  assert.deepEqual(lost, [{ kind: 'photo', filename: undefined, reason: 'unfetchable' }]);
});

test('cannotOpenSummary keeps the CANNOT_OPEN prefix and names the reason', () => {
  assert.equal(cannotOpenSummary([{ kind: 'photo', reason: 'expired' }]), 'could not open the attachment (the link expired)');
  assert.ok(cannotOpenSummary([{ kind: 'document', reason: 'oversize' }]).startsWith(CANNOT_OPEN));
});

test('cannotOpenSummary joins DISTINCT reasons for mixed losses', () => {
  const s = cannotOpenSummary([{ kind: 'photo', reason: 'expired' }, { kind: 'document', reason: 'oversize' }, { kind: 'photo', reason: 'expired' }]);
  assert.equal(s, 'could not open the attachment (the link expired; the file is too large to open)');
});

test('describeLost groups by kind, names a lone file, and pluralizes', () => {
  assert.equal(describeLost([{ kind: 'document', filename: 'A.pdf', reason: 'expired' }]), "the document 'A.pdf'");
  assert.equal(describeLost([{ kind: 'photo', reason: 'expired' }, { kind: 'photo', reason: 'expired' }]), '2 photos');
  assert.equal(describeLost([{ kind: 'photo', reason: 'expired' }, { kind: 'document', reason: 'oversize' }]), 'a photo + a document');
});

test('isMediaRejection: only a 400/422 payload rejection — not auth, not-found, rate-limit, or context-length', () => {
  assert.equal(isMediaRejection({ status: 400, message: 'invalid image data' }), true);
  assert.equal(isMediaRejection({ status: 422 }), true);
  // context-length 400 is NOT a bad file — resending the same bytes can't fix it
  assert.equal(isMediaRejection({ status: 400, message: "This model's maximum context length is 128000 tokens" }), false);
  assert.equal(isMediaRejection({ status: 401 }), false); // bad/expired key — not the file's fault
  assert.equal(isMediaRejection({ status: 403 }), false);
  assert.equal(isMediaRejection({ status: 404 }), false);
  assert.equal(isMediaRejection({ status: 429 }), false);
  assert.equal(isMediaRejection({ status: 500 }), false);
  assert.equal(isMediaRejection(new Error('x')), false);
  assert.equal(isMediaRejection(undefined), false);
});

test('isMmTask narrows only media_read tasks', () => {
  const base: OpsTask = { id: 't', chatId: 'c', agentHandle: 'h', kind: 'general', request: 'x', createdAt: 0 };
  assert.equal(isMmTask(base), false);
  assert.equal(isMmTask({ ...base, kind: 'web_research' }), false);
  assert.equal(isMmTask({ ...base, kind: 'media_read' }), true);
});

// ── toMmResult mapping (parsed envelope → MmResult contract) ─────────────────

const parsedOk = (over: Partial<MmParsedReply> = {}): MmParsedReply => ({
  legacyText: 'quick look done\n---\ntotal reads $310,000', analysis: 'page 3 of a service agreement; total $310,000',
  couldNotOpen: false, wasEnvelope: true, ...over,
});

test('toMmResult: voiced answer → ok with pre-voiced summary + analysis', () => {
  const r = toMmResult(parsedOk(), task({}), []);
  assert.equal(r.status, 'ok');
  assert.equal(r.summary, 'quick look done\n---\ntotal reads $310,000');
  assert.equal(r.analysis, 'page 3 of a service agreement; total $310,000');
});

test('toMmResult: prose slip (no envelope) → transient snag, raw text never ships', () => {
  const r = toMmResult({ legacyText: null, analysis: null, couldNotOpen: false, wasEnvelope: false }, task({}), []);
  assert.equal(r.status, 'error');
  assert.equal(r.summary, 'ran into a problem completing that');
  assert.equal(r.analysis, undefined);
});

test('toMmResult: could_not_open → CANNOT_OPEN sentinel (with the loss reason when known)', () => {
  const plain = toMmResult(parsedOk({ couldNotOpen: true }), task({}), []);
  assert.ok(plain.summary.includes(CANNOT_OPEN));
  const lost: LostFile[] = [{ kind: 'photo', reason: 'expired' }];
  const reasoned = toMmResult(parsedOk({ couldNotOpen: true }), task({}), lost);
  assert.equal(reasoned.summary, 'could not open the attachment (the link expired)');
});

test('toMmResult: valid envelope with no bubbles (not could_not_open) → transient snag, never silence', () => {
  const r = toMmResult(parsedOk({ legacyText: null }), task({}), []);
  assert.equal(r.status, 'error');
  assert.equal(r.summary, 'ran into a problem completing that');
});

test('withLostNote appends the deterministic loss note to analysis (and stands alone when analysis is empty)', () => {
  const lost: LostFile[] = [{ kind: 'document', filename: 'A.pdf', reason: 'expired' }];
  assert.equal(withLostNote('the read', lost), "the read\n[not seen: the document 'A.pdf' — the link expired]");
  assert.equal(withLostNote(null, lost), "[not seen: the document 'A.pdf' — the link expired]");
  assert.equal(withLostNote('the read', []), 'the read');
  const viaResult = toMmResult(parsedOk(), task({}), lost);
  assert.ok(viaResult.analysis!.includes('[not seen:'));
});

// ── buildMmPrompt sections ────────────────────────────────────────────────────

test('buildMmPrompt: ends on the format anchor and data-tags the raw ask', () => {
  const p = buildMmPrompt(task({}), []);
  assert.ok(p.trimEnd().endsWith(MM_FORMAT_ANCHOR));
  assert.ok(p.includes('<user_request>'));
});

test('buildMmPrompt: holding-line continuity renders only when holdingText is set', () => {
  const withHold = buildMmPrompt({ ...task({}), holdingText: 'one sec, opening that' }, []);
  assert.ok(withHold.includes('ALREADY on their screen'));
  assert.ok(withHold.includes('one sec, opening that'));
  assert.ok(!buildMmPrompt(task({}), []).includes('ALREADY on their screen'));
});

test('buildMmPrompt: shaky-confidence caveat renders only under 60', () => {
  assert.ok(buildMmPrompt({ ...task({}), originConfidence: 45 }, []).includes('shaky'));
  assert.ok(!buildMmPrompt({ ...task({}), originConfidence: 80 }, []).includes('shaky'));
});

test('buildMmPrompt: partial-loss note names the missing file and asks for the resend beat', () => {
  const lost: LostFile[] = [{ kind: 'photo', reason: 'unfetchable' }];
  const p = buildMmPrompt(task({}), lost);
  assert.ok(p.includes('NOT seeing'));
  assert.ok(p.includes('a photo'));
  assert.ok(p.includes('resend'));
  assert.ok(!buildMmPrompt(task({}), []).includes('NOT seeing'));
});

test('buildMmPrompt: the thread law renders only when a voice window precedes the message', () => {
  const withThread = buildMmPrompt(task({}), [], '', 6);
  assert.ok(withThread.includes('REGISTER and CONTINUITY only'));
  assert.ok(withThread.includes('NEVER a fact source'));
  assert.ok(withThread.includes('[timestamps]'));
  assert.ok(!buildMmPrompt(task({}), [], '', 0).includes('REGISTER and CONTINUITY only'));
  assert.ok(!buildMmPrompt(task({}), []).includes('REGISTER and CONTINUITY only'));
});

// ── cannotProcessSummary (incapability sentinel) ─────────────────────────────

test('cannotProcessSummary keeps the CANNOT_PROCESS prefix and names audio', () => {
  const s = cannotProcessSummary(task({ audio: [{ url: 'u', mimeType: 'audio/mp4' }] }));
  assert.ok(s.startsWith(CANNOT_PROCESS));
  assert.ok(s.includes('the voice memo'));
});

test('cannotProcessSummary names video', () => {
  const s = cannotProcessSummary(task({ video: [{ url: 'u', mimeType: 'video/mp4' }] }));
  assert.ok(s.includes('the video'));
});

test('cannotProcessSummary pluralizes and joins mixed kinds', () => {
  const s = cannotProcessSummary(task({
    audio: [{ url: 'u', mimeType: 'audio/mp4' }, { url: 'u2', mimeType: 'audio/mp4' }],
    images: [{ url: 'u', mimeType: 'image/jpeg' }],
  }));
  assert.ok(s.includes('2 voice memos'));
  assert.ok(s.includes('the photo'));
  assert.ok(s.includes(' and '));
});

test('cannotProcessSummary with no media falls back to bare sentinel', () => {
  assert.equal(cannotProcessSummary(task({})), CANNOT_PROCESS);
});

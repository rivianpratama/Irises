// General attachment intelligence: open ANY Gmail attachment a model lane can ingest and answer
// a question about it. The STRONG Ops model reads everything it accepts natively — PDFs (via
// OpenRouter's server-side file-parser plugin), inlined text, office files converted to text
// server-side (officeparser), and images (contract photos deserve the stronger reasoning). For
// images, ops_mm — Ops's own multimodal lane (a file-native model on OpenRouter, tuned
// independently from the MM agent) — is the BACKUP when the primary read fails or denies the
// image reached it (gpt-5.6 endpoints drop degenerate images and then deny receipt; see
// roleForAttachment/backupRoleForAttachment). Audio/video can't enter the Ops models at all, so
// they go straight to ops_mm. Formats no lane can open (legacy .doc/.xls, archives, executables)
// fail honestly with a reason the agent can relay — never a hallucinated "read".
import { parseOfficeAsync } from 'officeparser';
import { callLLM } from '../llm/callLLM.js';
import { getAttachment } from './gmail.js';
import { formatFromMime } from '../llm/transcribe.js';
import { fetchVerified, type LostReason } from './linqMedia.js';
import type { LlmContentBlock, LlmRole } from '../llm/types.js';
import type { ExtractedMedia } from '../webhook/types.js';

/** Content check for PDF magic bytes. The header must appear near the start (some generators
 *  prepend a BOM/junk line). Gmail routinely mis-reports PDFs as octet-stream, so this is the
 *  authoritative test after the bytes are fetched. */
function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes('%PDF-');
}

// PDFs: 8MB covers real documents. Sized for token cost, not the provider request cap — a 30MB PDF
// base64s to ~40MB and parses to millions of billed tokens on the ops-role model.
const MAX_DOC_BYTES = Number(process.env.MAX_PDF_BYTES || 8 * 1024 * 1024);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // images/audio/video as base64 data URLs
const MAX_TEXT_CHARS = 120_000;           // decoded text files, truncated with a notice

export type AttachmentKind =
  | { kind: 'pdf' }
  | { kind: 'image'; mediaType: string }
  | { kind: 'audio'; mimeType: string }
  | { kind: 'video'; mimeType: string }
  | { kind: 'text' }
  | { kind: 'office'; format: string } // human-readable format name, e.g. "Word document (.docx)"
  | { kind: 'unsupported'; reason: string };

const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/csv', 'application/x-ndjson',
  'application/rtf', 'text/rtf', 'message/rfc822', 'text/calendar', 'application/ics',
]);
const TEXT_EXTS = new Set([
  'txt', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'eml', 'ics', 'md', 'log', 'rtf', 'yaml', 'yml',
]);
// Zip-container office formats officeparser converts to text (keyed by extension).
const OFFICE_EXTS: Record<string, string> = {
  docx: 'Word document (.docx)', xlsx: 'Excel spreadsheet (.xlsx)', pptx: 'PowerPoint deck (.pptx)',
  odt: 'OpenDocument text (.odt)', ods: 'OpenDocument spreadsheet (.ods)', odp: 'OpenDocument presentation (.odp)',
};
const OFFICE_MIMES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': OFFICE_EXTS.docx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': OFFICE_EXTS.xlsx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': OFFICE_EXTS.pptx,
  'application/vnd.oasis.opendocument.text': OFFICE_EXTS.odt,
  'application/vnd.oasis.opendocument.spreadsheet': OFFICE_EXTS.ods,
  'application/vnd.oasis.opendocument.presentation': OFFICE_EXTS.odp,
};

function ext(filename?: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename ?? '');
  return (m?.[1] ?? '').toLowerCase();
}

/** ~true when the buffer decodes as readable UTF-8 (no NULs, <1% replacement chars). */
function looksLikeText(buffer: Buffer): boolean {
  if (!buffer.byteLength) return false;
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return false;
  const decoded = sample.toString('utf8');
  let bad = 0;
  for (const ch of decoded) if (ch === '�') bad++;
  return bad / decoded.length < 0.01;
}

/**
 * Classify an attachment by CONTENT first (magic bytes — Gmail's reported mime routinely lies,
 * e.g. PDFs as application/octet-stream), then reported mime, then filename extension, then a
 * text heuristic. Exported for tests.
 */
export function detectAttachmentKind(buffer: Buffer, mimeType?: string, filename?: string): AttachmentKind {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  const e = ext(filename);

  // --- content magic ---
  if (looksLikePdf(buffer)) return { kind: 'pdf' };
  const head = buffer.subarray(0, 16);
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { kind: 'image', mediaType: 'image/png' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mediaType: 'image/jpeg' };
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return { kind: 'image', mediaType: 'image/gif' };
  const riff = head.subarray(0, 4).toString('latin1') === 'RIFF' ? head.subarray(8, 12).toString('latin1') : '';
  if (riff === 'WEBP') return { kind: 'image', mediaType: 'image/webp' };
  if (riff === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav' };
  if (head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && mime.startsWith('audio'))) {
    return { kind: 'audio', mimeType: 'audio/mpeg' };
  }
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return { kind: 'audio', mimeType: 'audio/ogg' };
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    // ISO base-media container: audio vs video by brand, then by reported mime; default video/mp4.
    const brand = head.subarray(8, 12).toString('latin1').trim().toLowerCase();
    if (brand === 'm4a' || mime.startsWith('audio')) return { kind: 'audio', mimeType: 'audio/mp4' };
    return { kind: 'video', mimeType: 'video/mp4' };
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'video', mimeType: 'video/webm' };
  if (head.subarray(0, 2).toString('latin1') === 'PK') {
    const format = OFFICE_EXTS[e] ?? OFFICE_MIMES[mime];
    if (format) return { kind: 'office', format };
    return { kind: 'unsupported', reason: `a zip archive${e ? ` (.${e})` : ''} — the model cannot open it directly; ask the sender for the files individually or a PDF export` };
  }
  // Legacy OLE binaries (.doc/.xls/.ppt from pre-2007 Office) — nothing on the stack parses these.
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    return { kind: 'unsupported', reason: `a legacy Office file${e ? ` (.${e})` : ''} — only modern formats (docx/xlsx/pptx) can be read; ask the sender to resave it or export a PDF` };
  }

  // --- reported mime ---
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return { kind: 'pdf' }; // magic missed but declared — let the model try
  if (/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return { kind: 'image', mediaType: mime === 'image/jpg' ? 'image/jpeg' : mime };
  if (mime.startsWith('audio/')) return { kind: 'audio', mimeType: mime };
  if (mime.startsWith('video/')) return { kind: 'video', mimeType: mime };
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime)) return { kind: 'text' };
  if (OFFICE_MIMES[mime]) return { kind: 'office', format: OFFICE_MIMES[mime] };

  // --- filename extension, then content heuristic ---
  if (TEXT_EXTS.has(e)) return { kind: 'text' };
  if (OFFICE_EXTS[e]) return { kind: 'office', format: OFFICE_EXTS[e] };
  if (looksLikeText(buffer)) return { kind: 'text' };

  return { kind: 'unsupported', reason: `unrecognized format (${mime || 'unknown type'}${e ? `, .${e}` : ''}) — not a document/image/text/audio/video the model can open` };
}

export interface ReadAttachmentResult {
  status: 'ok' | 'too_large' | 'unsupported' | 'error';
  answer: string | null;
  warning?: string;
}

/** Which model lane opens this attachment kind FIRST. The strong Ops model reads everything it
 *  accepts natively: PDFs (OpenRouter's file-parser plugin extracts them server-side), inlined
 *  text/office, and IMAGES — gpt-5.6-* takes image input, and contract photos deserve the stronger
 *  reasoning. Audio/video are the only kinds Ops models cannot take at all, so they go straight to
 *  ops_mm, the dedicated multimodal lane. Exported for tests. */
export function roleForAttachment(kind: Exclude<AttachmentKind['kind'], 'unsupported'>): LlmRole {
  return kind === 'audio' || kind === 'video' ? 'ops_mm' : 'ops';
}

/** Backup lane when the primary read FAILS (throws, comes back empty, or denies receiving the
 *  file). Only images have one: live probing showed gpt-5.6 endpoints silently DROP degenerate
 *  images (the demo corpus's 1×1 stub) and then deny any image arrived — ops_mm (gemini-flash)
 *  given the same bytes describes exactly what it sees ("a blank white square"). Strong model
 *  first, honest reader as the net. Exported for tests. */
export function backupRoleForAttachment(kind: Exclude<AttachmentKind['kind'], 'unsupported'>): LlmRole | null {
  return kind === 'image' ? 'ops_mm' : null;
}

/** Sentinel the image prompt asks the model to emit when NO image actually reached it (vs. an
 *  image it can see but can't answer from). This is what makes the backup retry detectable: the
 *  observed failure mode is a polite denial in prose — a successful API call — not an error. */
export const NO_IMAGE_SENTINEL = 'NO_IMAGE_RECEIVED';

/** True when the reply is the sentinel (allow trailing punctuation/whitespace, disallow it buried
 *  inside a real answer — the instruction says "exactly, nothing else"). Exported for tests. */
export function isImageDenial(text: string): boolean {
  return text.trim().startsWith(NO_IMAGE_SENTINEL);
}

function buildPrompt(kindNoun: string, question: string, filename?: string, imageGuard = false, sourceNoun = 'emailed'): string {
  return [
    `You are examining ${/^[aeiou]/i.test(sourceNoun) ? 'an' : 'a'} ${sourceNoun} ${kindNoun}${filename ? ` (filename "${filename}")` : ''} for the user.`,
    `Task: ${question.trim() || 'Describe what this is and its key facts.'}`,
    'Start by stating what this actually is (its own title/heading/subject), then answer from what is literally in it.',
    'Quote exact dates, amounts, and names verbatim. If the requested information is not present, say so explicitly — never infer or fill gaps. This is read-only intelligence, never legal advice.',
    // Turns the "image never reached the model" case into a machine-readable signal so the caller
    // can retry on the backup lane instead of relaying a confusing "re-upload it" to the agent.
    ...(imageGuard ? [`If no image is actually attached or visible to you in this message, reply with exactly "${NO_IMAGE_SENTINEL}" and nothing else. Never describe or infer from the filename alone.`] : []),
  ].join('\n');
}

/**
 * Open a Gmail attachment of ANY supported kind and answer a question about it (the Ops
 * `read_attachment` tool). Read-only — nothing is persisted.
 */
export async function readEmailAttachment(args: {
  handle: string;
  messageId: string;
  attachmentId: string;
  question: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  chatId?: string;
  taskId?: string;
}): Promise<ReadAttachmentResult> {
  if (args.sizeBytes && args.sizeBytes > MAX_DOC_BYTES) {
    return { status: 'too_large', answer: null, warning: 'attachment exceeds the size limit for inline reading' };
  }
  let buffer: Buffer;
  try {
    buffer = await getAttachment(args.handle, args.messageId, args.attachmentId);
  } catch (err) {
    console.error('[attachments] fetch failed', err);
    return { status: 'error', answer: null, warning: 'could not fetch attachment (the attachment id may be stale — re-run the email search and use the fresh id)' };
  }
  return readAttachmentBuffer(buffer, args);
}

/** The post-fetch half of readEmailAttachment: classify the bytes, build the lane request, run the
 *  primary read, and — for images — retry once on the backup lane when the primary throws, returns
 *  nothing, or emits the no-image sentinel. Split from the Gmail fetch so it can be exercised
 *  directly with raw bytes (tests, probes). `llm` is injectable for tests. */
export async function readAttachmentBuffer(
  buffer: Buffer,
  args: {
    question: string; filename?: string; mimeType?: string; handle?: string; chatId?: string; taskId?: string;
    /** Where the file came from — flavors the read prompt ('emailed' default) and the trace label. */
    source?: 'email' | 'chat';
  },
  llm: typeof callLLM = callLLM,
): Promise<ReadAttachmentResult> {
  const detected = detectAttachmentKind(buffer, args.mimeType, args.filename);
  if (detected.kind === 'unsupported') {
    return { status: 'unsupported', answer: null, warning: detected.reason };
  }

  const cap = detected.kind === 'pdf' ? MAX_DOC_BYTES : MAX_MEDIA_BYTES;
  if (detected.kind !== 'text' && buffer.byteLength > cap) {
    return { status: 'too_large', answer: null, warning: 'attachment exceeds the size limit for inline reading' };
  }

  const role = roleForAttachment(detected.kind);
  const content: LlmContentBlock[] = [];
  let kindNoun = 'document';
  switch (detected.kind) {
    case 'pdf':
      kindNoun = 'PDF document';
      content.push({ type: 'document', mediaType: 'application/pdf', data: buffer.toString('base64') });
      break;
    case 'image':
      kindNoun = 'image';
      content.push({ type: 'image', url: `data:${detected.mediaType};base64,${buffer.toString('base64')}`, mimeType: detected.mediaType });
      break;
    case 'audio':
      kindNoun = 'audio recording';
      content.push({ type: 'audio', mimeType: detected.mimeType, data: buffer.toString('base64'), format: formatFromMime(detected.mimeType) });
      break;
    case 'video':
      kindNoun = 'video';
      content.push({ type: 'video', mimeType: detected.mimeType, data: buffer.toString('base64') });
      break;
    case 'office': {
      kindNoun = `${detected.format}, converted to plain text`;
      let extracted: string;
      try {
        extracted = (await parseOfficeAsync(buffer)).trim();
      } catch (err) {
        console.error('[attachments] office parse failed', err);
        return { status: 'unsupported', answer: null, warning: `${detected.format} could not be parsed — it may be corrupt or password-protected; ask the sender for a PDF export` };
      }
      if (!extracted) return { status: 'unsupported', answer: null, warning: `${detected.format} contained no extractable text (it may be image-only); ask the sender for a PDF export` };
      const truncated = extracted.length > MAX_TEXT_CHARS;
      content.push({
        type: 'text',
        text: `Attachment content (extracted text${truncated ? `, first ${MAX_TEXT_CHARS} characters — file is longer` : ''}; tables are flattened to lines):\n---\n${extracted.slice(0, MAX_TEXT_CHARS)}\n---`,
      });
      break;
    }
    case 'text': {
      kindNoun = 'text file';
      const decoded = buffer.toString('utf8');
      const truncated = decoded.length > MAX_TEXT_CHARS;
      content.push({
        type: 'text',
        text: `Attachment content${truncated ? ` (first ${MAX_TEXT_CHARS} characters — file is longer)` : ''}:\n---\n${decoded.slice(0, MAX_TEXT_CHARS)}\n---`,
      });
      break;
    }
  }
  const imageGuard = detected.kind === 'image';
  const sourceNoun = args.source === 'chat' ? 'texted' : 'emailed';
  content.push({ type: 'text', text: buildPrompt(kindNoun, args.question, args.filename, imageGuard, sourceNoun) });

  const attempt = async (lane: LlmRole, label: string): Promise<string | null> => {
    const res = await llm({
      role: lane,
      messages: [{ role: 'user', content }],
      trace: { handle: args.handle, chatId: args.chatId, taskId: args.taskId, label },
    });
    return res.text?.trim() || null;
  };

  const traceBase = args.source === 'chat' ? 'ops:read_chat_attachment' : 'ops:read_attachment';
  const backup = backupRoleForAttachment(detected.kind);
  try {
    const answer = await attempt(role, traceBase);
    // Primary succeeded and (for images) actually saw the file → done.
    if (answer && !(imageGuard && isImageDenial(answer))) return { status: 'ok', answer };
    if (!backup) {
      return answer
        ? { status: 'error', answer: null, warning: 'the model reported the file did not reach it — the attachment may be corrupt' }
        : { status: 'error', answer: null, warning: 'model returned no text' };
    }
    console.warn(`[attachments] primary ${role} read ${answer ? 'denied seeing the image' : 'returned no text'} — retrying on ${backup}`);
  } catch (err) {
    console.error('[attachments] read failed', err);
    if (!backup) return { status: 'error', answer: null, warning: 'could not read the attachment' };
    console.warn(`[attachments] primary ${role} read threw — retrying on ${backup}`);
  }

  // Backup lane (images only): the multimodal reader gets the same request verbatim.
  try {
    const answer = await attempt(backup!, `${traceBase}:backup`);
    if (answer && !isImageDenial(answer)) return { status: 'ok', answer };
    return { status: 'error', answer: null, warning: 'could not read the image on either lane — it may be blank or corrupt; ask the sender for a proper scan' };
  } catch (err) {
    console.error('[attachments] backup read failed', err);
    return { status: 'error', answer: null, warning: 'could not read the attachment' };
  }
}

// Honest, agent-relayable prose for each typed inbound-chat fetch loss. These land in the tool
// result, so they tell Ops exactly what to say (resend ask) — never a vendor/system name, never a guess.
const CHAT_LOSS_WARNING: Record<LostReason, string> = {
  expired: 'the file link has expired (chat attachments stay fetchable only briefly) — say so in your ANSWER and ask the user to resend the file',
  oversize: 'the file is too large to open inline — ask the user for a smaller version or the key page(s)',
  unfetchable: 'the file did not come through — ask the user to resend it',
};

/**
 * Open a file the user texted (a CDN ref off the task's media manifest) and answer a question
 * about it — the Ops `read_chat_attachment` tool. The fetch is verified with one re-sign retry
 * (fetchVerified, same guarantees MM's own read has); the read itself reuses readAttachmentBuffer
 * verbatim: strong Ops lane first, ops_mm for audio/video, and the NO_IMAGE_RECEIVED backup retry
 * for images. Size note: this path binds at the chat fetch cap (LLM_MAX_MEDIA_BYTES, default 10MB)
 * before the Gmail-tier 20/30MB caps ever apply — texted files are small; raise by env if needed.
 * Deps injectable for tests.
 */
export async function readChatAttachment(
  args: { media: ExtractedMedia; question: string; handle?: string; chatId?: string; taskId?: string },
  deps: { fetch?: typeof fetchVerified; llm?: typeof callLLM } = {},
): Promise<ReadAttachmentResult> {
  const got = await (deps.fetch ?? fetchVerified)(args.media);
  if (!got.ok) {
    return {
      status: got.reason === 'oversize' ? 'too_large' : 'error',
      answer: null,
      warning: CHAT_LOSS_WARNING[got.reason],
    };
  }
  return readAttachmentBuffer(Buffer.from(got.media.base64, 'base64'), {
    question: args.question,
    filename: args.media.filename,
    mimeType: got.media.mime || args.media.mimeType,
    handle: args.handle, chatId: args.chatId, taskId: args.taskId,
    source: 'chat',
  }, deps.llm ?? callLLM);
}

// Shared inbound mapping for BOTH transports (webhook + polling): one Telegram Update → the
// neutral enqueueInbound call every channel funnels through. Owns the two safety gates that must
// hold no matter how the update arrived:
//   • allowlist — TELEGRAM_ALLOWED_CHAT_IDS is REQUIRED (comma-separated raw chat ids). After a
//     bot-token handoff from an engine, the engine's own pairing/allowlist gates no longer protect
//     this bot, so Irises must bring its own. No list → the channel refuses to start (index.ts).
//   • DMs only (v1) — group chats are dropped; the engine-handoff story is per-person texting.
import { emptyMedia, type IncomingMedia, type ExtractedMedia } from '../../webhook/types.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    reply_to_message?: { message_id: number };
    photo?: Array<{ file_id: string; width?: number; height?: number }>;
    document?: { file_id: string; mime_type?: string; file_name?: string };
    voice?: { file_id: string; mime_type?: string };
    audio?: { file_id: string; mime_type?: string; file_name?: string };
    video?: { file_id: string; mime_type?: string; file_name?: string };
  };
}

export interface TelegramDeps {
  enqueueInbound: EnqueueInbound;
  agentClient: AgentClient;
  /** DI edge for tests; also used by polling.ts. */
  fetchFn?: typeof fetch;
}

export function allowedChatIds(): Set<string> {
  return new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean));
}

/** file_id → a fetchable file URL. ⚠️ The URL embeds the bot token — it is passed to the engine
 *  for the current turn only, never persisted and never logged. */
async function fileUrl(fileId: string, fetchFn: typeof fetch): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: { file_path?: string } };
    return data.result?.file_path ? `https://api.telegram.org/file/bot${token}/${data.result.file_path}` : null;
  } catch {
    return null;
  }
}

async function extractMedia(msg: NonNullable<TelegramUpdate['message']>, fetchFn: typeof fetch): Promise<IncomingMedia> {
  const media = emptyMedia();
  const push = async (bucket: ExtractedMedia[], fileId: string, mimeType: string, filename?: string) => {
    const url = await fileUrl(fileId, fetchFn);
    if (url) bucket.push({ url, mimeType, filename });
  };
  if (msg.photo?.length) {
    // Telegram sends multiple sizes — the LAST entry is the largest.
    await push(media.images, msg.photo[msg.photo.length - 1].file_id, 'image/jpeg');
  }
  if (msg.voice) await push(media.audio, msg.voice.file_id, msg.voice.mime_type ?? 'audio/ogg', 'voice-memo.ogg');
  if (msg.audio) await push(media.audio, msg.audio.file_id, msg.audio.mime_type ?? 'audio/mpeg', msg.audio.file_name);
  if (msg.video) await push(media.video, msg.video.file_id, msg.video.mime_type ?? 'video/mp4', msg.video.file_name);
  if (msg.document) {
    const mime = msg.document.mime_type ?? 'application/octet-stream';
    const bucket = mime.startsWith('image/') ? media.images : mime.startsWith('video/') ? media.video : mime.startsWith('audio/') ? media.audio : media.docs;
    await push(bucket, msg.document.file_id, mime, msg.document.file_name);
  }
  return media;
}

/** Process one update. Returns what happened — transports use it only for logging/tests. */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramDeps,
): Promise<'queued' | 'skipped_group' | 'skipped_not_allowed' | 'skipped_empty'> {
  const msg = update?.message;
  if (!msg) return 'skipped_empty';
  if (msg.chat.type !== 'private') return 'skipped_group'; // v1: DMs only
  if (!allowedChatIds().has(String(msg.chat.id))) return 'skipped_not_allowed';

  const fetchFn = deps.fetchFn ?? fetch;
  const media = await extractMedia(msg, fetchFn);
  const text = msg.text ?? msg.caption ?? '';
  const hasAny = text.trim() || media.images.length || media.audio.length || media.video.length || media.docs.length;
  if (!hasAny) return 'skipped_empty';

  const chatId = `tg:${msg.chat.id}`;
  const from = `tg:${msg.from?.id ?? msg.chat.id}`;
  const replyTo = msg.reply_to_message ? { message_id: String(msg.reply_to_message.message_id) } : undefined;
  deps.enqueueInbound(deps.agentClient, chatId, from, text, String(msg.message_id), media, undefined, replyTo);
  return 'queued';
}

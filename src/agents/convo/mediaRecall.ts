import { getPreference, setPreference } from '../../db/repositories/memory.js';
import { hasMedia, type IncomingMedia } from '../../webhook/types.js';

// Prior-media recall. Conversation history is text-only, so when a text follow-up needs RAW detail
// from an earlier image/video/voice memo/document ("zoom into the corner", "read the 3rd line"),
// Convo (text-only) can't help — it never saw the file. Convo re-delegates to the engine with the stashed
// file re-attached (delegate_to_mm media_scope="earlier"). The media (URLs + mimeTypes only) lives
// in a durable per-handle pref, mirroring `recent_research`.

// How long after the user SENT media we can still re-attach it. Past this we ask them to resend.
// NOTE: engine/CDN media URLs are short-lived, so even inside this window a re-fetch can fail (the engine then
// reports it couldn't open the file); guaranteeing the full day would require storing the bytes.
export const MEDIA_RECALL_TTL_MS = Number(process.env.MEDIA_RECALL_TTL_MS || 24 * 60 * 60 * 1000);

const RECENT_MEDIA_PREF = 'recent_media';

interface StoredRecentMedia {
  chatId: string;       // scope recall to the same conversation
  media: IncomingMedia; // URLs + mimeTypes only (small)
  at: number;           // epoch ms the media was received
}

/** Stash the media from a fresh media turn so a later text follow-up can recall it (overwrites the last). */
export async function rememberMedia(handle: string, chatId: string, media: IncomingMedia): Promise<void> {
  try {
    const value: StoredRecentMedia = { chatId, media, at: Date.now() };
    await setPreference(handle, RECENT_MEDIA_PREF, value);
  } catch (err) {
    console.error('[mediaRecall] rememberMedia failed', err);
  }
}

/** The most recent media stashed for this handle+chat, or null (none / different chat / no media). */
export async function recallMedia(handle: string, chatId: string): Promise<{ media: IncomingMedia; at: number } | null> {
  const rec = await getPreference<StoredRecentMedia>(handle, RECENT_MEDIA_PREF);
  if (!rec || rec.chatId !== chatId || !rec.media || !hasMedia(rec.media)) return null;
  return { media: rec.media, at: typeof rec.at === 'number' ? rec.at : 0 };
}

/** Human phrase for a media bag, e.g. "a photo", "a document + 2 photos". */
export function describeMedia(media: IncomingMedia): string {
  const bits: string[] = [];
  const n = (c: number, one: string, many: string) => (c === 1 ? one : `${c} ${many}`);
  if (media.images.length) bits.push(n(media.images.length, 'a photo', 'photos'));
  if (media.video.length) bits.push(n(media.video.length, 'a video', 'videos'));
  if (media.audio.length) bits.push(n(media.audio.length, 'a voice memo', 'voice memos'));
  if (media.docs.length) bits.push(n(media.docs.length, 'a document', 'documents'));
  return bits.join(' + ') || 'an attachment';
}

/** Human phrase for how long ago the media was sent, for the recall framing. */
export function describeAge(ageMs: number): string {
  const min = Math.round(ageMs / 60_000);
  if (min < 2) return 'moments ago';
  if (min < 60) return `about ${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'about an hour ago' : `about ${h} hours ago`;
  return 'about a day ago';
}

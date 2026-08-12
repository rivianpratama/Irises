import { formatFromMime } from './transcribe.js';
import type { LlmRequest, LlmContentBlock } from './types.js';

// Native audio/video for the OpenRouter multimodal route. Like images (see inlineImages.ts),
// messaging-CDN links (e.g. Linq's) aren't publicly fetchable, and Gemini/Vertex can't fetch remote
// media anyway — audio must be base64 (no URL form at all), and video needs a base64 data URL. So we
// fetch each block server-side and inline it: audio blocks get `{ data, format }`, video blocks get
// `{ data }` (the mapper wraps it into a data: URL). Kept separate from inlineImages so the image
// path — whose only job is rewriting a `url` string — stays simple and its tests stay green.

// Base64 inflates ~33%, and the VM heap is capped (--max-old-space-size). Cap the RAW bytes (checked
// BEFORE encoding, so oversized media is never base64-encoded into memory). Over cap ⇒ skip + log.
const MAX_MEDIA_BYTES = Number(process.env.LLM_MAX_MEDIA_BYTES || 10 * 1024 * 1024);

export interface FetchedMedia { base64: string; mime: string; bytes: number }
type MediaFetcher = (url: string, fallbackMime: string) => Promise<FetchedMedia | null>;

// Typed failure so callers can tell an expired/purged link (HTTP 4xx) from a transient network
// error from an oversize file — a plain `null` conflated all three. `fetchVerified` (mm/fetchMedia.ts)
// uses the HTTP status to decide whether a re-sign retry is worth it and what to tell the user.
export type MediaFetchFailure =
  | { ok: false; failure: 'http'; status: number }   // 403 expired sig, 404 purged, 5xx…
  | { ok: false; failure: 'oversize'; bytes: number }
  | { ok: false; failure: 'network' };
export type MediaFetchOutcome = { ok: true; media: FetchedMedia } | MediaFetchFailure;

/** Fetch a remote media URL, returning its base64 + resolved mime, or a TYPED failure. */
export async function fetchMediaDetailed(url: string, fallbackMime: string): Promise<MediaFetchOutcome> {
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    console.warn('[llm] media fetch error:', err);
    return { ok: false, failure: 'network' };
  }
  if (!resp.ok) {
    console.warn(`[llm] media fetch failed (${resp.status}) for ${url.slice(0, 80)}`);
    return { ok: false, failure: 'http', status: resp.status };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    console.warn('[llm] media body read error:', err);
    return { ok: false, failure: 'network' };
  }
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    console.warn(`[llm] media ${Math.round(buf.byteLength / 1024)}KB exceeds ${Math.round(MAX_MEDIA_BYTES / 1024)}KB cap — skipping ${url.slice(0, 80)}`);
    return { ok: false, failure: 'oversize', bytes: buf.byteLength };
  }
  const mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || fallbackMime;
  return { ok: true, media: { base64: buf.toString('base64'), mime, bytes: buf.byteLength } };
}

/** Fetch a remote media URL and return its base64 + resolved mime, or null on failure/oversize.
 *  Thin back-compat wrapper over fetchMediaDetailed (the OpenRouter-boundary inliner + its tests
 *  only need the null-on-failure contract). */
export async function fetchMediaAsBase64(url: string, fallbackMime: string): Promise<FetchedMedia | null> {
  const out = await fetchMediaDetailed(url, fallbackMime);
  return out.ok ? out.media : null;
}

/**
 * Return a copy of `req` with every remote audio/video block inlined to base64. Audio blocks gain
 * `data` + `format`; video blocks gain `data` (+ resolved `mimeType`). Blocks already carrying `data`
 * (or with no `url`) are left untouched; a fetch/size failure DROPS that block (a partial part would
 * 400 at the provider). Image/text/document blocks are untouched (images handled by inlineImageBlocks,
 * documents already carry base64). Returns the SAME req object when nothing changed. Fetcher is
 * injectable for testing.
 */
export async function inlineMediaBlocks(
  req: LlmRequest,
  fetchMedia: MediaFetcher = fetchMediaAsBase64,
): Promise<LlmRequest> {
  let touched = false;
  const messages = await Promise.all(req.messages.map(async m => {
    if (!Array.isArray(m.content)) return m;
    const mapped = await Promise.all(m.content.map(async (b): Promise<LlmContentBlock | null> => {
      if (b.type === 'audio') {
        if (b.data || !b.url) return b;               // already inlined, or nothing to fetch
        const got = await fetchMedia(b.url, b.mimeType);
        touched = true;
        if (!got) return null;                        // fetch/size failure → drop the block
        return { ...b, data: got.base64, format: formatFromMime(got.mime || b.mimeType) };
      }
      if (b.type === 'video') {
        if (b.data || !b.url) return b;
        const got = await fetchMedia(b.url, b.mimeType);
        touched = true;
        if (!got) return null;
        return { ...b, data: got.base64, mimeType: got.mime || b.mimeType };
      }
      return b;                                        // text / image / document untouched
    }));
    return { ...m, content: mapped.filter((b): b is LlmContentBlock => b !== null) };
  }));
  return touched ? { ...req, messages } : req;
}

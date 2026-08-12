import type { LlmRequest } from './types.js';

// OpenRouter providers — notably Google/Gemini — can't reliably fetch remote image URLs, and
// messaging-CDN links (e.g. a messaging platform's) are often not publicly retrievable. OpenRouter's own docs say
// base64 is REQUIRED for images that aren't publicly accessible. So on the OpenRouter path we fetch
// each image server-side and inline it as a base64 data URL (same approach as voice-memo transcription).

/** Fetch a remote image and return a `data:<mime>;base64,...` URL, or null on any failure. */
export async function fetchImageAsDataUrl(url: string, fallbackMime = 'image/jpeg'): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[llm] image fetch failed (${resp.status}) for ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || fallbackMime;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn('[llm] image fetch error:', err);
    return null;
  }
}

type ImageFetcher = (url: string, fallbackMime?: string) => Promise<string | null>;

/**
 * Return a copy of `req` with every remote image block's URL rewritten to an inline base64 data URL.
 * Blocks that are already `data:` URLs, non-image blocks, and plain-string content are left untouched.
 * On a fetch failure the original URL is kept (no worse than before). Returns the SAME req object
 * (no clone) when nothing was rewritten. The fetcher is injectable for testing.
 */
export async function inlineImageBlocks(
  req: LlmRequest,
  fetchImage: ImageFetcher = fetchImageAsDataUrl,
): Promise<LlmRequest> {
  let touched = false;
  const messages = await Promise.all(req.messages.map(async m => {
    if (!Array.isArray(m.content)) return m;
    const content = await Promise.all(m.content.map(async b => {
      if (b.type !== 'image' || b.url.startsWith('data:')) return b;
      const dataUrl = await fetchImage(b.url, b.mimeType);
      if (!dataUrl) return b;
      touched = true;
      return { ...b, url: dataUrl };
    }));
    return { ...m, content };
  }));
  return touched ? { ...req, messages } : req;
}

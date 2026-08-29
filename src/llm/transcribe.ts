import OpenAI from 'openai';
import { reportError } from '../diagnostics/errorLog.js';
import { laneKey, laneBaseUrl } from './laneKeys.js';

// Voice-memo transcription via OpenRouter's multimodal audio input (no OpenAI/Whisper).
// Voice memos arrive as audio media parts (audio/mp4 = m4a).
// OpenRouter takes an `input_audio` content block: base64 data + a format string
// (wav/mp3/m4a/aac/ogg/flac/...). The model must be audio-capable — default to a
// Gemini flash model (accepts m4a); override with TRANSCRIBE_MODEL.
// Ref: https://openrouter.ai/docs/guides/overview/multimodal/audio

// CAVEAT: the default is an OpenRouter aggregator slug. When the lane falls back to the generic
// `openai` endpoint (OPENAI_BASE_URL, no OpenRouter key), that slug 404s — set TRANSCRIBE_MODEL to a
// model id that endpoint recognizes (e.g. an unprefixed audio-capable OpenAI model). A 404 degrades
// to a null transcript, not a crash, but voice memos won't transcribe until it's set.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'google/gemini-2.5-flash';
// Completion ceiling for one memo. The old 1024 was roughly 45 seconds of speech and cut longer
// memos off mid-sentence with no signal at all (finish_reason was never read). Output only costs
// what's generated, so this is a runaway backstop, not a budget (env: TRANSCRIBE_MAX_TOKENS).
const TRANSCRIBE_MAX_TOKENS = Number(process.env.TRANSCRIBE_MAX_TOKENS) || 4096;
/** Appended to a transcript the model didn't finish — the reader (and the agents downstream) must
 *  know the memo continues past this point. A marked partial beats a dropped memo. */
const CUTOFF_NOTE = '\n[voice memo transcript cut off — memo longer than the transcription limit]';

// The transcription lane: OpenRouter preferred (its aggregator serves the audio-capable flash
// model), else the generic OpenAI lane (a compatible endpoint with an audio model, at
// OPENAI_BASE_URL). Blank keys count as unset (laneKey), so a blank key reports unconfigured instead
// of 401'ing every memo. Lazy + rebuilt on key/base-URL change so a .env edit between memos is
// honoured (the old module-level singleton froze the endpoint at import).
function transcribeLane(): { key: string; baseURL: string } | null {
  const or = laneKey('openrouter');
  if (or) return { key: or.value, baseURL: laneBaseUrl('openrouter') };
  const oa = laneKey('openai');
  if (oa) return { key: oa.value, baseURL: laneBaseUrl('openai') };
  return null;
}
let lane: { key: string; baseURL: string; client: OpenAI } | null = null;
function transcribeClient(): OpenAI | null {
  const chosen = transcribeLane();
  if (!chosen) return null;
  if (lane?.key !== chosen.key || lane?.baseURL !== chosen.baseURL) {
    lane = { key: chosen.key, baseURL: chosen.baseURL, client: new OpenAI({ apiKey: chosen.key, baseURL: chosen.baseURL }) };
  }
  return lane.client;
}

/** Map an audio MIME type to the OpenRouter `format` string. Shared with the media inliner. */
export function formatFromMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'; // voice memos
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('aiff')) return 'aiff';
  return 'm4a';
}

/**
 * Fetch a voice-memo URL and transcribe it through OpenRouter audio input.
 * Returns the transcript text, or null on any failure (callers degrade gracefully).
 */
export async function transcribeAudio(url: string, mimeType = 'audio/mp4'): Promise<string | null> {
  const client = transcribeClient();
  if (!client) {
    console.error('[transcribe] no OPENROUTER_API_KEY or OPENAI_API_KEY — cannot transcribe voice memos');
    reportError({
      source: 'mm', category: 'transcription_failure',
      message: 'no OPENROUTER_API_KEY or OPENAI_API_KEY set — cannot transcribe voice memos',
    });
    return null;
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[transcribe] failed to fetch audio: ${resp.status}`);
      reportError({
        source: 'mm', category: 'transcription_failure',
        message: `failed to fetch voice memo audio: ${resp.status}`,
        detail: { status: resp.status },
      });
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const format = formatFromMime(resp.headers.get('content-type') || mimeType);
    console.log(`[transcribe] ${Math.round(buffer.byteLength / 1024)}KB as ${format} via ${TRANSCRIBE_MODEL}`);

    // SDK types restrict input_audio.format to wav/mp3; OpenRouter accepts more, so cast.
    const content: unknown[] = [
      { type: 'text', text: 'Transcribe this voice memo verbatim. Output only the transcription text, nothing else.' },
      { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } },
    ];

    const completion = await client.chat.completions.create({
      model: TRANSCRIBE_MODEL,
      messages: [{ role: 'user', content: content as OpenAI.Chat.Completions.ChatCompletionContentPart[] }],
      max_tokens: TRANSCRIBE_MAX_TOKENS,
    });

    const choice = completion.choices[0];
    const finishReason = choice?.finish_reason ?? null;
    const text = choice?.message?.content?.trim();
    // This call runs on the raw SDK, outside callLLM, so nothing else looks at finish_reason: a
    // truncated memo used to reach the agents as a complete-looking transcript.
    if (finishReason === 'length') {
      console.warn(`[transcribe] transcript truncated at max_tokens=${TRANSCRIBE_MAX_TOKENS} (memo longer than the limit)`);
      reportError({
        source: 'mm', category: 'transcription_failure', severity: 'warn',
        message: 'voice memo transcript truncated at max_tokens',
        detail: { finishReason, maxTokens: TRANSCRIBE_MAX_TOKENS, model: TRANSCRIBE_MODEL, hasText: !!text },
      });
    }
    if (!text) {
      console.error(`[transcribe] no transcript text returned (finish_reason=${finishReason})`);
      reportError({
        source: 'mm', category: 'transcription_failure',
        message: 'transcription returned no text',
        detail: { finishReason, model: TRANSCRIBE_MODEL },
      });
      return null;
    }
    console.log(`[transcribe] "${text.substring(0, 50)}..."`);
    return finishReason === 'length' ? text + CUTOFF_NOTE : text;
  } catch (err) {
    console.error('[transcribe] error:', err);
    reportError({ source: 'mm', category: 'transcription_failure', err, detail: { model: TRANSCRIBE_MODEL } });
    return null;
  }
}

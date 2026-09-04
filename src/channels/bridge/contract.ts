// The wire contract between the two Irises-owned bridge plugins (bridge/hermes, bridge/openclaw)
// and the inbound door (./inboundRouter.ts). It lives here, apart from the router, because it is
// the ONLY place that decides what a v1 inbound payload is — the router is now a thin door that
// authorizes, calls parseBridgeInbound, and forwards.
//
// Everything in here is a hand-rolled coercer (the house pattern: coerceStatus, coerceBasis,
// coerceDials) — no schema library, no new dependency. The coercions are LIFTED VERBATIM from the
// router they came from, because bridge.test.ts pins them over real HTTP and is deliberately left
// untouched: it is the byte-identity oracle for this move.
//
// Two things are new, and both are gated by BRIDGE_CONTRACT_STRICT so the off path is exactly the
// pre-contract door: a body that is not a JSON object is refused as `body` (express's strict
// json() already refuses most of these before the router sees them — that is why contract.test.ts
// tests the parser directly), and a payload declaring a MAJOR schema_version we do not know is
// refused rather than silently half-understood. A payload with an unknown MINOR field is the
// opposite call: it is accepted and the field names are handed back for the receipt, so a plugin
// that ships a new field is visible in diagnostics instead of being a silent forward (the
// incident-06889fa blind spot) and instead of being a 400 that drops a real message on the floor.
import { emptyMedia, type IncomingMedia, type ReplyTo } from '../../webhook/types.js';

/** The payload version this door understands. A sender declaring the same MAJOR is compatible;
 *  a minor bump (1.4) is a sender with extra fields we ignore, which is fine by construction. */
export const BRIDGE_SCHEMA_VERSION = 1;

/** Inbound text cap. Deliberately NOT imported from enginePush.ts's MAX_TEXT_CHARS even though the
 *  number matches: these are two different doors with two different senders, and coupling them
 *  would mean tuning one silently retunes the other. */
export const BRIDGE_MAX_TEXT_CHARS = 4000;

export interface BridgeInbound {
  engine?: 'hermes' | 'openclaw';
  platform?: string;
  chat_id?: string | number;
  sender_id?: string | number;
  sender_name?: string;
  chat_name?: string;
  text?: string;
  message_id?: string | number;
  thread_id?: string | number;
  reply_to_id?: string | number;
  reply_to_text?: string;          // the quoted message's content, when the engine event carried it
  timestamp?: number;              // platform send time (epoch seconds or ms); used as receivedAt
  is_group?: boolean;
  media?: Array<{ url?: string; path?: string; mimeType?: string; mime_type?: string; filename?: string }>;
  schema_version?: number;
}

/** Every field a v1 payload may carry. Anything else is a MINOR extension: accepted, ignored, and
 *  named in the receipt. Same shape as THEME_KIND_SET — a ReadonlySet over a literal list. */
export const KNOWN_BRIDGE_FIELDS: ReadonlySet<string> = new Set<string>([
  'engine', 'platform', 'chat_id', 'sender_id', 'sender_name', 'chat_name', 'text',
  'message_id', 'thread_id', 'reply_to_id', 'reply_to_text', 'timestamp', 'is_group',
  'media', 'schema_version',
]);

/** The contract gate (env: BRIDGE_CONTRACT_STRICT). Default ON, read at CALL time so flipping it
 *  needs no restart — the same parse shape as every sibling flag (threadingEnabled and friends).
 *
 *  Off means the door behaves exactly as it did before this file existed: no body-shape rejection,
 *  no schema_version rejection, no text cap, and nothing reported as ignored. The coercions are
 *  shared either way, which is the point — there is one code path, and the flag only removes the
 *  three additions. */
export function bridgeContractStrict(): boolean {
  const v = (process.env.BRIDGE_CONTRACT_STRICT || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Normalize a platform-supplied timestamp (seconds OR ms) to epoch ms, or undefined when absent or
 *  implausible. A bogus value must never poison gap detection, so we clamp: nothing more than a
 *  minute in the future, nothing older than 7 days back. Absent/garbage → undefined → the caller
 *  falls back to Date.now() (exactly today's behavior). */
export function normalizeTimestamp(raw: unknown, nowMs: number = Date.now()): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n < 1e12 ? n * 1000 : n; // < ~2001 in ms means it's really seconds
  if (ms > nowMs + 60_000 || ms < nowMs - 7 * 24 * 3600_000) return undefined;
  return ms;
}

/** Map the plugin's media list into IncomingMedia buckets by mime type. hermes forwards LOCAL
 *  cached paths (same-box deployments: the engine itself re-reads them during delegation);
 *  OpenClaw forwards its staging URLs/paths. Never logged — paths/URLs may embed credentials. */
export function mapBridgeMedia(items: BridgeInbound['media']): IncomingMedia {
  const media = emptyMedia();
  for (const m of items ?? []) {
    const url = m.url || m.path;
    if (!url) continue;
    const mime = m.mimeType || m.mime_type || 'application/octet-stream';
    const entry = { url, mimeType: mime, filename: m.filename };
    if (mime.startsWith('image/')) media.images.push(entry);
    else if (mime.startsWith('audio/')) media.audio.push(entry);
    else if (mime.startsWith('video/')) media.video.push(entry);
    else media.docs.push(entry);
  }
  return media;
}

/** Exactly what the door needs to hand `enqueueInbound`/`noteBridgeChat`, plus the two facts the
 *  receipt reports (`schemaVersion`, `truncated`). Optional fields are OMITTED, never present-and-
 *  undefined, except the ones the pre-contract router also always computed. */
export interface BridgeInboundValue {
  engine: 'hermes' | 'openclaw' | undefined;
  platform: string;
  rawChatId: string;
  chatId: string;
  from: string;
  text: string;
  messageId: string;
  media: IncomingMedia;
  /** How many media entries the plugin FORWARDED (not how many mapped) — the receipt reports this,
   *  so an entry dropped for carrying neither url nor path is visible as a gap. */
  mediaCount: number;
  replyTo: ReplyTo | undefined;
  receivedAt: number | undefined;
  isGroup: boolean;
  chatName: string | undefined;
  threadId: string | undefined;
  schemaVersion: number;
  truncated: boolean;
}

export type BridgeParseResult =
  | { ok: true; value: BridgeInboundValue; ignoredFields: string[] }
  | { ok: false; error: string; field: string };

/** The message the door has answered 400 with since it existed. Kept as one constant so the
 *  required-trio rejection stays byte-identical to the pre-contract door. */
const TRIO_ERROR = 'platform, chat_id, and text (or media) are required';

/**
 * Parse an inbound bridge body. `nowMs` is the parse clock: it drives the timestamp clamp and the
 * synthetic ids, so a test can pin them (the router passes nothing, i.e. Date.now(), exactly as
 * before).
 */
export function parseBridgeInbound(body: unknown, nowMs: number = Date.now()): BridgeParseResult {
  const strict = bridgeContractStrict();
  const isObject = !!body && typeof body === 'object' && !Array.isArray(body);
  if (!isObject && strict) {
    return { ok: false, error: 'body must be a JSON object', field: 'body' };
  }
  // Off, a non-object degrades to the pre-contract read: every field comes back undefined and the
  // required trio is what answers 400.
  const b = (isObject ? body : {}) as BridgeInbound;

  const declared = (b as { schema_version?: unknown }).schema_version;
  const declaredNum = declared == null ? BRIDGE_SCHEMA_VERSION : Number(declared);
  if (strict && (!Number.isFinite(declaredNum) || Math.floor(declaredNum) !== BRIDGE_SCHEMA_VERSION)) {
    return {
      ok: false,
      error: `unsupported schema_version ${String(declared)} — this door speaks v${BRIDGE_SCHEMA_VERSION}`,
      field: 'schema_version',
    };
  }
  // Off (or a minor bump): report whatever was declared, falling back to v1 for a value that is not
  // even a number, so the receipt never carries NaN.
  const schemaVersion = Number.isFinite(declaredNum) ? declaredNum : BRIDGE_SCHEMA_VERSION;

  const platform = typeof b.platform === 'string' ? b.platform.trim().toLowerCase() : '';
  const rawChatId = b.chat_id != null ? String(b.chat_id).trim() : '';
  const rawText = typeof b.text === 'string' ? b.text : '';
  // The one place this parser is stricter than the door it replaces in BOTH modes: `media` has to
  // be an array. mapBridgeMedia for-of's it, so a scalar there used to throw out of the route
  // handler as a 500 — an unhandled TypeError is not a coercion, and a typed contract is exactly
  // the thing that should stop it.
  const mediaItems = Array.isArray(b.media) ? b.media : undefined;
  const media = mapBridgeMedia(mediaItems);
  const hasAny = rawText.trim() || media.images.length || media.audio.length || media.video.length || media.docs.length;
  if (!platform || !rawChatId || !hasAny) {
    return { ok: false, error: TRIO_ERROR, field: 'platform|chat_id|text' };
  }

  // The cap comes AFTER the trio on purpose: capping first could never turn a 400 into a 202, but
  // ordering it this way makes it impossible for the flag to change WHICH answer a body gets — off
  // and on agree on accept/reject, and differ only in how much text rides along.
  const truncated = strict && rawText.length > BRIDGE_MAX_TEXT_CHARS;
  const text = truncated ? rawText.slice(0, BRIDGE_MAX_TEXT_CHARS) : rawText;

  const quoted = typeof b.reply_to_text === 'string' && b.reply_to_text.trim() ? b.reply_to_text.slice(0, 2000) : undefined;
  const replyTo: ReplyTo | undefined = (b.reply_to_id != null || quoted)
    ? {
        message_id: b.reply_to_id != null ? String(b.reply_to_id) : `eng-quote-${nowMs.toString(36)}`,
        ...(quoted ? { content: quoted } : {}),
      }
    : undefined;

  const ignoredFields = strict ? Object.keys(b).filter(k => !KNOWN_BRIDGE_FIELDS.has(k)) : [];

  return {
    ok: true,
    ignoredFields,
    value: {
      engine: typeof b.engine === 'string' ? (b.engine as BridgeInbound['engine']) : undefined,
      platform,
      rawChatId,
      chatId: `eng:${platform}:${rawChatId}`,
      from: `eng:${platform}:${b.sender_id != null ? String(b.sender_id) : rawChatId}`,
      text,
      messageId: String(b.message_id ?? `eng-in-${nowMs.toString(36)}`),
      media,
      mediaCount: mediaItems?.length ?? 0,
      replyTo,
      receivedAt: normalizeTimestamp(b.timestamp, nowMs),
      isGroup: b.is_group === true,
      chatName: b.chat_name || undefined,
      threadId: b.thread_id != null ? String(b.thread_id) : undefined,
      schemaVersion,
      truncated,
    },
  };
}

/**
 * The bridge plugin's answer to POST /send, read defensively instead of `as`-cast. Tolerant on
 * purpose — by the time this runs the message IS sent: an older plugin build answers {"ok":true}
 * with no id, and a body that won't parse must not turn a delivered message into a failure. We
 * just lose tapped-reply matching for that bubble. The truthiness test is the cast's own, kept
 * exactly (a `message_id` of 0 or "" was never an id here either).
 */
export function coerceBridgeSendResult(raw: unknown): { messageId?: string } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as { message_id?: string | number };
  return { messageId: body.message_id ? String(body.message_id) : undefined };
}

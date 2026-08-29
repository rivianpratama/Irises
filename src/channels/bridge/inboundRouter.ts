// Inbound door for engine-fronted chats: the bridge plugins (bridge/hermes, bridge/openclaw —
// installed INTO the engines via their official plugin mechanisms) POST every fronted inbound
// message here, having suppressed the engine's own reply. From here it is a completely normal
// Irises turn: enqueueInbound → Convo → (deep work back on the engine) → Composer → the bridge
// channel delivers through the engine's connection.
//
// Auth mirrors /api/engine/push: ENGINE_PUSH_TOKEN set → x-bridge-token must match exactly;
// unset → loopback-only (dev). One token guards both engine-facing doors on purpose — the setup
// script provisions it once into the engine's plugin environment.
import { Router, type Request } from 'express';
import { noteBridgeChat } from './channel.js';
import { record } from '../../diagnostics/trace.js';
import { emptyMedia, type IncomingMedia, type ReplyTo } from '../../webhook/types.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

interface BridgeInbound {
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

// Exact match, never a substring: `includes('127.0.0.1')` also accepts a real remote address that
// merely CONTAINS the loopback text, and the tokenless mode is the dev fallback that guards a door
// which can make Irises speak.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function authorized(req: Request): boolean {
  const token = process.env.ENGINE_PUSH_TOKEN;
  if (token) return req.headers['x-bridge-token'] === token;
  return LOOPBACK.has(req.ip || req.socket.remoteAddress || '');
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

export function createBridgeInboundRouter(deps: { enqueueInbound: EnqueueInbound; agentClient: AgentClient }): Router {
  const router = Router();

  router.post('/api/bridge/inbound', (req, res) => {
    if (!authorized(req)) {
      res.status(403).json({ error: 'forbidden — send x-bridge-token' });
      return;
    }
    const b = (req.body ?? {}) as BridgeInbound;
    const platform = typeof b.platform === 'string' ? b.platform.trim().toLowerCase() : '';
    const rawChat = b.chat_id != null ? String(b.chat_id).trim() : '';
    const text = typeof b.text === 'string' ? b.text : '';
    const media = mapBridgeMedia(b.media);
    const hasAny = text.trim() || media.images.length || media.audio.length || media.video.length || media.docs.length;
    if (!platform || !rawChat || !hasAny) {
      res.status(400).json({ error: 'platform, chat_id, and text (or media) are required' });
      return;
    }
    const chatId = `eng:${platform}:${rawChat}`;
    const from = `eng:${platform}:${b.sender_id != null ? String(b.sender_id) : rawChat}`;
    noteBridgeChat(chatId, {
      isGroup: b.is_group === true,
      name: b.chat_name || undefined,
      // The plugin has always forwarded thread_id; dropping it here is what sent replies to a
      // Telegram forum topic back into the group's General.
      threadId: b.thread_id != null ? String(b.thread_id) : undefined,
    });
    record({ type: 'event', chatId, label: 'bridge:inbound', detail: { engine: b.engine, platform, isGroup: b.is_group === true, chars: text.length, media: (b.media ?? []).length } });
    // Reply-to: carry the quoted CONTENT alongside the id when the plugin forwarded it, so the model
    // sees what was replied to even if the id can't be resolved to a stored bubble/inbound row.
    const quoted = typeof b.reply_to_text === 'string' && b.reply_to_text.trim() ? b.reply_to_text.slice(0, 2000) : undefined;
    const replyTo: ReplyTo | undefined = b.reply_to_id != null
      ? { message_id: String(b.reply_to_id), ...(quoted ? { content: quoted } : {}) }
      : undefined;
    const receivedAt = normalizeTimestamp(b.timestamp);
    deps.enqueueInbound(deps.agentClient, chatId, from, text, String(b.message_id ?? `eng-in-${Date.now().toString(36)}`), media, replyTo, receivedAt);
    res.status(202).json({ ok: true, chatId });
  });

  return router;
}

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
import { emptyMedia, type IncomingMedia } from '../../webhook/types.js';
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
  is_group?: boolean;
  media?: Array<{ url?: string; path?: string; mimeType?: string; mime_type?: string; filename?: string }>;
}

function authorized(req: Request): boolean {
  const token = process.env.ENGINE_PUSH_TOKEN;
  if (token) return req.headers['x-bridge-token'] === token;
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip.includes('127.0.0.1') || ip.includes('::1');
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
    noteBridgeChat(chatId, { isGroup: b.is_group === true, name: b.chat_name || undefined });
    record({ type: 'event', chatId, label: 'bridge:inbound', detail: { engine: b.engine, platform, isGroup: b.is_group === true, chars: text.length, media: (b.media ?? []).length } });
    const replyTo = b.reply_to_id != null ? { message_id: String(b.reply_to_id) } : undefined;
    deps.enqueueInbound(deps.agentClient, chatId, from, text, String(b.message_id ?? `eng-in-${Date.now().toString(36)}`), media, replyTo);
    res.status(202).json({ ok: true, chatId });
  });

  return router;
}

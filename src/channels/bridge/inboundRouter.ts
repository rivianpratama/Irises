// Inbound door for engine-fronted chats: the bridge plugins (bridge/hermes, bridge/openclaw —
// installed INTO the engines via their official plugin mechanisms) POST every fronted inbound
// message here, having suppressed the engine's own reply. From here it is a completely normal
// Irises turn: enqueueInbound → Convo → (deep work back on the engine) → Composer → the bridge
// channel delivers through the engine's connection.
//
// This file is only the DOOR: auth, one call into ./contract.ts, the receipt, and the answer.
// What a v1 payload IS lives in the contract; mapBridgeMedia and normalizeTimestamp are re-exported
// from here because they were born here and callers (and bridge.test.ts, the byte-identity oracle
// for the coercions) import them from this path.
//
// Auth mirrors /api/engine/push: ENGINE_PUSH_TOKEN set → x-bridge-token must match exactly;
// unset → loopback-only (dev). One token guards both engine-facing doors on purpose — the setup
// script provisions it once into the engine's plugin environment.
import { Router, type Request } from 'express';
import { noteBridgeChat } from './channel.js';
import { parseBridgeInbound } from './contract.js';
import { record } from '../../diagnostics/trace.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

export { mapBridgeMedia, normalizeTimestamp } from './contract.js';

// Exact match, never a substring: `includes('127.0.0.1')` also accepts a real remote address that
// merely CONTAINS the loopback text, and the tokenless mode is the dev fallback that guards a door
// which can make Irises speak.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function authorized(req: Request): boolean {
  const token = process.env.ENGINE_PUSH_TOKEN;
  if (token) return req.headers['x-bridge-token'] === token;
  return LOOPBACK.has(req.ip || req.socket.remoteAddress || '');
}

export function createBridgeInboundRouter(deps: { enqueueInbound: EnqueueInbound; agentClient: AgentClient }): Router {
  const router = Router();

  router.post('/api/bridge/inbound', (req, res) => {
    if (!authorized(req)) {
      res.status(403).json({ error: 'forbidden — send x-bridge-token' });
      return;
    }
    const parsed = parseBridgeInbound(req.body);
    if (!parsed.ok) {
      // A 400 used to leave NO trace at all — the incident-06889fa blind spot, where a Python
      // datetime in `timestamp` silenced every inbound forward with nothing to read afterwards.
      // One receipt per outcome: a rejection emits THIS and not bridge:inbound.
      record({ type: 'event', label: 'bridge:inbound-rejected', detail: { reason: parsed.error, field: parsed.field } });
      res.status(400).json({ error: parsed.error });
      return;
    }
    const v = parsed.value;
    noteBridgeChat(v.chatId, {
      isGroup: v.isGroup,
      name: v.chatName,
      // The plugin has always forwarded thread_id; dropping it here is what sent replies to a
      // Telegram forum topic back into the group's General.
      threadId: v.threadId,
    });
    record({
      type: 'event', chatId: v.chatId, label: 'bridge:inbound',
      detail: {
        engine: v.engine, platform: v.platform, isGroup: v.isGroup, chars: v.text.length,
        media: v.media.images.length + v.media.audio.length + v.media.video.length + v.media.docs.length,
        decision: 'accepted', schemaVersion: v.schemaVersion, truncated: v.truncated,
        ...(parsed.ignoredFields.length ? { ignored: parsed.ignoredFields } : {}),
      },
    });
    // Reply-to: the contract carries the quoted CONTENT alongside the id when the plugin forwarded
    // it, so the model sees what was replied to even if the id can't be resolved to a stored
    // bubble/inbound row.
    deps.enqueueInbound(deps.agentClient, v.chatId, v.from, v.text, v.messageId, v.media, v.replyTo, v.receivedAt);
    res.status(202).json({ ok: true, chatId: v.chatId });
  });

  return router;
}

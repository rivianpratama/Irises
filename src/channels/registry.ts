// Channel registry — resolves the transport for a chat from its chatId prefix, statelessly.
//
// Follow-ups fire minutes later and survive process restarts: the engine's scheduled jobs deliver
// back through POST /api/engine/push carrying the chatId they were created with (memory rows key on
// chatId too), so a delivery can land on a process that never saw the original turn. An in-memory
// origin→channel map would be lost on that cold start — so the channel MUST be
// derivable from the chatId string itself, with zero lookup. Convention:
//   web:<clientId>        → web / CLI debug channel   (default single-user: "web:debug")
//   eng:<platform>:<chat> → bridge (engine-fronted chat, via OpenClaw/Hermes)
// Anything else is unroutable: Irises is a front-end for the OpenClaw/Hermes engines, so every live
// chatId carries one of these prefixes. Legacy bare / `tg:` ids from the removed Linq/Telegram
// channels no longer resolve — they throw loudly instead of silently misrouting.
import type { Channel, ChannelKind } from './types.js';

const channels = new Map<ChannelKind, Channel>();

export function registerChannel(channel: Channel): void {
  channels.set(channel.kind, channel);
  console.log(`[channels] registered "${channel.kind}"`);
}

/** The channel kind for a chatId, or null when no known prefix matches (an unroutable id). */
export function parseChannelKind(chatId: string): ChannelKind | null {
  if (chatId.startsWith('web:')) return 'web';
  if (chatId.startsWith('eng:')) return 'bridge'; // engine-fronted chat: eng:<platform>:<chat_id>
  return null;
}

export function getChannel(kind: ChannelKind): Channel | undefined {
  return channels.get(kind);
}

export function resolveChannel(chatId: string): Channel {
  const kind = parseChannelKind(chatId);
  if (!kind) {
    throw new Error(`[channels] unroutable chatId "${chatId}" — no known channel prefix (expected web: or eng:)`);
  }
  const channel = channels.get(kind);
  if (!channel) {
    throw new Error(`[channels] no channel registered for kind "${kind}" (chatId=${chatId})`);
  }
  return channel;
}

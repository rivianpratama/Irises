// Channel registry — resolves the transport for a chat from its chatId prefix, statelessly.
//
// Follow-ups fire minutes later and survive process restarts (the Autonome sweeper reads persisted
// `automations` rows carrying a bare chatId; memory rows key on chatId). An in-memory origin→channel
// map would be lost on the cold start the sweeper is designed to survive — so the channel MUST be
// derivable from the chatId string itself, with zero lookup. Convention:
//   web:<clientId>   → web debug channel   (default single-user: "web:debug")
//   tg:<telegramId>  → telegram
//   <anything else>  → linq (iMessage) — bare ids are unchanged, so existing Supabase rows need no migration.
import type { Channel, ChannelKind } from './types.js';

const channels = new Map<ChannelKind, Channel>();

export function registerChannel(channel: Channel): void {
  channels.set(channel.kind, channel);
  console.log(`[channels] registered "${channel.kind}"`);
}

export function parseChannelKind(chatId: string): ChannelKind {
  if (chatId.startsWith('web:')) return 'web';
  if (chatId.startsWith('tg:')) return 'telegram';
  return 'linq';
}

export function getChannel(kind: ChannelKind): Channel | undefined {
  return channels.get(kind);
}

export function resolveChannel(chatId: string): Channel {
  const kind = parseChannelKind(chatId);
  const channel = channels.get(kind);
  if (!channel) {
    throw new Error(`[channels] no channel registered for kind "${kind}" (chatId=${chatId})`);
  }
  return channel;
}

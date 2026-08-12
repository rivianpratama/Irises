// The bridge channel: Irises fronting the ENGINE's own channel connections (WhatsApp, Signal,
// Discord, Slack, LINE, … — every platform the engine has, current and future). The engine keeps
// owning the bot/number; its bridge plugin forwards fronted inbound turns to Irises and suppresses
// the engine's own reply, and this channel sends Irises's replies back out through the engine
// (EngineBackend.channelSend). chatId scheme: `eng:<platform>:<chat_id>`.
import { getEngineBackend } from '../../agents/ops/engineBackend.js';
import type { Channel, ChatInfo } from '../types.js';

/** Parse `eng:<platform>:<chat_id>` (the chat id itself may contain colons). */
export function parseBridgeChatId(chatId: string): { platform: string; target: string } | null {
  if (!chatId.startsWith('eng:')) return null;
  const rest = chatId.slice(4);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { platform: rest.slice(0, sep), target: rest.slice(sep + 1) };
}

// Per-chat metadata learned from inbound forwards (group flag, display name) so getChat can answer
// without a network hop. In-memory: after a restart the next inbound repopulates it, and the
// default (1:1) is the safe assumption for anything unseen.
const chatMeta = new Map<string, { isGroup: boolean; name?: string }>();
const CHAT_META_CAP = 2000;

export function noteBridgeChat(chatId: string, meta: { isGroup: boolean; name?: string }): void {
  if (chatMeta.size >= CHAT_META_CAP && !chatMeta.has(chatId)) {
    const oldest = chatMeta.keys().next().value;
    if (oldest) chatMeta.delete(oldest);
  }
  chatMeta.set(chatId, meta);
}

export const bridgeChannel: Channel = {
  kind: 'bridge',
  caps: { effects: false, threading: true, reactions: false, groupOps: false, contactCard: false },

  async sendMessage(chatId, text, _effect, replyTo) {
    const parsed = parseBridgeChatId(chatId);
    if (!parsed) throw new Error(`[bridge] malformed bridge chatId "${chatId}"`);
    const engine = getEngineBackend();
    if (!engine) throw new Error('[bridge] no engine configured (OPS_BACKEND unset) — cannot deliver');
    // The engine's platforms do their own message splitting/formatting; send as one unit.
    await engine.channelSend(parsed.platform, parsed.target, text, replyTo ? { replyToId: String(replyTo.message_id) } : {});
    return {
      chat_id: chatId,
      message: { id: `eng-out-${Date.now().toString(36)}`, parts: [{ type: 'text', value: text }], sent_at: new Date().toISOString(), delivery_status: 'sent', is_read: false },
    };
  },

  // The engines don't expose typing/read for external senders uniformly — quiet no-ops. The user
  // still gets the human pacing from Irises's mouth (send timing), just no typing indicator.
  async startTyping() { /* no-op */ },
  async stopTyping() { /* no-op */ },
  async markAsRead() { /* no-op */ },

  async getChat(chatId): Promise<ChatInfo> {
    const meta = chatMeta.get(chatId);
    const isGroup = meta?.isGroup ?? false;
    return {
      id: chatId,
      display_name: meta?.name ?? null,
      handles: isGroup
        ? [{ handle: chatId, service: 'bridge' }, { handle: 'eng:irises', service: 'bridge' }, { handle: 'eng:other', service: 'bridge' }]
        : [{ handle: chatId, service: 'bridge' }, { handle: 'eng:irises', service: 'bridge' }],
      is_group: isGroup,
      service: 'bridge',
    };
  },

  async sendReaction() { /* caps.reactions=false — never called; explicit no-op for safety */ },
};

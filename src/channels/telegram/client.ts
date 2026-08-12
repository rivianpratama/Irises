// Telegram channel client (PREPARED SKELETON — off by default; see docs/CHANNELS.md).
//
// Implements the Channel interface against the Telegram Bot API. It is wired and unit-testable, but
// not started in production: registration is gated on TELEGRAM_ENABLED==='true' && TELEGRAM_BOT_TOKEN
// (see ./index.ts). Inbound media download (file_id → getFile → URL) and group-admin ops are left as
// documented TODOs.
import type { Channel, ChatInfo, Reaction } from '../types.js';

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('[telegram] TELEGRAM_BOT_TOKEN not configured');
  return t;
}

/** Strip the `tg:` prefix to get the raw Telegram chat id. */
export function telegramChatId(chatId: string): string {
  return chatId.replace(/^tg:/, '');
}

async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[telegram] ${method} ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return null;
    }
    return await res.json() as Record<string, unknown>;
  } catch (err) {
    console.warn(`[telegram] ${method} failed (non-fatal):`, err);
    return null;
  }
}

// Map Irises's tapback reaction to a Telegram standard emoji (setMessageReaction, Bot API 7.0+).
function reactionEmoji(reaction: Reaction): string | null {
  if (reaction.type === 'custom') return reaction.emoji;
  const map: Record<string, string> = { love: '❤', like: '👍', dislike: '👎', laugh: '😂', emphasize: '‼', question: '🤔' };
  return map[reaction.type] ?? null;
}

export const telegramChannel: Channel = {
  kind: 'telegram',
  caps: { effects: false, threading: true, reactions: true, groupOps: false, contactCard: false },

  async sendMessage(chatId, text, _effect, replyTo) {
    const res = await call('sendMessage', {
      chat_id: telegramChatId(chatId),
      text,
      ...(replyTo ? { reply_parameters: { message_id: Number(replyTo.message_id) } } : {}),
    });
    const result = res?.result as { message_id?: number } | undefined;
    const id = result?.message_id != null ? String(result.message_id) : 'tg-out';
    return {
      chat_id: chatId,
      message: { id, parts: [{ type: 'text', value: text }], sent_at: new Date().toISOString(), delivery_status: 'sent', is_read: false },
    };
  },

  async startTyping(chatId) { await call('sendChatAction', { chat_id: telegramChatId(chatId), action: 'typing' }); },
  async stopTyping() { /* Telegram auto-expires the typing action (~5s) — nothing to stop. */ },
  async markAsRead() { /* No bot API for read receipts. */ },

  async getChat(chatId): Promise<ChatInfo> {
    const res = await call('getChat', { chat_id: telegramChatId(chatId) });
    const result = res?.result as { type?: string; title?: string } | undefined;
    const isGroup = !!result?.type && result.type !== 'private';
    const raw = telegramChatId(chatId);
    return {
      id: chatId,
      display_name: result?.title ?? null,
      // Two handles for a 1:1 (classifier-skip), three for a group so the group path engages.
      handles: isGroup
        ? [{ handle: `tg:${raw}`, service: 'telegram' }, { handle: 'tg:irises', service: 'telegram' }, { handle: 'tg:other', service: 'telegram' }]
        : [{ handle: `tg:${raw}`, service: 'telegram' }, { handle: 'tg:irises', service: 'telegram' }],
      is_group: isGroup,
      service: 'telegram',
    };
  },

  async sendReaction(chatId, messageId, reaction) {
    const emoji = reactionEmoji(reaction);
    if (!emoji) return;
    await call('setMessageReaction', {
      chat_id: telegramChatId(chatId),
      message_id: Number(messageId),
      reaction: [{ type: 'emoji', emoji }],
    });
  },
};

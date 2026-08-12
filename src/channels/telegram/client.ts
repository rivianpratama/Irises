// Telegram channel client. Implements the Channel interface against the Telegram Bot API.
// Registration is gated on TELEGRAM_ENABLED==='true' + TELEGRAM_BOT_TOKEN + a required allowlist
// (see ./index.ts). Outbound handles text (4096-char split) and media (sendPhoto/sendDocument);
// group-admin ops stay out of scope (caps.groupOps=false — v1 is DMs only).
import type { Channel, ChatInfo, Reaction } from '../types.js';

const CALL_TIMEOUT_MS = Number(process.env.TELEGRAM_CALL_TIMEOUT_MS || 15_000);
const MAX_TEXT = 4096; // Telegram's hard per-message text cap

/** Split at the cap, preferring the last newline/space inside each window so words survive. */
export function splitTelegramText(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT);
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '), MAX_TEXT - 200);
    const at = cut > 0 ? cut : MAX_TEXT;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

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
      // A hung Bot API call must never wedge the per-chat send lock (mirrors LINQ_SEND_TIMEOUT_MS).
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
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

  async sendMessage(chatId, text, _effect, replyTo, media) {
    const chat_id = telegramChatId(chatId);
    const replyParams = replyTo ? { reply_parameters: { message_id: Number(replyTo.message_id) } } : {};
    let lastId: string | null = null;

    // Media first (an image lands, then the words about it — the natural texting order). Images
    // ride sendPhoto, everything else sendDocument; each URL must be fetchable by Telegram.
    for (const m of media ?? []) {
      const isImage = /\.(jpe?g|png|gif|webp)(\?|$)/i.test(m.url);
      const res = await call(isImage ? 'sendPhoto' : 'sendDocument', {
        chat_id, ...(isImage ? { photo: m.url } : { document: m.url }), ...replyParams,
      });
      const result = res?.result as { message_id?: number } | undefined;
      if (result?.message_id != null) lastId = String(result.message_id);
    }

    for (const [i, part] of splitTelegramText(text).entries()) {
      if (!part.trim()) continue;
      const res = await call('sendMessage', {
        chat_id, text: part,
        // Only the first part quotes the replied-to message; continuations flow bare.
        ...(i === 0 && !(media?.length) ? replyParams : {}),
      });
      const result = res?.result as { message_id?: number } | undefined;
      if (result?.message_id != null) lastId = String(result.message_id);
    }
    return {
      chat_id: chatId,
      message: { id: lastId ?? 'tg-out', parts: [{ type: 'text', value: text }], sent_at: new Date().toISOString(), delivery_status: 'sent', is_read: false },
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

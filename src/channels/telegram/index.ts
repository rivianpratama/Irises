// Telegram channel registration. Three gates, ALL required before anything starts:
//   TELEGRAM_ENABLED==='true'      — explicit opt-in
//   TELEGRAM_BOT_TOKEN             — the bot identity (often handed off from an engine — see
//                                    scripts/engine-setup.sh's token handoff)
//   TELEGRAM_ALLOWED_CHAT_IDS      — REQUIRED allowlist. After a handoff the engine's own
//                                    pairing/allowlist no longer guards this bot; without a list
//                                    anyone who finds the bot could spend the deployment's tokens,
//                                    so an empty list refuses to start rather than open the door.
// Transport: TELEGRAM_MODE=polling (default; no public URL needed, deleteWebhook on start) or
// TELEGRAM_MODE=webhook (register /webhook/telegram with setWebhook + secret yourself).
import type { Express } from 'express';
import { registerChannel } from '../registry.js';
import { telegramChannel } from './client.js';
import { createTelegramWebhook } from './webhook.js';
import { startTelegramPolling } from './polling.js';
import { allowedChatIds, type TelegramDeps } from './inbound.js';

export function registerTelegram(app: Express, deps: TelegramDeps): void {
  if (process.env.TELEGRAM_ENABLED !== 'true' || !process.env.TELEGRAM_BOT_TOKEN) return;
  if (allowedChatIds().size === 0) {
    console.error('[telegram] TELEGRAM_ALLOWED_CHAT_IDS is required (comma-separated raw chat ids) — channel NOT started. DM @userinfobot on Telegram to find your id.');
    return;
  }
  registerChannel(telegramChannel);
  const mode = (process.env.TELEGRAM_MODE || 'polling').toLowerCase();
  if (mode === 'webhook') {
    app.use(createTelegramWebhook(deps));
    console.log('[telegram] channel enabled — webhook mode (POST /webhook/telegram; register it with setWebhook)');
  } else {
    startTelegramPolling(deps);
    console.log('[telegram] channel enabled — polling mode (getUpdates; webhook cleared on start)');
  }
}

// Telegram channel registration (PREPARED SKELETON). No-op unless BOTH TELEGRAM_ENABLED==='true'
// and TELEGRAM_BOT_TOKEN are set, so an unset token can never boot a half-wired channel. To go live:
// set those env vars and register the webhook with Telegram (see docs/CHANNELS.md).
import type { Express } from 'express';
import { registerChannel } from '../registry.js';
import { telegramChannel } from './client.js';
import { createTelegramWebhook } from './webhook.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

export function registerTelegram(app: Express, deps: { enqueueInbound: EnqueueInbound; agentClient: AgentClient }): void {
  if (process.env.TELEGRAM_ENABLED !== 'true' || !process.env.TELEGRAM_BOT_TOKEN) return;
  registerChannel(telegramChannel);
  app.use(createTelegramWebhook(deps));
  console.log('[telegram] channel enabled — POST /webhook/telegram');
}

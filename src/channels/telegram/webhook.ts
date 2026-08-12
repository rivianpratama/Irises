// Telegram inbound webhook (PREPARED SKELETON). Parses a Telegram Update into the neutral inbound
// event and feeds the SAME enqueueInbound pipeline as Linq/web. Off unless registered (see ./index.ts).
import { Router, type Request, type Response } from 'express';
import { emptyMedia } from '../../webhook/types.js';
import type { AgentClient, EnqueueInbound } from '../../index.js';

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    reply_to_message?: { message_id: number };
  };
}

export function createTelegramWebhook(deps: { enqueueInbound: EnqueueInbound; agentClient: AgentClient }): Router {
  const router = Router();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  router.post('/webhook/telegram', (req: Request, res: Response) => {
    // Validate Telegram's secret-token header when configured.
    if (secret && req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) { res.sendStatus(401); return; }

    const update = req.body as TelegramUpdate;
    const msg = update?.message;
    if (!msg || typeof msg.text !== 'string') { res.sendStatus(200); return; }  // ignore non-text (media TODO)

    const chatId = `tg:${msg.chat.id}`;
    const from = `tg:${msg.from?.id ?? msg.chat.id}`;
    const messageId = String(msg.message_id);
    const replyTo = msg.reply_to_message ? { message_id: String(msg.reply_to_message.message_id) } : undefined;

    // TODO(skeleton): inbound media (photo/document/voice) → file_id → getFile → download URL → IncomingMedia.
    deps.enqueueInbound(deps.agentClient, chatId, from, msg.text, messageId, emptyMedia(), undefined, replyTo);
    res.sendStatus(200);
  });

  return router;
}

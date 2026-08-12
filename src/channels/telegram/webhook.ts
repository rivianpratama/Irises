// Telegram inbound webhook — the alternative transport for deployments that already have a public
// HTTPS URL (TELEGRAM_MODE=webhook; register it with setWebhook + a secret, see docs/CHANNELS.md).
// Parsing, the allowlist, the DMs-only gate, and media extraction all live in inbound.ts, shared
// verbatim with the polling transport.
import { Router, type Request, type Response } from 'express';
import { handleTelegramUpdate, type TelegramDeps, type TelegramUpdate } from './inbound.js';

export function createTelegramWebhook(deps: TelegramDeps): Router {
  const router = Router();

  router.post('/webhook/telegram', (req: Request, res: Response) => {
    // Validate Telegram's secret-token header when configured (read per-request so a rotated
    // secret applies without a restart).
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) { res.sendStatus(401); return; }

    // Ack immediately — Telegram retries slow webhooks, and media extraction does its own fetches.
    res.sendStatus(200);
    void handleTelegramUpdate(req.body as TelegramUpdate, deps)
      .catch(err => console.error('[telegram] webhook update handling failed:', err));
  });

  return router;
}

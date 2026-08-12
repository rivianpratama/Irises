// Telegram long-polling transport — the default mode, chosen so adopters need NO public HTTPS URL
// (and because it's what the engines run, so a bot-token handoff drops straight in). On start it
// calls deleteWebhook: Telegram refuses getUpdates while a webhook is registered, and an engine
// that ran the bot in webhook mode leaves one behind — clearing it IS the handoff's last step.
import { handleTelegramUpdate, type TelegramDeps, type TelegramUpdate } from './inbound.js';

const POLL_TIMEOUT_S = 50;              // Telegram long-poll hold (its max is 50s)
const ERROR_BACKOFF_MS = Number(process.env.TELEGRAM_POLL_BACKOFF_MS || 5_000);

export interface PollingHandle { stop(): void; }

export function startTelegramPolling(deps: TelegramDeps): PollingHandle {
  const fetchFn = deps.fetchFn ?? fetch;
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const base = `https://api.telegram.org/bot${token}`;
  let stopped = false;
  let offset = 0;

  const loop = async () => {
    // Handoff hygiene: clear any webhook the previous owner (an engine) registered. Also drops
    // pending webhook-queued updates — the handoff moment is a clean slate, not a replay.
    try {
      await fetchFn(`${base}/deleteWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
      });
    } catch (err) {
      console.warn('[telegram] deleteWebhook failed (continuing — polling may 409 until it clears):', err);
    }

    while (!stopped) {
      // The long poll holds up to POLL_TIMEOUT_S server-side; abort a bit after that. Manual
      // controller (not AbortSignal.timeout) so the timer is cleared+unref'd every cycle — a
      // leaked per-iteration timer would pin the process (and hang the test runner) for minutes.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 10) * 1000);
      (timer as { unref?: () => void }).unref?.();
      try {
        const res = await fetchFn(`${base}/getUpdates`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeout: POLL_TIMEOUT_S, offset, allowed_updates: ['message'] }),
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(`[telegram] getUpdates ${res.status}: ${(await res.text()).slice(0, 120)}`);
          await sleep(ERROR_BACKOFF_MS);
          continue;
        }
        const data = await res.json() as { ok?: boolean; result?: TelegramUpdate[] };
        for (const update of data.result ?? []) {
          if (typeof update.update_id === 'number') offset = update.update_id + 1;
          try {
            await handleTelegramUpdate(update, deps);
          } catch (err) {
            console.error('[telegram] update handling failed (skipping one update):', err);
          }
        }
      } catch (err) {
        if (stopped) break;
        // Timeout of an idle long poll is normal; anything else gets a breath before redialing.
        if ((err as Error)?.name !== 'TimeoutError' && (err as Error)?.name !== 'AbortError') {
          console.warn('[telegram] poll cycle failed (backing off):', err);
          await sleep(ERROR_BACKOFF_MS);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };
  void loop();
  return { stop: () => { stopped = true; } };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });
}

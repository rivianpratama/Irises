// hermes-agent adapter. Speaks ONLY hermes's public, documented surfaces — the OpenAI-compatible
// API server (`/v1/chat/completions`, enabled on the user's hermes via API_SERVER_ENABLED +
// API_SERVER_KEY; default port 8642) and its cron REST API (`/api/jobs`). hermes itself is never
// modified. Per-chat continuity + engine-side memory scoping ride the X-Hermes-Session-Id/Key
// headers, so hermes builds its own deepening model of each chat.
import { EngineUnavailableError, EngineRunError, ENGINE_TIMEOUT_MS } from './engineBackend.js';
import type { EngineBackend, EngineRunContext, ReminderSpec, ReminderRef, ProbeResult } from './engineBackend.js';
import type { OpsTask } from '../types.js';

/** Injectable impure edges — the repo's DI testing convention (no module mocks). */
export interface HermesDeps {
  fetchFn: typeof fetch;
  now: () => number;
}
const realDeps: HermesDeps = { fetchFn: (...a) => fetch(...a), now: () => Date.now() };

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** Session key for a chat: stable, header-safe, ≤64 chars of the id (hermes caps at 256). */
export function hermesSessionKey(chatId: string): string {
  return `irises-${chatId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)}`;
}

/** Job-name scope so listing/cancel only ever touch jobs Irises created for this chat. */
export function jobPrefix(chatId: string): string {
  return `irises:${chatId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24)}:`;
}

/** The cron-job prompt template: do the work, then deliver THROUGH IRISES so the user hears it in
 *  Irises's voice on their channel — the engine never speaks to the user directly. */
export function reminderJobPrompt(spec: ReminderSpec, pushUrl: string): string {
  return [
    `A reminder you set for the Irises assistant's user (chat ${spec.chatId}) is due.`,
    `Instruction: ${spec.instruction}`,
    'Do any work the instruction needs (look things up with your tools if required), then deliver the outcome to the Irises app so it can tell the user:',
    `POST ${pushUrl} with header "x-engine-token: $IRISES_PUSH_TOKEN" (the IRISES_PUSH_TOKEN environment variable is set in your environment) and JSON body {"chatId": ${JSON.stringify(spec.chatId)}, "kind": "reminder", "text": "<what to tell the user, plain text>"}.`,
    'The text should be the substance only — Irises re-voices it in its own tone. Do not deliver anywhere else.',
  ].join('\n');
}

export class HermesBackend implements EngineBackend {
  readonly name = 'hermes' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deps: HermesDeps;

  constructor(deps: Partial<HermesDeps> = {}) {
    this.baseUrl = (process.env.HERMES_BASE_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
    this.apiKey = process.env.HERMES_API_KEY || '';
    this.deps = { ...realDeps, ...deps };
  }

  private headers(chatId?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (chatId) {
      // Session-Id: server-side conversation continuity. Session-Key: long-term memory scoping —
      // hermes threads it to its user-model layer, so each chat accrues its own engine-side memory.
      h['X-Hermes-Session-Id'] = hermesSessionKey(chatId);
      h['X-Hermes-Session-Key'] = hermesSessionKey(chatId);
    }
    return h;
  }

  /** fetch with the engine-call timeout AND the caller's abort signal, mapped to seam errors. */
  private async request(path: string, init: RequestInit, signal?: AbortSignal, timeoutMs = ENGINE_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      return await this.deps.fetchFn(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      // fetch throws TypeError on connection-level failures (refused/reset/DNS) — the engine is AWAY.
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new EngineUnavailableError(`hermes not reachable at ${this.baseUrl} (${(err as Error)?.message ?? err})`, err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private async throwForStatus(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new EngineRunError(`hermes rejected the API key (${res.status}) — check HERMES_API_KEY`, 'needs_auth', res.status);
    }
    if (res.status === 429) {
      throw new EngineRunError('hermes is at its concurrent-run cap (429)', 'rate_limited', res.status);
    }
    throw new EngineRunError(`hermes ${what} failed: ${res.status} ${body.slice(0, 300)}`, 'llm_error', res.status);
  }

  async runTask(prompt: string, task: OpsTask, ctx: EngineRunContext): Promise<string> {
    // Media mapping: images ride the OpenAI content-blocks shape hermes supports (image_url with
    // http(s)/data: URLs; raw uploads return 400 so URLs it is). Audio/video/docs can't be inlined
    // on this endpoint — pass their URLs in text for hermes's OWN tools to fetch/read/transcribe.
    const media = task.media;
    const images = media?.images ?? [];
    const others = [...(media?.audio ?? []), ...(media?.video ?? []), ...(media?.docs ?? [])];
    let text = prompt;
    if (others.length) {
      text += `\n\nAttached non-image file URLs (fetch and read them with your tools):\n${others
        .map(m => `- ${m.filename ?? 'file'} (${m.mimeType}): ${m.url}`).join('\n')}`;
    }
    const content: unknown = images.length
      ? [{ type: 'text', text }, ...images.map(m => ({ type: 'image_url', image_url: { url: m.url } }))]
      : text;

    const res = await this.request('/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(task.chatId),
      body: JSON.stringify({ model: 'hermes-agent', messages: [{ role: 'user', content }], stream: false }),
    }, ctx.signal);
    await this.throwForStatus(res, 'chat completion');
    const data = await res.json() as ChatCompletionResponse;
    const out = data.choices?.[0]?.message?.content;
    if (typeof out !== 'string') throw new EngineRunError('hermes returned no message content', 'llm_error', res.status);
    return out;
  }

  async createReminder(spec: ReminderSpec): Promise<ReminderRef> {
    const pushUrl = process.env.IRISES_PUSH_URL || `http://127.0.0.1:${process.env.PORT || 3000}/api/engine/push`;
    let schedule: string;
    let repeat: number | undefined;
    if (spec.cron) {
      schedule = spec.cron;
    } else if (spec.fireAt) {
      // One-time: pin the exact minute as a cron and let repeat:1 retire the job after it fires.
      const d = new Date(spec.fireAt);
      schedule = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
      repeat = 1;
    } else {
      throw new EngineRunError('reminder needs cron or fireAt', 'tool_errors');
    }
    const name = `${jobPrefix(spec.chatId)}${(spec.title || spec.instruction).slice(0, 40)}`;
    const res = await this.request('/api/jobs', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, schedule, prompt: reminderJobPrompt(spec, pushUrl), deliver: 'local', ...(repeat ? { repeat } : {}) }),
    }, undefined, 15_000);
    await this.throwForStatus(res, 'job create');
    const data = await res.json() as { job?: { id?: string | number; name?: string; schedule?: string } };
    return { id: String(data.job?.id ?? name), title: data.job?.name ?? name, schedule: data.job?.schedule ?? schedule };
  }

  async listReminders(chatId: string): Promise<ReminderRef[]> {
    const res = await this.request('/api/jobs', { method: 'GET', headers: this.headers() }, undefined, 15_000);
    await this.throwForStatus(res, 'job list');
    const data = await res.json() as { jobs?: Array<{ id?: string | number; name?: string; schedule?: string }> };
    const prefix = jobPrefix(chatId);
    return (data.jobs ?? [])
      .filter(j => (j.name ?? '').startsWith(prefix))
      .map(j => ({ id: String(j.id ?? ''), title: (j.name ?? '').slice(prefix.length), schedule: j.schedule ?? '' }));
  }

  async cancelReminder(id: string): Promise<boolean> {
    const res = await this.request(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers() }, undefined, 15_000);
    if (res.status === 404) return false;
    await this.throwForStatus(res, 'job delete');
    return true;
  }

  async remember(chatId: string, _agentHandle: string, note: string): Promise<void> {
    // Ride the chat's own engine session: hermes's memory loop persists what lands in-session.
    const res = await this.request('/v1/chat/completions', {
      method: 'POST',
      headers: this.headers(chatId),
      body: JSON.stringify({
        model: 'hermes-agent', stream: false,
        messages: [{ role: 'user', content: `Durable note about this user for your long-term memory (store it; no action needed, no reply beyond OK): ${note}` }],
      }),
    }, undefined, 60_000);
    await this.throwForStatus(res, 'memory note');
  }

  async probe(): Promise<ProbeResult> {
    try {
      const res = await this.request('/v1/capabilities', { method: 'GET', headers: this.headers() }, undefined, 5_000);
      if (!res.ok) return { ok: false, detail: `capabilities returned ${res.status} — check HERMES_API_KEY` };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: String((err as Error)?.message ?? err) };
    }
  }
}

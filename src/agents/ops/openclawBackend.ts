// OpenClaw adapter. Speaks the Gateway WebSocket control plane — the documented external-app path
// (`agent` RPC with expectFinal, protocol v4) via the official @openclaw/gateway-client package.
// OpenClaw itself is never modified; the WS control plane is always on when the gateway runs.
//
// The npm client is NOT a package.json dependency: it is installed by scripts/engine-setup.sh only
// when the user picks --engine openclaw (the package may lag OpenClaw releases, and hermes users
// shouldn't pay for it). A missing package surfaces as EngineUnavailableError with the install hint.
//
// v1 scope note: runTask / remember / probe are complete. Reminder scheduling has a working hermes
// path; on OpenClaw it lands next iteration (the cron.add RPC payload shape needs verification
// against a live gateway — see docs/ENGINES.md), so those methods fail honestly for now.
import { EngineUnavailableError, EngineRunError, ENGINE_TIMEOUT_MS } from './engineBackend.js';
import type { EngineBackend, EngineRunContext, ReminderSpec, ReminderRef, ProbeResult, CapabilitySummary } from './engineBackend.js';
import type { OpsTask } from '../types.js';

interface GatewayClientLike {
  start(): Promise<void> | void;
  request(method: string, params: Record<string, unknown>, opts?: { expectFinal?: boolean; timeoutMs?: number }): Promise<unknown>;
  stop?(): void;
  close?(): void;
}

interface AgentRunResult {
  status?: string;
  summary?: string;
  result?: { payloads?: Array<{ text?: string }> };
}

/** Injectable impure edges (repo DI convention): the client factory replaces module mocking. */
export interface OpenClawDeps {
  createClient: () => Promise<GatewayClientLike>;
}

export function openclawSessionKey(chatId: string): string {
  const agentId = process.env.OPENCLAW_AGENT_ID || 'main';
  return `agent:${agentId}:irises-${chatId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)}`;
}

async function defaultCreateClient(): Promise<GatewayClientLike> {
  let mod: { GatewayClient?: new (opts: Record<string, unknown>) => GatewayClientLike };
  try {
    // Dynamic + variable specifier so the package is optional AND tsc doesn't try to resolve it:
    // only OpenClaw deployments install it (scripts/engine-setup.sh --engine openclaw).
    const specifier = '@openclaw/gateway-client';
    mod = await import(specifier) as typeof mod;
  } catch (err) {
    throw new EngineUnavailableError(
      '@openclaw/gateway-client is not installed — run `npm i @openclaw/gateway-client` (scripts/engine-setup.sh --engine openclaw does this)', err);
  }
  if (!mod.GatewayClient) throw new EngineUnavailableError('@openclaw/gateway-client did not export GatewayClient');
  const client = new mod.GatewayClient({
    url: process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789',
    token: process.env.OPENCLAW_TOKEN || '',
    minProtocol: 4,
    maxProtocol: 4,
  });
  await client.start();
  return client;
}

export class OpenClawBackend implements EngineBackend {
  readonly name = 'openclaw' as const;
  private client: GatewayClientLike | null = null;
  private connecting: Promise<GatewayClientLike> | null = null;
  private readonly deps: OpenClawDeps;

  constructor(deps: Partial<OpenClawDeps> = {}) {
    this.deps = { createClient: defaultCreateClient, ...deps };
  }

  /** Lazy singleton with recreate-on-failure: a dead socket is dropped so the next call redials. */
  private async ensureClient(): Promise<GatewayClientLike> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.deps.createClient()
        .then(c => { this.client = c; return c; })
        .catch(err => {
          throw err instanceof EngineUnavailableError
            ? err
            : new EngineUnavailableError(`OpenClaw gateway not reachable (${(err as Error)?.message ?? err})`, err);
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private dropClient(): void {
    try { this.client?.stop?.(); this.client?.close?.(); } catch { /* already dead */ }
    this.client = null;
  }

  async runTask(prompt: string, task: OpsTask, ctx: EngineRunContext): Promise<string> {
    // Media: URLs in text for the agent's own fetch/browser tools. (The agent RPC also has a
    // native `attachments` param — adopt it once its payload shape is verified live.)
    const media = task.media;
    const all = [...(media?.images ?? []), ...(media?.audio ?? []), ...(media?.video ?? []), ...(media?.docs ?? [])];
    let message = prompt;
    if (all.length) {
      message += `\n\nAttached file URLs (fetch and read them with your tools):\n${all
        .map(m => `- ${m.filename ?? 'file'} (${m.mimeType}): ${m.url}`).join('\n')}`;
    }
    const client = await this.ensureClient();
    if (ctx.signal?.aborted) throw new EngineRunError('cancelled before dispatch', 'cancelled');
    let raw: unknown;
    try {
      raw = await client.request('agent', {
        message,
        sessionKey: openclawSessionKey(task.chatId),
        idempotencyKey: task.id,
        timeout: Math.ceil(ENGINE_TIMEOUT_MS / 1000),
      }, { expectFinal: true, timeoutMs: ENGINE_TIMEOUT_MS + 15_000 });
    } catch (err) {
      // A transport-level failure poisons the socket — drop it so the next call redials.
      this.dropClient();
      throw new EngineUnavailableError(`OpenClaw agent call failed at transport level (${(err as Error)?.message ?? err})`, err);
    }
    const run = raw as AgentRunResult;
    if (run.status === 'error') throw new EngineRunError(`OpenClaw run errored: ${run.summary ?? 'no summary'}`, 'llm_error');
    if (run.status === 'timeout') throw new EngineRunError('OpenClaw run hit its timeout', 'timeout');
    const text = (run.result?.payloads ?? []).map(p => p.text ?? '').filter(Boolean).join('\n').trim();
    if (!text) throw new EngineRunError(`OpenClaw run returned no text (status ${run.status ?? 'unknown'})`, 'llm_error');
    return text;
  }

  async createReminder(_spec: ReminderSpec): Promise<ReminderRef> {
    throw new EngineRunError('reminders on the OpenClaw backend are not wired yet (cron.add shape pending verification) — see docs/ENGINES.md', 'tool_errors');
  }

  async listReminders(_chatId: string): Promise<ReminderRef[]> {
    return [];
  }

  async cancelReminder(_id: string): Promise<boolean> {
    throw new EngineRunError('reminders on the OpenClaw backend are not wired yet — see docs/ENGINES.md', 'tool_errors');
  }

  async remember(chatId: string, _agentHandle: string, note: string): Promise<void> {
    // Phrased as a REQUEST — the engine owns its memory and decides how (and whether) to
    // fold this in; Irises never writes engine storage directly.
    const client = await this.ensureClient();
    try {
      await client.request('agent', {
        message: `Please update your memory about this user with the following, however you see fit — no user-visible action needed, reply OK: ${note}`,
        sessionKey: openclawSessionKey(chatId),
        idempotencyKey: `remember-${chatId}-${note.length}-${Date.now().toString(36)}`,
        timeout: 60,
      }, { expectFinal: true, timeoutMs: 75_000 });
    } catch (err) {
      this.dropClient();
      throw new EngineUnavailableError(`OpenClaw memory note failed (${(err as Error)?.message ?? err})`, err);
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      await this.ensureClient();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: String((err as Error)?.message ?? err) };
    }
  }

  /** OpenClaw capability discovery is a separate future path: the gateway exposes its tool inventory
   *  over a different RPC than hermes's REST `/v1/toolsets`, and that payload shape needs verification
   *  against a live gateway (same status as reminders — see docs/ENGINES.md). Until it's wired, report
   *  unknown so Convo falls back to its static doctrine rather than guessing at a capability set. */
  getCapabilitySummary(): CapabilitySummary | null {
    return null;
  }

  /** Bridge outbound: the gateway `send` RPC delivers through ANY configured OpenClaw channel
   *  (verified: src/gateway/server-methods/send.ts; scope operator.write; idempotencyKey required).
   *  No plugin needed on the outbound side — the same WS client the deep-work seam uses. */
  async channelSend(platform: string, chatId: string, text: string, opts: { threadId?: string; replyToId?: string } = {}): Promise<{ messageId?: string }> {
    const client = await this.ensureClient();
    try {
      await client.request('send', {
        to: chatId,
        channel: platform,
        message: text,
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        ...(opts.replyToId ? { replyToId: opts.replyToId } : {}),
        idempotencyKey: `irises-${chatId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      }, { timeoutMs: 20_000 });
      // The send RPC's reply carries no platform message id, so tapped-reply matching on this
      // engine falls back to the synthetic bubble id (bridge/channel.ts).
      return {};
    } catch (err) {
      this.dropClient();
      throw new EngineUnavailableError(`OpenClaw channel send failed (${(err as Error)?.message ?? err})`, err);
    }
  }
}

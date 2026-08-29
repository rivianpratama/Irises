// The "model map": which model Irises's own VOICE runs on vs. which model the host engine
// (hermes/OpenClaw) runs its DEEP WORK on. Computed from the already-resolved config (MODELS/PROVIDERS
// reflect env after engine discovery has run in loadEnv) plus the engine model captured at discovery.
// Feeds three surfaces: Irises's in-chat self-awareness (agents/convo), /health, and the dashboard.
//
// Pattern mirrors src/update/version.ts — a plain getter over already-resolved state, safe to call
// from anywhere. The LIVE fields are read at call time — endpoint (laneBaseUrl), configured
// (isLaneConfigured), and engine (getDiscoveredEngine, so a re-discovery shows up). The `model` and
// `provider` fields come from the MODELS/PROVIDERS consts, which are resolved ONCE at models.ts
// module-init (from process.env, itself loaded from .env only at boot), so changing a *_MODEL /
// *_PROVIDER needs a process restart to appear here — exactly matching what callLLM actually routes.

import { MODELS, PROVIDERS } from './models.js';
import { isLaneConfigured, laneBaseUrl } from './laneKeys.js';
import { getDiscoveredEngine } from '../agents/ops/engineDiscovery.js';
import type { LlmProvider, LlmRole } from './types.js';

export interface VoiceLaneInfo {
  role: LlmRole;
  provider: LlmProvider;
  model: string;
  /** The endpoint this lane talks to — the host for anthropic (SDK default unless ANTHROPIC_BASE_URL),
   *  the configured base URL for the OpenAI-compatible lanes. */
  endpoint: string;
  /** Whether this lane has a usable key (blank counts as unset — see laneKeys). */
  configured: boolean;
}

export interface ModelMap {
  /** Irises's own small conversational roles and the model each runs on. */
  voice: VoiceLaneInfo[];
  /** The host engine's own deep-work model (always the engine's config, not Irises's lanes). */
  engine: { backend: string | null; model: string | null; provider: string | null };
  /** OpenRouter-shaped side lanes that degrade gracefully off OpenRouter (see embed.ts / transcribe.ts). */
  sideLanes: {
    embeddings: { enabled: boolean; configured: boolean };
    transcription: { configured: boolean };
  };
}

/** The voice roles the model map reports (Irises's own conversational LLM calls). `ops` is
 *  engine-owned and `embed`/`transcribe` are side lanes reported separately. */
const VOICE_ROLES: readonly LlmRole[] = ['convo', 'classify', 'fallfirm'];

function truthyEnv(name: string): boolean {
  return ['1', 'true', 'on', 'yes', 'enabled'].includes((process.env[name] || '').trim().toLowerCase());
}

/** The base URL / host a lane talks to, for display. */
function endpointFor(provider: LlmProvider): string {
  if (provider === 'anthropic') return process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com';
  return laneBaseUrl(provider);
}

export function getModelMap(): ModelMap {
  const voice: VoiceLaneInfo[] = VOICE_ROLES.map(role => {
    const provider = PROVIDERS[role];
    return {
      role,
      provider,
      model: MODELS[role][provider],
      endpoint: endpointFor(provider),
      configured: isLaneConfigured(provider),
    };
  });

  const eng = getDiscoveredEngine();
  // An OpenAI-compatible side lane needs OpenRouter OR the generic OpenAI lane configured.
  const openAiCompatConfigured = isLaneConfigured('openrouter') || isLaneConfigured('openai');

  return {
    voice,
    engine: { backend: eng?.backend ?? null, model: eng?.model ?? null, provider: eng?.provider ?? null },
    sideLanes: {
      embeddings: { enabled: truthyEnv('MEMORY_SEMANTIC_RECALL'), configured: openAiCompatConfigured },
      transcription: { configured: openAiCompatConfigured },
    },
  };
}

/** A compact one-line-per-lane rendering, for the diagnostics CLI and logs. */
export function formatModelMap(map: ModelMap = getModelMap()): string {
  const lines: string[] = [];
  lines.push('Irises voice (own conversational models):');
  for (const v of map.voice) {
    const key = v.configured ? '' : '  ⚠ no key';
    lines.push(`  ${v.role.padEnd(8)} ${v.provider}/${v.model}  @ ${v.endpoint}${key}`);
  }
  lines.push('');
  if (map.engine.backend) {
    lines.push(`Engine deep work (${map.engine.backend}): ${map.engine.model ?? '?'}${map.engine.provider ? ` (provider ${map.engine.provider})` : ''}`);
  } else {
    lines.push('Engine deep work: none (standalone / OPS_BACKEND=off — Convo still chats)');
  }
  lines.push('');
  const emb = map.sideLanes.embeddings;
  lines.push(`Embeddings (semantic recall): ${emb.enabled ? (emb.configured ? 'on' : 'ON but no OpenAI/OpenRouter key — recall stays lexical') : 'off'}`);
  lines.push(`Transcription (voice memos): ${map.sideLanes.transcription.configured ? 'available' : 'unavailable (no OpenAI/OpenRouter key)'}`);
  return lines.join('\n');
}

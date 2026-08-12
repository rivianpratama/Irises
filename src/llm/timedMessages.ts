// Folds the structured LlmMessage.timestamp field into wire-safe content at the provider boundary.
//
// Internally a timed message is `{ role, timestamp, content }` — that's what agents build, what
// diagnostics/traces record, and what the dashboard shows. But both provider APIs (Anthropic and
// the OpenAI-compatible OpenRouter) reject unknown keys on message objects, so the timestamp can't
// travel as its own wire field. This renderer is the single place it becomes in-band:
//   - string content   → `[Mon, Jul 6, 9:14 PM] the text`
//   - block content    → a leading `{ type: 'text', text: '[Mon, Jul 6, 9:14 PM]' }` block before the rest
// Pure and side-effect-free; called by both provider adapters (callLLM.ts / openrouterRequest.ts).
import type { LlmMessage } from './types.js';

export function renderTimestamps(messages: LlmMessage[]): LlmMessage[] {
  return messages.map(m => {
    if (!m.timestamp) return m;
    const tag = `[${m.timestamp}]`;
    return typeof m.content === 'string'
      ? { role: m.role, content: `${tag} ${m.content}` }
      : { role: m.role, content: [{ type: 'text' as const, text: tag }, ...m.content] };
  });
}

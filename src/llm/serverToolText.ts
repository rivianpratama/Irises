// Harvest human-readable text from SERVER-SIDE web-search results so the Ops grounding backstop
// (agents/ops/fidelity.ts) can see facts the model legitimately sourced from the live web.
//
// Both providers run web_search server-side and fold the results into the reply — those results
// never pass through a CLIENT tool, so without this they never enter Ops' toolCorpus. The symptom
// (seen live on the prod dashboard): Ops web-searches a public figure, finds their employer/phone/
// email, then the fidelity check flags every one of those facts as ungrounded because none appear
// in a tool RESULT, and the answer is suppressed to "no sign of them." Seeding this text into the
// corpus is what lets a legitimately web-sourced fact ground.
//
// We extract titles, URLs, and the CITED SNIPPETS — the raw page bodies are encrypted (Anthropic
// `encrypted_content`) or excerpted (OpenRouter), but the snippet the model actually cited carries
// the evidence, which is exactly what grounding needs to confirm. Pure + defensive: unknown or
// error-shaped payloads yield '' instead of throwing (a diagnostics-adjacent path must never break
// a reply). Field names verified against the live Anthropic web-search and OpenRouter annotations
// docs (web_search_result / web_search_result_location; url_citation).

function dedupeLines(lines: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join('\n');
}

/**
 * Anthropic Messages content blocks from a server web_search turn. Two carriers:
 *   - `web_search_tool_result` → `content` is a LIST of `web_search_result` {title, url, …}
 *     (on error it's a single `web_search_tool_result_error` object, not a list — Array.isArray skips it).
 *   - text blocks → `citations` list of `web_search_result_location` {title, url, cited_text}.
 * SDK 0.39 doesn't type these blocks, so everything is read defensively as unknown.
 */
export function fromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const lines: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content as Array<Record<string, unknown>>) {
        const title = typeof r?.title === 'string' ? r.title : '';
        const url = typeof r?.url === 'string' ? r.url : '';
        const line = [title, url].filter(Boolean).join(' — ');
        if (line) lines.push(line);
      }
    } else if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations as Array<Record<string, unknown>>) {
        const cited = typeof c?.cited_text === 'string' ? c.cited_text : '';
        const title = typeof c?.title === 'string' ? c.title : '';
        const url = typeof c?.url === 'string' ? c.url : '';
        const line = [cited, title, url].filter(Boolean).join(' — ');
        if (line) lines.push(line);
      }
    }
  }
  return dedupeLines(lines);
}

/**
 * OpenRouter chat.completion assistant message. Web results ride in `annotations` as `url_citation`
 * entries: `{ type: 'url_citation', url_citation: { url, title, content, … } }` where `content` is
 * an extractive excerpt of the page.
 */
export function fromOpenRouterMessage(message: unknown): string {
  const annotations = (message as { annotations?: unknown } | null)?.annotations;
  if (!Array.isArray(annotations)) return '';
  const lines: string[] = [];
  for (const a of annotations as Array<Record<string, unknown>>) {
    if (!a || a.type !== 'url_citation') continue;
    const uc = (a.url_citation ?? {}) as Record<string, unknown>;
    const content = typeof uc.content === 'string' ? uc.content : '';
    const title = typeof uc.title === 'string' ? uc.title : '';
    const url = typeof uc.url === 'string' ? uc.url : '';
    const line = [content, title, url].filter(Boolean).join(' — ');
    if (line) lines.push(line);
  }
  return dedupeLines(lines);
}

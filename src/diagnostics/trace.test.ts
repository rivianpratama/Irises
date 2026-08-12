import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, getTraces, clearTraces } from './trace.js';

// Regression: recorded payloads must be stored VERBATIM by default (DIAGNOSTICS_STR_CAP=0).
// The 8000-char truncation once applied here clipped long system prompts in the dashboard,
// which read as if the API had received a truncated prompt (it never did).
test('system prompts, responses and raw payloads are recorded verbatim by default', () => {
  clearTraces();
  const system = 'S'.repeat(50_000);
  const response = 'R'.repeat(20_000);
  const rawText = 'W'.repeat(30_000);
  record({
    type: 'llm', role: 'ops', label: 'ops:step0', chatId: 'c-trace-test',
    system, response, raw: { content: [{ type: 'text', text: rawText }] },
  });
  const ev = getTraces().at(-1)!;
  assert.equal(ev.system, system);
  assert.equal(ev.response, response);
  const raw = ev.raw as { content: Array<{ text: string }> };
  assert.equal(raw.content[0].text, rawText);
  assert.ok(!String(ev.system).includes('…[+'), 'no truncation marker expected');
  clearTraces();
});

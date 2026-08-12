import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromAnthropicContent, fromOpenRouterMessage } from './serverToolText.js';

// The shapes here mirror the live Anthropic web-search response (web_search_tool_result +
// web_search_result_location citations) and OpenRouter url_citation annotations, verbatim per docs.

test('Anthropic: harvests web_search_tool_result items (title — url)', () => {
  const content = [
    { type: 'text', text: "I'll search for that." },
    { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'x' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv1',
      content: [
        { type: 'web_search_result', url: 'https://northwind.example/team/mharris', title: 'Margaret Harris — Northwind Labs', encrypted_content: 'ZZZ', page_age: 'May 1, 2026' },
      ],
    },
  ];
  const out = fromAnthropicContent(content);
  assert.match(out, /Margaret Harris — Northwind Labs/);
  assert.match(out, /https:\/\/northwind\.example\/team\/mharris/);
  assert.doesNotMatch(out, /ZZZ/, 'encrypted_content must not leak into the corpus');
});

test('Anthropic: harvests text-block citations with cited_text', () => {
  const content = [
    {
      type: 'text',
      text: 'She is at Northwind Labs.',
      citations: [
        { type: 'web_search_result_location', url: 'https://northwind.example', title: 'Northwind Labs', cited_text: 'Margaret Harris, mharris@northwind.example, (414) 699-6676', encrypted_index: 'idx' },
      ],
    },
  ];
  const out = fromAnthropicContent(content);
  assert.match(out, /mharris@northwind\.example/);
  assert.match(out, /\(414\) 699-6676/);
});

test('Anthropic: an error-shaped result (content is an object, not a list) is skipped, not thrown', () => {
  const content = [
    { type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  ];
  assert.equal(fromAnthropicContent(content), '');
});

test('Anthropic: non-array content and plain turns yield empty string', () => {
  assert.equal(fromAnthropicContent('a string'), '');
  assert.equal(fromAnthropicContent(undefined), '');
  assert.equal(fromAnthropicContent([{ type: 'text', text: 'no citations here' }]), '');
});

test('Anthropic: duplicate results across pause_turn legs dedupe within one extraction', () => {
  const content = [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
  ];
  assert.equal(fromAnthropicContent(content), 'A — https://a.com');
});

test('OpenRouter: harvests url_citation annotations (content — title — url)', () => {
  const message = {
    role: 'assistant',
    content: 'Here is what I found.',
    annotations: [
      { type: 'url_citation', url_citation: { url: 'https://northwind.example', title: 'Northwind Labs', content: 'Margaret Harris is an assistant manager…', start_index: 0, end_index: 20 } },
      { type: 'url_citation', url_citation: { url: 'https://directory.example/x', title: 'Directory', content: 'Open weekdays 9am to 5pm' } },
    ],
  };
  const out = fromOpenRouterMessage(message);
  assert.match(out, /Margaret Harris is an assistant manager/);
  assert.match(out, /Open weekdays 9am to 5pm/);
  assert.match(out, /https:\/\/directory\.example\/x/);
});

test('OpenRouter: a message with no annotations yields empty string; non-url_citation types are skipped', () => {
  assert.equal(fromOpenRouterMessage({ role: 'assistant', content: 'x' }), '');
  assert.equal(fromOpenRouterMessage({ annotations: [{ type: 'file', file: {} }] }), '');
  assert.equal(fromOpenRouterMessage(null), '');
});

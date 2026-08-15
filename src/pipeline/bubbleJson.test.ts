import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBubblesJson, bubblesToLegacyText, normalizeLlmText, parseReply, parseMmReply, buildEnvelopeSchema, BUBBLE_ENVELOPE_SCHEMA, MM_ENVELOPE_SCHEMA, MAX_BUBBLES } from './bubbleJson.js';
import { splitIntoBubbles } from './bubbles.js';
import { resolveOutboundBubbles } from '../state/replyThreading.js';

// ── clean envelopes ──────────────────────────────────────────────────────────────────────────

test('a clean envelope parses to bubbles and bridges to legacy --- text', () => {
  const raw = '{"bubbles":[{"text":"option period ends friday"},{"text":"you have until EOD to walk"}]}';
  const bubbles = parseBubblesJson(raw);
  assert.deepEqual(bubbles, [
    { text: 'option period ends friday' },
    { text: 'you have until EOD to walk' },
  ]);
  assert.equal(normalizeLlmText(raw), 'option period ends friday\n---\nyou have until EOD to walk');
});

test('the re field renders back to a [[re:N]] prefix', () => {
  const raw = '{"bubbles":[{"text":"owner is the delgado trust","re":2},{"text":"want the full record?"}]}';
  assert.equal(normalizeLlmText(raw), '[[re:2]]owner is the delgado trust\n---\nwant the full record?');
});

test('invalid re values are dropped, the bubble still sends unthreaded', () => {
  for (const badRe of ['0', '"x"', '3.5', '100', 'null']) {
    const raw = `{"bubbles":[{"text":"hi","re":${badRe}}]}`;
    assert.equal(normalizeLlmText(raw), 'hi', `re=${badRe} should be dropped`);
  }
  // a string index that IS valid is coerced
  assert.equal(normalizeLlmText('{"bubbles":[{"text":"hi","re":"2"}]}'), '[[re:2]]hi');
});

// ── the four parse tiers ─────────────────────────────────────────────────────────────────────

test('tier 1: ```json fenced envelope parses', () => {
  const raw = '```json\n{"bubbles":[{"text":"clear to close"}]}\n```';
  assert.equal(normalizeLlmText(raw), 'clear to close');
});

test('tier 2: prose-wrapped JSON is extracted', () => {
  const raw = 'Sure! {"bubbles":[{"text":"done"}]} hope that helps';
  assert.equal(normalizeLlmText(raw), 'done');
});

test('tier 3: lightly broken JSON (trailing comma, single quotes) is repaired', () => {
  const raw = "{'bubbles':[{'text':'rate came in at 6.5',},]}";
  assert.equal(normalizeLlmText(raw), 'rate came in at 6.5');
});

test('tier 4: a truncated envelope (max_tokens cut mid-string) is rescued', () => {
  // No closing quote/brackets — jsonrepair on the full string closes them.
  const raw = '{"bubbles":[{"text":"option period ends fri';
  const out = normalizeLlmText(raw);
  assert.ok(out && out.startsWith('option period ends fri'), `got: ${JSON.stringify(out)}`);
});

test('truncated multi-bubble: the completed bubbles survive', () => {
  const raw = '{"bubbles":[{"text":"first thought"},{"text":"second tho';
  const out = normalizeLlmText(raw);
  assert.ok(out && out.includes('first thought'), `got: ${JSON.stringify(out)}`);
});

// ── the legacy fallback (never drop a turn) ──────────────────────────────────────────────────

test('plain --- prose (a not-yet-flipped persona) passes through UNCHANGED', () => {
  const raw = "option period ends march 14\n---\nyou've still got contingency rights";
  assert.equal(parseBubblesJson(raw), null);
  assert.equal(normalizeLlmText(raw), raw);
});

test('plain prose with an incidental brace is not mistaken for an envelope', () => {
  const raw = 'the seller wants to close by friday {no pressure though}';
  assert.equal(parseBubblesJson(raw), null);
  assert.equal(normalizeLlmText(raw), raw);
});

test('null / empty input yields null', () => {
  assert.equal(normalizeLlmText(null), null);
  assert.equal(normalizeLlmText(undefined), null);
  assert.equal(normalizeLlmText(''), null);
  assert.equal(normalizeLlmText('   '), null);
});

// ── the empty envelope (tool-only turn) ──────────────────────────────────────────────────────

test('an empty envelope is a valid tool-only turn → null (not a fallback)', () => {
  assert.deepEqual(parseBubblesJson('{"bubbles":[]}'), []);
  assert.equal(normalizeLlmText('{"bubbles":[]}'), null);
  assert.equal(bubblesToLegacyText([]), null);
});

test('an envelope whose items are all unusable also collapses to a tool-only turn', () => {
  // valid JSON, valid shape, but no usable text — safer to treat as empty than to show JSON to a user
  assert.equal(normalizeLlmText('{"bubbles":[{"note":"oops"}]}'), null);
  assert.equal(normalizeLlmText('{"bubbles":["   "]}'), null);
});

// ── lenient shapes ───────────────────────────────────────────────────────────────────────────

test('a bare top-level array is accepted', () => {
  assert.equal(normalizeLlmText('[{"text":"a"},{"text":"b"}]'), 'a\n---\nb');
});

test('bare-string bubble items are accepted', () => {
  assert.equal(normalizeLlmText('{"bubbles":["a","b"]}'), 'a\n---\nb');
});

test('a wrong-shaped bubbles value is rejected (not an envelope)', () => {
  assert.equal(parseBubblesJson('{"bubbles":"hi"}'), null);
  assert.equal(parseBubblesJson('{"reply":"hi"}'), null);
});

// ── sanitization / caps ──────────────────────────────────────────────────────────────────────

test('empty and whitespace bubbles are dropped, text is trimmed', () => {
  assert.equal(normalizeLlmText('{"bubbles":[{"text":"  a  "},{"text":""},{"text":"b"}]}'), 'a\n---\nb');
});

test('an over-cap reply is capped at MAX_BUBBLES', () => {
  const many = Array.from({ length: MAX_BUBBLES + 5 }, (_, i) => ({ text: `b${i}` }));
  const bubbles = parseBubblesJson(JSON.stringify({ bubbles: many }));
  assert.equal(bubbles?.length, MAX_BUBBLES);
});

// ── round-trip: bridge output survives the real send pipeline ────────────────────────────────

test('bridge output re-splits through splitIntoBubbles to the same bubbles', () => {
  const raw = '{"bubbles":[{"text":"option period ends march 14"},{"text":"want the contract language?"}]}';
  const legacy = normalizeLlmText(raw)!;
  assert.deepEqual(splitIntoBubbles(legacy), [
    'option period ends march 14',
    'want the contract language?',
  ]);
});

test('bridge re prefixes resolve to native reply targets downstream', () => {
  const raw = '{"bubbles":[{"text":"owner is the trust","re":2},{"text":"want more?"}]}';
  const legacy = normalizeLlmText(raw)!;
  const segments = splitIntoBubbles(legacy);
  const { bubbles, targets } = resolveOutboundBubbles(segments, ['id-one', 'id-two'], { isBurst: true });
  assert.deepEqual(bubbles, ['owner is the trust', 'want more?']);
  assert.deepEqual(targets, [{ message_id: 'id-two' }, undefined]);
});

// ── confidence_level (the AICommenter convinced_level field) ─────────────────────────────────

test('parseReply extracts bubbles AND confidence_level', () => {
  const r = parseReply('{"bubbles":[{"text":"clear to close"}],"confidence_level":90}');
  assert.equal(r.legacyText, 'clear to close');
  assert.equal(r.confidenceLevel, 90);
});

test('confidence_level FIRST (above bubbles, the Convo contract order) parses identically', () => {
  const r = parseReply('{"confidence_level":25,"bubbles":[{"text":"which deal do you mean?"}]}');
  assert.equal(r.confidenceLevel, 25);
  assert.equal(r.legacyText, 'which deal do you mean?');
  // and an empty tool-only envelope with leading confidence still yields null text + the number
  const t = parseReply('{"confidence_level":85,"bubbles":[]}');
  assert.equal(t.legacyText, null);
  assert.equal(t.confidenceLevel, 85);
});

test('confidence_level 0 is kept (not treated as absent)', () => {
  assert.equal(parseReply('{"bubbles":[{"text":"no idea honestly"}],"confidence_level":0}').confidenceLevel, 0);
});

test('confidence_level is rounded and clamped to 0..100', () => {
  assert.equal(parseReply('{"bubbles":[{"text":"a"}],"confidence_level":150}').confidenceLevel, 100);
  assert.equal(parseReply('{"bubbles":[{"text":"a"}],"confidence_level":-5}').confidenceLevel, 0);
  assert.equal(parseReply('{"bubbles":[{"text":"a"}],"confidence_level":72.6}').confidenceLevel, 73);
  assert.equal(parseReply('{"bubbles":[{"text":"a"}],"confidence_level":"80"}').confidenceLevel, 80);
});

test('a missing or non-numeric confidence_level is undefined but the bubbles still parse', () => {
  assert.equal(parseReply('{"bubbles":[{"text":"a"}]}').confidenceLevel, undefined);
  const bad = parseReply('{"bubbles":[{"text":"a"}],"confidence_level":"high"}');
  assert.equal(bad.confidenceLevel, undefined);
  assert.equal(bad.legacyText, 'a');
});

test('confidence_level does not leak into the bubble text or the bridged output', () => {
  assert.equal(normalizeLlmText('{"bubbles":[{"text":"done"}],"confidence_level":88}'), 'done');
});

test('parseReply on non-JSON prose yields no confidence, raw text passthrough', () => {
  const r = parseReply('just a normal reply');
  assert.equal(r.legacyText, 'just a normal reply');
  assert.equal(r.confidenceLevel, undefined);
});

// ── bracketed-prose false positives (the critical bugs Fable caught) ──────────────────────────

test('a legacy [[re:N]]-tagged --- reply (not-yet-flipped persona) passes through UNCHANGED', () => {
  // THE rollout-safety case: this is live traffic today. Must NOT be swallowed into a tool-only turn.
  const raw = '[[re:2]]owner is the delgado trust\n---\nwant the full record?';
  assert.equal(parseBubblesJson(raw), null);
  assert.equal(normalizeLlmText(raw), raw);
});

test('prose with a bracketed citation/token is not mistaken for an envelope', () => {
  for (const raw of [
    'grabbed the tax records [1] want a summary?',
    'i marked it [done] for you',
    'he wrote "definately" [sic] in the addendum',
  ]) {
    assert.equal(parseBubblesJson(raw), null, `should not parse: ${raw}`);
    assert.equal(normalizeLlmText(raw), raw);
  }
});

test('prose with a bracketed dollar range is left intact, never chopped into $1 / $2 / 000', () => {
  const raw = '[$1,800 - $2,000] is the range i found';
  assert.equal(parseBubblesJson(raw), null);
  assert.equal(normalizeLlmText(raw), raw);
});

test('two envelopes joined by a newline (multi text-block) merge into one reply', () => {
  const raw = '{"bubbles":[{"text":"a"}]}\n{"bubbles":[{"text":"b"}]}';
  assert.equal(normalizeLlmText(raw), 'a\n---\nb');
});

test('normalize is idempotent: re-normalizing bridge output does not swallow the [[re:N]] tag', () => {
  const once = normalizeLlmText('{"bubbles":[{"text":"owner is the trust","re":2},{"text":"more?"}]}')!;
  assert.equal(normalizeLlmText(once), once);
});

test('prose-wrapped truncated envelope is rescued from the first brace', () => {
  const raw = 'Sure! {"bubbles":[{"text":"done and du';
  const out = normalizeLlmText(raw);
  assert.ok(out && out.startsWith('done and du'), `got: ${JSON.stringify(out)}`);
});

// ── cap keeps the LAST bubble (where the link/question lives) ─────────────────────────────────

test('over-cap: the final bubble (e.g. a consent link) survives the cap', () => {
  const bubbles = Array.from({ length: MAX_BUBBLES + 3 }, (_, i) => ({ text: `filler ${i}` }));
  bubbles.push({ text: 'tap to connect: https://consent.example.com/abc' });
  const out = normalizeLlmText(JSON.stringify({ bubbles }))!;
  assert.ok(out.includes('https://consent.example.com/abc'), 'the link bubble must not be dropped');
  assert.equal(out.split('\n---\n').length, MAX_BUBBLES);
});

// ── round-trip documentation (behavior is intentional, pin it) ───────────────────────────────

test('a bubble text that itself contains --- re-splits downstream (documented behavior)', () => {
  const legacy = normalizeLlmText('{"bubbles":[{"text":"a --- b"}]}')!;
  assert.deepEqual(splitIntoBubbles(legacy), ['a', 'b']);
});

test('a bubble the model overpacked is still split by the 20-word backstop', () => {
  // JSON parses fine, but the single text is a 24-word wall — splitLongBubble must still fire.
  const wall = 'the option period ends march 14 so you still have your contingency rights until then and i can pull the exact contract language for you';
  const legacy = normalizeLlmText(JSON.stringify({ bubbles: [{ text: wall }] }))!;
  const out = splitIntoBubbles(legacy);
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  for (const b of out) assert.ok(words(b) <= 20, `bubble over ceiling: "${b}"`);
});

// ── written tool calls (the toolsViaJson envelope) ───────────────────────────────────────────────

test('envelope with tool_calls: bubbles bridge, calls extract, null args are stripped', () => {
  const r = parseReply(JSON.stringify({
    confidence_level: 70,
    tool_calls: [{ name: 'delegate_to_ops', args: { kind: 'dealmachine', request: 'owner of 412 maple', meta_prompt: null, address: '412 Maple', deal_ref: null, confirmed: null } }],
    bubbles: [{ text: 'pulling the owner now', re: null }],
  }));
  assert.equal(r.wasEnvelope, true);
  assert.equal(r.legacyText, 'pulling the owner now');
  assert.equal(r.confidenceLevel, 70);
  assert.deepEqual(r.toolCalls, [{ name: 'delegate_to_ops', input: { kind: 'dealmachine', request: 'owner of 412 maple', address: '412 Maple' } }]);
});

test('tool_calls-only turn (empty bubbles) yields null text but the calls still extract', () => {
  const r = parseReply('{"confidence_level":85,"tool_calls":[{"name":"send_reaction","args":{"type":"like"}}],"bubbles":[]}');
  assert.equal(r.legacyText, null);
  assert.deepEqual(r.toolCalls, [{ name: 'send_reaction', input: { type: 'like' } }]);
});

test('tool_calls: null / [] / missing all mean no calls, envelope still valid', () => {
  for (const tc of ['null', '[]', undefined]) {
    const raw = tc === undefined
      ? '{"confidence_level":80,"bubbles":[{"text":"hi"}]}'
      : `{"confidence_level":80,"tool_calls":${tc},"bubbles":[{"text":"hi"}]}`;
    const r = parseReply(raw);
    assert.equal(r.wasEnvelope, true, `raw: ${raw}`);
    assert.equal(r.toolCalls, undefined);
    assert.equal(r.legacyText, 'hi');
  }
});

test('args as a JSON STRING (model slip) is parsed; boolean/number strings coerce for typed consumers', () => {
  const r = parseReply(JSON.stringify({
    confidence_level: 90,
    tool_calls: [
      { name: 'unlink_account', args: '{"confirmed":"true"}' },
      { name: 'set_preference', args: { key: 'feature_declined', value: 'true' } },
      { name: 'set_preference', args: { key: 'commission_split', value: '70' } },
      { name: 'schedule_automation', args: { instruction: 'nudge', needs_ops: 'false', schedule_kind: 'once' } },
    ],
    bubbles: [{ text: 'done' }],
  }));
  assert.deepEqual(r.toolCalls, [
    { name: 'unlink_account', input: { confirmed: true } },
    { name: 'set_preference', input: { key: 'feature_declined', value: true } },
    { name: 'set_preference', input: { key: 'commission_split', value: 70 } },
    { name: 'schedule_automation', input: { instruction: 'nudge', needs_ops: false, schedule_kind: 'once' } },
  ]);
});

test('a tool_calls entry with no usable name is dropped; the rest survive; bubbles always ship', () => {
  const r = parseReply(JSON.stringify({
    confidence_level: 60,
    tool_calls: [{ args: { kind: 'general' } }, { name: '  ' }, { name: 'send_reaction', args: { type: 'love' } }, 'garbage'],
    bubbles: [{ text: 'ok' }],
  }));
  assert.deepEqual(r.toolCalls, [{ name: 'send_reaction', input: { type: 'love' } }]);
  assert.equal(r.legacyText, 'ok');
});

test('truncation mid-tool_call: tier 4 keeps the prefix (confidence survives, bubbles lost is OK)', () => {
  // Schema order is confidence_level, tool_calls, bubbles — a max_tokens cut inside the call
  // must still parse the prefix rather than dropping the whole envelope.
  const raw = '{"confidence_level":70,"tool_calls":[{"name":"delegate_to_ops","args":{"kind":"dealmachine","request":"owner of 412 map';
  const r = parseReply(raw);
  assert.equal(r.wasEnvelope, true);
  assert.equal(r.confidenceLevel, 70);
});

test('unparseable garble that mentions tool_calls is suppressed, never texted as shrapnel', () => {
  const raw = 'sure thing! "tool_calls" here we go {{{"name": delegate';
  const r = parseReply(raw);
  assert.equal(r.legacyText, null, 'JSON shrapnel must not reach the user');
  assert.equal(r.wasEnvelope, false);
});

test('wasEnvelope is the retry signal: true for any valid envelope, false for prose/empty', () => {
  assert.equal(parseReply('{"confidence_level":85,"bubbles":[]}').wasEnvelope, true);
  assert.equal(parseReply('just prose').wasEnvelope, false);
  assert.equal(parseReply('').wasEnvelope, false);
  assert.equal(parseReply(null).wasEnvelope, false);
});

test('multi-envelope merge (newline-joined blocks) merges tool_calls too, not just bubbles', () => {
  const raw = '{"bubbles":[{"text":"a"}],"tool_calls":[{"name":"send_reaction","args":{"type":"like"}}]}\n{"bubbles":[{"text":"b"}],"tool_calls":[{"name":"remember_user","args":{"name":"Sam"}}]}';
  const r = parseReply(raw);
  assert.equal(r.legacyText, 'a\n---\nb');
  assert.deepEqual(r.toolCalls?.map(c => c.name), ['send_reaction', 'remember_user']);
});

// ── buildEnvelopeSchema ──────────────────────────────────────────────────────────────────────────

test('buildEnvelopeSchema without tools returns the plain bubble schema verbatim', () => {
  assert.equal(buildEnvelopeSchema(), BUBBLE_ENVELOPE_SCHEMA);
  assert.equal(buildEnvelopeSchema([]), BUBBLE_ENVELOPE_SCHEMA);
});

test('buildEnvelopeSchema: name enum, flat nullable args union, truncation-safe field order', () => {
  const schema = buildEnvelopeSchema([
    { name: 'a_tool', description: 'd', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['x', 'y'] }, flag: { type: 'boolean' } }, required: ['kind'] } },
    { name: 'b_tool', description: 'd', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, note: { description: 'untyped' } } } },
  ]) as {
    required: string[];
    properties: { tool_calls: { items: { properties: { name: { enum: string[] }; args: { required: string[]; properties: Record<string, { type: string[] }>; additionalProperties: boolean } } } } };
  };
  assert.deepEqual(schema.required, ['confidence_level', 'tool_calls', 'bubbles', 'status']);
  const items = schema.properties.tool_calls.items;
  assert.deepEqual(items.properties.name.enum, ['a_tool', 'b_tool']);
  const args = items.properties.args;
  assert.equal(args.additionalProperties, false);
  assert.deepEqual([...args.required].sort(), ['flag', 'kind', 'note']); // union across tools, first-wins on dupes
  assert.deepEqual(args.properties.flag.type, ['boolean', 'null']);
  assert.deepEqual(args.properties.kind.type, ['string', 'null']); // enum flattens to string (values in description)
  assert.deepEqual(args.properties.note.type, ['string', 'null']); // untyped arg defaults to string
});

// ── the MM envelope (direct-voice media agent: {could_not_open, analysis, bubbles}) ─────────────

test('MM_ENVELOPE_SCHEMA is strict-mode + Gemini-safe: all fields required, no type unions', () => {
  const s = MM_ENVELOPE_SCHEMA as { required: string[]; additionalProperties: boolean; properties: Record<string, { type?: unknown }> };
  assert.deepEqual(s.required, ['could_not_open', 'analysis', 'bubbles']); // property order = chain-of-thought order
  assert.equal(s.additionalProperties, false);
  // No nullable/multi-primitive unions anywhere — Gemini's classic schema-translation 400.
  for (const [key, def] of Object.entries(s.properties)) {
    assert.equal(typeof def.type, 'string', `property ${key} must have a single primitive type`);
  }
  const bubbles = s.properties.bubbles as { items: { required: string[]; additionalProperties: boolean; properties: { text: { type: string } } } };
  assert.deepEqual(bubbles.items.required, ['text']);
  assert.equal(bubbles.items.additionalProperties, false);
  assert.equal(bubbles.items.properties.text.type, 'string');
});

test('parseMmReply: a clean MM envelope yields bridged bubbles + the private analysis', () => {
  const raw = '{"could_not_open":false,"analysis":"page 3 of a service agreement; total $310,000; renewal ~Jul 24","bubbles":[{"text":"it\'s page 3 of the service agreement"},{"text":"total reads $310,000"}]}';
  const r = parseMmReply(raw);
  assert.equal(r.wasEnvelope, true);
  assert.equal(r.couldNotOpen, false);
  assert.equal(r.legacyText, "it's page 3 of the service agreement\n---\ntotal reads $310,000");
  assert.match(r.analysis ?? '', /\$310,000/);
});

test('parseMmReply: fenced and prose-wrapped MM envelopes still parse (tiered walk)', () => {
  const fenced = '```json\n{"could_not_open":false,"analysis":"a photo of a bike frame","bubbles":[{"text":"that frame has a hairline crack"}]}\n```';
  assert.equal(parseMmReply(fenced).legacyText, 'that frame has a hairline crack');
  const wrapped = 'sure! {"could_not_open":false,"analysis":"a memo","bubbles":[{"text":"the memo confirms friday"}]} hope that helps';
  assert.equal(parseMmReply(wrapped).legacyText, 'the memo confirms friday');
});

test('parseMmReply: jsonrepair rescues a lightly malformed MM envelope', () => {
  const sloppy = "{could_not_open: false, analysis: 'a receipt screenshot', bubbles: [{text: 'total shows $415'},]}";
  const r = parseMmReply(sloppy);
  assert.equal(r.wasEnvelope, true);
  assert.equal(r.legacyText, 'total shows $415');
  assert.equal(r.analysis, 'a receipt screenshot');
});

test('parseMmReply: could_not_open true with empty bubbles → couldNotOpen flag, null text', () => {
  const r = parseMmReply('{"could_not_open":true,"analysis":"the file would not decode","bubbles":[]}');
  assert.equal(r.couldNotOpen, true);
  assert.equal(r.legacyText, null);
  assert.equal(r.wasEnvelope, true);
});

test('parseMmReply: missing/empty analysis normalizes to null', () => {
  assert.equal(parseMmReply('{"could_not_open":false,"analysis":"","bubbles":[{"text":"hi"}]}').analysis, null);
  assert.equal(parseMmReply('{"bubbles":[{"text":"hi"}]}').analysis, null);
});

test('parseMmReply: NO raw-text passthrough — a prose slip yields null text, wasEnvelope false', () => {
  const r = parseMmReply('I looked at the photo and it shows a bike frame with a hairline crack.');
  assert.equal(r.wasEnvelope, false);
  assert.equal(r.legacyText, null); // unlike parseReply, raw prose must never ship as MM's reply
  assert.equal(r.analysis, null);
  assert.equal(r.couldNotOpen, false);
  // empty input behaves the same
  assert.equal(parseMmReply('').wasEnvelope, false);
  assert.equal(parseMmReply(null).legacyText, null);
});

test('parseReply regression: an MM envelope still bridges through the shared parser unchanged', () => {
  const raw = '{"could_not_open":false,"analysis":"private","bubbles":[{"text":"one"},{"text":"two"}]}';
  const shared = parseReply(raw);
  assert.equal(shared.wasEnvelope, true);
  assert.equal(shared.legacyText, 'one\n---\ntwo'); // bubbles key is the canonical envelope marker
});

// ── hidden status field (mood/gauges/meta-prompt) — parsed, exposed, never bridged to the user ──

test('parseReply exposes the hidden status object and never leaks it into bubble text', () => {
  const raw = '{"confidence_level":80,"tool_calls":null,"bubbles":[{"text":"hey","re":null}],"status":{"mood_core":"joyful","mood_label":"hopeful","mood_level":72}}';
  const r = parseReply(raw);
  assert.equal(r.wasEnvelope, true);
  assert.equal(r.legacyText, 'hey');                 // ONLY the bubble text bridges to the user
  assert.equal(r.statusRaw?.mood_core, 'joyful');    // status is captured for the persona layer
  assert.equal(r.statusRaw?.mood_level, 72);
  assert.ok(!String(r.legacyText).includes('joyful')); // never leaks into what the user sees
});

test('parseReply tolerates a null / missing status without breaking the envelope', () => {
  const nulled = parseReply('{"confidence_level":80,"tool_calls":null,"bubbles":[{"text":"hi","re":null}],"status":null}');
  assert.equal(nulled.legacyText, 'hi');
  assert.equal(nulled.statusRaw, undefined);

  const missing = parseReply('{"confidence_level":80,"bubbles":[{"text":"hi","re":null}]}');
  assert.equal(missing.legacyText, 'hi');
  assert.equal(missing.statusRaw, undefined);
});

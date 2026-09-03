import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicSystem, MAX_CACHE_BREAKPOINTS } from './callLLM.js';

type Block = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

test('no system → undefined; caching off → bare string (billed as ordinary input)', () => {
  assert.equal(buildAnthropicSystem(undefined, true, [100]), undefined);
  assert.equal(buildAnthropicSystem('', true, [100]), undefined);
  assert.equal(buildAnthropicSystem('you are irises', false, [5]), 'you are irises');
});

test('caching on, no prefix boundary → the whole system is one cached block (whole-system shape)', () => {
  for (const none of [undefined, [] as number[]]) {
    const out = buildAnthropicSystem('stable ops system', true, none) as Block[];
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'stable ops system');
    assert.equal(out[0].cache_control?.type, 'ephemeral');
  }
});

test('caching on, ONE breakpoint → persona cached + per-turn remainder UNcached, byte for byte as before', () => {
  // Mirrors Convo: `${persona}${perTurn}`. Only the persona must carry cache_control, so the cache
  // matches the persona across turns instead of the varying whole system.
  const persona = 'PERSONA-'.repeat(10);      // the stable head
  const perTurn = `\n\nRight now it's ${new Date(0).toISOString()} ...`; // varies every turn
  const system = persona + perTurn;
  const out = buildAnthropicSystem(system, true, [persona.length]) as Block[];
  // Deep-equal, not field by field: a single offset must emit EXACTLY the two blocks the
  // one-length signature emitted before breakpoints became a list — nothing added, nothing renamed.
  assert.deepEqual(out, [
    { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perTurn },
  ]);
});

test('TWO breakpoints → two cached prefixes in order, the tail still uncached', () => {
  // Convo since the craft pages moved into the per-turn block: the persona head, then the slot that
  // is stable WITHIN a chat (tool docs + craft pages), then the genuinely per-turn tail.
  const persona = 'PERSONA-'.repeat(10);
  const stable = 'CRAFT-'.repeat(10);
  const perTurn = '\n\ntheir message, the clock, the dossier';
  const system = persona + stable + perTurn;
  const out = buildAnthropicSystem(system, true, [persona.length, persona.length + stable.length]) as Block[];
  assert.deepEqual(out, [
    { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perTurn },
  ]);
  assert.equal(out.map(b => b.text).join(''), system, 'the split adds, drops and reorders nothing');
});

test('a breakpoint that does not advance is dropped — an empty stable slot leaves ONE breakpoint', () => {
  // What a turn with no tool docs and no craft page hands in: the second offset lands exactly where
  // the first did. It must not become a zero-length block (the API rejects those) — the request has
  // to come out identical to a single-breakpoint one.
  const system = 'PERSONA-'.repeat(10) + '\n\nper-turn';
  const one = buildAnthropicSystem(system, true, [80]);
  assert.deepEqual(buildAnthropicSystem(system, true, [80, 80]), one);
  assert.deepEqual(buildAnthropicSystem(system, true, [80, 40]), one, 'and neither does one that goes backwards');
});

test('out-of-range breakpoints are ignored, and a list of nothing but bad ones falls all the way back', () => {
  const system = 'short system';
  for (const bad of [system.length, system.length + 1, 0, -5, NaN]) {
    const out = buildAnthropicSystem(system, true, [bad]) as Block[];
    assert.equal(out.length, 1, `offset=${bad} → single whole-system block`);
    assert.equal(out[0].text, system);
    assert.equal(out[0].cache_control?.type, 'ephemeral');
  }
  // A bad one in front of a good one costs only itself.
  const out = buildAnthropicSystem(system, true, [0, 5]) as Block[];
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'short');
});

test('no more cache breakpoints than the provider allows, whatever the caller asks for', () => {
  assert.equal(MAX_CACHE_BREAKPOINTS, 4, "Anthropic's per-request limit on cache_control blocks");
  const system = 'x'.repeat(100);
  const out = buildAnthropicSystem(system, true, [10, 20, 30, 40, 50, 60]) as Block[];
  const cached = out.filter(b => b.cache_control);
  assert.equal(cached.length, MAX_CACHE_BREAKPOINTS, 'the first four, in order');
  assert.deepEqual(cached.map(b => b.text.length), [10, 10, 10, 10]);
  assert.equal(out.length, MAX_CACHE_BREAKPOINTS + 1, 'plus the uncached tail');
  assert.equal(out[out.length - 1].cache_control, undefined);
  assert.equal(out.map(b => b.text).join(''), system);
});

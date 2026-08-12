import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicSystem } from './callLLM.js';

type Block = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

test('no system → undefined; caching off → bare string (billed as ordinary input)', () => {
  assert.equal(buildAnthropicSystem(undefined, true, 100), undefined);
  assert.equal(buildAnthropicSystem('', true, 100), undefined);
  assert.equal(buildAnthropicSystem('you are irises', false, 5), 'you are irises');
});

test('caching on, no prefix boundary → the whole system is one cached block (Ops/Reflexion shape)', () => {
  const out = buildAnthropicSystem('stable ops system', true, undefined) as Block[];
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'stable ops system');
  assert.equal(out[0].cache_control?.type, 'ephemeral');
});

test('caching on, valid prefix boundary → persona cached + per-turn remainder UNcached (the fix)', () => {
  // Mirrors Convo: `${persona}${perTurn}`. Only the persona must carry cache_control, so the cache
  // matches the persona across turns instead of the varying whole system.
  const persona = 'PERSONA-'.repeat(10);      // the stable head
  const perTurn = `\n\nRight now it's ${new Date(0).toISOString()} ...`; // varies every turn
  const system = persona + perTurn;
  const out = buildAnthropicSystem(system, true, persona.length) as Block[];
  assert.equal(out.length, 2, 'split into a cached prefix + an uncached remainder');
  assert.equal(out[0].text, persona);
  assert.equal(out[0].cache_control?.type, 'ephemeral', 'the persona block IS cached');
  assert.equal(out[1].text, perTurn);
  assert.equal(out[1].cache_control, undefined, 'the per-turn remainder is NOT a cache breakpoint');
  // Byte-exact reconstruction: the split must not add/drop/reorder a single character.
  assert.equal(out[0].text + out[1].text, system);
});

test('an out-of-range prefix boundary falls back to a single whole-system cached block (defensive)', () => {
  const system = 'short system';
  // len >= system.length (e.g. a stale/miscomputed boundary) must NOT produce an empty remainder block.
  for (const badLen of [system.length, system.length + 1, 0, -5]) {
    const out = buildAnthropicSystem(system, true, badLen) as Block[];
    assert.equal(out.length, 1, `len=${badLen} → single block`);
    assert.equal(out[0].text, system);
    assert.equal(out[0].cache_control?.type, 'ephemeral');
  }
});

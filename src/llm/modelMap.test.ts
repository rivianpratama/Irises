import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModelMap, formatModelMap, type ModelMap } from './modelMap.js';

test('getModelMap: three voice roles + engine + sideLanes, all well-formed', () => {
  const m = getModelMap();
  assert.equal(m.voice.length, 3);
  assert.deepEqual(m.voice.map(v => v.role).sort(), ['classify', 'convo', 'fallfirm']);
  for (const v of m.voice) {
    assert.ok(v.provider, 'each voice lane names a provider');
    assert.ok(v.model, 'each voice lane names a model');
    assert.ok(v.endpoint, 'each voice lane names an endpoint');
    assert.equal(typeof v.configured, 'boolean');
  }
  assert.ok('backend' in m.engine && 'model' in m.engine && 'provider' in m.engine);
  assert.ok('embeddings' in m.sideLanes && 'transcription' in m.sideLanes);
});

test('formatModelMap: renders the voice lanes, the engine line, and side-lane status', () => {
  const map: ModelMap = {
    voice: [
      { role: 'convo', provider: 'openai', model: 'gpt-5.6-luna', endpoint: 'https://api.openai.com/v1', configured: true },
      { role: 'classify', provider: 'openai', model: 'gpt-5.6-luna', endpoint: 'https://api.openai.com/v1', configured: false },
      { role: 'fallfirm', provider: 'openai', model: 'gpt-5.6-luna', endpoint: 'https://api.openai.com/v1', configured: true },
    ],
    engine: { backend: 'hermes', model: 'gpt-5.6-terra', provider: 'openai' },
    sideLanes: { embeddings: { enabled: false, configured: true }, transcription: { configured: true } },
  };
  const out = formatModelMap(map);
  assert.match(out, /convo\s+openai\/gpt-5\.6-luna/);
  assert.match(out, /no key/, 'an unconfigured lane is flagged');
  assert.match(out, /Engine deep work \(hermes\): gpt-5\.6-terra/);
  assert.match(out, /Transcription/);
});

test('formatModelMap: standalone (no engine) reads as none', () => {
  const map: ModelMap = {
    voice: [{ role: 'convo', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', endpoint: 'https://openrouter.ai/api/v1', configured: true }],
    engine: { backend: null, model: null, provider: null },
    sideLanes: { embeddings: { enabled: false, configured: false }, transcription: { configured: false } },
  };
  const out = formatModelMap(map);
  assert.match(out, /Engine deep work: none/);
});

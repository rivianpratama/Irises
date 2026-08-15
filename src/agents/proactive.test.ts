// Run with: npm test   (TZ=UTC DATA_BACKEND=memory tsx --test)
// The proactive voicer: the shape of the instruction the Composer gets (branch mark first, payload
// last), the byte-pin between PROACTIVE_MARK and the persona's branch trigger, and the guarantee
// that a proactive message NEVER goes silent — with no voice model reachable, the Fallfirm floor
// still carries the substance.
process.env.TZ = 'UTC';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROACTIVE_MARK, fallfirmOutcomeFor, voiceProactive, _internal, type ProactiveKind } from './proactive.js';
import { fallfirmFloor } from './fallfirm/floor.js';
import { resetStorageForTests } from '../db/sqlite.js';

const KINDS: ProactiveKind[] = ['reminder', 'email', 'memo', 'update'];

beforeEach(() => resetStorageForTests());

test('the persona branch trigger is byte-identical to PROACTIVE_MARK', () => {
  const persona = readFileSync(join(__dirname, 'composer', 'Context.md'), 'utf8');
  assert.ok(
    persona.includes(PROACTIVE_MARK),
    'composer/Context.md must carry the exact PROACTIVE_MARK phrase — the branch is keyed on the surface form',
  );
});

test('the instruction opens on the branch mark and ends on the payload', () => {
  for (const kind of KINDS) {
    const text = `the ${kind} substance, verbatim`;
    const instruction = _internal.buildProactiveInstruction({ kind, text });
    assert.ok(instruction.startsWith(PROACTIVE_MARK), `${kind}: the mark leads`);
    assert.ok(instruction.trimEnd().endsWith(`"${text}"`), `${kind}: the facts are the last thing read`);
    // The fidelity contract is restated per turn, not left to the persona alone.
    assert.match(instruction, /only place your facts come from/);
    assert.match(instruction, /voice, register and continuity ONLY/);
  }
});

test('caller framing rides between the kind framing and the facts', () => {
  const instruction = _internal.buildProactiveInstruction({
    kind: 'update', text: 'now on build abc1234', framing: 'you just came back from an upgrade',
  });
  const framingAt = instruction.indexOf('you just came back from an upgrade');
  const factsAt = instruction.indexOf('now on build abc1234');
  assert.ok(framingAt > 0 && factsAt > framingAt, 'framing first, facts last');
});

test('each kind is pointed at its own moment, and none of them names machinery', () => {
  for (const kind of KINDS) {
    const instruction = _internal.buildProactiveInstruction({ kind, text: 'x' });
    assert.match(instruction, /orient|placing|first beat/, `${kind}: the orientation beat is asked for`);
    assert.doesNotMatch(instruction, /\bcron\b|\bjob\b|\bengine\b|\bwebhook\b/i);
  }
});

test('the Fallfirm degrade carries the substance in facts, the framing in summary', () => {
  const outcome = fallfirmOutcomeFor({ kind: 'email', text: 'karen sent the lease back', framing: 'it looked urgent' });
  assert.equal(outcome.kind, 'confirmed');
  assert.equal(outcome.facts, 'karen sent the lease back');
  assert.match(outcome.summary, /their email/);
  assert.match(outcome.summary, /it looked urgent/);
});

test('with no voice model configured, the floor still lands with the substance', async (t) => {
  // Mirrors the enginePush push-delivery convention: in a key-less test env every voicer call fails
  // fast, so this exercises the whole ladder — Composer (two attempts) → Fallfirm → floor.
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY) {
    t.skip('a voice model is configured in this environment — the floor path is unreachable here');
    return;
  }
  const payload = { kind: 'reminder' as const, text: 'pick up the dry cleaning by 6' };
  const text = await voiceProactive(payload, 'web:a', '');
  assert.equal(text, fallfirmFloor(fallfirmOutcomeFor(payload)));
  assert.match(text, /pick up the dry cleaning by 6/, 'the thing they were promised still reaches them');
});

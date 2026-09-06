// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The three switches, and the one property that matters about all of them: they parse the way every
// other flag in this repo parses. An operator who has flipped CONVO_TURN_FOCUS_BLOCK knows what
// `off`, `no` and a typo do here without reading a second doc — and a typo doing something OTHER
// than off is how a switch gets flipped in the wrong direction during an incident.
//
// Read at CALL time, so each case sets the var and calls again; the var is saved and restored so a
// test that runs after these sees the environment it expected (the turnFocus.test.ts shape).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { hooksEnabled, momentsEnabled, thesisEnabled } from './featureFlags.js';

/** Every value an operator might type that leaves the feature ON — plus the empty string, which is
 *  what a var set to nothing in an env file actually is. */
const ON_VALUES = ['', 'true', '1', 'on', 'yes', 'YES', ' on '];

/** …and the ones that turn it off, including the typo. Anything unrecognised is OFF on purpose: a
 *  switch whose garbage state is ON cannot be turned off by someone in a hurry. */
const OFF_VALUES = ['false', '0', 'off', 'no', 'nonsense'];

const FLAGS: Array<{ name: string; read: () => boolean }> = [
  { name: 'CONVO_HOOKS_ENABLED', read: hooksEnabled },
  { name: 'MEMORY_MOMENTS_ENABLED', read: momentsEnabled },
  { name: 'MEMORY_THESIS_ENABLED', read: thesisEnabled },
];

for (const flag of FLAGS) {
  test(`${flag.name} defaults ON and parses like its siblings`, () => {
    const saved = process.env[flag.name];
    try {
      delete process.env[flag.name];
      assert.equal(flag.read(), true, 'unset is on');
      for (const v of ON_VALUES) {
        process.env[flag.name] = v;
        assert.equal(flag.read(), true, `"${v}" is on`);
      }
      for (const v of OFF_VALUES) {
        process.env[flag.name] = v;
        assert.equal(flag.read(), false, `"${v}" is off`);
      }
    } finally {
      if (saved === undefined) delete process.env[flag.name];
      else process.env[flag.name] = saved;
    }
  });
}

test('the three read three different vars — one flip never moves another feature', () => {
  const saved = FLAGS.map(f => process.env[f.name]);
  try {
    for (const flag of FLAGS) {
      for (const f of FLAGS) delete process.env[f.name];
      process.env[flag.name] = 'off';
      for (const other of FLAGS) {
        assert.equal(
          other.read(), other.name !== flag.name,
          `${flag.name}=off also turned ${other.name} ${other.read() ? 'on' : 'off'}`,
        );
      }
    }
  } finally {
    FLAGS.forEach((f, i) => {
      const prior = saved[i];
      if (prior === undefined) delete process.env[f.name];
      else process.env[f.name] = prior;
    });
  }
});

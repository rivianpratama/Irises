// Run with: npm test   (TZ=UTC tsx --test — runner pins DATA_BACKEND=memory)
//
// The four switches, and the one property that matters about all of them: they parse the way every
// other flag in this repo parses. An operator who has flipped CONVO_TURN_FOCUS_BLOCK knows what
// `off`, `no` and a typo do here without reading a second doc — and a typo doing something OTHER
// than off is how a switch gets flipped in the wrong direction during an incident.
//
// One of the four is still landing and so ships default OFF. That difference is the ONLY one this
// file tolerates: the accepted words are identical, the garbage state is still off, and the empty
// string still means whatever unset means — which is why it is asserted beside the default here
// instead of being listed among the on-words (provenance.test.ts:93 is the same shape).
//
// Read at CALL time, so each case sets the var and calls again; the var is saved and restored so a
// test that runs after these sees the environment it expected (the turnFocus.test.ts shape).
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { hooksEnabled, momentsEnabled, thesisEnabled, shareTurnsEnabled } from './featureFlags.js';

/** Every value an operator might type that turns the feature ON, whatever its default is. */
const ON_VALUES = ['true', '1', 'on', 'yes', 'YES', ' on '];

/** …and the ones that turn it off, including the typo. Anything unrecognised is OFF on purpose: a
 *  switch whose garbage state is ON cannot be turned off by someone in a hurry. */
const OFF_VALUES = ['false', '0', 'off', 'no', 'nonsense'];

const FLAGS: Array<{ name: string; read: () => boolean; dflt: boolean }> = [
  { name: 'CONVO_HOOKS_ENABLED', read: hooksEnabled, dflt: true },
  { name: 'MEMORY_MOMENTS_ENABLED', read: momentsEnabled, dflt: true },
  { name: 'MEMORY_THESIS_ENABLED', read: thesisEnabled, dflt: true },
  // The share turn, still landing: default OFF so every intermediate build of the series is inert
  // on a live box and only the last commit changes a reply. The body is its siblings' body.
  { name: 'CONVO_SHARE_TURNS_ENABLED', read: shareTurnsEnabled, dflt: false },
];

for (const flag of FLAGS) {
  test(`${flag.name} defaults ${flag.dflt ? 'ON' : 'OFF'} and parses like its siblings`, () => {
    const saved = process.env[flag.name];
    const dflt = flag.dflt ? 'on' : 'off';
    try {
      delete process.env[flag.name];
      assert.equal(flag.read(), flag.dflt, `unset is ${dflt}`);
      process.env[flag.name] = '';
      assert.equal(flag.read(), flag.dflt, `a var set to nothing is unset, so ${dflt}`);
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

test('the four read four different vars — one flip never moves another feature', () => {
  const saved = FLAGS.map(f => process.env[f.name]);
  try {
    for (const flag of FLAGS) {
      for (const f of FLAGS) delete process.env[f.name];
      // Flip this one AWAY from its own default; every other one must still read its default.
      const flip = flag.dflt ? 'off' : 'on';
      process.env[flag.name] = flip;
      for (const other of FLAGS) {
        const want = other.name === flag.name ? !flag.dflt : other.dflt;
        assert.equal(
          other.read(), want,
          `${flag.name}=${flip} also turned ${other.name} ${other.read() ? 'on' : 'off'}`,
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

// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The batteries' shared plumbing, and only the half that can be tested without a service: argv
// reading, the SQL string literal, the markdown trims. `sh` / `curlJson` / `sqlJson` / `sqlExec`
// shell out to curl and sqlite3 and are deliberately NOT exercised here — `npm test` must never
// touch a live instance — so what they are held to is the batteries' own dry runs.
//
// These are small functions, and that is the point: they were copied by hand into three batteries
// and had already drifted (a markdown cell truncated at two different widths). One home, one test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CELL_WIDTH, arg, cell, expand, flag, num, quote, truncate, whyFailed } from './harness.js';

/** argv is process-global, so every case that reads it says what it is reading. */
function withArgv<T>(argv: string[], fn: () => T): T {
  const saved = process.argv;
  process.argv = ['node', 'battery.ts', ...argv];
  try {
    return fn();
  } finally {
    process.argv = saved;
  }
}

test('flag is presence, arg is the value after it', () => {
  withArgv(['--round', '3', '--dry-run'], () => {
    assert.equal(flag('dry-run'), true);
    assert.equal(flag('no-reset'), false);
    assert.equal(arg('round'), '3');
    assert.equal(arg('out', './fallback.json'), './fallback.json');
  });
});

test('a flag standing where a value should be is not read as the value', () => {
  // `--positive-ask --dry-run` must not make the ask the string "--dry-run".
  withArgv(['--positive-ask', '--dry-run'], () => {
    assert.equal(arg('positive-ask'), undefined);
    assert.equal(arg('positive-ask', 'the default ask'), 'the default ask');
  });
});

test('num falls back on anything that is not a non-negative number', () => {
  process.env.HARNESS_TEST_MS = '5000';
  assert.equal(num('HARNESS_TEST_MS', 90_000), 5_000);
  process.env.HARNESS_TEST_MS = 'soon';
  assert.equal(num('HARNESS_TEST_MS', 90_000), 90_000);
  process.env.HARNESS_TEST_MS = '-1';
  assert.equal(num('HARNESS_TEST_MS', 90_000), 90_000);
  delete process.env.HARNESS_TEST_MS;
  assert.equal(num('HARNESS_TEST_MS', 90_000), 90_000);
});

test('expand resolves ~ itself, because execFile never sees a shell', () => {
  assert.equal(expand('~/.irises/irises.db'), resolve(homedir(), '.irises/irises.db'));
  assert.equal(expand('./round.json'), resolve('./round.json'));
});

test('quote doubles the only character that could end a SQL literal', () => {
  assert.equal(quote('web:guest'), "'web:guest'");
  assert.equal(quote("o'brien"), "'o''brien'");
});

test('a markdown cell keeps the row intact and is one width everywhere', () => {
  // The width is pinned rather than read from the constant: two of the three batteries printed at
  // 64 and one at 72, and this is the assertion that stops that happening again silently.
  assert.equal(CELL_WIDTH, 64);
  assert.equal(cell('two\nlines'), 'two ⏎ lines');
  assert.equal(cell('a | b'), 'a \\| b');
  const long = 'x'.repeat(CELL_WIDTH + 20);
  assert.equal(cell(long).length, CELL_WIDTH);
  assert.ok(cell(long).endsWith('…'));
  assert.equal(cell('short'), 'short');
});

test('truncate is inclusive of the ellipsis it adds', () => {
  assert.equal(truncate('abcdef', 6), 'abcdef');
  assert.equal(truncate('abcdef', 4), 'abc…');
});

test('whyFailed reads the reason off a piped child, not the command that failed', () => {
  // `sh` pipes the child's stderr, so execFileSync's Error carries "Command failed: <the whole
  // command>" on line 1 and the child's own words BELOW it. This is the exact message a table-less
  // sqlite3 throws, and line 1 is the useless half: it names what was run, never why it failed.
  const err = new Error(
    "Command failed: sqlite3 /tmp/irises.db SELECT * FROM thread_inventory;\n"
    + 'Error: in prepare, no such table: thread_inventory\n',
  );
  assert.equal(whyFailed(err), 'Error: in prepare, no such table: thread_inventory');
});

test('whyFailed still has something to say for the shapes that are not that', () => {
  assert.equal(whyFailed(new Error('curl: (7) Failed to connect to 127.0.0.1 port 3000')),
    'curl: (7) Failed to connect to 127.0.0.1 port 3000');
  // Nothing readable at all — an Error with no message, or something that was never an Error —
  // still gets a sentence rather than the word "undefined" inside a report line.
  assert.equal(whyFailed(new Error('')), 'command failed');
  assert.equal(whyFailed(new Error('   \n  \n')), 'command failed');
  assert.equal(whyFailed(undefined), 'command failed');
  assert.equal(whyFailed('sqlite3 is not installed'), 'sqlite3 is not installed');
});

// `whyFailed` existing is not the fix; every site USING it is. The three that regressed were
// `console.error` calls inside `main()` and the network readers — unreachable from a test that may
// not touch a service — so what is pinned instead is the source: a battery that shells out through
// `sh` may not read a caught Error's `.message` by hand, because the piping decided where the reason
// lives and doing it by hand is how three of five sites came to print the command instead.
test('the battery reports a failed sh call only through whyFailed', () => {
  // `__dirname`, not `import.meta.url`: this project compiles to CommonJS (see
  // src/agents/loadContext.ts), and `npm run typecheck:scripts` DOES check this file.
  const src = readFileSync(join(__dirname, 'focusBattery.ts'), 'utf8');
  assert.deepEqual(
    src.match(/\.message\b/g) ?? [], [],
    'focusBattery.ts reads a caught Error\'s .message directly — use whyFailed(err) from harness.ts, '
    + "or the line prints \"Command failed: <the command>\" and drops the reason with the stderr piped",
  );
  // And it does report them: five catch blocks, five reasons. A rewrite that stopped reporting
  // altogether would satisfy the assertion above.
  assert.equal((src.match(/whyFailed\(err\)/g) ?? []).length, 5);
});

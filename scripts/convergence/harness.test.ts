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
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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

/**
 * An Error shaped the way execFileSync throws one: `Command failed: <the whole command>` and the
 * child's words in the message, AND the child's stderr hung on the object as a string (the `utf8`
 * encoding `sh` passes). Every message/stderr pair below was captured from a real `sh` call — see
 * the cases for which one — because the whole bug this pins is a guess about that shape.
 */
function execFileError(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}${stderr ? `\n${stderr}` : ''}`), { stderr });
}

test('whyFailed reads the reason off a piped child, not the command that failed', () => {
  // `sh` pipes the child's stderr, so execFileSync's Error carries "Command failed: <the whole
  // command>" on line 1 and the child's own words BELOW it. From `sqlite3 <db> "SELECT * FROM nope;"`,
  // and line 1 is the useless half: it names what was run, never why it failed.
  const err = execFileError(
    'sqlite3 /tmp/irises.db SELECT * FROM thread_inventory;',
    'Error: in prepare, no such table: thread_inventory\n',
  );
  assert.equal(whyFailed(err), 'Error: in prepare, no such table: thread_inventory');
});

test('whyFailed reads past a MULTI-line child error to the reason, not its caret pointer', () => {
  // sqlite3 3.43 prints three lines for a bad statement: the reason, the statement, and a caret
  // pointing into it. Captured from `sqlite3 <db> "SELECT json_nope(1);"` — the shape that matters,
  // because a sqlite3 built without JSON1 is exactly how the durable read is expected to fail, and
  // this battery's header promises that failure arrives reported. `^--- error here` is not a report.
  const err = execFileError(
    'sqlite3 /tmp/irises.db SELECT json_nope(1);',
    'Error: in prepare, no such function: json_nope\n  SELECT json_nope(1);\n         ^--- error here\n',
  );
  assert.equal(whyFailed(err), 'Error: in prepare, no such function: json_nope');
});

test('whyFailed reads past a MULTI-line COMMAND too — the queries here span lines', () => {
  // The other half, and the reason this reads `err.stderr` rather than counting lines in the
  // message: readInventory's SQL is written across three lines, so "the line after the command" is
  // still the command. Captured from that very query against a db with no thread_inventory; taking
  // message line 2 reported `'themes', themes_json, 'turnsSinceOffer', turns_since_offer))` as the
  // reason the round could not read the row.
  const err = execFileError(
    "sqlite3 /tmp/irises.db SELECT json_group_array(json_object(\n      'themes', themes_json,"
    + " 'turnsSinceOffer', turns_since_offer))\n      FROM thread_inventory WHERE handle = 'x';",
    'Error: in prepare, no such table: thread_inventory\n',
  );
  assert.equal(whyFailed(err), 'Error: in prepare, no such table: thread_inventory');
});

test('whyFailed falls back to the message for the two failures with no stderr to read', () => {
  // A missing binary throws before a child exists, so there is no stderr and the message IS the
  // reason. Captured from `sh('sqlite3-nope', ['x'])`.
  assert.equal(whyFailed(new Error('spawnSync sqlite3-nope ENOENT')), 'spawnSync sqlite3-nope ENOENT');
  // A child that exits non-zero without a word: stderr is the empty string, and the command line is
  // then the only fact there is. Captured from `sh('false', [])`.
  assert.equal(whyFailed(execFileError('false', '')), 'Command failed: false');
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
  // A Buffer stderr is what a caller who dropped `sh`'s encoding would hand this, so it is read
  // rather than ignored — an unread Buffer would silently fall through to the command line.
  assert.equal(whyFailed(Object.assign(new Error('Command failed: sqlite3 x'),
    { stderr: Buffer.from('Error: in prepare, no such table: nope\n') })),
  'Error: in prepare, no such table: nope');
});

// `whyFailed` existing is not the fix; every site USING it is — and that claim is about a battery's
// source, not about this module, so it is pinned in the test file of the battery it reads
// (focusBattery.test.ts, 'every failed shell-out in this battery reports its reason'). Nothing here
// reads another file.

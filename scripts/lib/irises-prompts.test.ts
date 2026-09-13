// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// The prompt helpers, driven the only way a test can drive them: answers piped in on stdin, with no
// terminal anywhere near the run. That is the whole point of the design these tests pin —
//
//   • a helper that decided whether to ask by looking at `[ -t 0 ]` could not be tested at all, and
//     would throw away the answers a wizard's heredoc pipes in. Interactivity is IRISES_ASSUME_YES,
//     which the calling script sets from its own --yes / no-TTY detection, and nothing else;
//   • the question goes to stderr and the answer to stdout for every helper whose value is captured,
//     so `v="$(ask_text …)"` gets a value with no prompt glued to the front of it — and so nothing a
//     human was asked can ever end up in the `RESULT:` line a wrapper parses off stdout;
//   • EOF is the default, not a hang: the lifecycle scripts outlive the SSH session that starts them.
//
// And one that is not about shape at all: ask_secret's value must not appear in ANY captured stream
// but its own stdout, and ask_confirm_token must refuse a --yes run outright — it guards the two
// steps (delete your data, roll the build back) that a script must never be able to take by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'scripts', 'lib', 'irises-lib.sh');

interface Run { out: string; err: string; code: number }

/** Source the lib under `set -euo pipefail`, run `body`, feed `input` in on stdin. */
function ask(body: string, input = '', env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'irises-prompt-'));
  const script = join(dir, 'body.sh');
  writeFileSync(script, ['set -euo pipefail', `source ${JSON.stringify(LIB)}`, body, ''].join('\n'));
  const res = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    input,
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      NO_COLOR: '1',
      IRISES_HOME: join(dir, 'state'),
      ...env,
    },
  });
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 };
}

const YES = { IRISES_ASSUME_YES: '1' };

// ── ui_interactive ────────────────────────────────────────────────────────────

test('ui_interactive answers the question the scripts actually ask', () => {
  const open = ask('if ui_interactive; then echo ASK; else echo SILENT; fi');
  assert.match(open.out, /ASK/, 'a piped stdin is still a run that may ask — only --yes says otherwise');
  const shut = ask('if ui_interactive; then echo ASK; else echo SILENT; fi', '', YES);
  assert.match(shut.out, /SILENT/);
});

// ── ask_yn ────────────────────────────────────────────────────────────────────

test('ask_yn takes the default on a bare Enter, both ways', () => {
  const yes = ask('if ask_yn "go?" y; then echo YES; else echo NO; fi', '\n');
  assert.match(yes.out, /YES/, 'a [Y/n] prompt that answers NO to Enter is a prompt that lies');
  const no = ask('if ask_yn "go?" n; then echo YES; else echo NO; fi', '\n');
  assert.match(no.out, /NO/);
});

test('ask_yn takes the default on EOF, so a dropped terminal never blocks a run', () => {
  const r = ask('if ask_yn "go?" y; then echo YES; else echo NO; fi', '');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /YES/);
  const n = ask('if ask_yn "go?" n; then echo YES; else echo NO; fi', '');
  assert.match(n.out, /NO/);
});

test('ask_yn reads a typed answer over the default', () => {
  assert.match(ask('if ask_yn "go?" n; then echo YES; else echo NO; fi', 'y\n').out, /YES/);
  assert.match(ask('if ask_yn "go?" y; then echo YES; else echo NO; fi', 'n\n').out, /NO/);
  assert.match(ask('if ask_yn "go?" n; then echo YES; else echo NO; fi', 'nonsense\n').out, /NO/);
});

test('ask_yn under --yes never reads stdin, and says which way it went', () => {
  const r = ask('if ask_yn "go?" y; then echo YES; else echo NO; fi\ncat', 'STDIN-UNTOUCHED\n', YES);
  assert.match(r.out, /YES/);
  assert.match(r.out, /taking 'y' \(--yes \/ non-interactive\)/, 'a question answered for you is a question said out loud');
  assert.match(r.out, /STDIN-UNTOUCHED/, 'the helper must not eat a line it never asked for');
});

// ── ask_choice ────────────────────────────────────────────────────────────────

test('ask_choice echoes the chosen index on stdout and nothing else', () => {
  const r = ask('ask_choice "which" 1 alpha beta gamma', '2\n');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '2', `the menu and the prompt belong on stderr:\n${r.out}`);
  assert.match(r.err, /1\) alpha/);
  assert.match(r.err, /3\) gamma/);
});

test('ask_choice takes the default on an empty line and on EOF', () => {
  assert.equal(ask('ask_choice "which" 3 a b c', '\n').out, '3');
  assert.equal(ask('ask_choice "which" 2 a b c', '').out, '2');
});

test('ask_choice re-asks an out-of-range answer, then accepts the good one', () => {
  const r = ask('ask_choice "which" 1 a b c', '9\nzero\n3\n');
  assert.equal(r.out, '3');
  assert.match(r.err, /pick a number from 1 to 3/);
});

test('ask_choice gives up after three bad answers and takes the default', () => {
  const r = ask('ask_choice "which" 2 a b c', '9\n8\n7\n6\n');
  assert.equal(r.code, 0, 'giving up is an outcome, not a failure — the caller gets the default');
  assert.equal(r.out, '2');
});

test('ask_choice under --yes prints no menu at all', () => {
  const r = ask('ask_choice "which" 2 a b c', '', YES);
  assert.equal(r.out, '2');
  assert.equal(r.err.trim(), '', `a run that cannot answer must not be shown a menu:\n${r.err}`);
});

// ── ask_text ──────────────────────────────────────────────────────────────────

test('ask_text echoes the typed value, and the default for an empty line', () => {
  assert.equal(ask('ask_text "port" 3000', '3100\n').out, '3100');
  assert.equal(ask('ask_text "port" 3000', '\n').out, '3000');
  assert.equal(ask('ask_text "port" 3000', '').out, '3000', 'EOF is a default, not a hang');
  assert.equal(ask('ask_text "port" 3000', '', YES).out, '3000');
});

test('ask_text re-asks what its validator refuses', () => {
  const body = 'digits() { case "${1:-}" in ""|*[!0-9]*) return 1 ;; esac; return 0; }\n'
    + 'ask_text "port" 3000 digits';
  const r = ask(body, 'ninety\n3100\n');
  assert.equal(r.out, '3100');
  assert.match(r.err, /try again/);
});

test('ask_text returns 1 after three refusals — the caller can tell that from a choice', () => {
  const body = 'nope() { return 1; }\n'
    + 'rc=0; v="$(ask_text "port" 3000 nope)" || rc=$?; printf "%s/%s" "$v" "$rc"';
  assert.equal(ask(body, 'a\nb\nc\n').out, '3000/1');
});

// ── ask_secret ────────────────────────────────────────────────────────────────

test('ask_secret puts the value on stdout and never in the prompt stream', () => {
  const r = ask('v="$(ask_secret "key:")"; printf "GOT=%s" "$v"', 'hunter2-not-a-real-key\n');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /GOT=hunter2-not-a-real-key/);
  assert.ok(!r.err.includes('hunter2'), `a secret echoed into the log is a leaked secret:\n${r.err}`);
});

test('ask_secret refuses a non-interactive run rather than inventing a blank key', () => {
  const r = ask('rc=0; v="$(ask_secret "key:")" || rc=$?; printf "v=[%s] rc=%s" "$v" "$rc"', 'x\n', YES);
  assert.match(r.out, /v=\[\] rc=1/);
});

// ── ask_confirm_token ─────────────────────────────────────────────────────────

test('ask_confirm_token wants the word, exactly', () => {
  assert.match(ask('if ask_confirm_token "type delete:" delete; then echo GO; else echo STOP; fi', 'delete\n').out, /GO/);
  assert.match(ask('if ask_confirm_token "type delete:" delete; then echo GO; else echo STOP; fi', 'DELETE\n').out, /STOP/);
  assert.match(ask('if ask_confirm_token "type delete:" delete; then echo GO; else echo STOP; fi', ' delete \n').out, /STOP/);
  assert.match(ask('if ask_confirm_token "type delete:" delete; then echo GO; else echo STOP; fi', '').out, /STOP/);
});

test('ask_confirm_token refuses under --yes, so no script can take the step for a human', () => {
  const r = ask('if ask_confirm_token "type delete:" delete; then echo GO; else echo STOP; fi', 'delete\n', YES);
  assert.match(r.out, /STOP/);
  assert.match(r.err, /confirmed by hand/);
});

// ── front_pattern_valid ───────────────────────────────────────────────────────

test('front_pattern_valid accepts what the engine can actually parse', () => {
  const table: Array<[string, boolean]> = [
    ['*:*', true],
    ['telegram:*', true],
    ['telegram:*,whatsapp:+1555*', true],
    ['discord.guild:123', true],
    ['my_platform:abc-123', true],
    ['', false],
    ['telegram', false],
    [':123', false],
    ['telegram:', false],
    ['telegram:* , whatsapp:*', false],
    ['telegram:*,', false],
    [',telegram:*', false],
    ['telegram:*,,whatsapp:*', false],
    ['telegram:*,broken', false],
  ];
  for (const [pattern, want] of table) {
    const r = ask(`if front_pattern_valid ${JSON.stringify(pattern)}; then echo OK; else echo BAD; fi`);
    assert.match(
      r.out,
      want ? /OK/ : /BAD/,
      `front_pattern_valid("${pattern}") should be ${want ? 'accepted' : 'rejected'}`,
    );
  }
});

// ── archive_home ──────────────────────────────────────────────────────────────

test('archive_home writes a tarball of the data dir and echoes its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-archive-'));
  const home = join(dir, 'state');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'irises.db'), 'not really a database');
  const dest = join(dir, 'backup.tar.gz');
  const r = ask(`p="$(archive_home ${JSON.stringify(dest)})"; printf "P=%s" "$p"`, '', { IRISES_HOME: home });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`P=${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(existsSync(dest), 'the path it printed has to be a file that is there');
  const listed = spawnSync('tar', ['-tzf', dest], { encoding: 'utf8' });
  assert.match(listed.stdout ?? '', /irises\.db/, 'the archive has to carry the data, not just exist');
});

test('archive_home refuses rather than reporting an archive of nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irises-archive-'));
  const r = ask(`rc=0; p="$(archive_home ${JSON.stringify(join(dir, 'x.tar.gz'))})" || rc=$?; printf "p=[%s] rc=%s" "$p" "$rc"`,
    '', { IRISES_HOME: join(dir, 'nothing-here') });
  assert.match(r.out, /p=\[\] rc=1/);
  assert.match(r.err, /there is no .* to archive/);
});

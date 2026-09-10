// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// Three properties every shell file in this repo has to keep, none of which any single script's own
// test would notice:
//
//  1. It parses. `bash -n` is the cheapest real check we have (shellcheck is not a dependency).
//  2. It reaches the shared library exactly one way, so there is one place to fix a helper.
//  3. It contains NO literal that an engine's lifecycle guard blocks. hermes's
//     cron/lifecycle_guard.py refuses a terminal command matching `hermes gateway <restart|stop>`,
//     `systemctl … <restart|stop|start> … hermes-gateway`, `launchctl <kickstart|…> … hermes.gateway`
//     or `pkill … hermes … gateway` — and it reads the CONTENTS of any script the command names,
//     including sourced ones. One such string in a comment is enough to make `bash scripts/update.sh`
//     unrunnable from a chat, so the verbs are assembled at runtime and this test keeps them that way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCRIPTS = join(process.cwd(), 'scripts');

function shellFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...shellFiles(p));
    else if (name.endsWith('.sh')) out.push(p);
  }
  return out;
}

const FILES = shellFiles(SCRIPTS);

/** Mirrors the four blocking branches of hermes's _GATEWAY_LIFECYCLE_PATTERN, line by line. */
const BLOCKED: Array<{ name: string; re: RegExp }> = [
  { name: 'hermes gateway restart|stop', re: /hermes\s+gateway\s+(?:restart|stop)/i },
  { name: 'launchctl … hermes.gateway', re: /launchctl\s+(?:kickstart|unload|load|stop|restart|submit|bootstrap)\b[^\n]*\bhermes[.\-]?gateway/i },
  { name: 'systemctl restart|stop|start … hermes-gateway', re: /systemctl\s+(?:-\S+\s+)*(?:restart|stop|start)\b[^\n]*\bhermes[.\-]?gateway/i },
  { name: 'pkill … hermes … gateway', re: /p?kill\b[^\n]*\bhermes\b[^\n]*\bgateway/i },
];

test('there are shell files to check', () => {
  assert.ok(FILES.length >= 1, `no scripts/**/*.sh found — did the layout change?`);
});

for (const file of FILES) {
  const rel = relative(process.cwd(), file);

  test(`${rel} is valid bash`, () => {
    execFileSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
  });

  test(`${rel} carries no literal an engine lifecycle guard would refuse`, () => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const hits: string[] = [];
    lines.forEach((line, i) => {
      for (const { name, re } of BLOCKED) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} matches [${name}]: ${line.trim()}`);
      }
    });
    assert.deepEqual(hits, [], `assemble the verb at runtime instead:\n${hits.join('\n')}`);
  });
}

test('every lifecycle script sources the library the one supported way', () => {
  const lifecycle = FILES.filter(f => /(engine-setup|update)\.sh$/.test(f));
  assert.equal(lifecycle.length, 2, `expected engine-setup.sh and update.sh, found ${lifecycle.length}`);
  for (const f of lifecycle) {
    const body = readFileSync(f, 'utf8');
    assert.match(
      body,
      /source "\$\(CDPATH='' cd -- "\$\(dirname -- "\$0"\)" && pwd\)\/lib\/irises-lib\.sh"/,
      `${relative(process.cwd(), f)} must source the lib with the dirname-of-$0 form (a bare relative path breaks any run from another cwd)`,
    );
  }
});

test('the library itself is never executed and never duplicated in a script', () => {
  for (const f of FILES.filter(x => !x.endsWith('irises-lib.sh'))) {
    const body = readFileSync(f, 'utf8');
    // A helper redefined locally is a helper that drifts. These four were copy-pasted between the
    // two scripts before the library existed.
    for (const fn of ['get_env()', 'set_env()', 'is_our_server()', 'health_ok()']) {
      assert.ok(!body.includes(fn), `${relative(process.cwd(), f)} redefines ${fn} — use the library's`);
    }
  }
});

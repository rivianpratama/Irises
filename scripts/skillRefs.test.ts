// Run with: npm test   (scripts/**/*.test.ts is in the test glob).
//
// hermes's URL skill installer does not fetch SKILL.md alone: it scrapes the markdown for local
// paths whose first segment is one of references|templates|scripts|assets|examples, fetches each
// one relative to the SKILL.md URL, and a single 404 makes the WHOLE install fail with
// "Could not fetch '<url>' from any source." Our scripts/ lives at the repo root, not beside
// SKILL.md, so any such reference is a phantom fetch that kills installs.
//
// The two patterns below mirror hermes's `_LOCAL_LINK_RE` / `_SUSPICIOUS_LOCAL_REF_RE`
// (tools/skills_hub.py). Write repo paths as `./scripts/...` in SKILL.md — the leading `./` means
// the character before the first segment is not `](`, a backtick, whitespace, a quote, or line
// start, so hermes never treats it as a sidecar file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SUPPORT_DIRS = 'references|templates|scripts|assets|examples';
const localRef = () => new RegExp(`(?:\\]\\(|\`|(?:^|[\\s"']))((?:${SUPPORT_DIRS})/[^\\s)\`"'<>]+)`, 'gm');
const traversalRef = () => new RegExp(`(?:${SUPPORT_DIRS})/(?:[^\\s)\`"'<>]*/)?\\.\\.(?:/|$)`, 'm');

function sidecarRefs(markdown: string): string[] {
  const normalized = markdown.replace(/\\/g, '/');
  return [...normalized.matchAll(localRef())].map((m) => m[1]);
}

const SKILLS_DIR = join(process.cwd(), 'skills');
const skillFiles = readdirSync(SKILLS_DIR)
  .filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
  .map((name) => join(SKILLS_DIR, name, 'SKILL.md'));

test('there is at least one shipped SKILL.md to check', () => {
  assert.ok(skillFiles.length > 0, 'no skills/*/SKILL.md found — did the layout change?');
});

test('the mirrored regex still catches a bare support-dir reference', () => {
  assert.deepEqual(sidecarRefs('run: `bash scripts/engine-setup.sh --engine hermes`'), ['scripts/engine-setup.sh']);
  assert.deepEqual(sidecarRefs('see [the guide](references/guide.md)'), ['references/guide.md']);
  assert.deepEqual(sidecarRefs('run: `bash ./scripts/engine-setup.sh --engine hermes`'), []);
});

for (const file of skillFiles) {
  test(`${file} references no phantom sidecar files`, () => {
    const markdown = readFileSync(file, 'utf8');
    assert.deepEqual(
      sidecarRefs(markdown),
      [],
      `hermes would try to fetch these next to SKILL.md and abort the install on the 404 — write them as ./<path> instead`,
    );
    assert.equal(
      traversalRef().test(markdown.replace(/\\/g, '/')),
      false,
      'hermes rejects the whole bundle on a path-traversal-looking reference',
    );
  });
}

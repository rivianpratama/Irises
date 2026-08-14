#!/usr/bin/env node
// Build step (runs after tsc in `npm run build`): stamp dist/version.json with this build's git
// sha + branch, so the running server (src/update/version.ts) can report its own version and the
// update checker has something to compare against origin.
//
// A git failure must NEVER fail the build — a gitless build (e.g. a Docker image built from a COPY
// that excludes .git) simply gets {sha:null} and reports source:'unknown' at runtime.

const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const dist = join(root, 'dist');

function git(args) {
  return execFileSync('git', args, { cwd: root, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

let stamp = { sha: null, branch: null, builtAt: new Date().toISOString() };
try {
  const sha = git(['rev-parse', 'HEAD']);
  if (/^[0-9a-f]{40}$/i.test(sha)) {
    let branch = null;
    try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || null; } catch { /* branch optional */ }
    stamp = { sha: sha.toLowerCase(), branch, builtAt: new Date().toISOString() };
  }
} catch { /* gitless build — stamp stays {sha:null} */ }

try {
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'version.json'), JSON.stringify(stamp, null, 2) + '\n');
  console.log(`[stamp-version] dist/version.json -> ${stamp.sha ? stamp.sha.slice(0, 7) + (stamp.branch ? ` (${stamp.branch})` : '') : 'no git (sha:null)'}`);
} catch (err) {
  console.warn('[stamp-version] could not write dist/version.json:', err && err.message);
}
process.exit(0);

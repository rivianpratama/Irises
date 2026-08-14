// Version identity — how the RUNNING server knows which build it is, so /health and the update
// checker have a sha to report and compare against origin.
//
// Resolution order is load-bearing:
//   1. dist/version.json — the STAMP written at build time (scripts/stamp-version.js). This is what
//      the running code actually is. After `git pull` but before a restart, the worktree HEAD has
//      already moved to the new commit, so live `git rev-parse` would report a build that isn't
//      running yet. The stamp does not move until the next build, so it stays honest — which is
//      exactly what keeps `updateAvailable` true until the restart lands.
//   2. live `git rev-parse HEAD` — the fallback under `tsx` dev, where there is no dist/ stamp and
//      the worktree IS the running code, so live git is correct there.
//   3. unknown — gitless build with no stamp (e.g. a Docker image built without .git).
//
// This project compiles to CommonJS (see loadContext.ts), so __dirname is the right resolver and
// works under both `tsx` (src/update/…) and `node dist` (dist/update/…).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface VersionInfo {
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  builtAt: string | null;
  source: 'stamp' | 'git' | 'unknown';
}

/** The clone root — dist/update/../.. and src/update/../.. both resolve here. */
export function repoRoot(): string {
  return resolve(__dirname, '..', '..');
}

let cached: VersionInfo | null = null;

/** Parse a dist/version.json body into a VersionInfo, or null if it carries no usable sha. Pure. */
export function parseStamp(json: string): VersionInfo | null {
  try {
    const o = JSON.parse(json) as { sha?: unknown; branch?: unknown; builtAt?: unknown };
    const sha = typeof o.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(o.sha) ? o.sha.toLowerCase() : null;
    if (!sha) return null;
    return {
      sha,
      shortSha: sha.slice(0, 7),
      branch: typeof o.branch === 'string' ? o.branch : null,
      builtAt: typeof o.builtAt === 'string' ? o.builtAt : null,
      source: 'stamp',
    };
  } catch {
    return null;
  }
}

function fromGit(): VersionInfo | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    let branch: string | null = null;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot(), timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim() || null;
    } catch { /* branch is optional */ }
    return { sha, shortSha: sha.slice(0, 7), branch, builtAt: null, source: 'git' };
  } catch {
    return null;
  }
}

/** The running build's version. Resolved once (a build cannot change without a restart). Never throws. */
export function getVersion(): VersionInfo {
  if (cached) return cached;
  let v: VersionInfo | null = null;
  try {
    v = parseStamp(readFileSync(join(__dirname, '..', 'version.json'), 'utf8'));
  } catch { /* no stamp (tsx dev, or gitless build) — fall through to live git */ }
  if (!v) v = fromGit();
  if (!v) v = { sha: null, shortSha: null, branch: null, builtAt: null, source: 'unknown' };
  cached = v;
  return v;
}

export function _resetVersionForTests(): void {
  cached = null;
}

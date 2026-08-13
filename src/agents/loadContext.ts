import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Persona bodies live in Context.md next to each agent.
// Resolves under both `tsx` (src/agents/...) and `node dist` (dist/agents/...)
// because the build copies the .md files into dist.
// (This project compiles to CommonJS, so __dirname is the right resolver here.)
//
// Loading policy, by environment:
// - Production (NODE_ENV==='production'): load ONCE, then always serve the cached body
//   (immutable, predictable, zero per-request fs calls). Change prompts via redeploy + restart.
// - Development: mtime-aware hot-reload. We statSync the file each call (microseconds) and
//   only re-read when it changed. This is what makes persona edits take effect on the next
//   message WITHOUT a restart — `tsx watch` does NOT restart on .md edits (they aren't modules),
//   so without this a long-running dev process serves a stale persona indefinitely.
// Throws on a missing/empty file so we fail fast rather than serve a persona-less agent.

const IS_PROD = process.env.NODE_ENV === 'production';

interface Cached { body: string; mtimeMs: number }
const cache = new Map<string, Cached>();

export function loadContext(
  agent: 'convo' | 'composer' | 'fallfirm',
  // A second persona can live beside Context.md in the same folder (e.g. fallfirm's Progress.md — the
  // waiting-on-Ops voice, a distinct persona from its outcome voice). The build copies every .md under
  // src/agents, so a sibling file is picked up with no extra wiring. Cache is keyed per file.
  file: string = 'Context.md',
): string {
  const key = file === 'Context.md' ? agent : `${agent}/${file}`;
  const path = join(__dirname, agent, file);
  const cached = cache.get(key);

  // In production, once loaded, always serve the cache (no further fs calls).
  if (cached && IS_PROD) return cached.body;

  // In dev, cheaply check if the file changed since we last read it.
  if (cached) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // File briefly unavailable (e.g. mid-write) — serve the last good copy.
      return cached.body;
    }
    if (mtimeMs === cached.mtimeMs) return cached.body;
  }

  let body: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    body = readFileSync(path, 'utf8').trim();
    if (!body) throw new Error('empty');
  } catch {
    if (cached) return cached.body; // never go persona-less after a good load
    throw new Error(`[agents] Missing ${file} for "${agent}" at ${path}. Did the build copy step run (npm run build / copy:context)?`);
  }

  cache.set(key, { body, mtimeMs });
  console.log(`[agents] loaded ${key} persona (${body.length} chars, mtime ${new Date(mtimeMs).toISOString()})`);
  return body;
}

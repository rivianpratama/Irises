// Where Irises keeps its local state — a private, Hermes/OpenClaw-style state
// directory. Machine-shaped data lives in <home>/irises.db (see sqlite.ts); the
// curated memory tiers live as markdown under <home>/memories/<handle>/.
//
// Paths are resolved ON EVERY CALL, never cached at import: a module-level
// constant would freeze the wrong root when a test fixture or deploy re-points
// IRISES_HOME after import (both engines carry warnings about exactly this bug).
// Only the opened database HANDLE is cached (sqlite.ts) — caching a connection
// is correct; caching a path is not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { driver } from './client.js';

// memory driver → a throwaway per-process root, so "ephemeral" stays literal:
// nothing touches the real state dir, and the tree is removed on clean exit.
let memHome: string | null = null;
function memoryHome(): string {
  if (!memHome) {
    memHome = fs.mkdtempSync(path.join(os.tmpdir(), 'irises-mem-'));
    process.once('exit', () => {
      try { fs.rmSync(memHome!, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
  }
  return memHome;
}

/** The state root: IRISES_HOME (tilde-expanded) > ~/.irises. Memory driver → temp dir. */
export function irisesHome(): string {
  if (driver === 'memory') return memoryHome();
  const env = (process.env.IRISES_HOME ?? '').trim();
  if (env) {
    if (env === '~') return os.homedir();
    if (env.startsWith('~/') || env.startsWith('~\\')) return path.join(os.homedir(), env.slice(2));
    return path.resolve(env);
  }
  return path.join(os.homedir(), '.irises');
}

/** SQLite database location. ':memory:' on the memory driver (sqlite.ts short-circuits). */
export function dbPath(): string {
  if (driver === 'memory') return ':memory:';
  return path.join(irisesHome(), 'irises.db');
}

/**
 * Handles become directory names, so encode anything a filesystem could reject
 * or reinterpret: every byte outside [A-Za-z0-9._-] becomes %XX ("web:guest" →
 * "web%3Aguest" — ':' is illegal in Windows dirnames). Fixed-width %XX byte
 * encoding is injective, so distinct handles can never share a directory. Never
 * decoded — the plain handle lives inside the files themselves.
 */
export function encodeHandle(handle: string): string {
  let out = '';
  for (const ch of handle) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) { out += ch; continue; }
    for (const byte of Buffer.from(ch, 'utf8')) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  // '', '.' and '..' would alias or escape the memories/ root as directory names,
  // and Windows strips a TRAILING dot from dirnames (colliding with the dotless
  // handle) — encode those dots too.
  if (out === '') return '%';
  if (out === '.' || out === '..') return out.replace(/\./g, '%2E');
  if (out.endsWith('.')) out = out.slice(0, -1) + '%2E';
  return out;
}

/** Per-handle memory-tier directory: <home>/memories/<encoded handle>. Not created. */
export function memoriesDir(handle: string): string {
  return path.join(irisesHome(), 'memories', encodeHandle(handle));
}

/** mkdir -p with private permissions (0o700 — a no-op on Windows). Returns dir. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// The plumbing every convergence battery needs and none of them is about: argv reading, shelling
// out to `curl` and the `sqlite3` CLI, and the two string trims a markdown report wants.
//
// WHY THIS FILE EXISTS. loopBattery.ts, threadBattery.ts and focusBattery.ts each carried its own
// character-for-character copy of these twelve functions, and the copies had already begun to drift
// (`cell` truncated at 72 in one file and 64 in the other two). Three copies is where a comment
// saying "lift them out when a third battery wants them" stops being a plan and becomes the thing
// that was not done. So they live here, once.
//
// It is only the plumbing. No verdict, no threshold, no probe and no knowledge of any battery's
// subject: what a battery ASSERTS against belongs in expectations.ts (which imports it from `src/`),
// and what it measures belongs in the battery. Nothing here reads a receipt.
//
// NOT a `*.test.ts`, and it must never become one: `npm test` runs "scripts/**/*.test.ts" and may
// not touch a live service. It also runs no `main()` of its own — importing it starts nothing, which
// is exactly what the older two batteries cannot say about themselves and why they could not be
// imported FROM. Importing INTO them is free, so they can follow whenever someone next touches them.
//
// No dependencies, deliberately: HTTP through `curl` and SQLite through the `sqlite3` CLI, both via
// child_process, so a battery needs nothing installed that the instance it measures does not already
// need.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// ── argv ────────────────────────────────────────────────────────────────────────────────────────

/** `--name` present? */
export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** `--name value`, or `fallback`. A following `--other` is not a value. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

/**
 * A numeric knob from the environment, for the timing overrides a battery needs so it can be
 * smoke-tested against a stub in seconds. Negative and unparseable values fall back rather than
 * throwing: a mistyped override that silently makes a round meaningless is worse than one that
 * quietly runs at the documented default.
 */
export function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** `~/x` → `$HOME/x`. execFile never sees a shell, so nothing else expands it. */
export function expand(p: string): string {
  return resolve(p.startsWith('~/') ? p.replace('~', homedir()) : p);
}

// ── shelling out (no dependencies: curl + the sqlite3 CLI) ──────────────────────────────────────

/**
 * The largest reply this plumbing will hold in memory. Generous because a `turn:trace` round hauls
 * back whole prompts; the ceiling exists so a runaway read fails loudly instead of swapping.
 */
export const SH_MAX_BUFFER = 256 * 1024 * 1024;

/** One command, no shell, output trimmed. */
export function sh(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: SH_MAX_BUFFER }).trim();
}

/** A GET whose body is JSON, or null for anything that did not arrive as JSON. */
export function curlJson<T>(url: string): T | null {
  try {
    const body = sh('curl', ['-sS', '--max-time', '30', url]);
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

/**
 * One statement through the sqlite3 CLI, parsed as the single JSON value it returns. The query wraps
 * its own rows in json_group_array/json_object: `-json` output is not available on every sqlite3
 * build, but the JSON1 functions are, so the SQL does the encoding instead of the CLI.
 */
export function sqlJson<T>(db: string, sql: string): T[] {
  const raw = sh('sqlite3', [db, sql]);
  if (!raw || raw === 'null') return [];
  return JSON.parse(raw) as T[];
}

/** One statement whose result is nothing — a reset, a delete. Throws when sqlite3 does. */
export function sqlExec(db: string, sql: string): void {
  sh('sqlite3', [db, sql]);
}

/** A SQL string literal. The only escaping these batteries need, and the only one they may use. */
export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ── the report, and waiting ─────────────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** How wide one markdown cell is allowed to be. One number, so two batteries cannot disagree. */
export const CELL_WIDTH = 64;

/** Markdown cells: pipes break the table and newlines break the row. */
export const cell = (s: string, width: number = CELL_WIDTH) =>
  truncate(s.replace(/\s*\n+\s*/g, ' ⏎ ').replace(/\|/g, '\\|'), width);

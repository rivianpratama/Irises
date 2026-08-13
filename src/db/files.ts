// Shared file primitives for the markdown memory tiers — ONE implementation for
// every destructive rewrite, so no repository hand-rolls a file write. The write
// path mirrors Hermes's atomic_write_text: temp file IN THE TARGET DIRECTORY
// (same device, so rename is atomic), fsync, rename over the target. A reader
// can never observe a half-written file.

import fs from 'node:fs';
import path from 'node:path';

let tmpSeq = 0;

// Synchronous sleep for the Windows rename retry (AV scanners briefly hold fresh
// files). Atomics.wait is permitted on Node's main thread.
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomically replace `filePath` with `content`. Parent dirs are created (0o700);
 * the file lands with mode 0o600 (permission modes are no-ops on Windows).
 * Throws on failure — callers own the fail-loud/fail-soft decision.
 */
export function atomicWriteText(filePath: string, content: string, opts?: { mode?: number }): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${tmpSeq++}`);
  const fd = fs.openSync(tmp, 'w', opts?.mode ?? 0o600);
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      sleepMs(100);
      try {
        fs.renameSync(tmp, filePath);
      } catch (err2) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* no residue where possible */ }
        throw err2;
      }
    } else {
      try { fs.rmSync(tmp, { force: true }); } catch { /* no residue where possible */ }
      throw err;
    }
  }
  // Durability of the rename itself needs a parent-dir fsync (POSIX only —
  // Windows cannot open directories). Best-effort: the crash window is tiny and
  // the tiers tolerate losing their very last write, never corruption.
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* unsupported on this platform */ }
}

/**
 * Read a UTF-8 file. `null` means "does not exist"; ANY other failure throws —
 * an unreadable-but-present file must never look like an empty one, or the next
 * read-modify-write would clobber real data with a fresh rewrite.
 */
export function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Append to a ledger file (MEDIUM.archive.md). Creates parent dirs; throws on failure. */
export function appendText(filePath: string, content: string, opts?: { mode?: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: opts?.mode ?? 0o600 });
}

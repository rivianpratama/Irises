// Best-effort pidfile so scripts/update.sh --restart can find and cycle THIS process. The git-clone
// install has no external supervisor (the operator runs `npm start` themselves), so there is nothing
// else that knows the server's pid. No-op on the memory driver (ephemeral run, nothing to restart).

import fs from 'node:fs';
import { join } from 'node:path';
import { driver } from '../db/client.js';
import { irisesHome, ensureDir } from '../db/stateDir.js';

export function pidFilePath(): string {
  return join(irisesHome(), 'irises.pid');
}

/** Write $IRISES_HOME/irises.pid; remove it on clean exit. Failure just means --restart falls back
 *  to printing instructions. Never throws. */
export function writePidFileAtBoot(): void {
  if (driver === 'memory') return;
  try {
    ensureDir(irisesHome());
    const p = pidFilePath();
    fs.writeFileSync(p, String(process.pid));
    process.once('exit', () => {
      try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    });
  } catch { /* no pidfile → --restart uses instructions instead */ }
}

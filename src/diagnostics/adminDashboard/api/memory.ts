import { Router, Request, Response } from 'express';
import { getUserProfile } from '../../../db/repositories/profiles.js';
import { getMemory } from '../../../db/repositories/memory.js';
import { listShortTerm } from '../../../db/repositories/memoryShort.js';
import { listMediumAll, listMediumPreserved } from '../../../db/repositories/memoryMedium.js';
import { getLongDoc, listLongRevisions } from '../../../db/repositories/memoryLong.js';
import { authed } from '../auth.js';
import { cached } from '../cache.js';

// Read-only per-user memory inspector: all three tiers.
// Prefs are ALLOW-LISTED — agent_memory.prefs also carries operational stashes
// (cursors, bookkeeping) that aren't the admin's business here, and the
// inspector must never become a raw prefs dump.

const PREF_ALLOWLIST = ['chat_id', 'timezone'] as const;

export function registerMemoryRoutes(router: Router): void {
  router.get('/dashboard/api/memory', async (req: Request, res: Response) => {
    if (!authed(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const handle = String(req.query.handle ?? '');
      if (!handle) { res.status(400).json({ error: 'handle required' }); return; }
      const payload = await cached(`memory:${handle}`, 5_000, async () => {
        const [profile, agentMem, short, medium, preserved, longDoc, revisions] = await Promise.all([
          getUserProfile(handle),
          getMemory(handle),
          listShortTerm(handle, { limit: 50 }),
          listMediumAll(handle),
          listMediumPreserved(handle),
          getLongDoc(handle),
          listLongRevisions(handle, 10),
        ]);
        const prefs: Record<string, unknown> = {};
        for (const k of PREF_ALLOWLIST) {
          if (agentMem?.prefs?.[k] !== undefined) prefs[k] = agentMem.prefs[k];
        }
        return {
          handle,
          profile,
          dossierMd: agentMem?.dossierMd ?? '',
          prefs,
          short,
          medium,
          // Segments of MEDIUM.md with no valid annotation: a hand edit, or an entry whose
          // annotation got mangled. They survive every rewrite but are never RENDERED into a
          // prompt, so a corrupted entry is otherwise invisible — this is where an admin sees it.
          mediumPreserved: {
            count: preserved.length,
            segments: preserved.map(s => (s.length > 500 ? `${s.slice(0, 500)}…` : s)),
          },
          long: { doc: longDoc, revisions },
        };
      });
      res.json(payload);
    } catch (err) {
      console.error('[dashboard] /api/memory failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });
}

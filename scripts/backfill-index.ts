// Standalone one-time mail SEARCH-index backfill. Indexes an already-received inbox (which the
// connect watermark skipped) into the `emails` table that Ops reads via search_inbox_local —
// broad fetch covering inbox+sent+archive, no LLM cost, paced against the Gmail quota budget.
//
//   npx tsx scripts/backfill-index.ts --handle <phone> [--days 730]
//
// IMPORTANT: with DATA_BACKEND=memory this writes to THIS process's memory and exits — useless for a
// separately-running server. Use it with Supabase (shared store), or, for the memory backend, rely
// on the server's own boot-time search-index self-heal (it runs in-process).
import 'dotenv/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const handle = arg('handle') || process.env.MOCK_AGENT_HANDLE;
  if (!handle) {
    console.error('Usage: npx tsx scripts/backfill-index.ts --handle <phone> [--days N]');
    process.exit(1);
  }
  if ((process.env.DATA_BACKEND || '').toLowerCase() === 'memory') {
    console.warn('⚠ DATA_BACKEND=memory: this standalone run writes to its OWN memory and exits — a separate server won\'t see it.');
    console.warn('  Use Supabase, or let the server\'s boot-time search-index self-heal run in-process.\n');
  }

  const newerThanDays = arg('days') ? Number(arg('days')) : 730;

  // The mail SEARCH index (the emails table search_inbox_local reads) — broad fetch covering
  // inbox+sent+archive, no LLM cost, paced against the Gmail quota budget.
  const { backfillEmailSearchIndex } = await import('../src/pipeline/indexEmail.js');
  const s = await backfillEmailSearchIndex(handle, { newerThanDays });
  console.log(`Search index: ${s.indexed} messages indexed`);
}

main().catch(err => { console.error(err); process.exit(1); });

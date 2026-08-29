// Preview the FIRST MOVE — the one-time install introduction — without an engine, without a phone,
// and without a single byte of state written anywhere. This is the voice-QA seam for a feature whose
// whole cost lands in a message that can only ever be sent once: read the ask, feed it a canned
// engine reply, and see exactly what she would keep, what her first dossier would say, and what she
// would text.
//
//   npx tsx scripts/preview-first-move.ts                          # the ask itself (stdout), version on stderr
//   npx tsx scripts/preview-first-move.ts --profile reply.json     # sanitized profile + seeded LONG.md + payload
//   npx tsx scripts/preview-first-move.ts --profile reply.json --voice   # …and the actual composed bubbles
//
// Hand-run only, and NOT wired into package.json on purpose: `npm test` runs "scripts/**/*.test.ts"
// and must never spend a token, so this file is deliberately not a *.test.ts and deliberately not an
// npm script (the threadBattery.ts / print-engine-doctrine.ts house rule).
//
// `--profile` takes whatever the engine actually said: a raw reply with prose around a ```json fence,
// a JSON string holding that reply, or a bare JSON object. All three go through the same door the
// live pull uses (extractFencedJson → sanitizeEngineProfile), so what you read here is what firstMove
// would have kept — including the fields it THREW AWAY, which is usually the interesting part.
//
// TWO GUARANTEES, both structural rather than promised:
//   • NOTHING IS SENT. voiceProactive is called for the words only; the delivery stack
//     (proactiveDelivery.ts) is never loaded, so there is no mouth in this process. firstMove.ts is
//     imported for its two PURE payload helpers, and nothing that opens first-move.json is called.
//   • NOTHING IS WRITTEN. Every src/ import below is DYNAMIC, after DATA_BACKEND=memory is forced —
//     src/db/client.ts picks its driver at first import, so a static import would have bound this
//     process to the real store under ~/.irises before the first line of main() ran. On the memory
//     driver the store is a throwaway temp dir removed at exit, so a Composer call that touches the
//     db cannot reach your actual memory, and first-move.json is never opened at all.
//
// `--voice` costs real tokens (one Composer call, plus a Fallfirm call if the ladder is spent) and
// needs an LLM key: it reads deploy/app.env then .env exactly like a boot would, and skips with a
// note when neither lane is configured.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The repo root, from this file's own location — so the script works from any cwd. (This project
 *  compiles to CommonJS, so `__dirname` is the right resolver here; see src/agents/loadContext.ts.) */
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const USAGE = `preview-first-move — read-only dry run of the install introduction

  npx tsx scripts/preview-first-move.ts                        print the engine ask + its version
  npx tsx scripts/preview-first-move.ts --profile <file>       sanitize a canned engine reply and
                                                               show the seeded dossier + payload
  npx tsx scripts/preview-first-move.ts --profile <file> --voice   also compose the real bubbles
                                                               (costs tokens; needs an LLM key)

Never sends, never writes state.
`;

function heading(title: string): void {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}\n`);
}

/**
 * A canned reply file → the untrusted value the sanitizer is handed. The ladder mirrors what really
 * arrives over the bridge: the reply is TEXT, and only sometimes is that text bare JSON.
 *   1. the file parses as a JSON object  → that object (someone saved the block alone)
 *   2. the file parses as a JSON string  → extractFencedJson over it (a saved reply, JSON-quoted)
 *   3. anything else                     → extractFencedJson over the raw file (the real shape:
 *                                          prose, a fence, maybe more prose)
 */
function parseCannedReply(
  raw: string,
  extractFencedJson: (reply: string) => unknown | null,
): { parsed: unknown; via: string } {
  try {
    const direct: unknown = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { parsed: direct, via: 'bare JSON object' };
    if (typeof direct === 'string') return { parsed: extractFencedJson(direct), via: 'JSON string → extractFencedJson' };
  } catch { /* the usual case: a reply with prose around it, handled below */ }
  return { parsed: extractFencedJson(raw), via: 'raw engine reply → extractFencedJson' };
}

async function main(): Promise<number> {
  if (has('--help') || has('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const profilePath = value('--profile');
  if (has('--profile') && !profilePath) {
    process.stderr.write('--profile needs a file path\n');
    return 2;
  }
  // There is nothing to voice without a profile — the payload IS the details. Say so rather than
  // printing the ask and silently dropping the flag.
  if (has('--voice') && !profilePath) {
    process.stderr.write('--voice needs --profile <file>: the composed bubbles are voiced from the payload\n');
    return 2;
  }

  // The ask is pure string work (sessionHash → node:crypto), so it is safe to load before anything
  // else and safe to print on its own.
  const { FIRST_MOVE_ASK, firstMoveAskVersion } = await import('../src/agents/ops/firstMoveAsk.js');

  if (!profilePath) {
    // Same convention as print-engine-doctrine.ts: stdout is EXACTLY the ask, so it stays pipeable.
    process.stderr.write(`# first-move ask, content version ${firstMoveAskVersion()}\n`);
    process.stdout.write(FIRST_MOVE_ASK);
    process.stdout.write('\n');
    return 0;
  }

  // From here on the db layer may be reached (the profile module pulls in userContext/status, and
  // --voice pulls in the Composer). Bind it to the ephemeral driver BEFORE those imports resolve.
  if (has('--voice')) {
    const dotenv = (await import('dotenv')).default;
    dotenv.config({ path: path.join(ROOT, 'deploy/app.env') });
    dotenv.config({ path: path.join(ROOT, '.env'), override: true });
  }
  process.env.DATA_BACKEND = 'memory';

  const { extractFencedJson, sanitizeEngineProfile } = await import('../src/agents/ops/firstMoveProfile.js');
  const { buildSeedDossier } = await import('../src/memory/seedFromEngine.js');
  const { bridgeChatId, introText } = await import('../src/agents/ops/firstMove.js');

  const rawFile = readFileSync(path.resolve(profilePath), 'utf8');
  const { parsed, via } = parseCannedReply(rawFile, extractFencedJson);
  process.stderr.write(`# ${profilePath}: ${via}${parsed ? '' : ' — NOTHING PARSED (empty profile follows)'}\n`);

  const profile = sanitizeEngineProfile(parsed);

  heading('sanitized profile (what she is allowed to keep)');
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);

  heading('seeded LONG.md (buildSeedDossier — written only into empty memory)');
  process.stdout.write(`${buildSeedDossier(profile) || '(empty profile — no dossier would be written)'}\n`);

  // firstMove.ts's own payload builder, not a copy of it: the details as "- " lines (or the
  // newly-acquainted marker), which is the ONLY fact source a proactive turn gets. A preview that
  // rebuilt this by hand would drift away from the message it exists to preview.
  const payloadText = introText(profile);

  heading("proactive payload text (kind 'introduction')");
  process.stdout.write(`${payloadText}\n`);
  const gate = profile.channel?.hasHistory
    ? `would SEND to ${bridgeChatId(profile.channel)}`
    : 'would NOT send — nudge mode (no confirmed history on a valid channel)';
  process.stdout.write(`\nsend gate: ${gate}\n`);

  if (!has('--voice')) return 0;

  const { isLaneConfigured } = await import('../src/llm/laneKeys.js');
  if (!isLaneConfigured('anthropic') && !isLaneConfigured('openrouter')) {
    heading('composed bubbles');
    process.stdout.write(
      'skipped: no LLM key configured (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / OPENROUTER_API_KEY,\n' +
      'read from the shell, deploy/app.env, then .env). Everything above is key-free.\n',
    );
    return 0;
  }

  const { voiceProactive } = await import('../src/agents/proactive.js');
  const chatId = 'eng:preview:first-move-preview';
  process.stderr.write('# --voice: one real Composer call on a throwaway handle (tokens are billed)\n');
  heading('composed bubbles (real Composer call — never delivered)');
  const text = await voiceProactive({ kind: 'introduction', text: payloadText, framing: undefined }, chatId, chatId);
  process.stdout.write(`${text}\n`);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch((err: unknown) => {
    console.error('[preview-first-move] failed', err);
    process.exit(1);
  });

// Print an engine's standing doctrine to stdout, so the manual-send fallback documented in
// bridge/hermes/engine-onboarding-message.md never needs a second copy of the text to drift from.
//
//   npx tsx scripts/print-engine-doctrine.ts [hermes|openclaw]
//
// The automatic path (src/agents/ops/engineOnboarding.ts, run at boot) is the normal one; this exists
// for an operator who set ENGINE_ONBOARDING=off, or who wants to read/send it by hand.
import { HERMES_ONBOARDING_MESSAGE, hermesOnboardingVersion } from '../src/agents/ops/hermesDoctrine.js';
import { OPENCLAW_ONBOARDING_MESSAGE, onboardingVersion } from '../src/agents/ops/openclawDoctrine.js';

const DOCTRINES = {
  hermes: { message: HERMES_ONBOARDING_MESSAGE, version: hermesOnboardingVersion },
  openclaw: { message: OPENCLAW_ONBOARDING_MESSAGE, version: onboardingVersion },
} as const;

const which = (process.argv[2] || 'hermes').toLowerCase();
const doctrine = DOCTRINES[which as keyof typeof DOCTRINES];
if (!doctrine) {
  console.error(`unknown engine "${which}" — expected one of: ${Object.keys(DOCTRINES).join(', ')}`);
  process.exit(2);
}
// Version to stderr so stdout stays exactly the message (pipeable into curl/jq unchanged).
process.stderr.write(`# ${which} doctrine, content version ${doctrine.version()}\n`);
process.stdout.write(doctrine.message);

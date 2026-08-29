// Print Irises's model map — which model her own voice runs on, and which model the host engine
// (hermes/OpenClaw) runs its deep work on.
//
//   npx tsx scripts/print-model-map.ts
//
// loadEnv MUST be imported first: it runs engine discovery, which is what makes the voice roles
// inherit the engine's provider/model. Without it the map would show the shipped defaults, not the
// inherited values.
import '../src/loadEnv.js';
import { getModelMap, formatModelMap } from '../src/llm/modelMap.js';

const map = getModelMap();
// Human-readable to stdout; the structured object to stderr for scripts that want to parse it.
process.stderr.write(`${JSON.stringify(map)}\n`);
process.stdout.write(`${formatModelMap(map)}\n`);

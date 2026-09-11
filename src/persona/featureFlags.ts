// The four switches this phase ships, in one leaf.
//
// They live together, and away from the engines they gate, for one reason: every engine here is a
// pure module that a test imports for the price of a string (persona/hooks.ts, persona/moments.ts,
// memory/thesisEngine.ts), and a flag parsed inside one of them makes the OTHER engines' callers
// import it to ask a yes/no question. So the question lives in a file that imports nothing at all,
// and the engines stay about their own arithmetic. Same reason policy.ts next door is a leaf.
//
// WHAT THEY DO NOT DO: none of these rolls the CHARACTER back. She is the persona block and the lane
// files now, and a prompt is not a runtime switch — flipping every flag here off leaves the same
// person answering, with less machinery around her. Rolling the character back is a branch revert,
// and the plan says so under Verification rather than leaving an operator to discover it at 3am.
//
// House shape, four lines each, read at CALL time (turnFocus.ts's `turnFocusBlockEnabled` is the
// template): unset or empty is ON, and only `true | 1 | on | yes` keep it on after that — so garbage
// is OFF, and a flip needs no restart. Each one is a row in scripts/flagDocs.test.ts, which reads
// its default out of the parser below and fails unless deploy/app.env and .env.example both say the
// same word beside the same var.
//
// A switch that is still landing keeps the same four lines with the empty default inverted, so every
// intermediate build is inert and the last commit of the series is the only one that changes a reply
// (memory/provenance.ts's `provenanceEnabled` is that template). The body is what has to be
// byte-identical either way; the default is only which side of it ships today.

/**
 * The hook machinery (env: CONVO_HOOKS_ENABLED). Default ON.
 *
 * Off removes the MACHINERY, never the doctrine: no idle gate reading the turn, no `Turn:` line in
 * the turn-focus block, no selector, no `hooks` dyn section, no `craft/hooks.md` gate, no quiet
 * re-ask, and nothing written to the rhythm ledger. What survives is the persona block, which still
 * teaches the task/idle law — because that is the character, and the character has no switch.
 *
 * The off path is byte-identical to an install that never had the feature, with
 * CONVO_PERSONA_MODULES at its default. The exception is worth stating: with the module gate OFF the
 * whole craft corpus rides the cached persona head every turn, so `craft/hooks.md` is in the prompt
 * either way and this flag cannot take it out.
 */
export function hooksEnabled(): boolean {
  const v = (process.env.CONVO_HOOKS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * Moments (env: MEMORY_MOMENTS_ENABLED). Default ON.
 *
 * Gates both ends of the store she keeps about a person that is not facts: the nightly harvest pass
 * that writes `memories/<handle>/MOMENTS.md`, and the sampling that offers one back inside the
 * `hooks` section for a callback. Off means no pass runs, nothing is written or pruned, and a file an
 * earlier install wrote is simply never read — the prompt is what it would have been without the
 * feature, and `/forget` still wipes the file either way.
 */
export function momentsEnabled(): boolean {
  const v = (process.env.MEMORY_MOMENTS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The thesis (env: MEMORY_THESIS_ENABLED). Default ON.
 *
 * Gates the weekly rewrite that keeps her one read on this person in `memories/<handle>/THESIS.md`,
 * and the `thesis` dyn section that hands that read to Convo. Off means the pass never runs and the
 * section never renders, so an existing file goes stale in place rather than being deleted — the one
 * asymmetry worth knowing, and the reason turning it back on costs a week rather than a restart.
 */
export function thesisEnabled(): boolean {
  const v = (process.env.MEMORY_THESIS_ENABLED || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/**
 * The third turn shape (env: CONVO_SHARE_TURNS_ENABLED). Default **OFF** while the shape lands.
 *
 * Gates the whole share turn: the idle gate's third verdict, the share section beside the turn
 * block, its craft page, the drift anchor that reads for it, and the one follow-up question the
 * affect compiler may leave open. Off, the gate maps a share back onto a task, so a message that
 * hands her something and asks for nothing is answered flat exactly as it is today — the prompt is
 * byte-identical, down to the bytes, which is the contract the flag exists to keep and what
 * hookWiring's off-path pin measures.
 *
 * Subordinate to CONVO_HOOKS_ENABLED: with the machinery off there is no gate to read a third
 * shape, so this switch has nothing to turn on. It is default off only until the series that builds
 * the shape is whole; every commit before that last one is inert on a live box, deliberately, so a
 * half-built shape can never reach a reply.
 */
export function shareTurnsEnabled(): boolean {
  const v = (process.env.CONVO_SHARE_TURNS_ENABLED || '').trim().toLowerCase();
  if (v === '') return false;
  return ['true', '1', 'on', 'yes'].includes(v);
}

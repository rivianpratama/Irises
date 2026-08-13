// Routing floor. Convo decides on its own whether to delegate to Ops; when it answers a data
// question ITSELF from general knowledge (no delegation), that answer bypasses Ops' grounding
// backstop entirely — the one fabrication path nothing else catches ("anything from the MLS this
// week?" → invented). needsGrounding is a conservative, high-precision regex screen that flags the
// messages which MUST run through Ops. 'maybe' is reserved for a future bounded-classify tier; the
// first cut only forces on a confident 'yes' (over-delegation costs a round-trip, so we stay strict).

export type GroundingNeed = 'yes' | 'no' | 'maybe';

// A URL anywhere is a strong signal the message wants something read/looked up (not answered from
// general knowledge) — the domain-neutral analogue of the old street-address short-circuit.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i;

// Data-lookup phrasings that need a real source (the user's own email/records, or the live web)
// rather than the model's general knowledge — the fabrication surface the gate exists to close.
const STRONG: RegExp[] = [
  // Explicit retrieval verbs — "look it up", "find X", "search for", "pull up", "check my …".
  /\b(look\s+(?:it|this|that|them|up)|look up|pull up|pull the|search (?:for|up|my|the|through)|find (?:me |the |my |an? )?\S|check (?:my|the|on)|dig up|track down)\b/i,
  // References to the user's OWN connected data (their inbox / email / messages / calendar /
  // account). "gmail" stays: it's the user's own vocabulary for their inbox, still a correct
  // delegation trigger even though the engine owns the account access.
  /\b(my|the)\s+(inbox|email|emails|gmail|messages?|calendar|schedule|account|order|invoice|subscription)\b/i,
  // Retrieval-history questions answerable only from their records ("did I get X", "has Y replied").
  /\b(did (?:i|we)\b|has\b[^?]*\b(responded|replied|sent|arrived)|when did (?:i|we)\b)\b/i,
  // Live/current quantitative asks — a real figure, not a definition.
  /\b(how much|how many)\b/i,
  /\b(what'?s|what is)\s+(the\s+)?(status|latest|current|newest|price|cost|balance|total|value)\b/i,
];

// A factual question about a NAMED entity (a proper noun that isn't the sentence-initial word) —
// the shape a model will confidently fabricate an answer to. Two signals AND'd: a question word,
// plus a capitalized proper noun sitting after another word (so the leading "What"/"Who" alone
// doesn't trip it, which keeps definitional "What is recursion?" out).
const QUESTION_WORD = /\b(who|whose|where|which|when|what)\b/i;
const PROPER_NOUN = /\w\s([A-Z][a-z]{2,})/;

// Leading conversational acks must not shield a data question from the gate: "ok What/when did I
// sell the Martinezes" is a lookup with a throat-clear in front, not a greeting. Stripped (possibly
// repeatedly: "ok cool, who owns …") before classification; a message that is NOTHING but acks
// stays social. Only bare acknowledgment words — not steering words like "no"/"wait"/"actually".
const ACK_PREFIX = /^(?:(?:ok(?:ay)?|kk?|cool|nice|got it|gotcha|thanks|thank you|thx|ty|yeah|yep|yes|sure|alright|right|oh|hey|hi|hello)\b[\s,.!-]*)+/i;

// Definitional / arithmetic / social — answered locally; never force these to Ops (unless a URL
// rides along, which flips it back to a lookup).
const NEGATIVE = /^(?:\s*)(?:hi|hey|hello|thanks|thank you|ok|okay|got it|cool|nice)\b|\b(what does|what is (?:a|an|the term)|explain|means?\b|how do i|difference between|define)\b/i;

export function needsGrounding(text: string): GroundingNeed {
  const t = (text || '').trim();
  if (t.length < 4) return 'no';
  if (URL_RE.test(t)) return 'yes';                 // a link to read always wins
  const core = t.replace(ACK_PREFIX, '').trim();
  if (core.length < 4) return 'no';                 // the message WAS just the ack/greeting
  if (NEGATIVE.test(core)) return 'no';             // terminology/math/greeting
  for (const re of STRONG) if (re.test(core)) return 'yes';
  if (QUESTION_WORD.test(core) && PROPER_NOUN.test(core)) return 'yes'; // "who is X at <Named>?"
  return 'no';
}

// ── Draft salvage for a delegation turn ─────────────────────────────────────────────────────────
// When a turn delegates to Ops, the model's direct draft can't ship as-is (any RESULT it wrote is
// un-grounded — Convo is single-shot and never sees the tool output). But the draft's OPENING is
// usually Irises's own genuinely human holding text ("okay that's a real question", "pulling the
// comps on 412 Maple now") — and per user directive that voice must SHIP whenever it's safe, never
// be replaced by a generated line. So: keep the leading run of safe holding/acknowledgment bubbles
// (holding texts are 1–3 bubbles by persona design) and cut at the first bubble that asserts an
// outcome or carries a figure the user themselves didn't say. Only when nothing safe survives does
// the caller fall to the Fallfirm-voiced line — Fallfirm is the fallback, never the override.

// A bubble that CLAIMS something happened / was found (or not found) — the fabrication surface.
const CLAIMS_RESULT = /\b(pulled|checked|searched|scanned|went through|found|surfaced|came (?:up|back)|turned up|shows?|says?|looks like|according to|no (?:results?|matches?|luck|record)|nothing (?:surfaced|came|found|matched|there)|couldn'?t find|didn'?t (?:find|see)|there'?s (?:no|nothing)|don'?t have)\b/i;

// A bubble that reads like an in-progress holding line or a still-on-it reassurance — future/
// progressive, no outcome. Mirrors the persona's own example range ("scanning your inbox now",
// "back in a bit", "almost there", "hang tight", "on it").
const HOLDING_LIKE = /\b(one sec|a sec|one more sec|hang on|hang tight|hold on|lemme|let me|gimme|give me|checking|pulling|digging|grabbing|running|scanning|searching|finding|combing|fetching|chasing|tracking down|working on|going through|looking (?:into|up|at|through)|on it|still (?:on|at|working|going)|almost (?:there|done)|back in a (?:bit|sec|min|minute|few)|be right back|won'?t be long|coming (?:up|right up))\b/i;

// A short acknowledgment/empathy beat that legitimately OPENS a multi-bubble holding text ("okay
// that's a real question", "oof, the martinez file again", "you're welcome!") — kept when it leads
// into a real holding bubble, but never sufficient on its own (an ack alone promises no look).
// Anchored to interjection openers so a lowercase ASSERTION ("the owner is the delgado trust")
// can't sneak in as an "ack".
const ACK_LIKE = /^(?:ok(?:ay)?|kk+|oo+f+|ugh+|ha(?:ha)*|heh+|lol|hm+|oh+|ooh+|whew|sheesh|yeah|yep|yes|sure(?: thing)?|alright|all right|right|fair(?: enough)?|good (?:one|question|call|shout)|got it|gotcha|nice|solid|bet|say less|no worries|no problem|np|of course|absolutely|honestly|anytime|my pleasure|you'?re welcome|welcome|love (?:it|that))\b/i;
const ACK_MAX_WORDS = 8; // an ack is a beat, not a paragraph — anything longer isn't one

// Digit-runs in `text` (e.g. "412", "410000" from "$410,000") — the unit of the grounding check.
const digitRuns = (text: string): string[] => (text.match(/\d+/g) ?? []).map(r => r.replace(/^0+(?=\d)/, ''));

/**
 * Keep the human part of a delegation-turn draft: its leading holding/ack bubbles (max 3 — the
 * persona's 1–3 bubble holding range), in the legacy `\n---\n` wire format in and out.
 *
 * `ground` is the user's OWN words for this ask (their message + address/deal hints): a figure the
 * user themselves said ("comps on 412 Maple" → "pulling comps on 412 Maple now") is an echo, not a
 * fabrication, so it survives; any digit NOT in the ground still ends the salvage. With no ground,
 * every figure breaks (the old conservative behavior).
 *
 * Returns null when no bubble actually holds the line (acks alone don't count — a draft that never
 * says "on it" salvages nothing, and the voiced fallback line takes over).
 */
export function salvageHoldingText(legacyText: string | null, ground?: string): string | null {
  if (!legacyText) return null;
  const groundRuns = ground ? digitRuns(ground) : [];
  const kept: string[] = [];
  let hasHolding = false;
  for (const bubble of legacyText.split(/\n---\n/).map(b => b.trim()).filter(Boolean)) {
    if (kept.length >= 3) break;
    if (CLAIMS_RESULT.test(bubble)) break;          // an asserted outcome — the un-grounded part
    if (bubble.includes('?')) break;                // a question isn't a holding line
    // Figures: safe only when every digit-run is an echo of the user's own ask.
    const runs = digitRuns(bubble);
    if (runs.length && (bubble.includes('$') || !runs.every(r => groundRuns.some(g => g.includes(r))))) break;
    if (HOLDING_LIKE.test(bubble)) hasHolding = true;
    else if (!(ACK_LIKE.test(bubble) && bubble.split(/\s+/).length <= ACK_MAX_WORDS)) break; // neither holding nor a short ack — stop rather than guess
    kept.push(bubble);
  }
  return hasHolding && kept.length ? kept.join('\n---\n') : null;
}

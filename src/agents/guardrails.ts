// Output guardrails for anything heading OUT to the user.
//
// Charter (docs/PROMPTING_CHARTER.md): Law 12 / §10.1 "back unrecoverable rules with code" —
// a tool-name leak is classified unrecoverable (a brand reaches the user once and trust is
// dented), so it gets a deterministic backstop. §3 Invariant Core ("never name internal
// machinery"); §9.4 the deliberately triple-guarded hand-back.
//
// This is a TRIPWIRE, not the primary defense. The persona prompts are the primary defense;
// every warning logged below means one of them slipped and needs reinforcing (§10.1, §13).
//
// Policy: the user must never see the name of an internal agent/role or the underlying model.
// Irises presents as ONE entity; the back-line roles ("Ops", "Reflexion") and the model/provider
// names are internal machinery. Irises's data sources — the web and the user's own email — are
// ordinary and fine to name, so there is no external data-vendor brand to scrub here. The agents
// may name their internal roles freely to EACH OTHER; this only rewrites text on its way to the
// user, so a model slip — or the composer-failure path that relays Ops's raw summary with no
// model in the loop — can never crack the single-entity seam.

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const INTERNAL_TOOL_REDACTIONS: RedactionRule[] = [
  // "Reflexion" is a banned name — the memory curator. To the user, memory work is just
  // Irises remembering things; "my reflexion pass will tidy that up" cracks the seam the same way
  // "ops" does. One rule suffices: "my memory will tidy that up" reads naturally in every shape.
  { pattern: /\b(?:(?:my|the|our)\s+)?reflexion(?:\s+(?:agent|engine|system|process|pass|job))?\b/gi, replacement: 'my memory' },
  // Model/provider names — the "what model are you" leak ("i run on deepseek"). To the user Irises
  // is one entity, not a stack; admitting to being an AI is fine (persona rule), naming the model
  // never is. Two tiers: tokens with NO innocent chat meaning are scrubbed bare; "claude" (a
  // client's name) and "gemini" (a zodiac sign) are scrubbed ONLY in self-referential tech shapes,
  // so "claude is coming by at 3" and "she's a gemini" pass untouched.
  { pattern: /\b(?:deepseek|chatgpt|openai|openrouter|anthropic|gpt[-\s]?\d[\w.-]*|gpt)(?:['’]s)?\b/gi, replacement: 'AI' },
  { pattern: /\b((?:built|powered|running|based|trained)\s+(?:on|by)\s+)(?:claude|gemini)\b/gi, replacement: '$1AI' },
  { pattern: /\b(?:claude|gemini)(?:['’]s)?\s+(under\s+the\s+hood|behind\s+the\s+scenes)\b/gi, replacement: 'AI $1' },
  // "Ops" is the second banned name — the back-line agent. To the user there is only Irises, so a
  // leaked "ops is pulling that up" cracks the single-entity seam the same way a brand does. The
  // rules are ordered most-specific-first and grammar-aware, so the common leak shapes degrade to
  // first-person Irises instead of garbled text. Bare "ops" is guarded against "co-ops"
  // (cooperatives) by the hyphen lookbehind; "oops"/"stops"/"workshops" never match \bops\b at all.
  { pattern: /\b(?:(?:my|the|our)\s+)?ops(?:\s+(?:engine|agent|team|side|system))?\s+is\b/gi, replacement: "i'm" },
  { pattern: /\b(?:(?:my|the|our)\s+)?ops(?:\s+(?:engine|agent|team|side|system))?\s+(came back|found|pulled|says|said|has|got)\b/gi, replacement: 'i $1' },
  { pattern: /\s+(?:off\s+)?to\s+(?:(?:my|the|our)\s+)?ops(?:\s+(?:engine|agent|team|side|system))?\b/gi, replacement: '' },
  { pattern: /\b(?:(?:my|the|our)\s+)?ops\s+(?:engine|agent|team|side|system)\b/gi, replacement: 'me' },
  { pattern: /(?<!-)\bops\b/gi, replacement: 'i' },
];

/**
 * Scrub internal tool names from a single piece of user-facing text. Idempotent and
 * safe to call on every outbound bubble. Logs once per hit so a leak that reaches this
 * far is visible (it means a persona prompt needs reinforcing), without throwing.
 */
export function redactInternalTools(text: string | null | undefined): string {
  if (!text) return text ?? '';
  let out = text;
  for (const { pattern, replacement } of INTERNAL_TOOL_REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  if (out !== text) {
    console.warn('[guardrail] redacted an internal tool name from user-facing text');
  }
  return out;
}

// The SECOND user-facing invariant, backed by code for the same reason (§10.1): the Ops engine
// writes its result as a labeled, machine-shaped block — "ANSWER:", "SOURCE:", "FLAGS:",
// "NO RESULT:", and, for email findings, "Subject:"/"Sender:"/"Summary:" (see ops/Context.md).
// The Composer persona is supposed to strip every one of those and re-voice into Irises's chat
// voice. When that primary defense doesn't run — the composer-failure fallback that would relay
// Ops' raw summary with no model in the loop (orchestrator.composeFollowUp)
// — this is the deterministic tripwire that keeps the scaffolding off the user's phone.
//
// It does NOT re-voice (no third-person→second-person, no reshaping) — that stays the persona's
// job. It only removes the machine labels so a slipped summary can't land as a labeled block.
// Applied per line because the send path has already split the text into bubbles on newlines/---.

// Whole lines that are pure back-office machinery (the "how"/where the Composer always drops).
const OPS_DROP_LINE = /^\s*(?:SOURCE|FLAGS)\s*:/i;
// Labels that prefix a real value — drop the label, keep the value.
const OPS_STRIP_LABEL = /^\s*(?:ANSWER|NO RESULT|SUMMARY|SUBJECT|SENDER)\s*:\s*/i;

/**
 * Strip an echoed holding line off the front of a composed reply. The Composer is handed Irises's
 * exact holding text ("checking your inbox for repair requests now") as a continuity anchor; a
 * literal-minded model sometimes RETYPES it and glues its answer on with no whitespace
 * ("...a Pine property nownothing under 'Pine'...", "checking your inbox nowokay i found it"),
 * which ships as one fused bubble — the line is already on the user's screen, so the echo doubles
 * it AND fuses the seam.
 *
 * A holding text is 1–3 bubbles (`---`-separated), and the model most naturally echoes its LAST
 * bubble (the line it was told to "continue straight from"), so we try the full text first, then
 * every individual bubble longest-first, and repeat until nothing more strips (an echo of bubbles
 * 2 then 3 peels off in two passes). A prefix must match an ENTIRE candidate — partial word reuse
 * is never touched — and if stripping would leave nothing, the reply is returned unchanged rather
 * than send blank. Logs on hit (persona-slip telemetry, §10.1/§13).
 */
export function stripEchoedHolding(reply: string, holdingText: string | null | undefined): string {
  if (!reply || !holdingText) return reply ?? '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gi, '');

  // Cut `text`'s head if its normalized form starts with ALL of normalized `candidate`; null = no match.
  const stripPrefix = (text: string, candidate: string): string | null => {
    const target = norm(candidate);
    if (!target) return null;
    let matched = 0;
    let i = 0;
    for (; i < text.length && matched < target.length; i++) {
      const c = text[i].toLowerCase();
      if (!/[a-z0-9]/.test(c)) continue;         // separators/punctuation never break the match
      if (c !== target[matched]) return null;    // diverged: not an echo of this candidate
      matched++;
    }
    if (matched < target.length) return null;    // text is shorter than the candidate
    // Trim the seam: leftover whitespace, --- separators, and leading punctuation the echo left.
    return text.slice(i).replace(/^[\s\-–—.,:;!?]+/, '').trim();
  };

  // Full holding text first (strips the most), then each bubble longest-first.
  const bubbles = holdingText.split(/\s*---\s*|[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const candidates = [holdingText, ...bubbles.sort((a, b) => b.length - a.length)];

  let out = reply;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const c of candidates) {
      const rest = stripPrefix(out, c);
      if (rest !== null && rest) {               // never strip down to blank
        out = rest;
        stripped = true;
        break;                                   // restart: the remainder may echo the next bubble
      }
    }
  }
  if (out !== reply) console.warn('[guardrail] stripped an echoed holding line from a composed reply');
  return out;
}

/**
 * Strip raw Ops summary scaffolding (ANSWER:/SOURCE:/FLAGS:/NO RESULT:/Subject:/Sender:/Summary:
 * labels) from a single piece of user-facing text. Idempotent, never throws, and safe to call on
 * every outbound bubble alongside redactInternalTools. Logs once per hit — a hit means the Composer
 * was bypassed and a persona/fallback path needs reinforcing (§10.1, §13). Never re-voices; only
 * removes the labels so a leaked scaffold degrades to plain text instead of a labeled block.
 */
export function stripOpsScaffolding(text: string | null | undefined): string {
  if (!text) return text ?? '';
  let hit = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (OPS_DROP_LINE.test(line)) { hit = true; continue; }        // SOURCE:/FLAGS: → drop the line
    const stripped = line.replace(OPS_STRIP_LABEL, '');            // ANSWER:/Subject:/… → keep value
    if (stripped !== line) hit = true;
    kept.push(stripped);
  }
  if (!hit) return text;
  console.warn('[guardrail] stripped raw Ops scaffolding from user-facing text');
  // Collapse blank lines a dropped SOURCE/FLAGS line may have left behind.
  return kept.join('\n').replace(/\n{2,}/g, '\n').trim();
}

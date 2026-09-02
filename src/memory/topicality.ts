// "Does what they just said touch this?" — the one lexical relevance verdict shared by the memory
// stack and the thread engine.
//
// It started life inside wrappers.ts as the short-tier hot-look gate (the only working code-level
// relevance check in the memory stack), and it is here because a SECOND caller needs exactly the
// same question answered: the thread engine's theme stage, which used to choose a theme on
// confidence, recency and cooldown alone and could hand the model a pattern with no lexical relation
// to the message in hand. One implementation, so the two can never drift apart on what counts as
// "about the same thing".
//
// PURE by construction: no clock, no DB, no I/O, no LLM. Deliberately crude — a bag of content
// words, no stemming, no ordering, no embeddings — and deliberately CHEAP, because it runs on the
// reply path inside features whose premise is zero extra model calls.
//
// Not to be confused with textSim.ts next door, which answers a different question ("are these two
// SHORT TEXTS the same thing?") with graded jaccard/containment scores over its own stopword list.
// That one merges and matches stored notes; this one asks whether a stored thing has anything to do
// with the current turn, and answers yes/no on a single shared word. Both are kept because the
// thresholds are the callers' visible choice: threading uses BOTH, in the same turn, for different
// decisions.

// Tokens too common to signal a topic; ignored when testing whether the current turn touches a
// past look. Kept small and generic on purpose.
export const TOPIC_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'my', 'your', 'their', 'our', 'you',
  'they', 'we', 'me', 'them', 'us', 'what', 'when', 'where', 'who', 'how', 'why', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'will', 'about', 'get', 'got', 'tell', 'know', 'so', 'if', 'at',
  'as', 'by', 'from', 'up', 'out', 'now', 'just', 'ok', 'okay', 'thanks', 'thank', 'yeah', 'yes',
  'not', 'any', 'some', 'all', 'more', 'much', 'have', 'has', 'had', 'want', 'need', 'please',
]);

/** Text → the topic words it is compared by: lowercased, split on anything that is not a letter or
 *  digit, stopwords and one/two-character tokens dropped, duplicates collapsed by the Set. */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !TOPIC_STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Does this turn touch this candidate? True iff they share ≥1 salient token.
 *
 * `whenEmpty` is the whole reason this is a parameter rather than a constant, and its two callers
 * want opposite answers to the same edge — a turn with nothing to compare (absent text, a media-only
 * turn, or a bare "ok thanks" whose every token is a stopword):
 *
 *   • `'touch'`    — fail OPEN. The memory gates: never lose a held entry over an ack, and let an
 *                    ack still close a loop from the hot look.
 *   • `'no_touch'` — fail CLOSED. The theme offer: a turn that said nothing topical is not the turn
 *                    to name a pattern in someone.
 *
 * It is about the TURN only. A token-bearing turn against a token-less candidate is a real
 * no-match, never an empty one — no tokens is no evidence, and must not read as a match.
 */
export function touchesTurn(
  turnText: string | undefined,
  candidateText: string,
  opts: { whenEmpty: 'touch' | 'no_touch' },
): boolean {
  const onEmpty = opts.whenEmpty === 'touch';
  if (!turnText || !turnText.trim()) return onEmpty;
  const turn = salientTokens(turnText);
  if (!turn.size) return onEmpty;
  const candidate = salientTokens(candidateText);
  for (const t of turn) if (candidate.has(t)) return true;
  return false;
}

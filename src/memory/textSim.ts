// Shared text-similarity primitives for the note groomer and the thread inventory.
//
// Both features ask the same cheap question — "are these two short pieces of text about the same
// thing?" — and neither may spend a model call answering it. The groomer (noteGroomer.ts) uses it
// as the gate that decides whether an LLM is called AT ALL; threading (persona/threads.ts, phase C)
// uses it to match a freshly captured note against the loops and themes it already holds, on the
// reply path, inside a feature whose entire premise is zero new LLM calls. One implementation, so
// the two can never drift apart on what counts as "the same thing" — and so the thresholds stay
// visibly the callers' own choice rather than something buried in a shared helper.
//
// PURE by construction: no clock, no DB, no I/O. Deliberately crude — a bag of content words, no
// stemming, no ordering, no embeddings. The scores are inputs to a threshold, never a verdict.

// Small and deliberately incomplete: these words carry no facts, so leaving them in makes every
// pair of English sentences look alike. Anything domain-bearing stays.
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'for',
  'in', 'on', 'at', 'it', 'its', 'this', 'that', 'with', 'my', 'me', 'i', 'you', 'your', 'they',
  'them', 'their', 'we', 'us', 'our', 'as', 'by', 'from', 'so', 'if', 'do', 'does', 'did',
]);

/** Text → the bag of content words it gets compared by. Splits on anything that is neither a letter
 *  nor a digit, Unicode-aware (`\p{L}`/`\p{N}`), so non-English text tokenizes rather than
 *  collapsing to one blob. Lowercased, stopwords dropped, duplicates collapsed by the Set. */
export function tokenSet(body: string): Set<string> {
  return new Set(
    body.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t !== '' && !STOPWORDS.has(t)),
  );
}

/**
 * Both overlap scores for a pair of token sets, reported together because the two callers weigh
 * them differently and each one alone is blind in a way the other is not:
 *   • `jaccard`     — |A∩B| / |A∪B|. The symmetric measure: how much of BOTH texts is shared.
 *   • `containment` — |A∩B| / min(|A|,|B|). The asymmetric one, which catches the short-inside-long
 *     shape Jaccard structurally misses: "gate code 4421" ⊂ "the gate code for the house is 4421,
 *     punch it in on the keypad…" scores badly on the union and is a total containment.
 *
 * An empty set on either side scores 0/0 rather than dividing by zero: no tokens is NO EVIDENCE,
 * and it must never read as a perfect match — the caller would merge or match on nothing at all.
 */
export function simScore(a: Set<string>, b: Set<string>): { jaccard: number; containment: number } {
  if (!a.size || !b.size) return { jaccard: 0, containment: 0 };
  let intersection = 0;
  // Iterate the smaller side: the sets are tiny, but this is O(n²) over every pair upstream.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) intersection++;
  if (!intersection) return { jaccard: 0, containment: 0 };
  return {
    jaccard: intersection / (a.size + b.size - intersection),
    containment: intersection / Math.min(a.size, b.size),
  };
}

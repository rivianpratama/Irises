// The outbound bubble pipeline — pure, unit-tested (see bubbles.test.ts), used by the single
// send path in index.ts for EVERY user-facing reply (live Convo turns and Composer/Fallfirm
// follow-ups alike).
//
// Charter split (docs/PROMPTING_CHARTER.md §10.1): the persona prompts are the primary defense for
// bubble shape — Convo and Composer both carry the "one thought per bubble, 5–12 words, hard
// ceiling 20" rule. This module is the deterministic backstop for the two slips models actually
// make: forgetting the `---` between sentences (splitSentences) and writing an unpunctuated
// run-on that sails past the word ceiling in one wall (splitLongBubble). Like the guardrails,
// it only ever RE-SPLITS — it never removes, shortens, or truncates a single word.

// Clean up LLM response formatting quirks before sending
export function cleanResponse(text: string): string {
  return text
    // Numeric/currency ranges (3–5, 10%–12%, $1,800–$2,000) keep a hyphen — never a
    // comma/list and never a bubble break — so a range is relayed faithfully, not chopped.
    .replace(/(\d%?)\s*[—–]\s*([$€£¥]?\d)/g, '$1-$2')
    // Em-dashes / en-dashes otherwise read as an AI tell. A mid-sentence dash between
    // words becomes a comma pause; any other stray dash just becomes a space.
    .replace(/(\w)\s*[—–]\s*(\w)/g, '$1, $2')
    .replace(/\s*[—–]\s*/g, ' ')
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Abbreviations that end in a period but do NOT end a sentence, so splitSentences
// doesn't chop after them (e.g. "9 a.m. tomorrow" stays one bubble).
const SENTENCE_ABBREV = /\b(?:mr|mrs|ms|dr|st|ave|rd|blvd|apt|ste|no|vs|approx|est|etc|inc|co|jr|sr|ft|sq|e\.g|i\.e|a\.m|p\.m)\.$/i;

// Enforce "one sentence / one question per bubble" even when the model forgot to put
// "---" between them. Splits AFTER a sentence-ending . ? or ! that is followed by
// whitespace and more text. This only RE-SPLITS one bubble into several — it never
// removes, shortens, or truncates any text. Safe on numbers: a decimal/ordinal
// ("3.5", "1. ") is guarded by the (?<![0-9]\.) lookbehind, and money ("$1,800.00")
// has no space after the dot; a few common abbreviations (st., a.m. ...) are
// stitched back onto the previous bubble.
export function splitSentences(bubble: string): string[] {
  const parts = bubble.split(/(?<=[.?!])(?<![0-9]\.)\s+/);
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && SENTENCE_ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

// The personas' own hard ceiling ("no bubble ever exceeds 20 words" — convo/Context.md line 3,
// composer/Context.md "bubble splitting + word limit"). Below it the bubble is the persona's
// call and code stays out of the way; above it the persona has already failed and we re-split.
export const MAX_BUBBLE_WORDS = 20;

// Where a run-on naturally breathes: right BEFORE one of these words a human would have hit
// send and started the next bubble ("...ends march 14" / "so you've still got...").
const CLAUSE_STARTERS = /^(?:so|but|and|or|then|plus|also|though|cause|because|which|if|want|wanna)$/i;

/**
 * Enforce the personas' 20-word bubble ceiling in code. A bubble at or under the ceiling passes
 * through untouched (shaping short thoughts is the persona's job, not ours). Over it, the bubble
 * is split at the most natural seam nearest its middle — after a comma/semicolon, or before a
 * clause-starting conjunction — and each half is re-checked, so a wall degrades into balanced,
 * texting-sized thoughts. Last resort (no natural seam at all) is a mid-point space. Never
 * truncates: every word survives, only the breaks are added. A bubble carrying a URL is left
 * whole so a tappable link never shatters; tight ranges ("$1,800-2,000", "3-5") are single
 * tokens by the time we're called (cleanResponse), so a split can never land inside one.
 * Logs once per hit — a hit means a persona let a wall through and needs reinforcing (§10.1).
 */
export function splitLongBubble(bubble: string): string[] {
  const words = bubble.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_BUBBLE_WORDS) return [bubble];
  if (/https?:\/\//i.test(bubble)) return [bubble]; // never break a link bubble

  // Candidate seams: split before word i. Prefer a comma/semicolon ending the left half,
  // or a clause-starter opening the right half. Both halves must stay non-trivial.
  const mid = words.length / 2;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 3; i <= words.length - 3; i++) {
    if (!/[,;]$/.test(words[i - 1]) && !CLAUSE_STARTERS.test(words[i])) continue;
    const d = Math.abs(i - mid);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best === -1) best = Math.round(mid); // no natural seam: balanced split on a space

  // The bubble break replaces the comma pause at the seam (a person doesn't end a text ",").
  const left = words.slice(0, best).join(' ').replace(/,$/, '');
  const right = words.slice(best).join(' ');
  console.warn(`[guardrail] split a ${words.length}-word bubble over the ${MAX_BUBBLE_WORDS}-word ceiling`);
  return [...splitLongBubble(left), ...splitLongBubble(right)];
}

// Split a reply into chat bubbles. Breaks on "---", newlines, a SPACED em/en-dash
// (" — ", a stray dash-used-as-a-pause), every sentence boundary (. ? !) via
// splitSentences, AND the word ceiling via splitLongBubble, so no bubble ever carries
// two sentences, two questions, or an over-the-ceiling run-on. A TIGHT dash (3–5,
// $1,800–2,000, word—word) is part of a range/compound and is left intact for
// cleanResponse to normalize, so ranges are never chopped across two bubbles.
export function splitIntoBubbles(text: string): string[] {
  return text
    // Normalize SPACED numeric/currency ranges ("$1,800 – $2,000", "3 – 5") to a tight
    // hyphen BEFORE the split below, or the spaced-dash rule would chop the range across
    // two bubbles. Word-level spaced dashes still split (that rule stays).
    .replace(/([\d%])\s+[—–]\s+([$€£¥]?\d)/g, '$1-$2')
    .split(/\s*---\s*|[\r\n]+|\s+[—–]\s+/)
    .flatMap(m => splitSentences(m))
    .map(m => cleanResponse(m))
    .filter(m => m.length > 0)
    // Word-ceiling enforcement LAST, on the cleaned text: cleanResponse turns mid-sentence
    // dashes into commas, which are exactly the seams splitLongBubble prefers.
    .flatMap(m => splitLongBubble(m));
}

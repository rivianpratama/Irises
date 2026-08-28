// Recall query EXPANSION — the paraphrase fallback for installs that have no embeddings lane.
//
// Semantic recall (src/memory/semanticRecall.ts) buys paraphrase tolerance with vectors, and vectors
// need an embeddings endpoint, which in practice means an OpenRouter key. A typical Hermes-only
// install runs Anthropic alone: no embeddings endpoint exists to call, so semantic recall can never
// arm and recall_memory stays a keyword search that misses "the vacation house by the water" when
// what was written down said "my lake cabin".
//
// This module closes that gap with the lane the install DOES have. One tiny `classify` call turns the
// query into a handful of extra search words, and the lexical search runs with them appended. The
// full ladder, whose branch lives at the recall site in agents/convo/shared.ts:
//
//   embeddings active  → vector + FTS hybrid (memoryArchive.searchArchive), nothing here runs
//   embeddings absent  → expand the query here → FTS over query + expansion
//   expansion failed   → plain FTS, byte for byte what it has always been
//
// Failure policy: expandRecallQuery NEVER throws and NEVER returns anything but a clean word list.
// It sits on the reply path with a user waiting, so every way it can go wrong — no lane, a tripped
// budget, a hung provider, a truncated reply, prose instead of words — resolves to '' and the search
// runs unexpanded. A recall that finds less is a bad answer; a recall that throws is a dead turn.
//
// The query is USER-AUTHORED, so it rides into the prompt inside wrapPrompt/dataTag like every other
// dynamic payload — the model must never read it as instructions.

import { callLLM } from '../llm/callLLM.js';
import { wrapPrompt, dataTag } from '../llm/promptTag.js';
import { reportError } from '../diagnostics/errorLog.js';

/** Words the expansion may contribute. Six is the model's instruction and the hard cap here, and it
 *  is deliberately smaller than the archive tokenizer's 8-token query budget: the user's own words
 *  come FIRST in the concatenation (see the recall site), so expansion can only ever fill slots the
 *  query itself did not use. */
export const MAX_EXPANSION_TERMS = 6;
/** Below this, a "word" is a stopword fragment or an article — it widens the OR-match to everything
 *  and ranks nothing. */
const MIN_TERM_CHARS = 3;
/** Six single words plus whatever preamble a chatty model insists on. */
const EXPAND_MAX_TOKENS = 60;
/** Wall clock for the one call. Tighter than the groomer's 15s and Ops triage's 15s because this one
 *  is IN FRONT OF THE USER: the recall second pass is still to come, so every second here is a second
 *  of silence. A lane slower than this has already cost more than the extra hits are worth. */
const EXPAND_TIMEOUT_MS = 10_000;

/** The contract with the model. Pinned character-for-character by recallExpansion.test.ts: the
 *  words-only shape is what makes the post-processing below a filter rather than a parser. */
export const RECALL_EXPANSION_SYSTEM_PROMPT = `You expand a search over one person's saved memories. Given a short query, reply with up to six extra search words that might appear in the remembered text itself — synonyms, the likely original phrasing, and closely related concrete nouns.

Reply with the words only: lowercase, space-separated, single words. No punctuation, no explanation, no repeats of words already in the query.`;

/** Kill switch (env: MEMORY_RECALL_EXPANSION), read at CALL time so flipping it needs no restart.
 *  Default ON: the whole point is that an install with no OpenRouter key gets paraphrase-tolerant
 *  recall without being told to configure anything. Same parse shape as the other memory flags. */
export function recallExpansionEnabled(): boolean {
  const v = (process.env.MEMORY_RECALL_EXPANSION || '').trim().toLowerCase();
  if (v === '') return true;
  return ['true', '1', 'on', 'yes'].includes(v);
}

/** Same split the archive tokenizer uses (unicode-aware, punctuation-stripping), applied to both the
 *  reply and the query so "already in the query" is a comparison between like things — and, because
 *  both sides are lowercased here, a case-insensitive one. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Turn whatever the model said into the search words we are willing to add. This is the ONLY defense
 * against a garbage reply, and it is a sufficient one: prose survives it only as at most six short
 * lowercase words, appended AFTER the user's own terms, where the tokenizer's cap keeps them
 * subordinate. Nothing here can throw.
 */
function cleanTerms(raw: string | null, query: string): string {
  // Seeded with the query's own words: a repeat adds no reach (the row already had to contain it to
  // match) and burns one of the eight token slots the search gets.
  const seen = new Set(words(query));
  const out: string[] = [];
  for (const term of words(raw ?? '')) {
    if (term.length < MIN_TERM_CHARS) continue;
    if (seen.has(term)) continue;   // in the query, or already taken from this reply
    seen.add(term);
    out.push(term);
    if (out.length === MAX_EXPANSION_TERMS) break;
  }
  return out.join(' ');
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('recall expansion timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

let llmForTests: typeof callLLM | null = null;

/** Test seam: route the expansion call somewhere fake for suites that drive the recall flow
 *  END TO END (agents/convo/recallMemory.test.ts) and so have no argument to inject through. The
 *  real ladder — flag, gate, post-processing, concatenation — still runs; only the provider is
 *  swapped. null = off, which is the production shape and the default. Unit tests pass `deps.llm`
 *  instead and never touch this. */
export function __setRecallExpansionLlmForTests(fn: typeof callLLM | null): void {
  llmForTests = fn;
}

/**
 * Extra search words for a recall query — up to six, lowercase, space-joined, none of them already
 * in the query. Returns '' when the feature is off, the query is blank, or ANYTHING goes wrong; the
 * caller appends the result to the query, so '' means "search exactly as before".
 */
export async function expandRecallQuery(
  query: string,
  deps: { llm?: typeof callLLM } = {},
): Promise<string> {
  // Before the flag read and before any dispatch: a disabled install must not pay a single call, and
  // an empty query has nothing to expand FROM (the model would invent a topic out of nothing).
  if (!recallExpansionEnabled()) return '';
  const q = query.trim();
  if (!q) return '';

  const llm = deps.llm ?? llmForTests ?? callLLM;
  try {
    const res = await withTimeout(
      llm({
        role: 'classify',
        maxTokens: EXPAND_MAX_TOKENS,
        system: RECALL_EXPANSION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: wrapPrompt(dataTag('query', q)) }],
        trace: { label: 'memory:recall_expand' },
      }),
      EXPAND_TIMEOUT_MS,
    );
    // A cut-off word list ends mid-word, and a half-word is a term that matches nothing (FTS) or
    // matches far too much (LIKE's substring scan). Cheaper to drop the whole reply than to guess
    // which of the six survived.
    if (res.truncated) return '';
    return cleanTerms(res.text, q);
  } catch (err) {
    // Every lane failure lands here — noLaneConfiguredError on an install with no classify lane at
    // all, BudgetExceededError on a spent day, a provider throw, the timeout above. All of them mean
    // the same thing to the caller: search with what the user typed.
    //
    // Reported as well as logged, same category/severity as the other two background classify passes
    // (memory/climateDrift.ts, memory/noteGroomer.ts): the degrade is deliberately invisible to the
    // user, so a recall that has quietly lost its paraphrase tolerance for a week would otherwise
    // show up only as "she doesn't remember things as well as she used to". The query itself never
    // rides along — it is user-authored text, and the error log is not a memory store. Fingerprint
    // folding bounds the volume of an install with no classify lane at all.
    console.warn('[memory] recall expansion failed — searching on the query alone', err);
    reportError({
      source: 'memory',
      category: 'classifier_failure',
      severity: 'warn',
      message: 'recall query expansion failed — searching on the query alone',
      err,
    });
    return '';
  }
}

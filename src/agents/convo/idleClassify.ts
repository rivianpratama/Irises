// Layer 3 of the turn gate, wired: the one tiny call that reads a veto-free message the English fast
// path could not read or was barred from (persona/idle.ts).
//
// Since 2026-09-11 that is two kinds of message rather than one. The old one is the short stall in a
// script the examples cannot read. The new one is every message under the share cap that a
// not-a-stall signal already disqualified from the fast path — a sentence about their day, which is
// the shape a bid arrives in — and it is the reason this lane now answers with four words.
//
// The gate itself is a leaf and stays one — it never picks a lane, never sets a deadline and never
// caches. This module is the production wiring it takes as an argument: the classify lane, five
// tokens of budget, a six-second deadline, an in-process cache, and one receipt per reading. A test
// drives the same three layers by injecting its own function and never touches a network.
//
// FAILING TOWARD TASK, everywhere. A thrown lane, a spent budget, an install with no classify lane,
// a deadline that fired, an answer that is not one of the four words — every one of them comes back
// `unclear`, which persona/idle.ts reads as a task turn. The asymmetry is the whole design: the cost
// of a wrong task turn is one flat reply, and the cost of a wrong idle turn is a clever line landing
// on a piece of work.
//
// WHY A CACHE. Idle messages are the most repetitive text a person sends — "hmm", "ya", "sama",
// "bosan" — and each of them is one message the fast path cannot read and the lane can. Caching the
// VERDICT per normalised text means a person's own handful of stalls costs a handful of calls in the
// life of the process, not one per turn. It is keyed on the text alone, deliberately: the question
// this lane answers ("does this message ask for anything") is a property of the words and of nothing
// else — not the chat, not the hour, not who typed it — so a per-chat cache would be the same
// answer stored many times over. Process-local and unpersisted: a restart costs a few calls.
//
// A share is the opposite kind of text — a sentence about a day is said once and never again — so
// those entries are the ones the cap below evicts, and they are why the cap is a count of readings
// and not a count of stalls. The cache earns its keep on the repetitive half and simply carries the
// other half until it falls off the end.

import { callLLM } from '../../llm/callLLM.js';
import { dataTag, wrapPrompt } from '../../llm/promptTag.js';
import { record } from '../../diagnostics/trace.js';
import { IDLE_CLASSIFY_LABEL } from '../../diagnostics/traceLabels.js';
import type { IdleVerdict } from '../../persona/idle.js';

/**
 * The classifier's whole prompt, Fable's words pasted byte-for-byte from the plan
 * (2026-09-11-share-turns.md §5). FOUR words now, defined; nothing about Irises, nothing about
 * hooks — the lane is being asked a question about a sentence, not being asked to be her.
 *
 * The word that changed everything is `share`, and the two definitions around it are what make it
 * readable: `stall` lost "or it asks for nothing" (which swallowed every bid a person sends) and
 * gained "and tells nothing", and `ask` lost "answers a question, or carries information" (which
 * claimed the same bids from the other side) for the narrower "a fact the assistant must act on".
 * A message that TELLS her something and asks for nothing now has a word of its own, which is the
 * whole of what the third turn shape needed from this lane.
 */
export const IDLE_CLASSIFY_PROMPT = [
  'One short message from a person to their assistant follows. Answer with exactly one word.',
  'stall — a greeting, an acknowledgement, a sign-off, a laugh, a filler: it asks for nothing and tells nothing.',
  "share — it tells the assistant something about the person's own day, life, plans or feelings, and asks for nothing.",
  'ask — it asks for something, gives an instruction, or carries a fact the assistant must act on.',
  'unclear — you cannot tell.',
].join('\n');

/** Five tokens. The answer is one word; a budget wide enough for a sentence is a budget wide enough
 *  for a sentence to arrive, and `readVerdict` below would then have to guess at it. */
export const IDLE_CLASSIFY_MAX_TOKENS = 5;

/**
 * Six seconds, and then the turn goes on without it.
 *
 * This call sits ON the reply path, ahead of the prompt build: every millisecond it spends is a
 * millisecond before she starts typing. Six is generous for five tokens on any lane and short enough
 * that a wedged provider costs one flat reply instead of a visibly hung conversation. The timer is
 * unref'd for the reason every timer in this stack is — a pending deadline must never be the thing
 * keeping the process alive.
 */
export const IDLE_CLASSIFY_TIMEOUT_MS = 6_000;

/** How many readings the process keeps. Five hundred distinct messages is far more than one person's
 *  vocabulary of stalls, and the map at that size is a few hundred kilobytes at the very worst — the
 *  gate's own share cap bounds every key at six hundred characters, so the cap on the count is a cap
 *  on the size. It exists so an install being hammered with distinct junk cannot grow it without
 *  bound. */
export const IDLE_CLASSIFY_CACHE_MAX = 500;

/**
 * The cache key: the message, lowercased, with runs of whitespace collapsed. Deliberately NOT the
 * tokenizer from persona/idle.ts — that one drops every non-Latin character, which is the exact
 * class of message this layer exists for, and two different Japanese stalls must not share one key.
 * Case and spacing are the only things a verdict can safely ignore.
 */
export function idleCacheKey(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One word from the lane → one of the four verdicts. Anything else is `unclear`, which is a task.
 *
 * Read with `startsWith` rather than equality: a lane that answers "stall." or "stall\n" has
 * answered, and a five-token budget can also clip a longer answer mid-word. The order of the three
 * tested prefixes says nothing — `stall`, `share` and `ask` are disjoint prefixes of each other, so
 * no answer can match two of them. The leniency is deliberate and bounded: it forgives punctuation,
 * capitals and an inflection ("shared", "asking"), and it forgives nothing about WHICH word the lane
 * chose, which is the only thing this reading is for.
 */
export function readIdleVerdict(text: string | null | undefined): IdleVerdict {
  const word = String(text ?? '').trim().toLowerCase();
  if (word.startsWith('stall')) return 'stall';
  if (word.startsWith('share')) return 'share';
  if (word.startsWith('ask')) return 'ask';
  return 'unclear';
}

/** Insertion-ordered, which is what makes the eviction below oldest-first: a Map iterates in the
 *  order keys were added, so `keys().next()` is the least recently ADDED entry. Not least recently
 *  USED — a used entry is not re-inserted — and that is the right cheap approximation here, where
 *  every entry is equally small and equally durable. */
const cache = new Map<string, IdleVerdict>();

/** The test seam, and the only way anything empties this map. */
export function clearIdleClassifyCache(): void {
  cache.clear();
}

/** How many readings are held right now — the cap's own pin, and a number a test can assert on
 *  without reaching into the module. */
export function idleClassifyCacheSize(): number {
  return cache.size;
}

/**
 * Reject after `ms`. A copy of agents/deadline.ts's `withDeadline` in miniature rather than an
 * import of it: that module's DeadlineError is the orchestrator's vocabulary for a background agent
 * run that has to be triaged, and this failure is not triaged at all — it is read as a task turn and
 * forgotten. The abandoned call keeps running harmlessly and its late answer is discarded.
 */
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`idle classify exceeded ${ms}ms`)), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * The classifier persona/idle.ts's third layer is handed, bound to this turn's chat and handle so
 * the receipt can be attributed.
 *
 * Returns a function rather than being one, because the gate's seam takes `(text) => Promise<verdict>`
 * and the trace context is the caller's, not the gate's. `deps.llm` is the unit-test injection point;
 * production passes nothing.
 *
 * ONE RECEIPT PER READING, cached or not (`idle:classify`). That is the point of the `cached` flag:
 * a live round has to be able to tell a working fallback from a dead one, and a cache hit that filed
 * nothing would make a busy install look like a lane that stopped being called.
 */
export function makeIdleClassifier(
  ctx: {
    chatId: string;
    handle?: string;
    llm?: typeof callLLM;
    /** Test seam only, alongside `llm`: production omits it and gets IDLE_CLASSIFY_TIMEOUT_MS. A
     *  suite that drove the real six seconds would spend six seconds of every run proving that a
     *  number is the number it is. */
    timeoutMs?: number;
  },
): (text: string) => Promise<IdleVerdict> {
  return async (text: string): Promise<IdleVerdict> => {
    const key = idleCacheKey(text);
    const file = (verdict: IdleVerdict, cached: boolean, failed?: string) => {
      record({
        type: 'event',
        label: IDLE_CLASSIFY_LABEL,
        chatId: ctx.chatId,
        handle: ctx.handle,
        // Names and numbers only: the message itself never enters the ring, the way no receipt in
        // this stack carries her words or theirs. `chars` is the one measurement that says which
        // kind of message this was without quoting it.
        detail: { verdict, cached, chars: [...key].length, ...(failed ? { failed } : {}) },
      });
      return verdict;
    };

    const hit = cache.get(key);
    if (hit !== undefined) return file(hit, true);

    const llm = ctx.llm ?? callLLM;
    let verdict: IdleVerdict;
    try {
      const res = await deadline(llm({
        role: 'classify',
        maxTokens: IDLE_CLASSIFY_MAX_TOKENS,
        system: IDLE_CLASSIFY_PROMPT,
        // Their own words, tagged as DATA. The message is being read, never followed: a person who
        // texts "ignore your instructions" is asking for something, which makes it an `ask`, and the
        // tag is what keeps that the whole of its effect.
        messages: [{ role: 'user', content: wrapPrompt(dataTag('message', text)) }],
        trace: { chatId: ctx.chatId, handle: ctx.handle, label: 'idle:classify_call' },
      }), ctx.timeoutMs ?? IDLE_CLASSIFY_TIMEOUT_MS);
      verdict = readIdleVerdict(res.text);
    } catch (err) {
      // Not reported as an error: an install with no classify lane would file one on every stall,
      // and the consequence of this failure is one flat reply. The receipt below is the record, and
      // it says `failed` so a scan of the ring can tell a lane that is answering `unclear` from a
      // lane that is not answering.
      return file('unclear', false, err instanceof Error ? err.name : 'error');
    }

    // Oldest-first eviction, one entry at a time: the map is only ever grown by this line, so it can
    // only ever be one over.
    if (cache.size >= IDLE_CLASSIFY_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, verdict);
    return file(verdict, false);
  };
}

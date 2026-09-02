// Walled URLs: the hosts whose pages are JavaScript-rendered behind a login wall, so a delegated
// look at one of their links has to OPEN A BROWSER instead of fetching the page.
//
// Why this module exists (VPS evidence, 2026-09-02). Asked "who is the girl in
// https://www.instagram.com/reel/DcJg4VkgMT0/", the engine (deepseek-v4-flash) burned twelve API
// calls on `terminal` and `execute_code`, never touched the `browser` toolset it had enabled, and
// answered NO RESULT — because a fetch of that URL returns a login shell and the model read the
// empty shell as "the answer isn't there". Triage then called it UNANSWERABLE and gave up on the
// first attempt. Poke and a local Hermes both answered the same question by opening the page and
// reading the caption. The capability was present; nothing told the engine this host needs it.
//
// Everything here is pure and env-free: both callers (the task prompt in ./client.ts and the retry
// escalation in ./triage.ts) inject the capability summary and their own flag read, so the same
// inputs always produce the same decision and the off path is a caller-side `enabled: false`.
import type { CapabilitySummary } from './engineBackend.js';

/** Hosts that serve a login/consent shell to anything but a real browser. Single source: the
 *  prompt's `tooling:` line, the `ops:kickoff` receipt and the retry escalation all read this. */
export const WALLED_HOSTS: readonly string[] = [
  'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'facebook.com', 'fb.watch',
  'linkedin.com', 'threads.net', 'youtube.com', 'pinterest.com', 'reddit.com',
];

/** Hosts walled on SOME paths only, keyed by their WALLED_HOSTS entry. youtube.com is the one:
 *  its watch/shorts players render title, channel and description in JS (and increasingly gate them
 *  behind a consent/sign-in interstitial), while a channel, search or home URL is simply not the
 *  shape this hint is about. */
const PATH_GATES: ReadonlyArray<readonly [string, RegExp]> = [
  ['youtube.com', /^\/(shorts\/|watch\b)/i],
];

// Only http(s) links count — a scheme-less mention ("instagram.com/reel/x") is not something the
// engine can be told to open, and a non-http scheme is not a page. Stops at whitespace and at the
// delimiters that wrap links in prose, markdown and HTML so those never end up inside the URL.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;
// Sentence punctuation that trails a URL in prose ("see …/reel/X/.") is not part of it.
const TRAILING_PUNCT = /[.,;:!?…]+$/;

export interface WalledUrl {
  /** The URL exactly as written in the ask (trailing prose punctuation trimmed). */
  url: string;
  /** The WALLED_HOSTS entry it matched — the CANONICAL host, so `www.instagram.com/...` and
   *  `m.instagram.com/...` both report `instagram.com`. */
  host: string;
}

/** The canonical walled host a hostname belongs to, or null. Subdomain-aware, and deliberately not
 *  a substring test: `notinstagram.com` and `instagram.com.evil.io` are not instagram. */
function walledHostFor(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const entry of WALLED_HOSTS) if (h === entry || h.endsWith(`.${entry}`)) return entry;
  return null;
}

/** Every walled URL in a piece of text, in first-seen order, deduped by URL. Never throws: an
 *  unparseable match is skipped. */
export function findWalledUrls(text: string): WalledUrl[] {
  const out: WalledUrl[] = [];
  const seen = new Set<string>();
  for (const match of (text ?? '').matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    const host = walledHostFor(parsed.hostname);
    if (!host) continue;
    const gate = PATH_GATES.find(([h]) => h === host);
    if (gate && !gate[1].test(parsed.pathname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, host });
  }
  return out;
}

/** The text a walled URL can appear in: the user's ask PLUS the front-line brief — Convo routinely
 *  restates the link there ("akses URL IG reel itu"), and sometimes only there. */
export function walledScanText(task: { request: string; metaPrompt?: string }): string {
  return `${task.request}\n${task.metaPrompt ?? ''}`;
}

/**
 * Does this capability summary promise a BROWSER?
 *
 * `web` is the answer because of the class table in ./hermesBackend.ts (CLASS_KEYWORDS): every
 * browser token an engine can report — the `browser` toolset name, `browser_navigate`, `browse` —
 * normalizes into the `web` class, and CapabilityClass has no finer grain. So this is the strongest
 * available signal, not a precise one: an engine with only `web_search`/fetch and no browser also
 * reports `web`. That asymmetry is deliberate and cheap — the hint is a routing suggestion, and an
 * engine without the tools simply cannot follow it. A null/unknown summary is NOT a promise.
 */
export function hasBrowserClass(summary: CapabilitySummary | null | undefined): boolean {
  return !!summary && summary.classes.includes('web');
}

/** The `tooling:` line for a set of walled hosts. One line — the task prompt joins its fields with
 *  newlines. */
function toolingHintLine(hosts: readonly string[]): string {
  return `tooling: ${hosts.join(', ')} pages are JavaScript/login-walled — curl, fetch and web_extract return a login shell, not the post. Open the URL with the browser toolset (browser_navigate → browser_snapshot / browser_get_images / browser_vision), read the caption, tags, on-screen text and top comments, then web_search any names or handles you find. A blocked fetch is NOT a NO RESULT. Expect this to take 1–3 minutes; do not stop early because the brief asked for speed.`;
}

/** The extra steer for the second leg after a walled-URL first pass came back empty-handed. */
export function browserRetryDirective(url: string): string {
  return `The first pass never opened the page in a browser. browser_navigate to ${url}, read the caption/tags/comments from the rendered page, then answer.`;
}

export interface WalledToolingDecision {
  /** Canonical walled hosts named in the text, deduped, first-seen order. */
  hosts: string[];
  /** The walled URLs themselves, first-seen order. */
  urls: string[];
  /** The line to insert, or null when the hint is not warranted (flag off, nothing walled, or no
   *  browser). `hosts`/`urls` are populated either way — the receipt wants the fact even on the
   *  no-op, and the flag gates the PROMPT, not the trace. */
  line: string | null;
}

/** The whole walled-URL tooling decision in one pure call, so the prompt and the `ops:kickoff`
 *  receipt can never disagree about whether the hint went in. */
export function decideWalledTooling(input: {
  text: string;
  capabilities: CapabilitySummary | null | undefined;
  enabled: boolean;
}): WalledToolingDecision {
  const found = findWalledUrls(input.text);
  const hosts = [...new Set(found.map(f => f.host))];
  const armed = input.enabled && hosts.length > 0 && hasBrowserClass(input.capabilities);
  return { hosts, urls: found.map(f => f.url), line: armed ? toolingHintLine(hosts) : null };
}

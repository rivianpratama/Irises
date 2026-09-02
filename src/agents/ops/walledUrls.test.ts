process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLED_HOSTS, findWalledUrls, decideWalledTooling, browserRetryDirective, walledScanText,
} from './walledUrls.js';
import { buildTaskPrompt, runTask } from './client.js';
import { resetEngineBackendCache, type EngineBackend } from './engineBackend.js';
import { HermesBackend, manifestHasBrowser } from './hermesBackend.js';
import { getTraces, clearTraces } from '../../diagnostics/trace.js';
import { emptyMedia } from '../../webhook/types.js';
import type { OpsTask } from '../types.js';

// A URL shape that is actually walled for each single-source host: youtube.com is only walled on its
// watch/shorts players, so it needs a real player path rather than the bare host.
function sampleUrl(host: string): string {
  if (host === 'youtube.com') return `https://www.${host}/watch?v=abc123`;
  return `https://www.${host}/some/post/123`;
}

// ── findWalledUrls ────────────────────────────────────────────────────────────

test('findWalledUrls: every WALLED_HOSTS entry is detected from its own URL shape', () => {
  for (const host of WALLED_HOSTS) {
    const found = findWalledUrls(`have a look at ${sampleUrl(host)} for me`);
    assert.deepEqual(found.map(f => f.host), [host], `${host} should be detected`);
  }
});

test('findWalledUrls: the live evidence case — an instagram reel inside a real ask', () => {
  assert.deepEqual(
    findWalledUrls('who is the girl in https://www.instagram.com/reel/DcJg4VkgMT0/'),
    [{ url: 'https://www.instagram.com/reel/DcJg4VkgMT0/', host: 'instagram.com' }],
  );
});

test('findWalledUrls: subdomain-aware — any subdomain reports the canonical host', () => {
  const found = findWalledUrls([
    'https://m.facebook.com/watch/?v=1',
    'https://vm.tiktok.com/ZSabc/',
    'https://old.reddit.com/r/x/comments/1/y/',
  ].join(' '));
  assert.deepEqual(found.map(f => f.host), ['facebook.com', 'tiktok.com', 'reddit.com']);
});

test('findWalledUrls: a host that merely CONTAINS a walled name is not walled', () => {
  assert.deepEqual(findWalledUrls('https://notinstagram.com/reel/1 https://instagram.com.evil.io/reel/1'), []);
});

test('findWalledUrls: dedupes the same URL, keeps two distinct URLs on one host', () => {
  const twice = findWalledUrls('https://www.instagram.com/p/AAA/ again: https://www.instagram.com/p/AAA/');
  assert.deepEqual(twice.map(f => f.url), ['https://www.instagram.com/p/AAA/']);
  const two = findWalledUrls('https://www.instagram.com/p/AAA/ and https://www.instagram.com/p/BBB/');
  assert.deepEqual(two.map(f => f.url), ['https://www.instagram.com/p/AAA/', 'https://www.instagram.com/p/BBB/']);
});

test('findWalledUrls: non-http is ignored (other schemes, and a bare host with no scheme)', () => {
  assert.deepEqual(findWalledUrls('ftp://instagram.com/reel/1'), []);
  assert.deepEqual(findWalledUrls('mailto:someone@instagram.com'), []);
  assert.deepEqual(findWalledUrls('instagram.com/reel/DcJg4VkgMT0/'), []);
});

test('findWalledUrls: trailing sentence punctuation is not part of the URL', () => {
  assert.deepEqual(findWalledUrls('see https://www.instagram.com/reel/DcJg4VkgMT0/.').map(f => f.url),
    ['https://www.instagram.com/reel/DcJg4VkgMT0/']);
  assert.deepEqual(findWalledUrls('(https://x.com/someone/status/12345)').map(f => f.url),
    ['https://x.com/someone/status/12345']);
  assert.deepEqual(findWalledUrls('[the reel](https://www.instagram.com/reel/DcJg4VkgMT0/)').map(f => f.url),
    ['https://www.instagram.com/reel/DcJg4VkgMT0/'], 'a markdown link is not swallowed whole');
});

test('findWalledUrls: youtube is walled on watch/shorts players only', () => {
  assert.deepEqual(findWalledUrls('https://www.youtube.com/watch?v=abc').map(f => f.host), ['youtube.com']);
  assert.deepEqual(findWalledUrls('https://youtube.com/shorts/abc').map(f => f.host), ['youtube.com']);
  assert.deepEqual(findWalledUrls('https://www.youtube.com/@somechannel'), [], 'a channel page is not the walled shape');
  assert.deepEqual(findWalledUrls('https://www.youtube.com/'), []);
});

test('findWalledUrls: an open host and an empty ask find nothing', () => {
  assert.deepEqual(findWalledUrls('https://example.com/blog/post-1 https://en.wikipedia.org/wiki/X'), []);
  assert.deepEqual(findWalledUrls(''), []);
});

test('walledScanText: scans the ask AND the front-line brief (Convo restates the URL there)', () => {
  const text = walledScanText({ request: 'who is the girl', metaPrompt: 'akses https://www.instagram.com/reel/DcJg4VkgMT0/ itu' });
  assert.deepEqual(findWalledUrls(text).map(f => f.host), ['instagram.com']);
  assert.equal(walledScanText({ request: 'a' }), 'a\n', 'no brief → the ask plus an empty line, never "undefined"');
});

// ── the browser signal itself (review r1 / Important #2) ──────────────────────
//
// The arming predicate used to be `summary.classes.includes('web')`, and `web` is a SUPERSET: the
// closed CapabilityClass vocabulary folds browser, browse, http, fetch, url, crawl and scrape into
// that one class, so a deployment with web_search and NO browser toolset armed both halves — it got
// a `tooling:` line naming tools it does not have and (once the escalation had a reader) a silent
// extra engine leg before reaching the same give-up it reaches immediately today.
//
// The gate now reads a precise probe, `EngineBackend.hasBrowserTooling()`, off the raw manifest
// tokens the adapter already holds. That ALSO keeps CapabilitySummary out of the engine-facing task
// prompt, which is what its own docstring promises (review r1 / Important #3).
//
// manifestHasBrowser lives in hermesBackend.ts, next to the token extractor and the class table it
// shares; its tests live here because the walled-URL hint is its only consumer.

test('manifestHasBrowser: a real browser toolset says yes; web_search/fetch alone says no', () => {
  // The live evidence shape (VPS /v1/toolsets) — this is the deployment the whole feature is for.
  assert.equal(manifestHasBrowser({
    object: 'list', platform: 'api_server', data: [
      { name: 'web', enabled: true, configured: true, tools: ['web_search', 'web_extract'] },
      { name: 'browser', enabled: true, configured: true, tools: ['browser_navigate', 'browser_snapshot', 'browser_vision'] },
    ],
  }), true);
  // The regression case: web class present, no browser anywhere.
  assert.equal(manifestHasBrowser({
    object: 'list', platform: 'api_server', data: [
      { name: 'web', enabled: true, configured: true, tools: ['web_search', 'web_extract'] },
      { name: 'terminal', enabled: true, configured: true, tools: ['run_command'] },
    ],
  }), false, 'web_search is not a browser — this is exactly the box that must NOT arm');
  // A browser toolset present but switched off is not a live capability (same rule as the classes).
  assert.equal(manifestHasBrowser({ data: [{ name: 'browser', enabled: false, configured: true, tools: ['browser_navigate'] }] }), false);
  assert.equal(manifestHasBrowser({ data: [{ name: 'browser', enabled: true, configured: false, tools: ['browser_navigate'] }] }), false);
  // The other tolerated shapes the normalizer accepts.
  assert.equal(manifestHasBrowser(['web_search', 'browse_page']), true);
  assert.equal(manifestHasBrowser({ features: { computer_use: true } }), true, 'computer_use can open a page');
  assert.equal(manifestHasBrowser({ features: { web_search: true, terminal: true } }), false);
  // Garbage never throws and never promises.
  for (const bad of [null, undefined, 42, 'a string', '<html>502</html>', {}, []]) {
    assert.equal(manifestHasBrowser(bad as unknown), false, `${JSON.stringify(bad)} is not a promise`);
  }
});

const json200 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A /v1/toolsets fake; /v1/capabilities answers the real API-surface shape (no class tokens). */
function toolsetFetch(toolsets: unknown[]): typeof fetch {
  return (async (url: RequestInfo | URL) => String(url).endsWith('/v1/toolsets')
    ? json200({ object: 'list', platform: 'api_server', data: toolsets })
    : json200({ features: { chat_completions: true } })) as typeof fetch;
}

async function settle(be: HermesBackend, until: () => boolean): Promise<void> {
  const start = Date.now();
  while (!until() && Date.now() - start < 500) await new Promise(r => setTimeout(r, 5));
}

test('hasBrowserTooling: undefined until discovery answers, then the manifest’s own truth', async () => {
  const withBrowser = new HermesBackend({
    fetchFn: toolsetFetch([
      { name: 'web', enabled: true, configured: true, tools: ['web_search'] },
      { name: 'browser', enabled: true, configured: true, tools: ['browser_navigate'] },
    ]),
  });
  assert.equal(withBrowser.hasBrowserTooling(), undefined, 'a cold cache cannot promise a browser');
  withBrowser.getCapabilitySummary();                       // kicks the background refresh
  await settle(withBrowser, () => withBrowser.hasBrowserTooling() !== undefined);
  assert.equal(withBrowser.hasBrowserTooling(), true);

  const webOnly = new HermesBackend({
    fetchFn: toolsetFetch([{ name: 'web', enabled: true, configured: true, tools: ['web_search', 'web_extract'] }]),
  });
  webOnly.getCapabilitySummary();
  await settle(webOnly, () => webOnly.hasBrowserTooling() !== undefined);
  assert.equal(webOnly.hasBrowserTooling(), false, 'the web class is reported, a browser is not');
  assert.deepEqual(webOnly.getCapabilitySummary(), { classes: ['web'] }, 'and the summary itself is unchanged by any of this');

  const away = new HermesBackend({ fetchFn: (async () => { throw new TypeError('ECONNREFUSED'); }) as typeof fetch });
  away.getCapabilitySummary();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(away.hasBrowserTooling(), undefined, 'engine away → unknown, never a false negative');
});

// ── decideWalledTooling ───────────────────────────────────────────────────────

const ASK = 'who is the girl in https://www.instagram.com/reel/DcJg4VkgMT0/';

test('decideWalledTooling: walled URL + browser + flag on → the tooling line, hosts and urls', () => {
  const d = decideWalledTooling({ text: ASK, browser: true, enabled: true });
  assert.deepEqual(d.hosts, ['instagram.com']);
  assert.deepEqual(d.urls, ['https://www.instagram.com/reel/DcJg4VkgMT0/']);
  assert.equal(d.line?.startsWith('tooling: instagram.com pages are JavaScript/login-walled'), true);
  assert.match(d.line!, /browser_navigate → browser_snapshot \/ browser_get_images \/ browser_vision/);
  assert.match(d.line!, /A blocked fetch is NOT a NO RESULT\./);
  assert.match(d.line!, /1–3 minutes/);
  assert.equal(d.line!.includes('\n'), false, 'it is ONE line — the prompt joins fields with newlines');
});

test('decideWalledTooling: the host list is deduped and reads in first-seen order', () => {
  const d = decideWalledTooling({
    text: 'https://www.tiktok.com/@a/video/1 https://www.instagram.com/p/AAA/ https://m.tiktok.com/@b/video/2',
    browser: true, enabled: true,
  });
  assert.deepEqual(d.hosts, ['tiktok.com', 'instagram.com']);
  assert.equal(d.line?.startsWith('tooling: tiktok.com, instagram.com pages are'), true);
});

test('decideWalledTooling: no line when the engine has no browser, when nothing is walled, or when the flag is off', () => {
  const noBrowser = decideWalledTooling({ text: ASK, browser: false, enabled: true });
  assert.equal(noBrowser.line, null);
  assert.deepEqual(noBrowser.hosts, ['instagram.com'], 'the hosts are still reported — the receipt wants the fact');

  const unknown = decideWalledTooling({ text: ASK, browser: undefined, enabled: true });
  assert.equal(unknown.line, null, 'an undiscovered toolset is not a promise of a browser');

  const nothingWalled = decideWalledTooling({ text: 'find the date on that invoice', browser: true, enabled: true });
  assert.equal(nothingWalled.line, null);
  assert.deepEqual(nothingWalled.hosts, []);

  const off = decideWalledTooling({ text: ASK, browser: true, enabled: false });
  assert.equal(off.line, null);
  assert.deepEqual(off.hosts, ['instagram.com'], 'the flag gates the PROMPT, not the receipt');
});

// ── browserRetryDirective ─────────────────────────────────────────────────────

test('browserRetryDirective: names the URL and says why the first pass came back empty', () => {
  assert.equal(
    browserRetryDirective('https://www.instagram.com/reel/DcJg4VkgMT0/'),
    'The first pass never opened the page in a browser. browser_navigate to https://www.instagram.com/reel/DcJg4VkgMT0/, read the caption/tags/comments from the rendered page, then answer.',
  );
});

// ── buildTaskPrompt: where the hint lands, and the byte-identical off path ────

const AT = { now: Date.parse('2026-08-12T00:00:00Z'), tz: 'UTC' };

function mkTask(over: Partial<OpsTask> = {}): OpsTask {
  return {
    id: 't1', chatId: 'web:debug', agentHandle: '+15551234567', kind: 'web_research',
    request: ASK, createdAt: Date.now(), media: emptyMedia(), ...over,
  };
}

function withFlag(value: string | undefined, fn: () => void): void {
  const prev = process.env.OPS_WALLED_URL_HINT;
  if (value === undefined) delete process.env.OPS_WALLED_URL_HINT;
  else process.env.OPS_WALLED_URL_HINT = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.OPS_WALLED_URL_HINT; else process.env.OPS_WALLED_URL_HINT = prev;
  }
}

test('buildTaskPrompt: the tooling line sits immediately after `task kind:`, exactly once', () => {
  const lines = buildTaskPrompt(mkTask(), { ...AT, browser: true }).split('\n');
  const kindAt = lines.findIndex(l => l.startsWith('task kind: '));
  assert.ok(kindAt >= 0, 'the task kind line is still there');
  assert.equal(lines.filter(l => l.startsWith('tooling: ')).length, 1, 'one hint, not two');
  assert.ok(lines[kindAt + 1].startsWith('tooling: instagram.com pages are JavaScript/login-walled'),
    `expected the hint right after the kind line, got: ${lines[kindAt + 1]}`);
});

test('buildTaskPrompt: no hint without a walled URL, without a browser, or with no probe read', () => {
  const plain = buildTaskPrompt(mkTask({ request: 'find the date on that invoice' }), { ...AT, browser: true });
  assert.doesNotMatch(plain, /^tooling: /m);
  assert.doesNotMatch(buildTaskPrompt(mkTask(), { ...AT, browser: false }), /^tooling: /m);
  assert.doesNotMatch(buildTaskPrompt(mkTask(), { ...AT, browser: undefined }), /^tooling: /m);
  assert.doesNotMatch(buildTaskPrompt(mkTask(), AT), /^tooling: /m, 'a caller that reads no probe gets today’s prompt');
});

test('buildTaskPrompt: the URL can ride in the front-line brief instead of the ask', () => {
  const p = buildTaskPrompt(mkTask({ request: 'who is the girl', metaPrompt: 'akses https://www.instagram.com/reel/DcJg4VkgMT0/ itu, cepet' }), { ...AT, browser: true });
  assert.match(p, /^tooling: instagram\.com pages are/m);
});

test('buildTaskPrompt: OPS_WALLED_URL_HINT off → byte-identical to the pre-hint prompt', () => {
  const task = mkTask();
  const before = buildTaskPrompt(task, AT); // no browser probe read == today's bytes
  withFlag('false', () => {
    assert.equal(buildTaskPrompt(task, { ...AT, browser: true }), before);
  });
  withFlag('true', () => {
    assert.notEqual(buildTaskPrompt(task, { ...AT, browser: true }), before, 'and on, it really does change the bytes');
  });
});

// ── the ops:kickoff receipt ───────────────────────────────────────────────────

function stubEngine(browser: boolean | undefined, onPrompt: (p: string) => void): EngineBackend {
  return {
    name: 'hermes',
    runTask: async (prompt: string) => { onPrompt(prompt); return 'ANSWER: her name is on the caption\nSOURCE: the reel page\nFLAGS: none'; },
    async createReminder() { return { id: 'r', title: 't', schedule: 's' }; },
    async listReminders() { return []; },
    async cancelReminder() { return false; },
    async remember() { /* noop */ },
    async probe() { return { ok: true }; },
    async channelSend() { return {}; },
    hasBrowserTooling() { return browser; },
  };
}

async function kickoffDetail(task: OpsTask, browser: boolean | undefined): Promise<{ detail: Record<string, unknown>; prompt: string }> {
  let prompt = '';
  resetEngineBackendCache(stubEngine(browser, p => { prompt = p; }));
  clearTraces();
  try {
    await runTask(task);
    const kickoff = getTraces().find(e => e.label === 'ops:kickoff');
    assert.ok(kickoff, 'ops:kickoff was recorded');
    return { detail: (kickoff.detail ?? {}) as Record<string, unknown>, prompt };
  } finally {
    resetEngineBackendCache(undefined);
  }
}

test('runTask: ops:kickoff reports the walled hosts and whether the hint went in', async () => {
  const armed = await kickoffDetail(mkTask(), true);
  assert.deepEqual(armed.detail.walledHosts, ['instagram.com']);
  assert.equal(armed.detail.toolingHint, true);
  assert.equal(armed.detail.browserTooling, true);
  assert.match(armed.prompt, /^tooling: instagram\.com pages are/m, 'and the engine actually received it');
  assert.equal(armed.detail.kind, 'web_research', 'the fields it already carried are untouched');
});

test('runTask: ops:kickoff tells the three no-ops apart — no browser, none reported, nothing walled', async () => {
  const noBrowser = await kickoffDetail(mkTask(), false);
  assert.deepEqual(noBrowser.detail.walledHosts, ['instagram.com'], 'the URL was walled; only the capability was missing');
  assert.equal(noBrowser.detail.toolingHint, false);
  assert.equal(noBrowser.detail.browserTooling, false, 'the engine said it has no browser');
  assert.doesNotMatch(noBrowser.prompt, /^tooling: /m);

  // The cold-cache case: discovery has not answered yet, so nothing is known either way. Without
  // this field a fresh-process no-op is indistinguishable from "no browser on this box".
  const unknown = await kickoffDetail(mkTask(), undefined);
  assert.deepEqual(unknown.detail.walledHosts, ['instagram.com']);
  assert.equal(unknown.detail.toolingHint, false);
  assert.equal(unknown.detail.browserTooling, null, 'null = the engine could not say (cold cache / no probe)');

  const plain = await kickoffDetail(mkTask({ request: 'find the date on that invoice' }), true);
  assert.deepEqual(plain.detail.walledHosts, []);
  assert.equal(plain.detail.toolingHint, false);
  assert.equal(plain.detail.browserTooling, true, 'the browser was there — the ask simply had no walled link');
});

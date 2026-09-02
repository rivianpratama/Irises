process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLED_HOSTS, findWalledUrls, hasBrowserClass, decideWalledTooling, browserRetryDirective, walledScanText,
} from './walledUrls.js';
import type { CapabilitySummary } from './engineBackend.js';

const WITH_BROWSER: CapabilitySummary = { classes: ['web', 'code'] };
const NO_BROWSER: CapabilitySummary = { classes: ['code', 'files'] };

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

// ── hasBrowserClass ───────────────────────────────────────────────────────────

test('hasBrowserClass: the web class is the browser signal; nothing else is', () => {
  assert.equal(hasBrowserClass(WITH_BROWSER), true);
  assert.equal(hasBrowserClass(NO_BROWSER), false);
  assert.equal(hasBrowserClass({ classes: [] }), false);
  assert.equal(hasBrowserClass(null), false);
  assert.equal(hasBrowserClass(undefined), false);
});

// ── decideWalledTooling ───────────────────────────────────────────────────────

const ASK = 'who is the girl in https://www.instagram.com/reel/DcJg4VkgMT0/';

test('decideWalledTooling: walled URL + browser + flag on → the tooling line, hosts and urls', () => {
  const d = decideWalledTooling({ text: ASK, capabilities: WITH_BROWSER, enabled: true });
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
    capabilities: WITH_BROWSER, enabled: true,
  });
  assert.deepEqual(d.hosts, ['tiktok.com', 'instagram.com']);
  assert.equal(d.line?.startsWith('tooling: tiktok.com, instagram.com pages are'), true);
});

test('decideWalledTooling: no line when the engine has no browser, when nothing is walled, or when the flag is off', () => {
  const noBrowser = decideWalledTooling({ text: ASK, capabilities: NO_BROWSER, enabled: true });
  assert.equal(noBrowser.line, null);
  assert.deepEqual(noBrowser.hosts, ['instagram.com'], 'the hosts are still reported — the receipt wants the fact');

  const unknownCaps = decideWalledTooling({ text: ASK, capabilities: null, enabled: true });
  assert.equal(unknownCaps.line, null, 'an unknown capability set is not a promise of a browser');

  const nothingWalled = decideWalledTooling({ text: 'find the date on that invoice', capabilities: WITH_BROWSER, enabled: true });
  assert.equal(nothingWalled.line, null);
  assert.deepEqual(nothingWalled.hosts, []);

  const off = decideWalledTooling({ text: ASK, capabilities: WITH_BROWSER, enabled: false });
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

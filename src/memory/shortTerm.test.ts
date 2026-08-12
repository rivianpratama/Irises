// Run with: npm test   (TZ=UTC tsx --test)
// Renderer parity snapshots: the recent-research and flagged-emails blocks must be
// BYTE-IDENTICAL to the legacy prefs-based blocks they replaced (dossier.ts), so the
// storage move cannot drift the prompts. Plus behavior tests for the new today-digest.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRecentResearch, renderTodayDigest, renderFlaggedEmails,
  RECENT_RESEARCH_TTL_MS, RECENT_RESEARCH_MAX_CHARS, PENDING_EMAIL_TTL_MS,
} from './shortTerm.js';
import type { ShortTermEntry } from '../db/repositories/memoryShort.js';

const NOW = Date.parse('2026-07-14T12:00:00Z');

function entry(over: Partial<ShortTermEntry>): ShortTermEntry {
  return {
    id: over.id ?? 'e1',
    agentHandle: '+15550003333',
    kind: over.kind ?? 'ops_research',
    request: over.request,
    content: over.content ?? 'result',
    meta: over.meta ?? {},
    taskId: over.taskId,
    createdAt: over.createdAt ?? NOW - 60_000,
    expiresAt: over.expiresAt ?? NOW + 60 * 60 * 1000,
    chatId: over.chatId,
  };
}

test('renderRecentResearch matches the legacy block byte-for-byte', () => {
  const e = entry({ request: 'comps near maplewood', content: 'three comps: 410k, 425k, ~440k' });
  const rendered = renderRecentResearch(e, NOW);
  // The exact legacy string from dossier.ts (pre-revamp) for the same inputs:
  const legacy = `## Recent research (you already delivered the answer from this — it's on their screen)\nthey asked: "comps near maplewood"\nthree comps: 410k, 425k, ~440k\nUse this ONLY to answer a NEW question they actually ask about it. Never re-deliver or re-summarize what you already told them — that part is settled ground.`;
  assert.equal(rendered, legacy);
});

test('renderRecentResearch: missing request renders empty quotes (legacy behavior); stale renders nothing', () => {
  assert.match(renderRecentResearch(entry({ request: undefined }), NOW), /they asked: ""\n/);
  const stale = entry({ createdAt: NOW - RECENT_RESEARCH_TTL_MS - 1 });
  assert.equal(renderRecentResearch(stale, NOW), '');
  assert.equal(renderRecentResearch(null, NOW), '');
});

test('renderRecentResearch slices content to the legacy 600-char render cap', () => {
  const e = entry({ content: 'y'.repeat(RECENT_RESEARCH_MAX_CHARS + 50) });
  const rendered = renderRecentResearch(e, NOW);
  assert.ok(rendered.includes('y'.repeat(RECENT_RESEARCH_MAX_CHARS)));
  assert.ok(!rendered.includes('y'.repeat(RECENT_RESEARCH_MAX_CHARS + 1)));
});

test('renderFlaggedEmails matches the legacy block byte-for-byte', () => {
  const flags = [
    entry({
      id: 'f2', kind: 'email_flag', content: 'wire instructions changed - verify by phone',
      meta: { from: 'title co', subject: 'URGENT wire update', deadlineDate: null, deadlineLabel: null },
      createdAt: NOW - 5_000,
    }),
    entry({
      id: 'f1', kind: 'email_flag', content: 'appraisal due friday',
      meta: { from: 'Jane <jane@lender.com>', subject: 'Appraisal deadline', deadlineDate: '2026-07-17', deadlineLabel: 'appraisal' },
      createdAt: NOW - 10_000,
    }),
  ];
  const rendered = renderFlaggedEmails(flags, NOW);
  const legacy = `## Emails you just flagged to them (use these facts for the follow-up, not the chat)\n- from title co, "URGENT wire update": wire instructions changed - verify by phone\n- from Jane <jane@lender.com>, "Appraisal deadline": appraisal due friday — deadline: appraisal 2026-07-17\nif they want a reminder, set it with schedule_automation using the matching deadline/subject.`;
  assert.equal(rendered, legacy);
});

test('renderFlaggedEmails caps at 3 newest and drops >12h-old flags', () => {
  const flags = [0, 1, 2, 3].map(i =>
    entry({ id: `f${i}`, kind: 'email_flag', content: `flag ${i}`, meta: { from: 'x', subject: `s${i}` }, createdAt: NOW - i * 1000 }),
  );
  const rendered = renderFlaggedEmails(flags, NOW);
  assert.ok(rendered.includes('flag 0') && rendered.includes('flag 2'));
  assert.ok(!rendered.includes('flag 3')); // 4th newest dropped

  const old = [entry({ kind: 'email_flag', content: 'ancient', meta: {}, createdAt: NOW - PENDING_EMAIL_TTL_MS - 1 })];
  assert.equal(renderFlaggedEmails(old, NOW), '');
});

test('renderTodayDigest lists non-latest research/media lines, never email flags', () => {
  const entries = [
    entry({ id: 'latest', request: 'newest ask', content: 'newest answer' }),
    entry({ id: 'e2', kind: 'media_analysis', request: 'read the inspection pdf', content: 'roof flagged, HVAC ok', createdAt: NOW - 2000 }),
    entry({ id: 'e3', request: 'zoning for 4th ave', content: 'zoned R-2', createdAt: NOW - 3000 }),
    entry({ id: 'e4', kind: 'email_flag', content: 'should not appear', createdAt: NOW - 4000 }),
  ];
  const digest = renderTodayDigest(entries, { excludeId: 'latest' }, NOW);
  assert.ok(digest.startsWith('## Earlier today (already delivered — settled ground, never re-deliver)'));
  assert.ok(digest.includes('- [file] they asked "read the inspection pdf" → roof flagged, HVAC ok'));
  assert.ok(digest.includes('- [research] they asked "zoning for 4th ave" → zoned R-2'));
  assert.ok(!digest.includes('newest answer')); // excluded — the recent-research block owns it
  assert.ok(!digest.includes('should not appear')); // email flags have their own section
});

test('renderTodayDigest renders nothing when there is nothing to digest', () => {
  assert.equal(renderTodayDigest([], {}, NOW), '');
  assert.equal(renderTodayDigest([entry({ id: 'only' })], { excludeId: 'only' }, NOW), '');
});

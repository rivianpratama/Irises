import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUserText, extractBubbles, claimUsageRows, aggregateTurnCost, assembleTurnCards,
} from './turncostAssembly.js';
import type { Turn } from '../../turns.js';
import type { TraceEvent } from '../../trace.js';
import type { UsageRowLite } from '../../../db/repositories/tokenUsage.js';
import { estimateCostUsd } from '../../../llm/budget.js';

// Pure-function coverage for the Turn cost view's assembly rules: bubble-envelope
// parsing, user-text preference, and — the load-bearing part — usage-row claiming
// (task_id beats window, each row claims at most once, pad-zone rows are flagged).

let evSeq = 0;
function ev(over: Partial<TraceEvent>): TraceEvent {
  return { id: ++evSeq, ts: over.ts ?? 1000, type: over.type ?? 'llm', ...over } as TraceEvent;
}

let turnSeq = 0;
function turn(over: Partial<Turn>): Turn {
  const events = over.events ?? [];
  return {
    id: over.id ?? `t${++turnSeq}.test`,
    key: 'chat_1',
    chatId: 'chat_1',
    handle: '+15550001111',
    source: 'user',
    startedAt: over.startedAt ?? 1000,
    lastAt: over.lastAt ?? 2000,
    eventCount: events.length,
    agents: [],
    open: over.open ?? false,
    ...over,
    events,
  } as Turn;
}

let rowSeq = 0;
function row(over: Partial<UsageRowLite>): UsageRowLite {
  return {
    id: ++rowSeq,
    taskId: null,
    chatId: 'chat_1',
    handle: '+15550001111',
    role: 'convo',
    label: null,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    status: 'ok',
    latencyMs: 500,
    createdAt: 1500,
    ...over,
  };
}

// ── extractUserText ──────────────────────────────────────────────────────────

test('extractUserText prefers the uncapped turn:start text over the trigger', () => {
  const long = 'x'.repeat(600);
  const t = turn({
    trigger: long.slice(0, 400),
    events: [ev({ type: 'event', label: 'turn:start', detail: { text: long } })],
  });
  const got = extractUserText(t);
  assert.equal(got.text, long);
  assert.equal(got.truncated, false);
});

test('extractUserText flags a maxed-out trigger when no event text exists', () => {
  const t = turn({ trigger: 'y'.repeat(400), events: [] });
  const got = extractUserText(t);
  assert.equal(got.text?.length, 400);
  assert.equal(got.truncated, true);
});

test('extractUserText: short trigger is not flagged; no text at all → null', () => {
  assert.deepEqual(extractUserText(turn({ trigger: 'hi irises', events: [] })),
    { text: 'hi irises', truncated: false });
  assert.deepEqual(extractUserText(turn({ events: [] })), { text: null, truncated: false });
});

// ── extractBubbles ───────────────────────────────────────────────────────────

test('extractBubbles parses envelopes from user-facing events only, in ts order', () => {
  const t = turn({
    events: [
      ev({ ts: 30, label: 'composer', role: 'convo', response: '{"bubbles":[{"text":"found it"},{"text":"deadline is friday"}],"confidence_level":95}' }),
      ev({ ts: 10, label: 'classify', role: 'classify', response: 'RESPOND' }),
      ev({ ts: 20, label: 'convo', role: 'convo', response: '{"bubbles":[{"text":"one sec"}],"confidence_level":88}' }),
      ev({ ts: 25, label: 'ops:final', role: 'ops', response: 'ANSWER: deadline Fri.\nSOURCE: contract.' }),
      ev({ ts: 26, label: 'dossier_update', response: '{"facts":["tracking deadline"]}' }),
    ],
  });
  const got = extractBubbles(t);
  assert.deepEqual(got.map(g => g.agent), ['convo', 'composer']);
  assert.deepEqual(got[0].texts, ['one sec']);
  assert.deepEqual(got[1].texts, ['found it', 'deadline is friday']);
});

test('extractBubbles: plain-text response becomes one bubble; broken envelope renders nothing', () => {
  const plain = turn({ events: [ev({ label: 'judge', role: 'judge', response: 'heads up, call the title company first' })] });
  assert.deepEqual(extractBubbles(plain)[0].texts, ['heads up, call the title company first']);

  const broken = turn({ events: [ev({ label: 'convo', role: 'convo', response: '{"bubbles":[{"text":"trunc' })] });
  assert.deepEqual(extractBubbles(broken), []);
});

test('extractBubbles skips null/ERROR responses and empty envelopes', () => {
  const t = turn({
    events: [
      ev({ label: 'convo', role: 'convo', response: null }),
      ev({ label: 'fallfirm:progress:x', role: 'fallfirm', response: 'ERROR: openrouter length-starved' }),
      ev({ label: 'convo', role: 'convo', response: '{"bubbles":[]}' }),
      ev({ label: 'convo', role: 'convo', response: '{"bubbles":[{"text":"  "}]}' }),
    ],
  });
  assert.deepEqual(extractBubbles(t), []);
});

// ── claimUsageRows ───────────────────────────────────────────────────────────

const PAD = 90_000;

test('task_id claim beats the time window — late rows land on the delegating turn', () => {
  const t1 = turn({ id: 'tA', startedAt: 100_000, lastAt: 200_000, events: [ev({ type: 'delegation', taskId: 'task-1', ts: 150_000 })] });
  const t2 = turn({ id: 'tB', startedAt: 500_000, lastAt: 600_000, events: [] });
  // Created squarely inside t2's window, but carries t1's task id.
  const late = row({ taskId: 'task-1', createdAt: 550_000, role: 'ops', label: 'ops:final' });
  const { claims, unattributed } = claimUsageRows([t1, t2], [late], PAD);
  assert.equal(claims.get('tA')?.length, 1);
  assert.equal(claims.get('tA')![0].kind, 'exact');
  assert.equal(claims.get('tB'), undefined);
  assert.equal(unattributed.length, 0);
});

test('window rows partition across adjacent turns — each row claimed exactly once', () => {
  const t1 = turn({ id: 'tA', startedAt: 100_000, lastAt: 200_000 });
  const t2 = turn({ id: 'tB', startedAt: 220_000, lastAt: 300_000 });
  const inT1 = row({ createdAt: 150_000 });
  // In the overlap of t1's pad tail and t2's pad lead-in → newest-first scan gives it to t2.
  const boundary = row({ createdAt: 210_000 });
  const inT2 = row({ createdAt: 250_000 });
  const { claims, unattributed } = claimUsageRows([t1, t2], [inT1, boundary, inT2], PAD);
  const total = (claims.get('tA')?.length ?? 0) + (claims.get('tB')?.length ?? 0);
  assert.equal(total, 3);
  assert.equal(unattributed.length, 0);
  assert.equal(claims.get('tA')!.length, 1);
  assert.equal(claims.get('tB')!.length, 2);
  const b = claims.get('tB')!.find(c => c.row.id === boundary.id)!;
  assert.equal(b.approx, true, 'pad-zone claim must be flagged approx');
  assert.equal(claims.get('tA')![0].approx, false);
});

test('rows before every window / in a dead gap are unattributed', () => {
  const t1 = turn({ id: 'tA', startedAt: 1_000_000, lastAt: 1_100_000 });
  const t2 = turn({ id: 'tB', startedAt: 2_000_000, lastAt: 2_100_000 });
  const before = row({ createdAt: 500_000 });
  const gap = row({ createdAt: 1_500_000 });   // past t1.lastAt+pad, before t2.startedAt-pad
  const { claims, unattributed } = claimUsageRows([t1, t2], [before, gap], PAD);
  assert.equal(claims.size, 0);
  assert.equal(unattributed.length, 2);
});

test('an open last turn claims rows with no upper bound', () => {
  const t = turn({ id: 'tA', startedAt: 100_000, lastAt: 200_000, open: true });
  const wayLater = row({ createdAt: 900_000_000 });
  const { claims, unattributed } = claimUsageRows([t], [wayLater], PAD);
  assert.equal(claims.get('tA')?.length, 1);
  assert.equal(unattributed.length, 0);
});

test('duplicate PK ids from the window+task double-fetch are deduped', () => {
  const t = turn({ id: 'tA', startedAt: 100_000, lastAt: 200_000, events: [ev({ type: 'delegation', taskId: 'task-9', ts: 120_000 })] });
  const r = row({ id: 777, taskId: 'task-9', createdAt: 150_000 });
  const dup = { ...r };
  const { claims } = claimUsageRows([t], [r, dup], PAD);
  assert.equal(claims.get('tA')?.length, 1);
});

// ── aggregateTurnCost ────────────────────────────────────────────────────────

test('aggregateTurnCost groups by agent+model and matches estimateCostUsd', () => {
  const claimed = [
    { row: row({ role: 'ops', label: 'ops:step0', model: 'anthropic/claude-opus-4.8', inputTokens: 10_000, outputTokens: 500 }), kind: 'exact' as const, approx: false },
    { row: row({ role: 'ops', label: 'ops:final', model: 'anthropic/claude-opus-4.8', inputTokens: 4_000, outputTokens: 200 }), kind: 'exact' as const, approx: false },
    { row: row({ role: 'convo', label: 'convo', model: 'claude-haiku-4-5', inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 800 }), kind: 'window' as const, approx: false },
  ];
  const got = aggregateTurnCost(claimed);
  assert.equal(got.byAgent.length, 3);            // ops:step0 / ops:final / convo
  assert.equal(got.calls, 3);
  assert.equal(got.inputTokens, 16_000);
  assert.equal(got.outputTokens, 800);
  assert.equal(got.attribution, 'mixed');
  const expected =
    estimateCostUsd('anthropic/claude-opus-4.8', { inputTokens: 10_000, outputTokens: 500 })
    + estimateCostUsd('anthropic/claude-opus-4.8', { inputTokens: 4_000, outputTokens: 200 })
    + estimateCostUsd('claude-haiku-4-5', { inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 800 });
  assert.ok(Math.abs(got.costUsd - expected) < 1e-9);
  const convo = got.byAgent.find(a => a.agent === 'convo')!;
  assert.equal(convo.exact, false);
});

test('aggregateTurnCost: error rows count as errors with their (zero) tokens; empty → none', () => {
  const claimed = [
    { row: row({ status: 'error', inputTokens: 0, outputTokens: 0 }), kind: 'window' as const, approx: true },
  ];
  const got = aggregateTurnCost(claimed);
  assert.equal(got.errors, 1);
  assert.equal(got.calls, 0);
  assert.equal(got.approx, true);
  assert.equal(got.attribution, 'window');
  assert.equal(aggregateTurnCost([]).attribution, 'none');
});

// ── assembleTurnCards ────────────────────────────────────────────────────────

test('assembleTurnCards produces oldest-first cards with cost + unattributed rollup', () => {
  const t1 = turn({
    id: 'tA', startedAt: 100_000, lastAt: 200_000, trigger: 'hey irises',
    events: [
      ev({ type: 'event', label: 'turn:start', ts: 100_000, detail: { text: 'hey irises' } }),
      ev({ label: 'convo', role: 'convo', ts: 110_000, response: '{"bubbles":[{"text":"hi!"}],"confidence_level":90}' }),
    ],
  });
  const t2 = turn({ id: 'tB', startedAt: 400_000, lastAt: 500_000, trigger: 'thanks', events: [] });
  const rows = [
    row({ createdAt: 120_000, inputTokens: 1000, outputTokens: 50 }),
    row({ createdAt: 900_000_000 }),  // orphan → unattributed
  ];
  const got = assembleTurnCards([t2, t1], rows, PAD);
  assert.deepEqual(got.cards.map(c => c.id), ['tA', 'tB']);
  assert.equal(got.cards[0].userText, 'hey irises');
  assert.deepEqual(got.cards[0].bubbles[0].texts, ['hi!']);
  assert.equal(got.cards[0].cost.inputTokens, 1000);
  assert.equal(got.cards[1].cost.attribution, 'none');
  assert.equal(got.unattributed.calls, 1);
  assert.ok(got.unattributed.costUsd > 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, emptyPatterns, mergeGrouping, parseGrouping } from '../site/core/patterns.js';
import { modeGrid } from '../site/core/stats.js';
import { draftTest, suggestHandling, testsJsonl, testSummary, updateTest } from '../site/core/tasks.js';

// Fictional conversations only.
const trace = (id, flags = [], extra = {}) => ({ id, kind: 'message', at: '2026-10-01T08:00:00Z', flags,
  input: { label: 'Customer', text: `Message ${id}` }, output: { label: 'Assistant', text: `Reply ${id}` }, context: [], ...extra });

function setup({ failFlags = [], passFlags = [], fails = 4, passes = 4, mode = {} }) {
  const traces = [...Array.from({ length: fails }, (_, i) => trace(`f${i}`, failFlags)), ...Array.from({ length: passes }, (_, i) => trace(`p${i}`, passFlags))];
  const notes = traces.map((item) => ({ id: `n-${item.id}`, traceId: item.id, anchor: 'trace', text: `note on ${item.id}` }));
  const patterns = { ...emptyPatterns(), failureModes: [{ key: 'two-requests', name: 'Two requests, one confirmed', definition: 'Only one of two requests is confirmed',
    noteIds: notes.filter((note) => note.traceId.startsWith('f')).map((note) => note.id), ...mode }] };
  const state = { verdicts: Object.fromEntries(traces.map((item) => [item.id, item.id.startsWith('f') ? 'bad' : 'good'])), notes, grid: {}, transcription: {} };
  return { traces, state, patterns, grid: modeGrid({ traces, state, patterns }) };
}

test('a pattern where code overruled the AI is suggested as a fix, not something to measure', () => {
  const { traces, patterns, grid } = setup({ failFlags: ['reply_overwritten', 'partial_confirmation'] });
  const suggestion = suggestHandling({ mode: patterns.failureModes[0], grid, traces, codeFaultFlags: ['reply_overwritten'] });
  assert.equal(suggestion.choice, 'fix');
  assert.match(suggestion.why, /In 4 of 4 examples, code overruled/);
});

test('a pattern a warning flag already spots is suggested as a code check', () => {
  const { traces, patterns, grid } = setup({ failFlags: ['partial_confirmation'] });
  const suggestion = suggestHandling({ mode: patterns.failureModes[0], grid, traces });
  assert.deepEqual([suggestion.choice, suggestion.flag], ['code_check', 'partial_confirmation']);
  // A flag that also fires on good replies doesn't count.
  const noisy = setup({ failFlags: ['partial_confirmation'], passFlags: ['partial_confirmation'] });
  assert.notEqual(suggestHandling({ mode: noisy.patterns.failureModes[0], grid: noisy.grid, traces: noisy.traces }).choice, 'code_check');
});

test('otherwise the grouping model’s suggestion is used, and fixing first is the default', () => {
  const judged = setup({ mode: { handleSuggestion: 'judge', handleWhy: 'Whether a reply is too long is a judgement call.' } });
  assert.deepEqual(suggestHandling({ mode: judged.patterns.failureModes[0], grid: judged.grid, traces: judged.traces }),
    { choice: 'judge', why: 'Whether a reply is too long is a judgement call.' });
  const plain = setup({ fails: 1 });
  assert.equal(suggestHandling({ mode: plain.patterns.failureModes[0], grid: plain.grid, traces: plain.traces }).choice, 'fix');
});

test('the grouping model is asked how to handle each pattern, and the reviewer’s choice survives regrouping', () => {
  const parsed = parseGrouping(JSON.stringify({ failure_modes: [{ key: 'too-long', name: 'Too long', definition: 'd', note_ids: ['n1'], handle: 'judge', handle_why: 'Needs judgement' },
    { key: 'odd', name: 'Odd', definition: 'd', note_ids: ['n1'], handle: 'banana' }] }));
  assert.equal(parsed.failureModes[0].handleSuggestion, 'judge');
  assert.ok(!('handleSuggestion' in parsed.failureModes[1]));
  let patterns = mergeGrouping({ previous: emptyPatterns(), result: parsed, notes: [{ id: 'n1' }] });
  patterns = applyEdit(patterns, { action: 'handle', key: 'too-long', choice: 'code_check' });
  assert.equal(patterns.failureModes[0].handle.choice, 'code_check');
  assert.equal(patterns.failureModes[0].locked, false, 'choosing how to handle it does not lock the name');
  const again = mergeGrouping({ previous: patterns, result: parsed, notes: [{ id: 'n1' }] });
  assert.equal(again.failureModes[0].handle.choice, 'code_check');
  assert.ok(!('handle' in applyEdit(again, { action: 'handle', key: 'too-long', choice: null }).failureModes[0]));
});

test('a bad conversation becomes a capability test case and a good one a regression case', () => {
  const { traces, state, patterns, grid } = setup({});
  const failing = draftTest({ trace: traces[0], state, patterns, grid });
  assert.equal(failing.kind, 'capability');
  assert.equal(failing.modeKey, 'two-requests');
  assert.equal(failing.shouldDo, 'Pass if the reply avoids this problem (Two requests, one confirmed): Only one of two requests is confirmed');
  assert.equal(failing.input.text, 'Message f0');
  const passing = draftTest({ trace: traces.at(-1), state, patterns, grid });
  assert.equal(passing.kind, 'regression');
  assert.equal(passing.shouldDo, 'Pass if the reply does what this one did: “Reply p3”');
  const judged = draftTest({ trace: traces[0], state, grid,
    patterns: { ...patterns, failureModes: [{ ...patterns.failureModes[0], handle: { choice: 'judge' } }] } });
  assert.equal(judged.check, 'judge');
});

test('only allowed fields change, and pass rates come from the latest re-check', () => {
  const base = { id: 't1', traceId: 'f0', kind: 'capability', input: { text: 'x' }, results: [], expected: {} };
  const edited = updateTest(base, { kind: 'banana', traceId: 'evil', shouldDo: '  Pass if both are confirmed ', expected: { intent: 'refund_status', topic: '' } });
  assert.deepEqual([edited.kind, edited.traceId, edited.shouldDo, edited.expected], ['capability', 'f0', 'Pass if both are confirmed', { intent: 'refund_status' }]);
  const tests = [
    { ...base, id: 'a', kind: 'regression', results: [{ pass: true }] },
    { ...base, id: 'b', kind: 'regression', results: [{ pass: true }, { pass: false }] },
    { ...base, id: 'c', kind: 'capability', results: [{ pass: true }] },
    { ...base, id: 'd', kind: 'capability' }
  ];
  const summary = testSummary(tests);
  assert.deepEqual(summary.regression, { count: 2, checked: 2, passing: 1 });
  assert.deepEqual(summary.capability, { count: 2, checked: 1, passing: 1 });
  assert.equal(summary.promotable, 1);
  assert.match(summary.warnings.join(' '), /1 regression case failing/);
  assert.match(testSummary([{ ...base, kind: 'regression' }]).warnings[0], /too easy/);
});

test('exports: JSONL for any eval runner', () => {
  const patterns = { failureModes: [{ key: 'k', name: 'Wrong day' }] };
  const tests = [
    { id: 't1', traceId: 'm-1', kind: 'capability', modeKey: 'k', input: { text: 'When is my payout\non Saturday?' }, context: [], startingState: '',
      shouldDo: 'Pass if it answers for Saturday', check: 'exact', expected: { topic: 'payouts' }, results: [] },
    { id: 't2', traceId: 'm-2', kind: 'regression', modeKey: null, input: { text: 'Hi' }, context: [], startingState: '', shouldDo: 'Greets', check: 'by_hand', expected: {}, results: [{ pass: true }] }
  ];
  const lines = testsJsonl(tests, { patterns, traceLink: (id) => `http://localhost/${id}` }).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].pattern, 'Wrong day');
  assert.equal(lines[0].pass_if, 'Pass if it answers for Saturday');
  assert.equal(lines[1].last_result, 'pass');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdit, buildGroupingPrompt, emptyPatterns, groupNotes, mergeGrouping, parseGrouping } from '../site/core/patterns.js';
import { modeGrid, nearbyTraces, normalizeReleases, pickNext, releasesFromTraces, saturation, trendsByRelease, withOutlierChips } from '../site/core/stats.js';

// Fictional conversations only.
const trace = (id, extra = {}) => ({ id, kind: 'message', at: '2026-09-25T08:00:00Z', input: { label: 'Customer', text: `message ${id}` },
  output: { label: 'Assistant', text: `reply ${id}` }, steps: [], flags: [], metrics: {}, dims: { kind: 'message' }, ...extra });

test('outlier chips mark the slowest conversations', () => {
  const traces = withOutlierChips([1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map((latency, index) => trace(`t${index}`, { metrics: { latency } })));
  assert.deepEqual(traces.at(-1).chips.map((chip) => chip.text), ['30 s · slower than 90%']);
  assert.deepEqual(traces[0].chips, []);
});

test('the grid takes notes first and the reviewer’s overrides second', () => {
  const traces = [trace('t1'), trace('t2'), trace('t3')];
  const state = { verdicts: { t3: 'good' }, notes: [{ id: 'n1', traceId: 't1' }, { id: 'n2', traceId: 't2' }], grid: { t2: { said: false } } };
  const patterns = { failureModes: [{ key: 'said', name: 'Says done', noteIds: ['n1', 'n2'] }] };
  const grid = modeGrid({ traces, state, patterns });
  assert.deepEqual(grid.rows.map((row) => row.cells.said), [{ value: true, source: 'notes' }, { value: false, source: 'you' }, { value: false, source: null }]);
  assert.deepEqual(grid.prevalence.said, { count: 1, of: 3, pct: 33 });
  const trends = trendsByRelease({ grid, releases: [{ name: '2026-09-24', at: '2026-09-24T00:00:00Z' }, { name: '2026-09-26', at: '2026-09-26T00:00:00Z' }] });
  assert.deepEqual(trends, [{ release: '2026-09-24', reviewed: 3, modes: { said: { count: 1, pct: 33 } } }]);
});

test('review next picks from the kind of conversation reviewed least', () => {
  const traces = [trace('a'), trace('b'), trace('v', { dims: { kind: 'message', channel: 'voice', role: 'merchant' } })];
  const state = { verdicts: { a: 'good' }, notes: [] };
  assert.equal(pickNext({ traces, state, strategy: 'variety', random: () => 0 }), 'v');
  assert.equal(pickNext({ traces, state, strategy: 'slice', slice: [traces[1], traces[2]] }), 'b');
  assert.equal(pickNext({ traces, state: { verdicts: { a: 1, b: 1, v: 1 }, notes: [] } }), null);
});

test('the grouping prompt carries notes, locked patterns and exclusions, not whole conversations', () => {
  const patterns = { ...emptyPatterns(), failureModes: [{ key: 'said', name: 'Says done', definition: 'Claims a save.', locked: true, noteIds: [],
    feedback: [{ text: 'This is about state, not wording' }] }], excluded: [{ modeKey: 'said', noteId: 'n2' }] };
  const { system, user } = buildGroupingPrompt({ domain: { description: 'A payments support assistant.' }, patterns,
    notes: [{ id: 'n1', traceId: 't1', text: 'Says refunded but it is pending', quote: 'refunded' }],
    traces: [{ id: 't1', input: { text: 'Where is my refund' }, output: { text: 'A long secret reply' } }] });
  assert.match(system, /5 to 8 distinct failure patterns/);
  assert.match(user, /LOCKED/);
  assert.match(user, /reviewer feedback: This is about state, not wording/);
  assert.match(user, /never include notes: n2/);
  assert.match(user, /"message":"Where is my refund"/);
  assert.doesNotMatch(user, /A long secret reply/);
});

test('merging a fresh grouping keeps locked names and respects exclusions', () => {
  const previous = { ...emptyPatterns(), excluded: [{ modeKey: 'said', noteId: 'n2' }],
    failureModes: [{ key: 'said', name: 'Says done', definition: 'Mine.', locked: true, noteIds: ['n1'], feedback: [] }, { key: 'old', name: 'Old', noteIds: ['n3'] }] };
  const result = parseGrouping('```json\n{"failure_modes":[{"key":"said","name":"Renamed","definition":"Theirs","note_ids":["n1","n2","zzz"]},{"name":"Two requests","note_ids":["n3"]}],"good_patterns":[],"unassigned_note_ids":["n4"]}\n```');
  const notes = ['n1', 'n2', 'n3', 'n4'].map((id) => ({ id }));
  const merged = mergeGrouping({ previous, result, notes, now: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(merged.failureModes.map((mode) => [mode.key, mode.name, mode.noteIds]), [['said', 'Says done', ['n1']], ['two-requests', 'Two requests', ['n3']]]);
  assert.equal(merged.history.at(-1).newModes, 1);
  assert.deepEqual(merged.unassigned, ['n4']);
  assert.equal(merged.lastRunNoteCount, 4);
});

test('reviewer edits: merge, remove an example, split and delete', () => {
  let patterns = { ...emptyPatterns(), failureModes: [{ key: 'a', name: 'A', noteIds: ['n1'] }, { key: 'b', name: 'B', noteIds: ['n2', 'n3'] }] };
  patterns = applyEdit(patterns, { action: 'merge', key: 'b', into: 'a' });
  assert.deepEqual(patterns.failureModes.map((mode) => [mode.key, mode.noteIds, mode.locked]), [['a', ['n1', 'n2', 'n3'], true]]);
  patterns = applyEdit(patterns, { action: 'remove-note', key: 'a', noteId: 'n3' });
  assert.deepEqual(patterns.failureModes[0].noteIds, ['n1', 'n2']);
  assert.deepEqual(patterns.excluded, [{ modeKey: 'a', noteId: 'n3' }]);
  patterns = applyEdit(patterns, { action: 'split', key: 'a', text: 'saving vs notifying' });
  assert.equal(patterns.failureModes[0].locked, false);
  assert.match(patterns.failureModes[0].feedback.at(-1).text, /Split this pattern: saving vs notifying/);
  assert.equal(applyEdit(patterns, { action: 'delete', key: 'a' }).failureModes.length, 0);
});

test('grouping sends only to zero-data-retention providers', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"failure_modes":[{"name":"Says done","note_ids":["n1"]}],"good_patterns":[]}' } }] }) };
  };
  const result = await groupNotes({ domain: { description: 'x' }, notes: [{ id: 'n1', traceId: 't1', text: 'bad' }], traces: [], patterns: emptyPatterns(), apiKey: 'k', fetchImpl });
  assert.deepEqual(sent.provider, { zdr: true, data_collection: 'deny' });
  assert.equal(result.failureModes[0].name, 'Says done');
  await assert.rejects(groupNotes({ domain: {}, notes: [{ id: 'n1' }], traces: [], patterns: emptyPatterns(), apiKey: '' }), /No OpenRouter key yet/);
});

test('saturation needs quiet groupings and enough notes', () => {
  const notes = Array.from({ length: 16 }, (_, index) => ({ createdAt: `2026-09-30T00:${String(index).padStart(2, '0')}:00Z` }));
  const patterns = { history: [{ at: '2026-09-29T00:00:00Z', newModes: 3 }, { at: '2026-09-30T01:00:00Z', newModes: 0 }, { at: '2026-09-30T02:00:00Z', newModes: 0 }] };
  assert.deepEqual(saturation(patterns, { notes }), { quietRuns: 2, notesSinceNewMode: 16, likelySaturated: true });
});

test('automatic checks: failed tools, figures from nowhere, and real outliers only', async () => {
  const { checkSummary, runChecks, withChecks } = await import('../site/core/checks.js');
  const result = (item, key) => runChecks(item).find((check) => check.key === key);
  const failedTool = { section: 'tool', label: 'Look up the refund', fn: 'get_refund', text: 'failed · timed out', error: true };
  const ignored = trace('a', { steps: [failedTool], output: { text: 'Your refund of £75.00 is on its way.' } });
  assert.equal(result(ignored, 'check_tool_failure').result, 'fail');
  assert.match(result(ignored, 'check_tool_failure').why, /“Look up the refund” failed, but the reply carries on/);
  assert.equal(result(trace('b', { steps: [failedTool], output: { text: 'Sorry, I couldn’t look that up just now.' } }), 'check_tool_failure').result, 'pass');
  assert.equal(result(trace('c', { steps: [failedTool, { section: 'tool', fn: 'get_refund', text: 'status: pending' }], output: { text: 'It is pending.' } }), 'check_tool_failure').result, 'pass');
  assert.equal(result(trace('d'), 'check_tool_failure').result, 'na');

  assert.deepEqual([result(ignored, 'check_numbers').result, result(ignored, 'check_numbers').why], ['fail', '“75.00” is in the reply but not in any tool result or message.']);
  const grounded = trace('e', { input: { text: 'Order 5521?' }, steps: [{ section: 'tool', text: 'status: pending · £1,042.50 · fee 2.4%' }],
    output: { text: 'Order 5521: £1042.50 is pending, fee 2.4%. It usually takes 5 to 10 days.' } });
  assert.equal(result(grounded, 'check_numbers').result, 'pass', 'commas and small everyday numbers don’t trip it');
  assert.equal(result(trace('f', { steps: [{ section: 'reasoning', text: 'I think the fee is 3.2%' }], output: { text: 'The fee is 3.2%.' } }), 'check_numbers').result, 'fail', 'the AI’s own reasoning is not a source');
  assert.equal(result(trace('g', { steps: [], output: { text: 'It costs £400.' } }), 'check_numbers').result, 'na', 'nothing to compare with');
  assert.equal(result(trace('h', { steps: [{ section: 'tool', text: 'ok' }], output: { text: 'All sorted.' } }), 'check_numbers').result, 'na');
  assert.equal(result(trace('i', { steps: [{ section: 'tool', text: '12 events found' }], output: { text: 'Swimming is at 4:15.' } }), 'check_numbers').result, 'na', 'a tool that only recorded a summary gives nothing to compare with');
  assert.equal(result(trace('j', { steps: [{ section: 'tool', text: 'Swimming 3:30 to 4:00' }], output: { text: 'Swimming is at 4:15.' } }), 'check_numbers').result, 'fail', 'a recorded result with figures is still checked');

  const timed = withChecks(withOutlierChips([4, 4.2, 4.4, 4.6, 4.8, 5, 5.2, 5.4, 5.6, 6, 19].map((latency, index) => trace(`t${index}`, { metrics: { latency } }))));
  assert.deepEqual(timed.filter((item) => item.flags.includes('slow')).map((item) => item.metrics.latency), [19], 'only the real outlier fails, not whoever is in the top tenth');
  assert.equal(timed[0].checks.find((check) => check.key === 'costly').result, 'na');
  assert.deepEqual(checkSummary(withChecks([ignored, grounded])).map((row) => [row.key, row.failed, row.passed, row.na]).slice(0, 2), [['check_tool_failure', 1, 0, 1], ['check_numbers', 1, 1, 0]]);
});

test('around this time: the same person’s conversations within a few minutes, oldest first', () => {
  const make = (id, at, person, text, group = 'Shop 1') => ({ id, at, person, group, input: { label: 'Chat', text }, output: { text: 'ok' } });
  const list = [
    make('a', '2026-09-01T09:00:00Z', 'Sam', 'Where is my order?'),
    make('b', '2026-09-01T09:00:02Z', 'Sam', 'It was a lamp'),
    make('c', '2026-09-01T09:00:28Z', 'Sam', 'Order 104'),
    make('d', '2026-09-01T09:00:10Z', 'Alex', 'Someone else, same minute'),
    make('e', '2026-09-01T09:20:00Z', 'Sam', 'Much later'),
    make('f', '2026-09-01T09:00:05Z', 'Sam', 'Same name, another shop', 'Shop 2')];
  const near = nearbyTraces(list, list[1]);
  assert.deepEqual(near.map((item) => [item.id, item.seconds, item.current]), [['a', -2, false], ['b', 0, true], ['c', 26, false]]);
  assert.equal(near[0].text, 'Where is my order?');
  assert.deepEqual(nearbyTraces(list, list[4]), [], 'nothing else nearby');
  assert.deepEqual(nearbyTraces(list, { id: 'x', at: '2026-09-01T09:00:00Z', input: { text: 'no person or group' } }), []);
  assert.deepEqual(nearbyTraces(list, { ...list[0], at: 'not a time' }), []);
  const many = Array.from({ length: 20 }, (_, index) => make(`m${String(index).padStart(2, '0')}`, `2026-09-01T10:00:${String(index).padStart(2, '0')}Z`, 'Sam', `message ${index}`));
  const window = nearbyTraces(many, many[10]);
  assert.equal(window.length, 9);
  assert.ok(window.some((item) => item.current), 'the current conversation stays in view when there are many');
});

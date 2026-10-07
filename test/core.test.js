import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdit, buildGroupingPrompt, emptyPatterns, groupNotes, mergeGrouping, parseGrouping } from '../site/core/patterns.js';
import { modeGrid, normalizeReleases, pickNext, releasesFromTraces, saturation, trendsByRelease, withOutlierChips } from '../site/core/stats.js';

// Fictional conversations only.
const trace = (id, extra = {}) => ({ id, kind: 'message', at: '2026-09-25T08:00:00Z', input: { label: 'Customer', text: `message ${id}` },
  output: { label: 'Assistant', text: `reply ${id}` }, steps: [], flags: [], metrics: {}, dims: { kind: 'message' }, ...extra });

test('outlier chips mark the slowest conversations', () => {
  const traces = withOutlierChips([1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map((latency, index) => trace(`t${index}`, { metrics: { latency } })));
  assert.deepEqual(traces.at(-1).chips.map((chip) => chip.text), ['30 s · slower than 90%']);
  assert.ok(traces.at(-1).flags.includes('slow'));
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

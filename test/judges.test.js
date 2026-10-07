import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCriterion, draftPrompt, flagAlignment, improvePrompt, labelCounts, labelsFor, leakWarnings, parseVerdict, runJudge, scoreJudge, setFor, verdictLabel, wilson } from '../site/core/judges.js';

const trace = (id, extra = {}) => ({ id, kind: 'message', input: { label: 'Customer', text: `message ${id}` }, output: { label: 'Assistant', text: `reply ${id}` }, steps: [], flags: [], ...extra });

test('the split is stable per conversation and roughly 20/40/40', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `m-${index}`);
  const sets = ids.map(setFor);
  assert.deepEqual(sets, ids.map(setFor));
  const share = (name) => sets.filter((set) => set === name).length / ids.length;
  assert.ok(Math.abs(share('train') - 0.2) < 0.05 && Math.abs(share('dev') - 0.4) < 0.05 && Math.abs(share('test') - 0.4) < 0.05);
});

test('labels come from the grid: the failure present means fail', () => {
  const grid = { rows: [{ traceId: 'a', cells: { said: { value: true } } }, { traceId: 'b', cells: { said: { value: false } } }] };
  const labels = labelsFor(grid, 'said');
  assert.deepEqual(labels.map((item) => item.label), ['fail', 'pass']);
  const counts = labelCounts(labels);
  assert.equal(counts.fail, 1);
  assert.equal(counts.needFail, 19);
});

test('scores in plain words: catches failures and leaves good replies alone', () => {
  const rows = [
    ...Array(6).fill({ human: 'fail', judge: 'fail' }), ...Array(6).fill({ human: 'fail', judge: 'pass' }),
    ...Array(19).fill({ human: 'pass', judge: 'pass' }), ...Array(9).fill({ human: 'pass', judge: 'fail' }), { human: 'pass', judge: null }];
  const score = scoreJudge(rows);
  assert.equal(score.catches.rate, 0.5);
  assert.equal(score.leavesAlone.count, 19);
  assert.equal(score.falseAlarms, 9);
  assert.equal(score.unanswered, 1);
  assert.deepEqual(score.catches.range.map((value) => Math.round(value * 100)), [25, 75]);
  assert.equal(verdictLabel(score), 'Below the target');
  // The squirrel judge: passes everything, 95% agreement, catches nothing.
  const squirrel = scoreJudge([...Array(95).fill({ human: 'pass', judge: 'pass' }), ...Array(5).fill({ human: 'fail', judge: 'pass' })]);
  assert.equal(squirrel.agreement, 0.95);
  assert.equal(squirrel.catches.rate, 0);
});

test('wilson intervals widen with fewer examples', () => {
  const [lowSmall, highSmall] = wilson(4, 5);
  const [lowBig, highBig] = wilson(80, 100);
  assert.ok(highSmall - lowSmall > highBig - lowBig);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('reads the verdict from the last line', () => {
  assert.deepEqual(parseVerdict('The reply claims a save.\nIt did not pass the check.\n**Verdict: Fail**').judge, 'fail');
  assert.equal(parseVerdict('Looks fine\nPass').judge, 'pass');
  assert.equal(parseVerdict('No verdict here').judge, null);
});

test('the first draft only uses example-set conversations', () => {
  const traces = Array.from({ length: 30 }, (_, index) => trace(`t${index}`));
  const labels = traces.map((item, index) => ({ traceId: item.id, label: index % 3 ? 'pass' : 'fail', set: setFor(item.id) }));
  const mode = { name: 'Says done', definition: 'Claims a save that did not happen.', noteIds: ['n1', 'n2'] };
  const trainFail = labels.find((item) => item.set === 'train' && item.label === 'fail');
  const heldFail = labels.find((item) => item.set !== 'train' && item.label === 'fail');
  const notes = [{ id: 'n1', traceId: trainFail.traceId, text: 'Said Saved, nothing saved' }, { id: 'n2', traceId: heldFail.traceId, text: 'SECRET held-out note' }];
  const prompt = draftPrompt({ domain: { description: 'A payments support assistant.' }, mode, criterion: defaultCriterion(mode), labels, traces, notes });
  assert.match(prompt, /## Criterion\nPass if the reply avoids this problem \(Says done\)/);
  assert.match(prompt, /Said Saved, nothing saved/);
  assert.doesNotMatch(prompt, /SECRET held-out note/);
  for (const item of labels.filter((entry) => entry.set !== 'train')) assert.doesNotMatch(prompt, new RegExp(`message ${item.traceId}\\b`));
  assert.match(prompt, /last line as exactly "Pass" or "Fail"/);
});

test('warns when a prompt quotes a held-out conversation, not shared text', () => {
  const unique = 'the residential trip is on the twenty eighth of october and everyone comes back next morning';
  const traces = [trace('held', { input: { text: unique } }), trace('ex', { input: { text: 'a common greeting that appears in the examples set as well everywhere' } })];
  const labels = [{ traceId: 'held', label: 'fail', set: 'dev' }, { traceId: 'ex', label: 'pass', set: 'train' }];
  assert.deepEqual(leakWarnings(`Example: ${unique}`, traces, labels), ['held']);
  assert.deepEqual(leakWarnings('General rule only.', traces, labels), []);
});

test('code checks are scored against the same labels', () => {
  const traces = [trace('a', { flags: ['said_saved_nothing_saved'] }), trace('b', { flags: ['said_saved_nothing_saved'] }), trace('c'), trace('d')];
  const labels = [{ traceId: 'a', label: 'fail' }, { traceId: 'b', label: 'pass' }, { traceId: 'c', label: 'fail' }, { traceId: 'd', label: 'pass' }];
  const [check] = flagAlignment({ traces, labels });
  assert.equal(check.flag, 'said_saved_nothing_saved');
  assert.equal(check.catches.count, 1);
  assert.equal(check.leavesAlone.count, 1);
});

test('runs the judge with zero-data-retention providers and keeps the human label', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    const fail = body.messages[1].content.includes('reply a');
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: `critique\nVerdict: ${fail ? 'Fail' : 'Pass'}` } }], usage: { cost: 0.001 } }) };
  };
  const { rows, cost } = await runJudge({ prompt: 'p', traces: [trace('a'), trace('b')], labels: [{ traceId: 'a', label: 'fail' }, { traceId: 'b', label: 'fail' }], apiKey: 'k', fetchImpl });
  assert.deepEqual(rows.map((row) => [row.traceId, row.human, row.judge]), [['a', 'fail', 'fail'], ['b', 'fail', 'pass']]);
  assert.ok(sent.every((body) => body.provider.zdr === true && body.provider.data_collection === 'deny'));
  assert.equal(Math.round(cost * 1000), 2);
  const failed = await runJudge({ prompt: 'p', traces: [trace('a')], labels: [], apiKey: 'k', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(failed.rows[0].judge, null);
  assert.match(failed.rows[0].critique, /Judge error: down/);
});

test('the improver needs a tuning run and returns a new prompt', async () => {
  const judge = { criterion: 'c' };
  await assert.rejects(improvePrompt({ judge, version: { prompt: 'p', results: {} }, traces: [], labels: [], apiKey: 'k' }), /tuning set first/);
  const version = { prompt: 'old', results: { dev: { rows: [{ traceId: 'a', human: 'fail', judge: 'pass', critique: 'looked fine' }] } } };
  let user = '';
  const fetchImpl = async (url, options) => {
    user = JSON.parse(options.body).messages[1].content;
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"prompt":"new prompt","change_summary":"stricter"}' } }] }) };
  };
  const result = await improvePrompt({ judge, version, traces: [trace('a')], labels: [{ traceId: 'a', label: 'fail', set: 'dev' }], apiKey: 'k', fetchImpl });
  assert.equal(result.prompt, 'new prompt');
  assert.match(user, /Human said fail, judge said pass/);
});

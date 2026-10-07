import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkTraces, createEngine, memoryStore } from '../site/core/engine.js';
import { sentLog } from '../site/core/openrouter.js';
import { sha256Hex } from '../site/core/sha256.js';
import { normalizeReleases, releasesFromTraces } from '../site/core/stats.js';
import { buildDemo } from '../scripts/build-demo.mjs';
import paymentsSpec from '../scripts/demo/payments.mjs';
import healthcareSpec from '../scripts/demo/healthcare.mjs';

const packs = await Promise.all(['payments', 'healthcare', 'general'].map(async (id) => JSON.parse(await readFile(new URL(`../site/packs/${id}.json`, import.meta.url), 'utf8'))));
const engineWith = (settings = {}) => createEngine({ store: memoryStore(), packs, settings: async () => settings, linkBase: 'https://example.test/' });
// Fictional conversations only.
const traces = (count) => Array.from({ length: count }, (_, index) => ({ id: `t-${index + 1}`, at: `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00Z`,
  input: { label: 'Customer', text: `Where is refund ${index + 1}?` }, output: { label: 'Assistant', text: `Refund ${index + 1} is pending.` } }));

test('the built-in SHA-256 matches Node’s, so the judge split is the same everywhere', () => {
  for (const text of ['', 'abc', 'judge-split:pay-001', `é漢字 ${'x'.repeat(300)}`]) assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
});

test('a traces file is checked before it is saved, with a plain reason when it is wrong', () => {
  assert.throws(() => checkTraces({ hello: 1 }), /not a list of traces/);
  assert.throws(() => checkTraces([{ input: 'a', output: 'b' }]), /has no "id"/);
  assert.throws(() => checkTraces([{ id: 1, input: 'a' }]), /has no "output"/);
  assert.throws(() => checkTraces([{ id: 1, input: 'a', output: 'b' }, { id: '1', input: 'a', output: 'b' }]), /share the id/);
  assert.equal(checkTraces({ traces: traces(2) }).length, 2);
});

test('load traces, review them, and reload a newer file without losing notes', async () => {
  const engine = engineWith();
  let data = await engine.action('general', 'import-traces', { traces: traces(3) });
  assert.equal(data.traces.length, 3);
  assert.equal(data.grouping.available, false);
  data = await engine.action('general', 'note', { traceId: 't-1', anchor: 'output', quote: 'pending', start: 12, end: 19, text: 'Should give a typical range' });
  data = await engine.action('general', 'verdict', { traceId: 't-2', verdict: 'good' });
  assert.equal(data.reviewed, 2);
  await assert.rejects(engine.action('general', 'note', { traceId: 'nope', text: 'x' }), /Unknown trace/);
  data = await engine.action('general', 'import-traces', { traces: traces(5) });
  assert.deepEqual([data.traces.length, data.state.notes.length, data.reviewed], [5, 1, 2]);
  data = await engine.action('general', 'import-traces', { traces: [{ id: 'extra', input: 'Hi', output: 'Hello' }], mode: 'add' });
  assert.equal(data.traces.length, 6);
  assert.deepEqual((await engine.listDomains()).map((item) => [item.id, item.traces]), [['payments', 0], ['healthcare', 0], ['general', 6]]);
  assert.equal((await engine.query('general', 'next', { strategy: 'slice' })).id, 't-3');
  await assert.rejects(engine.action('nowhere', 'verdict', {}), /Unknown domain/);
});

test('the demo loads as a backup, fills every tab, and comes back out the same', async () => {
  const engine = engineWith();
  const demo = buildDemo(paymentsSpec);
  const data = await engine.action('payments', 'restore', { bundle: demo });
  assert.equal(data.traces.length, 40);
  assert.ok(data.state.notes.length >= 20 && data.patterns.failureModes.length === 5 && data.tests.length === 6);
  assert.equal(data.grid.rows.length, data.reviewed);
  assert.ok(data.trends.length === 3, 'three release rows');
  assert.equal(data.trends.at(-1).modes['default-terms'].pct, 0, 'the pattern fixed in v1.2 no longer appears');
  assert.equal(data.handling['pending-as-done'].choice, 'code_check');
  assert.equal(data.judges[0].versions[1].dev.score.catches.rate, 1);
  assert.ok(data.saturation.likelySaturated);
  const [type, text] = await engine.exportFile('payments', 'backup.json');
  assert.equal(type, 'application/json');
  assert.deepEqual(JSON.parse(text).state, demo.state);
  for (const name of ['notes.csv', 'grid.csv', 'tests.csv', 'tests.jsonl', 'failure-modes.md', 'judges.csv', 'judge-scores.csv']) {
    const file = await engine.exportFile('payments', name);
    assert.ok(file[1].length > 100, name);
  }
  assert.match((await engine.exportFile('payments', 'notes.csv'))[1], /https:\/\/example\.test\/#\/payments\/review\/pay-001/);
  assert.equal(await engine.exportFile('payments', 'nope.csv'), null);
  await assert.rejects(engine.action('payments', 'restore', { bundle: { traces: [] } }), /not an EvalDesk backup/);
  assert.equal((await engine.action('payments', 'clear', {})).traces.length, 0);
});

test('demo conversations are complete and every quoted note sits in its reply', () => {
  for (const spec of [paymentsSpec, healthcareSpec]) {
    const demo = buildDemo(spec);
    assert.equal(new Set(demo.traces.map((trace) => trace.id)).size, 40);
    const byId = new Map(demo.traces.map((trace) => [trace.id, trace]));
    for (const note of demo.state.notes) if (note.quote) assert.equal(byId.get(note.traceId).output.text.slice(note.start, note.end), note.quote);
    for (const mode of demo.patterns.failureModes) assert.ok(mode.noteIds.length >= 2, `${mode.name} has examples`);
    for (const flag of new Set(demo.traces.flatMap((trace) => trace.flags))) assert.ok(spec.pack.flags[flag], `flag ${flag} has a label`);
  }
});

test('releases: added by hand, or read from a "release" field on the traces', async () => {
  assert.deepEqual(normalizeReleases([{ name: ' b ', at: '2026-09-10' }, { name: 'a', at: '2026-09-01T00:00:00Z' }, { name: 'a', at: '2026-09-02' }, { name: '', at: 'x' }]).map((item) => item.name), ['a', 'b']);
  assert.deepEqual(releasesFromTraces([{ at: '2026-09-03T00:00:00Z', release: 'v2' }, { at: '2026-09-02T00:00:00Z', release: 'v2' }, { at: '2026-09-01T00:00:00Z' }]),
    [{ name: 'v2', at: '2026-09-02T00:00:00.000Z' }]);
  const engine = engineWith();
  await engine.action('general', 'import-traces', { traces: traces(4) });
  const data = await engine.action('general', 'releases', { releases: [{ name: 'v1', at: '2026-09-03T00:00:00Z' }] });
  assert.deepEqual(data.manualReleases, [{ name: 'v1', at: '2026-09-03T00:00:00.000Z' }]);
});

test('grouping and judges use the saved key, send only to zero-data-retention providers, and log what was sent', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, auth: options.headers.authorization, body });
    const content = body.messages[0].content.includes('axial coding')
      ? JSON.stringify({ failure_modes: [{ name: 'Vague status', definition: 'Says pending with no range', note_ids: body.messages[1].content.match(/n-[a-z0-9]+/g), handle: 'judge', handle_why: 'Needs judgement' }], good_patterns: [] })
      : 'The reply gives no range.\nFail';
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.001 } }) };
  });
  const engine = engineWith({ apiKey: 'test-key', autoGroupEvery: 2 });
  await engine.action('general', 'import-traces', { traces: traces(12) });
  const preview = await engine.query('general', 'group-preview');
  assert.match(preview.system, /axial coding/);
  assert.equal(calls.length, 0, 'a preview sends nothing');
  await engine.action('general', 'note', { traceId: 't-1', text: 'No range given' });
  await engine.action('general', 'note', { traceId: 't-2', text: 'No range given either' });
  await engine.idle();
  let data = await engine.snapshot('general');
  assert.equal(data.patterns.failureModes[0].name, 'Vague status', 'grouped automatically after two notes');
  assert.equal(calls[0].auth, 'Bearer test-key');
  assert.deepEqual(calls[0].body.provider, { zdr: true, data_collection: 'deny' });
  for (let index = 3; index <= 12; index += 1) await engine.action('general', 'verdict', { traceId: `t-${index}`, verdict: 'good' });
  await engine.action('general', 'judge-create', { modeKey: 'vague-status' });
  data = await engine.action('general', 'judge-run', { judgeId: 'j-vague-status', v: 0, set: 'all' });
  assert.equal(data.judges[0].run.running, true);
  await engine.idle();
  data = await engine.snapshot('general');
  assert.deepEqual([data.judges[0].versions[0].all.count, data.judges[0].versions[0].all.failRate], [12, 1]);
  assert.ok(calls.every((call) => call.url === 'https://openrouter.ai/api/v1/chat/completions' && call.body.provider.zdr === true));
  const { log } = await engine.query('general', 'sent-log');
  assert.ok(log.length >= 13 && log.every((item) => !JSON.stringify(item).includes('test-key')), 'the log shows requests, never the key');
  assert.equal(sentLog()[0].body.model, 'deepseek/deepseek-v4.1-flash');
});

test('nothing from the private product this tool grew out of is in the repository', async () => {
  const banned = [[78, 117, 114, 97], [107, 105, 100, 100, 108, 121], [74, 101, 118], [99, 117, 115, 116, 111, 109, 45, 110, 117, 114, 97]].map((codes) => String.fromCharCode(...codes).toLowerCase());
  const root = new URL('..', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((name) => !/^(\.git|node_modules|evaldesk-data)\//.test(name) && /\.(js|mjs|json|md|html|css|example)$/.test(name));
  assert.ok(files.length > 20);
  for (const name of files) {
    const text = (await readFile(new URL(name, root), 'utf8')).toLowerCase();
    for (const word of banned) assert.ok(!new RegExp(`\\b${word}\\b`).test(text), `${name} mentions a banned word`);
  }
});

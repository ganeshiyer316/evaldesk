// Builds the demo files (site/demo/*.json) from the scenarios in scripts/demo/.
// Every conversation, person, merchant and clinic in them is invented.
// The demo is a part-finished review: traces, notes, patterns, one judge, test cases
// and releases, so every tab has something to show without an AI key.
//   npm run demo
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_VERSION, normalizeTrace } from '../site/core/engine.js';
import { defaultCriterion, draftPrompt, labelsFor } from '../site/core/judges.js';
import { modeGrid, withOutlierChips } from '../site/core/stats.js';
import { draftTest } from '../site/core/tasks.js';
import payments from './demo/payments.mjs';
import healthcare from './demo/healthcare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.parse('2026-09-01T08:10:00Z');
const HOUR = 3600000;
// A small repeatable random number, so the demo is the same every time it is built.
const noise = (seed) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };

export function buildDemo(spec) {
  const at = (index, extraHours = 0) => new Date(START + index * 12 * HOUR + Math.floor(noise(index + 1) * 5 * HOUR) + extraHours * HOUR).toISOString();
  const traces = spec.scenarios.map((item, index) => {
    const id = `${spec.prefix}-${String(index + 1).padStart(3, '0')}`;
    // Times and costs are invented too: tools take under a second or two, the model takes the rest.
    const slow = item.slow ? 14 : 0;
    const tokens = 1400 + Math.floor(noise(index + 3) * 4200);
    const tools = item.tools.map(([label, fn, request, text], toolIndex) => ({ section: 'tool', label, fn, request, text, short: label.toLowerCase(),
      seconds: Number((0.3 + noise(index * 7 + fn.length + toolIndex)).toFixed(1)), ...(/^failed\b/.test(text) ? { error: true } : {}) }));
    const thinking = Number((1.6 + noise(index + 11) * 4.5 + slow).toFixed(1));
    const cost = Number((tokens * 0.000004 * (item.slow ? 6 : 1)).toFixed(4));
    const steps = [{ section: 'reasoning', label: 'Reasoning', text: item.reason, seconds: thinking, cost }, ...tools];
    return {
      id, kind: item.kind ?? 'message', at: at(index), person: item.person ?? `${spec.personLabel} ${(index * 7) % 23 + 1}`, group: item.group ?? '',
      input: { label: item.kind && item.kind !== 'message' ? 'Trigger' : item.inputLabel ?? spec.inputLabels[item.role] ?? 'User', text: item.input },
      context: item.context ?? [], steps,
      output: { label: 'Assistant', text: item.reply, detail: '' }, summary: item.summary ?? `${tools.map((step) => `${step.label}${step.error ? ' (failed)' : ''}`).join(' → ') || 'No tools used'} → replied`,
      metrics: { latency: Number((thinking + tools.reduce((sum, step) => sum + step.seconds, 0)).toFixed(1)), tokens, cost, steps: steps.length, replyChars: item.reply.length },
      flags: item.flags ?? [], dims: { kind: item.kind ?? 'message', role: item.role, ...(item.dims ?? {}) }, meta: item.meta ?? null
    };
  });

  const state = { verdicts: {}, notes: [], transcription: {}, grid: {} };
  const noteIdsByTag = new Map();
  spec.scenarios.forEach((item, index) => {
    const trace = traces[index];
    if (item.unreviewed) {
      if (item.note) throw new Error(`${trace.id} is marked unreviewed but has a note`);
      return;
    }
    const failing = Boolean(spec.failureModes[item.tag]);
    state.verdicts[trace.id] = failing ? 'bad' : 'good';
    if (!item.note) return;
    const [quote, text] = item.note;
    const start = trace.output.text.indexOf(quote);
    if (quote && start < 0) throw new Error(`${trace.id}: the quote “${quote}” is not in the reply`);
    const id = `n-demo-${String(state.notes.length + 1).padStart(2, '0')}`;
    state.notes.push({ id, traceId: trace.id, anchor: quote ? 'output' : 'trace', anchorLabel: quote ? 'Assistant' : 'the whole conversation', quote,
      ...(quote ? { start, end: start + quote.length } : {}), text, createdAt: at(index, 30) });
    noteIdsByTag.set(item.tag, [...(noteIdsByTag.get(item.tag) ?? []), id]);
  });

  const firstRun = at(8, 31);
  const mode = ([key, item]) => ({ key, name: item.name, definition: item.definition, boundaries: item.boundaries ?? '', noteIds: noteIdsByTag.get(key) ?? [],
    suggestedFix: item.fix ?? '', howToMeasure: item.measure ?? '', ...(item.handle ? { handleSuggestion: item.handle, handleWhy: item.handleWhy } : {}),
    ...(item.chosen ? { handle: { choice: item.chosen, at: at(30) } } : {}), locked: Boolean(item.locked), feedback: [], createdAt: firstRun, isNew: false });
  const patterns = {
    failureModes: Object.entries(spec.failureModes).map(mode), goodPatterns: Object.entries(spec.goodPatterns).map(mode), excluded: [], unassigned: [],
    history: [{ at: firstRun, notes: 5, newModes: Object.keys(spec.failureModes).length, model: 'demo' },
      { at: at(22, 31), notes: Math.round(state.notes.length * 0.7), newModes: 0, model: 'demo' }, { at: at(38, 31), notes: state.notes.length, newModes: 0, model: 'demo' }],
    lastRunAt: at(38, 31), lastRunNoteCount: state.notes.length
  };
  for (const tag of noteIdsByTag.keys()) if (!spec.failureModes[tag] && !spec.goodPatterns[tag]) throw new Error(`Notes are tagged “${tag}”, which is not a pattern`);

  // One judge, with made-up sample results for two versions so the scorecard has numbers.
  const normalized = withOutlierChips(traces.map(normalizeTrace));
  const grid = modeGrid({ traces: normalized, state, patterns });
  const judged = patterns.failureModes.find((item) => item.key === spec.judge.key);
  const labels = labelsFor(grid, judged.key);
  const criterion = defaultCriterion(judged);
  const prompt = draftPrompt({ domain: spec.pack, mode: judged, criterion, labels, traces: normalized, notes: state.notes });
  const dev = labels.filter((item) => item.set === 'dev');
  const rows = (wrongIds) => dev.map((item) => {
    const verdict = wrongIds.includes(item.traceId) ? (item.label === 'fail' ? 'pass' : 'fail') : item.label;
    return { traceId: item.traceId, human: item.label, judge: verdict, critique: verdict === 'fail' ? spec.judge.failCritique : spec.judge.passCritique };
  });
  const firstWrong = [dev.find((item) => item.label === 'fail')?.traceId, ...dev.filter((item) => item.label === 'pass').slice(0, 2).map((item) => item.traceId)].filter(Boolean);
  const judges = { judges: [{ id: `j-${judged.key}`, modeKey: judged.key, modeName: judged.name, criterion, model: 'deepseek/deepseek-v4.1-flash', createdAt: at(32), final: null,
    versions: [
      { v: 0, prompt, note: 'First draft, from your pattern and the example set', createdAt: at(32), leaks: [], results: { dev: { at: at(32, 1), rows: rows(firstWrong), cost: 0.004 } } },
      { v: 1, prompt: `${prompt}\n\n## Also\n${spec.judge.extraRule}`, note: `${spec.judge.change} (sample results for the demo)`, createdAt: at(33), leaks: [], results: { dev: { at: at(33, 1), rows: rows(firstWrong.slice(2)), cost: 0.005 } } }
    ] }] };

  const byId = new Map(normalized.map((trace) => [trace.id, trace]));
  const tests = { tests: spec.tests.map(([number, result]) => {
    const trace = byId.get(`${spec.prefix}-${String(number).padStart(3, '0')}`);
    const test = draftTest({ trace, state, patterns, grid, now: new Date(at(34)) });
    return { ...test, results: result == null ? [] : [{ at: at(36), pass: result }] };
  }) };

  return { evaldesk: BUNDLE_VERSION, domain: spec.pack.id, exportedAt: at(39), demo: 'Every conversation in this file is fictional.',
    traces, state, patterns, judges, tests, releases: spec.releases.map(([name, index]) => ({ name, at: at(index, -6) })), profile: null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(join(root, 'site', 'demo'), { recursive: true });
  for (const spec of [payments, healthcare]) {
    const demo = buildDemo(spec);
    await writeFile(join(root, 'site', 'demo', `${spec.pack.id}.json`), `${JSON.stringify(demo, null, 1)}\n`);
    console.log(`${spec.pack.id}: ${demo.traces.length} traces, ${Object.keys(demo.state.verdicts).length} reviewed, ${demo.state.notes.length} notes, ${demo.patterns.failureModes.length} failure patterns, ${demo.tests.tests.length} test cases`);
  }
}

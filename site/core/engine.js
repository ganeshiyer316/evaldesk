// The whole tool behind one small interface, so the same code runs in a browser tab
// (data in the browser's own storage) and in the optional local server (data in files).
//   store:    { get(domainId, name), set(domainId, name, value), remove(domainId) }, all async
//   packs:    the domain packs (site/packs/*.json)
//   settings: async () => ({ apiKey, model, judgeModel, baseUrl, autoGroupEvery })
//   extraReleases: async () => [{ name, at }], releases that come from somewhere else (e.g. git tags)
import { applyEdit, buildGroupingPrompt, DEFAULT_REVIEW_MODEL, emptyPatterns, groupNotes } from './patterns.js';
import { DEFAULT_JUDGE_MODEL, defaultCriterion, draftPrompt, emptyJudges, flagAlignment, improvePrompt, labelCounts, labelsFor, leakWarnings, runJudge, scoreJudge, verdictLabel } from './judges.js';
import { HANDLING, draftTest, emptyTests, suggestHandling, testsCsv, testsJsonl, testSummary, updateTest } from './tasks.js';
import { isReviewed, modeGrid, normalizeReleases, pickNext, releasesFromTraces, saturation, toCsv, trendsByRelease, withOutlierChips } from './stats.js';
import { sentLog } from './openrouter.js';
import { checkSummary, withChecks } from './checks.js';

export const BUNDLE_VERSION = 1;
const DOCS = ['traces', 'state', 'patterns', 'judges', 'tests', 'releases', 'profile'];
const emptyState = () => ({ verdicts: {}, notes: [], transcription: {}, grid: {} });

// Fills in anything an imported trace leaves out, so any product's data can be loaded.
export function normalizeTrace(item, index) {
  return {
    id: String(item.id ?? `t-${index + 1}`), kind: item.kind ?? 'message', at: item.at ?? new Date(0).toISOString(),
    person: item.person ?? '', group: item.group ?? '', input: { label: item.input?.label ?? 'User', text: item.input?.text ?? String(item.input ?? '') },
    context: item.context ?? [], steps: item.steps ?? [], output: { label: item.output?.label ?? 'Assistant', text: item.output?.text ?? String(item.output ?? ''), detail: item.output?.detail ?? '' },
    summary: item.summary ?? '', metrics: item.metrics ?? {}, flags: item.flags ?? [], dims: item.dims ?? { kind: item.kind ?? 'message' },
    meta: item.meta ?? null, ...(item.release ? { release: String(item.release) } : {})
  };
}

// Checks a traces file before it is saved, and explains what is wrong in plain words.
export function checkTraces(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.traces) ? value.traces : null;
  if (!list) throw new Error('This file is not a list of traces. It should start with [ and hold one { … } per conversation.');
  if (!list.length) throw new Error('This file has no traces in it.');
  const seen = new Set();
  list.forEach((item, index) => {
    const where = `Trace ${index + 1}${item?.id != null ? ` (${item.id})` : ''}`;
    if (!item || typeof item !== 'object') throw new Error(`${where} is not an object.`);
    if (item.id == null || item.id === '') throw new Error(`${where} has no "id". Every trace needs an id that stays the same between loads.`);
    if (item.input == null) throw new Error(`${where} has no "input" (what the user asked).`);
    if (item.output == null) throw new Error(`${where} has no "output" (what the assistant replied).`);
    if (seen.has(String(item.id))) throw new Error(`Two traces share the id "${item.id}". Ids must be unique.`);
    seen.add(String(item.id));
  });
  return list;
}

export function createEngine({ store, packs, settings, linkBase = '', extraReleases = async () => [] }) {
  const domains = new Map([...packs].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((pack) => [pack.id, pack]));
  const grouping = new Map();
  const judgeRuns = new Map();

  // Short changes run one at a time, so two saves finishing together can't overwrite each other.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  const config = async () => {
    const value = (await settings()) ?? {};
    return { apiKey: value.apiKey ?? '', model: value.model || DEFAULT_REVIEW_MODEL, judgeModel: value.judgeModel || DEFAULT_JUDGE_MODEL,
      baseUrl: value.baseUrl || 'https://openrouter.ai', autoGroupEvery: Number(value.autoGroupEvery) > 0 ? Number(value.autoGroupEvery) : 5 };
  };

  const pack = (domainId) => {
    if (!domains.has(domainId)) throw new Error('Unknown domain');
    return domains.get(domainId);
  };

  async function load(domainId) {
    const [rawTraces, state, patterns, judges, tests, releases, profile] = await Promise.all(DOCS.map((name) => store.get(domainId, name)));
    const traces = withChecks(withOutlierChips((rawTraces ?? []).map(normalizeTrace)));
    const description = String(profile?.description ?? '').trim();
    return {
      traces, state: { ...emptyState(), ...(state ?? {}) }, patterns: { ...emptyPatterns(), ...(patterns ?? {}) },
      judges: { ...emptyJudges(), ...(judges ?? {}) }, tests: { ...emptyTests(), ...(tests ?? {}) },
      releases: normalizeReleases([...(releases ?? []), ...(await extraReleases()), ...releasesFromTraces(traces)]), manualReleases: normalizeReleases(releases ?? []),
      profile: { description }, domain: { ...pack(domainId), ...(description ? { description, packDescription: pack(domainId).description } : {}) }
    };
  }

  const groupingNotes = (state) => state.notes.map((note) => ({ ...note, verdict: state.verdicts[note.traceId] ?? null }));

  function runGrouping(domainId) {
    if (grouping.get(domainId)?.running) return grouping.get(domainId).promise;
    const status = { running: true, error: null, startedAt: new Date().toISOString() };
    status.promise = (async () => {
      try {
        const { traces, state, patterns, domain } = await load(domainId);
        const { apiKey, model, baseUrl } = await config();
        const next = await groupNotes({ domain, notes: groupingNotes(state), traces, patterns, apiKey, model, baseUrl });
        await serial(() => store.set(domainId, 'patterns', next));
        status.error = null;
      } catch (error) {
        status.error = error.message;
      } finally {
        status.running = false;
      }
    })();
    grouping.set(domainId, status);
    return status.promise;
  }

  function judgeView({ judge, grid, traces, domainId }) {
    const labels = labelsFor(grid, judge.modeKey);
    const versions = judge.versions.map((version) => {
      const scored = (set) => {
        const run = version.results?.[set];
        if (!run) return null;
        const score = scoreJudge(run.rows);
        return { at: run.at, count: run.rows.length, score, verdict: verdictLabel(score), cost: run.cost ?? 0 };
      };
      return { ...version, dev: scored('dev'), test: scored('test'), all: version.results?.all ? {
        at: version.results.all.at, count: version.results.all.rows.length,
        failRate: version.results.all.rows.filter((row) => row.judge === 'fail').length / Math.max(1, version.results.all.rows.filter((row) => row.judge).length) } : null };
    });
    const status = judgeRuns.get(`${domainId}:${judge.id}`);
    return { ...judge, versions, counts: labelCounts(labels), codeChecks: flagAlignment({ traces, labels }).slice(0, 3),
      run: status ? { running: status.running, done: status.done, total: status.total, kind: status.kind, error: status.error } : null };
  }

  async function snapshot(domainId) {
    const { traces, state, patterns, judges, tests, releases, manualReleases, profile, domain } = await load(domainId);
    const { apiKey, model, judgeModel, autoGroupEvery } = await config();
    const grid = modeGrid({ traces, state, patterns });
    const status = grouping.get(domainId);
    return {
      tests: tests.tests, testSummary: testSummary(tests.tests),
      handling: Object.fromEntries(patterns.failureModes.map((mode) => [mode.key, suggestHandling({ mode, grid, traces, codeFaultFlags: domain.codeFaultFlags ?? [] })])),
      judges: judges.judges.map((judge) => judgeView({ judge, grid, traces, domainId })), judgeModel,
      domain, profile, traces, checkSummary: checkSummary(traces), state, patterns, grid, trends: trendsByRelease({ grid, releases }),
      saturation: saturation(patterns, state), releases, manualReleases,
      reviewed: traces.filter((trace) => isReviewed(state, trace.id)).length,
      grouping: { available: Boolean(apiKey), model, running: Boolean(status?.running), error: status?.error ?? null, autoEvery: autoGroupEvery }
    };
  }

  async function bundle(domainId) {
    const docs = Object.fromEntries(await Promise.all(DOCS.map(async (name) => [name, await store.get(domainId, name)])));
    return { evaldesk: BUNDLE_VERSION, domain: domainId, exportedAt: new Date().toISOString(), ...docs };
  }

  async function exportFile(domainId, name, options = {}) {
    const base = options.linkBase ?? linkBase;
    const traceLink = (id) => `${base}#/${domainId}/review/${encodeURIComponent(id)}`;
    if (name === 'backup.json') return ['application/json', JSON.stringify(await bundle(domainId), null, 2)];
    const { traces, state, patterns, judges, tests, domain } = await load(domainId);
    const grid = modeGrid({ traces, state, patterns });
    if (name === 'notes.csv') {
      return ['text/csv', toCsv([['trace', 'link', 'verdict', 'quote', 'note', 'patterns', 'created'],
        ...state.notes.map((note) => [note.traceId, traceLink(note.traceId), state.verdicts[note.traceId] ?? '', note.quote ?? '', note.text,
          [...patterns.failureModes, ...patterns.goodPatterns].filter((mode) => mode.noteIds?.includes(note.id)).map((mode) => mode.name).join('; '), note.createdAt])])];
    }
    if (name === 'grid.csv') {
      return ['text/csv', toCsv([['trace', 'link', ...grid.modes.map((mode) => mode.name)],
        ...grid.rows.map((row) => [row.traceId, traceLink(row.traceId), ...grid.modes.map((mode) => (row.cells[mode.key].value ? 1 : 0))]),
        ['prevalence', '', ...grid.modes.map((mode) => `${grid.prevalence[mode.key].pct}%`)]])];
    }
    if (name === 'tests.jsonl') return ['application/x-ndjson', testsJsonl(tests.tests, { patterns, traceLink })];
    if (name === 'tests.csv') return ['text/csv', testsCsv(tests.tests, { patterns, traceLink })];
    if (name === 'failure-modes.md') {
      const noteById = new Map(state.notes.map((note) => [note.id, note]));
      const section = (mode, withStats) => {
        const examples = (mode.noteIds ?? []).map((id) => noteById.get(id)).filter(Boolean).slice(0, 6)
          .map((note) => `  - [${note.traceId}](${traceLink(note.traceId)}): ${note.quote ? `“${note.quote}”: ` : ''}${note.text}`);
        const paragraphs = [`### ${mode.name}`, `**Definition:** ${mode.definition}`, mode.boundaries && `**Boundaries:** ${mode.boundaries}`,
          withStats && `**Prevalence:** ${grid.prevalence[mode.key]?.count ?? 0} of ${grid.rows.length} reviewed traces (${grid.prevalence[mode.key]?.pct ?? 0}%)`,
          mode.suggestedFix && `**Likely fix:** ${mode.suggestedFix}`, mode.howToMeasure && `**How to measure:** ${mode.howToMeasure}`,
          withStats && mode.handle && `**How we'll handle it:** ${HANDLING[mode.handle.choice]?.label ?? mode.handle.choice}`,
          ['**Examples:**', ...examples].join('\n')];
        return `${paragraphs.filter(Boolean).join('\n\n')}\n`;
      };
      return ['text/markdown', [`# Failure modes: ${domain.name}`, '', `${grid.rows.length} traces reviewed, ${state.notes.length} notes. Generated ${new Date().toISOString().slice(0, 10)}.`, '',
        '## Failure modes', '', ...patterns.failureModes.map((mode) => section(mode, true)), '## Good patterns', '', ...patterns.goodPatterns.map((mode) => section(mode, false))].join('\n')];
    }
    if (name === 'judges.csv') {
      const rows = [['judge', 'version', 'set', 'conversation', 'link', 'your label', 'judge verdict', 'agree', 'judge critique', 'run at']];
      for (const judge of judges.judges) for (const version of judge.versions) for (const [set, run] of Object.entries(version.results ?? {})) {
        for (const row of run.rows) rows.push([judge.modeName, `v${version.v}`, { dev: 'tuning', test: 'final test', all: 'all conversations' }[set] ?? set, row.traceId,
          traceLink(row.traceId), row.human ?? '', row.judge ?? 'no answer', row.human && row.judge ? (row.human === row.judge ? 'yes' : 'no') : '', row.critique, run.at]);
      }
      return ['text/csv', toCsv(rows)];
    }
    if (name === 'judge-scores.csv') {
      const rows = [['judge', 'version', 'change', 'set', 'catches real failures', 'of', 'rate', 'likely range', 'leaves good replies alone', 'of', 'rate', 'likely range', 'false alarms', 'agreement', 'run at']];
      const pct = (value) => (value == null ? '' : `${Math.round(value * 100)}%`);
      for (const judge of judges.judges) for (const version of judge.versions) for (const set of ['dev', 'test']) {
        const run = version.results?.[set];
        if (!run) continue;
        const score = scoreJudge(run.rows);
        rows.push([judge.modeName, `v${version.v}`, version.note, set === 'dev' ? 'tuning' : 'final test', score.catches.count, score.catches.of, pct(score.catches.rate),
          `${pct(score.catches.range[0])}–${pct(score.catches.range[1])}`, score.leavesAlone.count, score.leavesAlone.of, pct(score.leavesAlone.rate),
          `${pct(score.leavesAlone.range[0])}–${pct(score.leavesAlone.range[1])}`, score.falseAlarms, pct(score.agreement), run.at]);
      }
      return ['text/csv', toCsv(rows)];
    }
    return null;
  }

  function startJudgeRun({ domainId, judgeId, kind, work }) {
    const key = `${domainId}:${judgeId}`;
    if (judgeRuns.get(key)?.running) throw new Error('This judge is already running. Wait for it to finish.');
    const status = { running: true, done: 0, total: 0, kind, error: null };
    judgeRuns.set(key, status);
    status.promise = (async () => {
      try { await work(status); } catch (error) { status.error = error.message; } finally { status.running = false; }
    })();
  }

  // Judges are read, changed and saved in one step, so runs finishing together keep each other's results.
  function saveJudges(domainId, change) {
    return serial(async () => {
      const judges = { ...emptyJudges(), ...((await store.get(domainId, 'judges')) ?? {}) };
      const result = change(judges);
      await store.set(domainId, 'judges', judges);
      return result;
    });
  }

  function saveJudge(domainId, judgeId, update) {
    return saveJudges(domainId, (judges) => {
      const judge = judges.judges.find((item) => item.id === judgeId);
      if (!judge) throw new Error('Judge not found');
      update(judge);
      return judge;
    });
  }

  async function testAction({ domainId, action, input, traces, state, patterns, tests }) {
    const grid = modeGrid({ traces, state, patterns });
    const traceById = new Map(traces.map((trace) => [trace.id, trace]));
    const add = (trace) => {
      if (tests.tests.some((test) => test.traceId === trace.id)) return false;
      tests.tests.push(draftTest({ trace, state, patterns, grid }));
      return true;
    };
    if (action === 'test-create') {
      const trace = traceById.get(input.traceId);
      if (!trace) throw new Error('Unknown trace');
      if (!add(trace)) throw new Error('This conversation is already a test case.');
    } else if (action === 'test-from-pattern') {
      const failing = grid.rows.filter((row) => row.cells[input.modeKey]?.value).map((row) => traceById.get(row.traceId)).filter(Boolean);
      if (!failing.length) throw new Error('This pattern has no labelled examples yet.');
      const added = failing.filter(add).length;
      if (!added) throw new Error('All of this pattern’s examples are already test cases.');
    } else {
      const index = tests.tests.findIndex((test) => test.id === input.id);
      if (index < 0) throw new Error('Test case not found');
      if (action === 'test-update') tests.tests[index] = updateTest(tests.tests[index], input);
      else if (action === 'test-result') tests.tests[index].results = [...(tests.tests[index].results ?? []), { at: new Date().toISOString(), pass: Boolean(input.pass) }].slice(-20);
      else if (action === 'test-delete') tests.tests.splice(index, 1);
      else throw new Error('Unknown test action');
    }
    await store.set(domainId, 'tests', tests);
  }

  async function judgeAction({ domainId, action, input }) {
    const { traces, state, patterns, judges, domain } = await load(domainId);
    const { apiKey, judgeModel, baseUrl } = await config();
    const grid = modeGrid({ traces, state, patterns });
    const judge = judges.judges.find((item) => item.id === input.judgeId);
    if (action === 'judge-create') {
      const mode = patterns.failureModes.find((item) => item.key === input.modeKey);
      if (!mode) throw new Error('Pick a failure pattern first');
      const labels = labelsFor(grid, mode.key);
      const criterion = defaultCriterion(mode);
      const prompt = draftPrompt({ domain, mode, criterion, labels, traces, notes: state.notes });
      await saveJudges(domainId, (latest) => { if (!latest.judges.some((item) => item.modeKey === mode.key)) latest.judges.push({ id: `j-${mode.key}`.slice(0, 60), modeKey: mode.key, modeName: mode.name, criterion, model: judgeModel, createdAt: new Date().toISOString(),
        versions: [{ v: 0, prompt, note: 'First draft, from your pattern and the example set', createdAt: new Date().toISOString(), leaks: leakWarnings(prompt, traces, labels), results: {} }],
        final: null }); });
      return;
    }
    if (!judge) throw new Error('Judge not found');
    const labels = labelsFor(grid, judge.modeKey);
    const mode = patterns.failureModes.find((item) => item.key === judge.modeKey) ?? { name: judge.modeName, definition: '', noteIds: [] };
    if (action === 'judge-update') {
      await saveJudge(domainId, judge.id, (item) => {
        if (typeof input.criterion === 'string' && input.criterion.trim()) item.criterion = input.criterion.trim();
        if (typeof input.model === 'string' && input.model.trim()) item.model = input.model.trim();
      });
    } else if (action === 'judge-version') {
      const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim()
        : draftPrompt({ domain, mode, criterion: judge.criterion, labels, traces, notes: state.notes });
      await saveJudge(domainId, judge.id, (item) => {
        item.versions.push({ v: item.versions.length, prompt, note: String(input.note ?? (input.prompt ? 'Edited by you' : 'Redrafted from the criterion')).slice(0, 200),
          createdAt: new Date().toISOString(), leaks: leakWarnings(prompt, traces, labels), results: {} });
      });
    } else if (action === 'judge-run') {
      const version = judge.versions.find((item) => item.v === Number(input.v));
      if (!version) throw new Error('Version not found');
      const set = ['dev', 'test', 'all'].includes(input.set) ? input.set : 'dev';
      if (set === 'test' && judge.final) throw new Error(`The final test was already used (v${judge.final.v}). Running it again would turn it into a tuning set.`);
      const ids = set === 'all' ? null : new Set(labels.filter((item) => item.set === set).map((item) => item.traceId));
      const chosen = ids ? traces.filter((trace) => ids.has(trace.id)) : traces;
      if (!chosen.length) throw new Error(set === 'all' ? 'No conversations loaded.' : `No labelled conversations in the ${set === 'dev' ? 'tuning' : 'final test'} set yet. Label more first.`);
      startJudgeRun({ domainId, judgeId: judge.id, kind: set, work: async (status) => {
        status.total = chosen.length;
        const { rows, cost } = await runJudge({ prompt: version.prompt, traces: chosen, labels, apiKey, model: judge.model, baseUrl,
          onProgress: (done) => { status.done = done; } });
        await saveJudge(domainId, judge.id, (item) => {
          const target = item.versions.find((entry) => entry.v === version.v);
          target.results = { ...(target.results ?? {}), [set]: { at: new Date().toISOString(), rows, cost } };
          if (set === 'test') item.final = { v: version.v, at: new Date().toISOString() };
        });
      } });
    } else if (action === 'judge-improve') {
      const version = judge.versions.find((item) => item.v === Number(input.v));
      if (!version) throw new Error('Version not found');
      startJudgeRun({ domainId, judgeId: judge.id, kind: 'improve', work: async (status) => {
        const proposal = await improvePrompt({ judge, version, traces, labels, apiKey, model: judge.model, baseUrl });
        const devIds = new Set(labels.filter((item) => item.set === 'dev').map((item) => item.traceId));
        const devTraces = traces.filter((trace) => devIds.has(trace.id));
        status.kind = 'dev';
        status.total = devTraces.length;
        const { rows, cost } = await runJudge({ prompt: proposal.prompt, traces: devTraces, labels, apiKey, model: judge.model, baseUrl,
          onProgress: (done) => { status.done = done; } });
        await saveJudge(domainId, judge.id, (item) => {
          item.versions.push({ v: item.versions.length, prompt: proposal.prompt, note: proposal.note, createdAt: new Date().toISOString(),
            leaks: leakWarnings(proposal.prompt, traces, labels), results: { dev: { at: new Date().toISOString(), rows, cost: cost + proposal.cost } } });
        });
      } });
    } else if (action === 'judge-delete') {
      await saveJudges(domainId, (latest) => { latest.judges = latest.judges.filter((item) => item.id !== judge.id); });
    } else {
      throw new Error('Unknown judge action');
    }
  }

  // One change to the reviewer's work. Returns the fresh snapshot.
  async function action(domainId, name, input = {}) {
    pack(domainId);
    if (name === 'group') {
      await runGrouping(domainId);
      const status = grouping.get(domainId);
      if (status?.error) throw new Error(status.error);
      return snapshot(domainId);
    }
    if (name.startsWith('judge-')) {
      await judgeAction({ domainId, action: name, input });
      return snapshot(domainId);
    }
    let autoGroup = false;
    await serial(async () => {
      const { traces, state, patterns, tests } = await load(domainId);
      const traceIds = new Set(traces.map((trace) => trace.id));
      const needTrace = () => { if (!traceIds.has(input.traceId)) throw new Error('Unknown trace'); };
      if (name === 'note') {
        needTrace();
        const text = String(input.text ?? '').trim();
        if (!text) throw new Error('Write a note first');
        state.notes.push({ id: `n-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, traceId: input.traceId,
          anchor: String(input.anchor ?? 'trace'), anchorLabel: String(input.anchorLabel ?? '').slice(0, 80), quote: String(input.quote ?? '').slice(0, 500),
          ...(Number.isInteger(input.start) && Number.isInteger(input.end) && input.end > input.start ? { start: input.start, end: input.end } : {}), text, createdAt: new Date().toISOString() });
        await store.set(domainId, 'state', state);
        const { apiKey, autoGroupEvery } = await config();
        autoGroup = Boolean(apiKey) && state.notes.length - (patterns.lastRunNoteCount ?? 0) >= autoGroupEvery;
      } else if (name === 'note-edit') {
        const note = state.notes.find((item) => item.id === input.id);
        if (!note) throw new Error('Note not found');
        if (input.delete) state.notes = state.notes.filter((item) => item !== note);
        else note.text = String(input.text ?? note.text).trim();
        await store.set(domainId, 'state', state);
      } else if (name === 'verdict') {
        needTrace();
        if (input.verdict === 'good' || input.verdict === 'bad') state.verdicts[input.traceId] = input.verdict;
        else delete state.verdicts[input.traceId];
        await store.set(domainId, 'state', state);
      } else if (name === 'transcription') {
        needTrace();
        if (input.value) state.transcription[input.traceId] = true; else delete state.transcription[input.traceId];
        await store.set(domainId, 'state', state);
      } else if (name === 'grid') {
        needTrace();
        state.grid[input.traceId] = { ...(state.grid[input.traceId] ?? {}) };
        if (typeof input.value === 'boolean') state.grid[input.traceId][input.modeKey] = input.value;
        else delete state.grid[input.traceId][input.modeKey];
        await store.set(domainId, 'state', state);
      } else if (name === 'pattern') {
        if (grouping.get(domainId)?.running) throw new Error('Notes are being grouped right now. Try again in a moment.');
        await store.set(domainId, 'patterns', applyEdit(patterns, input));
      } else if (name.startsWith('test-')) {
        await testAction({ domainId, action: name, input, traces, state, patterns, tests });
      } else if (name === 'import-traces') {
        // Notes and labels are kept: they stay attached to traces by id.
        const incoming = checkTraces(input.traces);
        const existing = input.mode === 'add' ? ((await store.get(domainId, 'traces')) ?? []) : [];
        const fresh = new Set(incoming.map((item) => String(item.id)));
        await store.set(domainId, 'traces', [...existing.filter((item) => !fresh.has(String(item.id))), ...incoming]);
      } else if (name === 'restore') {
        const data = input.bundle;
        if (!data || data.evaldesk !== BUNDLE_VERSION) throw new Error('This is not an EvalDesk backup file.');
        if (data.traces) checkTraces(data.traces);
        for (const doc of DOCS) {
          if (data[doc] != null) await store.set(domainId, doc, data[doc]);
          else await store.set(domainId, doc, null);
        }
      } else if (name === 'releases') {
        await store.set(domainId, 'releases', normalizeReleases(input.releases));
      } else if (name === 'profile') {
        await store.set(domainId, 'profile', { description: String(input.description ?? '').trim().slice(0, 600) });
      } else if (name === 'clear') {
        await store.remove(domainId);
      } else {
        throw new Error('Unknown action');
      }
    });
    if (autoGroup) runGrouping(domainId);
    return snapshot(domainId);
  }

  // Questions that don't change anything.
  async function query(domainId, name, input = {}) {
    pack(domainId);
    if (name === 'sent-log') return { log: sentLog() };
    const { traces, state, patterns, domain } = await load(domainId);
    if (name === 'next') {
      const slice = Array.isArray(input.ids) ? traces.filter((trace) => input.ids.includes(trace.id)) : null;
      return { id: pickNext({ traces, state, strategy: input.strategy ?? 'variety', slice }) };
    }
    if (name === 'group-preview') {
      const { model, baseUrl } = await config();
      return { model, to: `${baseUrl}/api/v1/chat/completions`, ...buildGroupingPrompt({ domain, notes: groupingNotes(state), traces, patterns }) };
    }
    throw new Error('Unknown question');
  }

  async function listDomains() {
    const list = [];
    for (const item of domains.values()) list.push({ id: item.id, name: item.name, group: item.group, traces: ((await store.get(item.id, 'traces')) ?? []).length });
    return list;
  }

  // For tests and scripts: resolves when background AI work has finished.
  const idle = () => Promise.all([...[...grouping.values()].map((status) => status.promise), ...[...judgeRuns.values()].map((status) => status.promise)]);

  return { listDomains, snapshot, action, query, exportFile, idle };
}

// A store that lives in memory. Used by tests and as a fallback when the browser blocks storage.
export function memoryStore() {
  const docs = new Map();
  return {
    get: async (domainId, name) => (docs.has(`${domainId}/${name}`) ? structuredClone(docs.get(`${domainId}/${name}`)) : null),
    set: async (domainId, name, value) => { if (value == null) docs.delete(`${domainId}/${name}`); else docs.set(`${domainId}/${name}`, structuredClone(value)); },
    remove: async (domainId) => { for (const key of [...docs.keys()]) if (key.startsWith(`${domainId}/`)) docs.delete(key); }
  };
}

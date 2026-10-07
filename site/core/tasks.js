// What to do about each failure pattern, and test cases made from reviewed conversations
// A test case ("task" in the course) is: the input, what the
// product already knew, and a rule for what counts as a pass. Regression cases are things
// the product does right and must keep doing; capability cases are goals it fails today.
import { defaultCriterion, flagAlignment, labelsFor } from './judges.js';
import { toCsv } from './stats.js';

export const HANDLING = {
  fix: { label: 'Fix it', icon: '🔧', means: 'A clear bug or missing instruction. Fix the prompt or the code; nothing to measure yet.' },
  code_check: { label: 'Code check', icon: '⚙️', means: 'A simple rule can spot it (a warning flag, a missing field). Cheap, and never drifts.' },
  judge: { label: 'LLM judge', icon: '⚖️', means: 'Spotting it needs judgement about meaning or tone. Build a judge in the Judges tab.' }
};


// The suggested way to handle one failure pattern, with the reason in plain words.
// codeFaultFlags (from the domain pack) are flags that mean plain code overruled a good AI
// proposal: a bug, not a quality question.
export function suggestHandling({ mode, grid, traces, codeFaultFlags = [] }) {
  const labels = labelsFor(grid, mode.key);
  const failed = labels.filter((item) => item.label === 'fail');
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  if (failed.length >= 3) {
    const codeFault = failed.filter((item) => (byId.get(item.traceId)?.flags ?? []).some((flag) => codeFaultFlags.includes(flag))).length;
    if (codeFault / failed.length >= 0.5) {
      return { choice: 'fix', why: `In ${codeFault} of ${failed.length} examples, code overruled what the AI proposed (see Tool calls). That’s a bug to fix, not something to measure.` };
    }
    const [best] = flagAlignment({ traces, labels });
    if (best && best.catches.of >= 3 && best.catches.rate >= 0.85 && best.leavesAlone.rate >= 0.85) {
      return { choice: 'code_check', flag: best.flag, why: `A warning flag already matches your labels: it catches ${Math.round(best.catches.rate * 100)}% of these failures and leaves ${Math.round(best.leavesAlone.rate * 100)}% of good replies alone.` };
    }
  }
  if (HANDLING[mode.handleSuggestion]) return { choice: mode.handleSuggestion, why: mode.handleWhy || HANDLING[mode.handleSuggestion].means };
  return { choice: 'fix', why: 'Start by fixing the likely cause. If it keeps happening after the fix, measure it with a code check or a judge.' };
}

const clean = (value, max = 400) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// A test case drafted from one reviewed conversation; the reviewer edits it afterwards.
export function draftTest({ trace, state, patterns, grid, now = new Date() }) {
  const row = grid.rows.find((item) => item.traceId === trace.id);
  const mode = patterns.failureModes.find((item) => row?.cells[item.key]?.value) ?? null;
  const verdict = state.verdicts[trace.id] ?? null;
  const failing = verdict === 'bad' || Boolean(mode);
  const overall = state.notes.find((note) => note.traceId === trace.id && note.anchor === 'trace')?.text
    ?? state.notes.find((note) => note.traceId === trace.id)?.text;
  const shouldDo = mode ? defaultCriterion(mode)
    : failing ? `Pass if the reply gets this right${overall ? `: ${clean(overall, 300)}` : '.'}`
      : `Pass if the reply does what this one did: “${clean(trace.output?.text, 200)}”`;
  const check = mode?.handle?.choice === 'judge' ? 'judge' : mode?.handle?.choice === 'code_check' ? 'code_check' : 'by_hand';
  return {
    id: `tc-${trace.id}`, traceId: trace.id, kind: failing ? 'capability' : 'regression', modeKey: mode?.key ?? null,
    input: { label: trace.input?.label ?? 'Input', text: trace.input?.text ?? '' }, context: (trace.context ?? []).slice(-4),
    startingState: '', shouldDo, check, expected: {}, results: [], createdAt: now.toISOString()
  };
}

export const emptyTests = () => ({ tests: [] });

// Only these fields can be changed from the page.
export function updateTest(test, input) {
  const next = { ...test };
  if (['regression', 'capability'].includes(input.kind)) next.kind = input.kind;
  if (input.modeKey !== undefined) next.modeKey = input.modeKey || null;
  for (const field of ['shouldDo', 'startingState']) if (typeof input[field] === 'string') next[field] = input[field].trim().slice(0, 2000);
  if (['by_hand', 'code_check', 'judge', 'exact'].includes(input.check)) next.check = input.check;
  if (input.expected && typeof input.expected === 'object') {
    next.expected = Object.fromEntries(Object.entries(input.expected).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, value.trim()]));
  }
  return next;
}

export const lastResult = (test) => test.results?.at(-1) ?? null;

// Pass rates by kind, from the latest recorded re-check of each test case.
export function testSummary(tests) {
  const part = (kind) => {
    const list = tests.filter((test) => test.kind === kind);
    const checked = list.filter((test) => lastResult(test));
    return { count: list.length, checked: checked.length, passing: checked.filter((test) => lastResult(test).pass).length };
  };
  const regression = part('regression');
  const capability = part('capability');
  const warnings = [];
  if (tests.length && !capability.count) warnings.push('Every test case is something the product already does. Add some it gets wrong, or the set can’t show progress (a set that always passes is too easy).');
  if (regression.checked && regression.passing < regression.checked) warnings.push(`${regression.checked - regression.passing} regression case${regression.checked - regression.passing === 1 ? '' : 's'} failing: something that used to work broke.`);
  const promotable = tests.filter((test) => test.kind === 'capability' && lastResult(test)?.pass).length;
  return { total: tests.length, regression, capability, promotable, warnings };
}

export function testsJsonl(tests, { patterns, traceLink }) {
  const name = (key) => patterns.failureModes.find((mode) => mode.key === key)?.name ?? null;
  return tests.map((test) => JSON.stringify({ id: test.id, kind: test.kind, pattern: name(test.modeKey), input: test.input.text, context: test.context,
    starting_state: test.startingState || null, pass_if: test.shouldDo, check: test.check, expected: test.expected, source: traceLink(test.traceId),
    last_result: lastResult(test) ? (lastResult(test).pass ? 'pass' : 'fail') : null })).join('\n') + (tests.length ? '\n' : '');
}

export function testsCsv(tests, { patterns, traceLink }) {
  const name = (key) => patterns.failureModes.find((mode) => mode.key === key)?.name ?? '';
  return toCsv([['test case', 'kind', 'pattern', 'input', 'starting state', 'pass if', 'check', 'last result', 'checked at', 'conversation'],
    ...tests.map((test) => [test.id, test.kind, name(test.modeKey), test.input.text, test.startingState, test.shouldDo, test.check,
      lastResult(test) ? (lastResult(test).pass ? 'pass' : 'fail') : '', lastResult(test)?.at ?? '', traceLink(test.traceId)])]);
}

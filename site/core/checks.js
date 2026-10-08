// Automatic checks: plain rules that run on every trace as soon as it is loaded. No AI,
// no key, nothing sent anywhere. Each gives pass, fail or "not applicable" with a reason
// in plain words. They are rules of thumb: a fail means "look at this one", not a verdict.
// A failed check also becomes a warning flag on the trace, so it can be filtered on and
// compared with the reviewer's own labels like any other flag.

export const CHECKS = {
  check_tool_failure: { name: 'Tool failures handled', flag: 'A tool failed and the reply doesn’t say so',
    about: 'When a tool call fails, the reply should say so or the tool should be tried again.' },
  check_numbers: { name: 'Figures come from a source', flag: 'A figure in the reply isn’t in any tool result or message',
    about: 'Amounts, percentages, times and long numbers in the reply should appear in a tool result or in what the user said.' },
  slow: { name: 'Speed', flag: 'Much slower than usual', about: 'Fails when a conversation is among the slowest tenth and took at least twice the typical time.' },
  costly: { name: 'Cost', flag: 'Costs much more than usual', about: 'Fails when a conversation is among the costliest tenth and cost at least twice the typical amount.' }
};

// Words that show a reply owned up to something not working.
const ADMITS = /\b(couldn[’']?t|could not|can[’']?t|cannot|unable|wasn[’']?t able|not able|didn[’']?t (work|go through)|fail(ed|ure|s)?|errors?|went wrong|problem|issue|sorry|unfortunately|try again|no (results|free|available)|not (available|found)|nothing (found|free))\b/i;

function toolFailure(trace) {
  const steps = trace.steps ?? [];
  const failed = steps.map((step, index) => ({ step, index })).filter((item) => item.step.error);
  if (!failed.length) return { result: 'na', why: 'No tool failed.' };
  const same = (a, b) => (a.fn && a.fn === b.fn) || (!a.fn && a.label === b.label);
  const unhandled = failed.filter(({ step, index }) => !steps.slice(index + 1).some((later) => !later.error && same(later, step)));
  const names = (list) => list.map(({ step }) => `“${step.label ?? step.fn ?? 'a tool'}”`).join(', ');
  if (!unhandled.length) return { result: 'pass', why: `${names(failed)} failed and was tried again successfully.` };
  if (ADMITS.test(trace.output?.text ?? '')) return { result: 'pass', why: `${names(unhandled)} failed, and the reply says something went wrong.` };
  return { result: 'fail', why: `${names(unhandled)} failed, but the reply carries on as if it worked.` };
}

// Every number in a text, written one way: no thousands commas, no trailing zeros, times as h:mm.
function figures(text) {
  const found = [];
  const source = String(text ?? '');
  for (const match of source.matchAll(/\d{1,2}:\d{2}|\d[\d,]*(?:\.\d+)?/g)) {
    const raw = match[0].replace(/,+$/, '');
    const before = source.slice(Math.max(0, match.index - 2), match.index);
    const after = source.slice(match.index + raw.length, match.index + raw.length + 2);
    const time = raw.includes(':');
    const value = time ? raw.replace(/^0/, '') : String(Number(raw.replaceAll(',', '')));
    const whole = raw.replaceAll(',', '').split('.')[0];
    // Small bare numbers ("5 to 10 days", "2 steps") are everyday wording, not figures worth checking.
    const matters = time || /[£$€₹]\s?$/.test(before) || /^\s?%/.test(after) || whole.length >= 3 || raw.includes('.');
    found.push({ raw, value, matters });
  }
  return found;
}

function groundedNumbers(trace) {
  const steps = trace.steps ?? [];
  if (!steps.length) return { result: 'na', why: 'This trace has no steps, so there is nothing to compare the reply with.' };
  const claimed = figures(trace.output?.text).filter((item) => item.matters);
  if (!claimed.length) return { result: 'na', why: 'The reply has no figures to check.' };
  const sources = [trace.input?.text, ...(trace.context ?? []).map((turn) => turn.text),
    ...steps.filter((step) => step.section !== 'reasoning').flatMap((step) => [step.request, step.text])];
  const known = new Set(sources.flatMap((text) => figures(text).map((item) => item.value)));
  const missing = [...new Set(claimed.filter((item) => !known.has(item.value)).map((item) => item.raw))];
  if (!missing.length) return { result: 'pass', why: `Every figure in the reply (${[...new Set(claimed.map((item) => item.raw))].slice(0, 4).join(', ')}) appears in a tool result or a message.` };
  return { result: 'fail', why: `${missing.slice(0, 3).map((raw) => `“${raw}”`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} in the reply but not in any tool result or message.` };
}

// Being in the top tenth is not a problem by itself (someone always is): it also has to be
// at least twice the typical value for conversations of the same kind.
function outlier(trace, metric, typical) {
  const value = trace.metrics?.[metric];
  if (typeof value !== 'number') return { result: 'na', why: `This trace has no ${metric === 'latency' ? 'timing' : 'cost'} recorded.` };
  const chip = (trace.chips ?? []).find((item) => item.key === metric);
  const usual = typical?.[metric];
  if (chip && usual > 0 && value >= usual * 2) return { result: 'fail', why: `${chip.text}, and ${(value / usual).toFixed(1)} times the typical ${metric === 'latency' ? 'time' : 'cost'}.` };
  return { result: 'pass', why: 'In the normal range for this kind of conversation.' };
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number' && value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

// Runs every check on one trace. Call after withOutlierChips, which the speed and cost checks read.
// typical: { latency, cost }, the median for traces of the same kind.
export function runChecks(trace, typical = {}) {
  const results = { check_tool_failure: toolFailure(trace), check_numbers: groundedNumbers(trace), slow: outlier(trace, 'latency', typical), costly: outlier(trace, 'cost', typical) };
  return Object.entries(results).map(([key, value]) => ({ key, name: CHECKS[key].name, ...value }));
}

export function withChecks(traces) {
  const typical = new Map();
  for (const kind of new Set(traces.map((trace) => trace.kind))) {
    const peers = traces.filter((trace) => trace.kind === kind);
    typical.set(kind, { latency: median(peers.map((trace) => trace.metrics?.latency)), cost: median(peers.map((trace) => trace.metrics?.cost)) });
  }
  return traces.map((trace) => {
    const checks = runChecks(trace, typical.get(trace.kind));
    const flags = [...(trace.flags ?? [])];
    for (const check of checks) if (check.result === 'fail' && !flags.includes(check.key)) flags.push(check.key);
    return { ...trace, checks, flags };
  });
}

// How each check did across all traces.
export function checkSummary(traces) {
  return Object.entries(CHECKS).map(([key, check]) => {
    const results = traces.map((trace) => (trace.checks ?? []).find((item) => item.key === key)?.result ?? 'na');
    const count = (value) => results.filter((item) => item === value).length;
    return { key, name: check.name, about: check.about, passed: count('pass'), failed: count('fail'), na: count('na') };
  });
}

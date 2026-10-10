// Numbers: outlier chips, the mode × trace grid,
// prevalence per release, and which trace to review next. Pure functions.

const METRICS = [
  ['latency', (value, pct) => `${value} s · slower than ${pct}%`],
  ['tokens', (value, pct) => `${value.toLocaleString('en-US')} tokens · more than ${pct}%`],
  ['replyChars', (value, pct) => `${value} characters · longer than ${pct}%`],
  ['cost', (value, pct) => `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)} · costs more than ${pct}%`]
];

// Adds chips for metrics at or above the 90th percentile of traces of the same kind.
export function withOutlierChips(traces, threshold = 90) {
  const byKind = new Map();
  for (const trace of traces) byKind.set(trace.kind, [...(byKind.get(trace.kind) ?? []), trace]);
  return traces.map((trace) => {
    const peers = byKind.get(trace.kind);
    const chips = [];
    for (const [key, label] of METRICS) {
      const value = trace.metrics?.[key];
      const values = peers.map((item) => item.metrics?.[key]).filter((item) => typeof item === 'number' && item > 0);
      if (typeof value !== 'number' || value <= 0 || values.length < 5) continue;
      const below = values.filter((item) => item < value).length;
      const pct = Math.floor((below / values.length) * 100);
      if (pct >= threshold) chips.push({ key, text: label(value, pct) });
    }
    const flags = [...(trace.flags ?? [])];
    return { ...trace, chips, flags };
  });
}

export function isReviewed(state, traceId) {
  return Boolean(state.verdicts?.[traceId] || state.notes?.some((note) => note.traceId === traceId));
}

// Does each failure mode apply to each reviewed trace?
// A note grouped into a mode marks the trace; the reviewer can override any cell.
export function modeGrid({ traces, state, patterns }) {
  const modes = patterns?.failureModes ?? [];
  const reviewed = traces.filter((trace) => isReviewed(state, trace.id));
  const noteTrace = new Map((state.notes ?? []).map((note) => [note.id, note.traceId]));
  const rows = reviewed.map((trace) => {
    const cells = {};
    for (const mode of modes) {
      const fromNotes = (mode.noteIds ?? []).some((noteId) => noteTrace.get(noteId) === trace.id);
      const override = state.grid?.[trace.id]?.[mode.key];
      cells[mode.key] = { value: typeof override === 'boolean' ? override : fromNotes, source: typeof override === 'boolean' ? 'you' : fromNotes ? 'notes' : null };
    }
    return { traceId: trace.id, at: trace.at, kind: trace.kind, release: trace.release ?? null, cells };
  });
  const prevalence = Object.fromEntries(modes.map((mode) => {
    const count = rows.filter((row) => row.cells[mode.key].value).length;
    return [mode.key, { count, of: rows.length, pct: rows.length ? Math.round((count / rows.length) * 100) : 0 }];
  }));
  return { modes, rows, prevalence };
}

export const BEFORE_FIRST = 'before the first release';

// A cleaned list of releases ({ name, at }), oldest first. A release is a version of the
// product that went live at a known time.
export function normalizeReleases(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((item) => ({ name: String(item?.name ?? '').trim().slice(0, 60), at: new Date(item?.at ?? NaN) }))
    .filter((item) => item.name && !Number.isNaN(item.at.getTime()) && !seen.has(item.name) && seen.add(item.name))
    .map((item) => ({ name: item.name, at: item.at.toISOString() })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// Releases named on the traces themselves (an optional "release" field): each starts at its earliest trace.
export function releasesFromTraces(traces) {
  const first = new Map();
  for (const trace of traces) {
    if (!trace.release) continue;
    if (!first.has(trace.release) || Date.parse(trace.at) < Date.parse(first.get(trace.release))) first.set(trace.release, trace.at);
  }
  return normalizeReleases([...first].map(([name, at]) => ({ name, at })));
}

export function releaseFor(at, releases) {
  const time = Date.parse(at);
  let current = null;
  for (const release of [...releases].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (Date.parse(release.at) <= time) current = release;
  }
  return current?.name ?? BEFORE_FIRST;
}

// Prevalence of each failure mode among reviewed traces, per release.
export function trendsByRelease({ grid, releases }) {
  const buckets = new Map();
  for (const row of grid.rows) {
    const name = row.release ?? releaseFor(row.at, releases);
    buckets.set(name, [...(buckets.get(name) ?? []), row]);
  }
  const order = [BEFORE_FIRST, ...[...releases].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((item) => item.name)]
    .filter((name) => buckets.has(name));
  return order.map((name) => {
    const rows = buckets.get(name);
    return { release: name, reviewed: rows.length, modes: Object.fromEntries(grid.modes.map((mode) => {
      const count = rows.filter((row) => row.cells[mode.key].value).length;
      return [mode.key, { count, pct: Math.round((count / rows.length) * 100) }];
    })) };
  });
}

// Which unreviewed trace to open next.
//   random: any unreviewed trace
//   variety: one of each kind (every value in the trace's dims), from the group reviewed least so far
//   slice: the next unreviewed trace in the given list (the current filter)
// The same person's conversations close in time to this one, oldest first, this one included.
// People often send several messages in a row, and each becomes its own trace: read alone, a
// reply can look wrong (or right) for reasons that only show when they are read together.
// Returns [] when there is nothing else nearby or the trace says neither who nor when.
export function nearbyTraces(traces, trace, { windowMs = 3 * 60000, limit = 9 } = {}) {
  const at = Date.parse(trace?.at);
  if (!trace || Number.isNaN(at) || (trace.person == null && trace.group == null)) return [];
  const same = (other) => (other.person ?? null) === (trace.person ?? null) && (other.group ?? null) === (trace.group ?? null);
  const near = traces.filter((other) => same(other) && Math.abs(Date.parse(other.at) - at) <= windowMs)
    .map((other) => ({ id: other.id, at: other.at, current: other.id === trace.id, seconds: Math.round((Date.parse(other.at) - at) / 1000),
      label: other.input?.label ?? other.kind ?? '', text: String(other.input?.text ?? other.output?.text ?? '').replace(/\s+/g, ' ').trim() }))
    .sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));
  if (near.length < 2) return [];
  // Keep the ones closest to this conversation when there are many.
  const index = near.findIndex((item) => item.current);
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), near.length - limit));
  return near.slice(start, start + limit);
}

export function pickNext({ traces, state, strategy = 'variety', slice = null, random = Math.random }) {
  const pool = (slice ?? traces).filter((trace) => !isReviewed(state, trace.id));
  if (!pool.length) return null;
  if (strategy === 'slice') return pool[0].id;
  if (strategy === 'random') return pool[Math.floor(random() * pool.length)].id;
  const key = (trace) => Object.keys(trace.dims ?? {}).sort().map((name) => trace.dims[name]).join('|');
  const reviewedPerGroup = new Map();
  for (const trace of traces) if (isReviewed(state, trace.id)) reviewedPerGroup.set(key(trace), (reviewedPerGroup.get(key(trace)) ?? 0) + 1);
  const groups = new Map();
  for (const trace of pool) groups.set(key(trace), [...(groups.get(key(trace)) ?? []), trace]);
  const [, members] = [...groups.entries()].sort((a, b) => (reviewedPerGroup.get(a[0]) ?? 0) - (reviewedPerGroup.get(b[0]) ?? 0)
    || b[1].length - a[1].length)[0];
  return members[Math.floor(random() * members.length)].id;
}

// Saturation: how many notes and groupings since the last new failure mode appeared.
export function saturation(patterns, state) {
  // Incomplete runs (an answer cut off part-way) say nothing about saturation.
  const runs = (patterns?.history ?? []).filter((run) => !run.partial);
  let quietRuns = 0;
  for (const run of [...runs].reverse()) {
    if (run.newModes > 0) break;
    quietRuns += 1;
  }
  const lastNew = [...runs].reverse().find((run) => run.newModes > 0);
  const notesSince = (state.notes ?? []).filter((note) => !lastNew || Date.parse(note.createdAt) > Date.parse(lastNew.at)).length;
  return { quietRuns, notesSinceNewMode: notesSince, likelySaturated: quietRuns >= 2 && notesSince >= 15 };
}

const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

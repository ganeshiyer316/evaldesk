// EvalDesk front end. Plain JavaScript, no build step.
import { connect, readSettings, writeSettings } from './backend.js';
import { nearbyTraces } from './core/stats.js';

let backend = null;
// The version this page is running: stamped at publish time, "dev" when run from the files as they are.
const VERSION = document.querySelector('meta[name="evaldesk-version"]')?.content || 'dev';
let newerVersion = null;

// An open tab keeps running the code it loaded. Ask now and then whether a newer release is out,
// and say so: otherwise a fix can be published and the reviewer never gets it.
async function checkForNewerVersion() {
  if (VERSION === 'dev' || newerVersion) return;
  try {
    const response = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const latest = response.ok ? (await response.json()).version : null;
    if (latest && latest !== VERSION) { newerVersion = latest; showNewerVersion(); }
  } catch { /* offline or blocked: try again later */ }
}

function showNewerVersion() {
  if (document.getElementById('newer')) return;
  const bar = document.createElement('div');
  bar.id = 'newer';
  bar.className = 'newer';
  bar.innerHTML = 'A newer version of EvalDesk is out. Your notes and work are kept. <button class="primary" id="reloadNow">Reload to get it</button>';
  document.body.prepend(bar);
  bar.querySelector('#reloadNow').addEventListener('click', () => location.reload());
}
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (iso) => {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

let domains = [];
let data = null;
let domainId = null;
let view = 'review';
let currentId = null;
let composer = null; // { anchor, quote }
let editing = null; // pattern key being edited
let poll = null;
const filters = { search: '', show: 'all', kind: 'all', flag: 'all', dims: {} };
let strategy = 'variety';
// The order of the conversation list: newest or oldest first. Remembered between visits.
let sortOrder = 'newest';
try { if (localStorage.getItem('evaldesk-sort') === 'oldest') sortOrder = 'oldest'; } catch {}
let judgeMode = null; // failure pattern whose judge is open
const judgeVersion = {}; // judge id → version number being viewed
let focusTest = null; // test case opened from a link
let scrollToTest = false; // scroll to it once, not on every re-render
let testFilter = 'all';
const HANDLING = {
  fix: { label: 'Fix it', icon: '🔧' }, code_check: { label: 'Code check', icon: '⚙️' }, judge: { label: 'LLM judge', icon: '⚖️' }
};

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function act(path, payload) {
  try {
    data = await backend.act(domainId, path, payload);
    render();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

const traceUrl = (id) => `#/${domainId}/review/${encodeURIComponent(id)}`;
const traceLink = (id) => `<a href="${esc(traceUrl(id))}" target="_blank" rel="noopener">${esc(id)}</a>`;
const BUILT_IN_FLAGS = { check_tool_failure: 'A tool failed and the reply doesn’t say so', check_numbers: 'A figure in the reply isn’t in any tool result or message',
  slow: 'Much slower than usual', costly: 'Costs much more than usual' };
const flagLabel = (flag) => BUILT_IN_FLAGS[flag] ?? data.domain.flags?.[flag] ?? flag.replaceAll('_', ' ');
const money = (value) => `$${value < 0.01 ? value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : value.toFixed(2)}`;
// One plain sentence per tab, so nobody has to know the jargon to know what a page is for.
const TAB_INTRO = {
  patterns: 'Patterns are the recurring ways your product goes wrong (and right), built from your notes. Correct them until they read like something you’d say.',
  grid: 'The grid shows which failure pattern applies to which conversation, and how common each one is.',
  judges: 'A judge is an AI checker for one failure pattern. You measure it against your own labels before you trust it.',
  tests: 'Test cases are conversations turned into checks you re-run after every change, so a fix stays fixed.',
  trends: 'Trends shows whether each failure pattern is getting rarer, release by release.'
};
const notesFor = (id) => data.state.notes.filter((note) => note.traceId === id);
const reviewed = (id) => Boolean(data.state.verdicts[id] || notesFor(id).length);

function setHash(nextView, id) {
  const hash = `#/${domainId}/${nextView}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash !== hash) location.hash = hash; else route();
}

async function route() {
  const [, wantedDomain, wantedView, rawId] = location.hash.split('/');
  const id = rawId ? decodeURIComponent(rawId) : null;
  if (!backend) backend = await connect();
  if (!domains.length) domains = await backend.domains();
  // A link ending in ?demo=payments opens straight into that demo, but never over existing work.
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && !route.demoTried) {
    route.demoTried = true;
    if (domains.some((item) => item.id === demo && !item.traces)) {
      try {
        const response = await fetch(`demo/${demo}.json`);
        if (response.ok) { await backend.act(demo, 'restore', { bundle: await response.json() }); domains = await backend.domains(); }
      } catch { /* the first page still offers the demo button */ }
    }
  }
  const nextDomain = domains.some((item) => item.id === wantedDomain) ? wantedDomain : domains.some((item) => item.id === demo && item.traces) ? demo : domains.find((item) => item.traces)?.id ?? domains[0].id;
  if (nextDomain !== domainId || !data) {
    domainId = nextDomain;
    data = await backend.data(domainId);
    composer = null;
    Object.assign(filters, { search: '', show: 'all', kind: 'all', flag: 'all', dims: {} });
  }
  view = ['review', 'patterns', 'grid', 'judges', 'tests', 'trends'].includes(wantedView) ? wantedView : 'review';
  if (view === 'judges' && id) judgeMode = id;
  if (view === 'tests') { focusTest = id; scrollToTest = Boolean(id); }
  currentId = id && data.traces.some((trace) => trace.id === id) ? id : currentId && data.traces.some((trace) => trace.id === currentId) ? currentId : null;
  render();
}

function header() {
  $('#domain').innerHTML = domains.map((item) => `<option value="${item.id}" ${item.id === domainId ? 'selected' : ''}>${esc(item.name)}${item.traces ? ` (${item.traces})` : ''}</option>`).join('');
  for (const tab of document.querySelectorAll('#tabs a')) {
    tab.classList.toggle('active', tab.dataset.view === view);
    tab.href = `#/${domainId}/${tab.dataset.view}`;
  }
  const goal = data.domain.reviewGoal ?? 100;
  const pct = Math.min(100, Math.round((data.reviewed / goal) * 100));
  $('#progress').innerHTML = data.traces.length
    ? `<b>${data.reviewed}</b> / ${goal} reviewed <span class="bar"><i style="width:${pct}%"></i></span> <b>${data.state.notes.length}</b> notes`
    : '';
}

// Sorts by each trace's time ("at"). Traces without a time keep their file order, after the rest.
function byTime(list) {
  const rows = list.map((trace, index) => ({ trace, index, time: Date.parse(trace.at) }));
  rows.sort((a, b) => {
    const noA = Number.isNaN(a.time), noB = Number.isNaN(b.time);
    if (noA || noB) return (noA - noB) || (a.index - b.index);
    return (sortOrder === 'newest' ? b.time - a.time : a.time - b.time) || (a.index - b.index);
  });
  return rows.map((row) => row.trace);
}

function filtered() {
  const text = filters.search.toLowerCase();
  return byTime(data.traces.filter((trace) => {
    if (filters.kind !== 'all' && trace.kind !== filters.kind) return false;
    for (const [key, value] of Object.entries(filters.dims)) if (value !== 'all' && String(trace.dims?.[key]) !== value) return false;
    if (filters.flag !== 'all' && !(trace.flags ?? []).includes(filters.flag)) return false;
    if (filters.show === 'unreviewed' && reviewed(trace.id)) return false;
    if (filters.show === 'reviewed' && !reviewed(trace.id)) return false;
    if (filters.show === 'bad' && data.state.verdicts[trace.id] !== 'bad') return false;
    if (filters.show === 'good' && data.state.verdicts[trace.id] !== 'good') return false;
    if (text && !`${trace.id} ${trace.input?.text} ${trace.output?.text} ${trace.summary}`.toLowerCase().includes(text)) return false;
    return true;
  }));
}

function options(values, selected, labels = {}) {
  return values.map((value) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(labels[value] ?? value)}</option>`).join('');
}

// A kind is "proactive" when the product spoke first (a reminder, an alert): there is no user message.
const proactive = (trace) => (data.domain.proactiveKinds ?? []).includes(trace.kind);
const kindName = (kind) => data.domain.kinds?.[kind] ?? kind;

// Filters for whatever the traces are tagged with (their "dims"), e.g. role, channel, region.
function dimFilters() {
  const values = new Map();
  for (const trace of data.traces) for (const [key, value] of Object.entries(trace.dims ?? {})) {
    if (key === 'kind' || value == null || value === '') continue;
    values.set(key, (values.get(key) ?? new Set()).add(String(value)));
  }
  return [...values].filter(([, set]) => set.size > 1 && set.size <= 12).slice(0, 4).map(([key, set]) => [key, ['all', ...[...set].sort()]]);
}

function listPanel(list) {
  const flags = ['all', ...new Set(data.traces.flatMap((trace) => trace.flags ?? []))];
  const items = list.map((trace) => {
    const verdict = data.state.verdicts[trace.id];
    const dot = verdict ?? (notesFor(trace.id).length ? 'noted' : '');
    return `<li data-id="${esc(trace.id)}" class="${trace.id === currentId ? 'current' : ''}">
      <div class="row1"><span class="dot ${dot}"></span>${esc(trace.id)} · ${when(trace.at)} · ${esc(trace.input?.label ?? '')}
        ${trace.flags?.length ? `<span class="mini" title="${esc(trace.flags.map(flagLabel).join(', '))}">⚑ ${trace.flags.length}</span>` : ''}</div>
      <div class="row2">${esc(proactive(trace) ? trace.output?.text : trace.input?.text)}</div></li>`;
  }).join('');
  return `<aside class="panel sticky" id="listPanel">
    <div class="next"><button class="primary" id="nextBtn" title="R">Review next</button>
      <select id="strategy">${options(['variety', 'random', 'slice'], strategy, { variety: 'one of each kind', random: 'random', slice: 'next in this list' })}</select></div>
    <div class="filters">
      <input type="search" id="f-search" placeholder="Search messages and replies" value="${esc(filters.search)}">
      <select id="f-show">${options(['all', 'unreviewed', 'reviewed', 'bad', 'good'], filters.show, { all: 'All', unreviewed: 'Not reviewed', reviewed: 'Reviewed', bad: 'Marked bad', good: 'Marked good' })}</select>
      <select id="f-kind">${options(['all', ...new Set(data.traces.map((trace) => trace.kind))], filters.kind, { all: 'All kinds', ...(data.domain.kinds ?? {}) })}</select>
      ${dimFilters().map(([key, values]) => `<select id="d-${esc(key)}">${options(values, filters.dims[key] ?? 'all', { all: `Any ${key}` })}</select>`).join('')}
      <select id="f-flag" style="grid-column:1/-1">${options(flags, filters.flag, { all: 'Any warning', ...Object.fromEntries(flags.slice(1).map((flag) => [flag, `⚑ ${flagLabel(flag)}`])) })}</select>
    </div>
    <div class="count sortrow"><span>Showing ${list.length} of ${data.traces.length}</span>
      <select id="sort" title="Order of this list">${options(['newest', 'oldest'], sortOrder, { newest: 'Newest first', oldest: 'Oldest first' })}</select></div>
    <ul class="list">${items || '<li class="empty">Nothing matches these filters.</li>'}</ul>
  </aside>`;
}

// Google Docs-style comments: the commented words stay highlighted in the text, and the
// comments sit in a margin next to the part they belong to. Several comments may cover
// different (even overlapping) parts of one sentence.
let blockNotes = [];

function spanOf(note, text) {
  if (Number.isInteger(note.start) && Number.isInteger(note.end) && note.end > note.start && text.slice(note.start, note.end) === note.quote) return [note.start, note.end];
  const index = note.quote ? text.indexOf(note.quote) : -1;
  return index >= 0 ? [index, index + note.quote.length] : null;
}

function markedText(text, notes) {
  const spans = notes.map((note) => ({ id: note.id, range: spanOf(note, text) })).filter((item) => item.range);
  if (!spans.length) return esc(text);
  const cuts = [...new Set([0, text.length, ...spans.flatMap((item) => item.range)])].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    const ids = spans.filter((item) => item.range[0] <= from && item.range[1] >= to).map((item) => item.id);
    html += ids.length ? `<mark data-notes="${esc(ids.join(' '))}" class="${ids.length > 1 ? 'multi' : ''}">${esc(text.slice(from, to))}</mark>` : esc(text.slice(from, to));
  }
  return html;
}

function composerHtml(placeholderLabel) {
  return `<div class="composer">${composer.quote ? `<div class="quote">“${esc(composer.quote)}”</div>` : `<div class="small" style="font-size:12px;color:var(--muted)">Note on: <b>${esc(composer.label ?? placeholderLabel)}</b></div>`}
    <textarea id="noteText" placeholder="What's wrong (or good), and what should have happened?">${esc(composer.text ?? '')}</textarea>
    <div class="actions"><button class="primary" id="saveNote">Save <kbd>⌘↵</kbd></button><button id="cancelNote">Cancel</button></div></div>`;
}

function noteCard(note) {
  const patterns = [...data.patterns.failureModes, ...data.patterns.goodPatterns].filter((mode) => mode.noteIds?.includes(note.id));
  return `<div class="note" data-note-card="${esc(note.id)}">${note.quote ? `<div class="quote">“${esc(note.quote.length > 90 ? `${note.quote.slice(0, 90)}…` : note.quote)}”</div>` : ''}
    <div>${esc(note.text)}</div>
    ${patterns.length ? `<div class="small" style="font-size:12px;color:var(--muted)">In: ${patterns.map((mode) => `<a href="#/${domainId}/patterns">${esc(mode.name)}</a>`).join(', ')}</div>` : ''}
    <div class="tools"><a data-edit-note="${esc(note.id)}">Edit</a><a data-delete-note="${esc(note.id)}">Delete</a></div></div>`;
}

// How long a step took and what it cost, as a bar against the whole conversation.
function stepTiming(step) {
  if (step.seconds == null && step.cost == null) return '';
  return `<div class="timing">${step.share != null ? `<span class="tbar"><i style="width:${Math.max(2, Math.round(step.share * 100))}%"></i></span>` : ''}
    ${[step.seconds != null && `${step.seconds} s`, step.cost != null && money(step.cost)].filter(Boolean).join(' · ')}
    ${step.slowest ? '<span class="pill warn">Slowest step</span>' : ''}${step.costliest ? '<span class="pill warn">Most costly step</span>' : ''}</div>`;
}

function block(kind, anchor, label, text, detail = '', request = '', fn = '', step = null) {
  const notes = blockNotes.filter((note) => note.anchor === anchor);
  const writing = composer && composer.anchor === anchor;
  return `<div class="row">
    <div class="block ${kind} ${step?.error ? 'failed' : ''}" data-anchor="${esc(anchor)}"><button class="blocknote" data-note-anchor="${esc(anchor)}" data-note-label="${esc(label)}" title="Note on this whole part">💬</button>
      <div class="label">${esc(label)}${fn ? ` <span class="fn" title="The function in the code that does this">(<code>${esc(fn)}</code>)</span>` : ''}${step?.error ? ' <span class="pill fail">Failed</span>' : ''}</div>${request ? `<div class="req"><b>Asked:</b> ${esc(request)}</div><div class="got">Got:</div>` : ''}<div class="text">${markedText(text, notes)}</div>${detail ? `<div class="detail">${esc(detail)}</div>` : ''}${step ? stepTiming(step) : ''}</div>
    <div class="margin">${writing ? composerHtml(label) : ''}${notes.map(noteCard).join('')}</div></div>`;
}

// The conversation in four parts: who asked, what the AI
// understood, which tools (plain code) ran with what they were asked and returned, and
// what was sent back. Each part opens and closes; the choice is remembered.
const SECTION_DEFAULTS = { user: true, reasoning: true, tools: false, assistant: true };
const openSections = (() => {
  try { return { ...SECTION_DEFAULTS, ...JSON.parse(localStorage.getItem('evaldesk-open-sections') ?? '{}') }; } catch { return { ...SECTION_DEFAULTS }; }
})();
function rememberSections() {
  try { localStorage.setItem('evaldesk-open-sections', JSON.stringify(openSections)); } catch {}
}

function section(key, icon, title, gist, anchors, body, forceOpen = false) {
  const count = blockNotes.filter((note) => anchors.includes(note.anchor)).length;
  const open = forceOpen || openSections[key] || (composer && anchors.includes(composer.anchor));
  return `<details class="sec sec-${key}" data-section="${key}" ${open ? 'open' : ''}>
    <summary><span class="sec-title">${icon} ${esc(title)}</span>${gist ? `<span class="sec-gist">${esc(gist)}</span>` : ''}${count ? `<span class="sec-notes">💬 ${count}</span>` : ''}</summary>
    <div class="sec-body">${body}</div></details>`;
}

function conversationSections(trace) {
  const steps = (trace.steps ?? []).map((step, index) => ({ ...step, anchor: step.anchor ?? `step-${index}` }));
  const totalSeconds = steps.reduce((sum, step) => sum + (step.seconds ?? 0), 0);
  const top = (field) => { const having = steps.filter((step) => step[field] > 0); return having.length > 1 ? having.reduce((a, b) => (b[field] > a[field] ? b : a)) : null; };
  const [slowest, costliest] = [top('seconds'), top('cost')];
  for (const step of steps) Object.assign(step, { share: step.seconds != null && totalSeconds ? step.seconds / totalSeconds : null, slowest: step === slowest, costliest: step === costliest });
  const reasoning = steps.filter((step) => step.section === 'reasoning');
  const tools = steps.filter((step) => step.section !== 'reasoning');
  const voice = /voice/i.test(trace.input?.label ?? '');
  const clip = (text, n = 90) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
  const stepBlock = (step) => block('step', step.anchor, step.label, step.text, step.detail, step.request, step.fn, step);
  const user = section('user', proactive(trace) ? '⏰' : '👤', proactive(trace) ? 'Trigger' : `User${trace.person ? ` (${trace.person})` : ''}`,
    clip(`${trace.input?.label ?? ''}: ${trace.input?.text ?? ''}`), ['input', ...(trace.context ?? []).map((_, index) => `context-${index}`)],
    `${trace.context?.length ? `<details class="earlier"><summary>Earlier in the conversation (${trace.context.length})</summary>
      ${trace.context.map((turn, index) => block('context', `context-${index}`, `Earlier message${turn.who ? ` · ${turn.who}` : ''}${turn.at ? ` · ${when(turn.at)}` : ''}`, turn.text)).join('')}</details>` : ''}
    ${block('input', 'input', `${trace.context?.length && !proactive(trace) ? 'This message · ' : ''}${trace.input?.label ?? 'Input'}`, trace.input?.text ?? '')}
    ${voice ? `<label class="voice"><input type="checkbox" id="transcription" ${data.state.transcription[trace.id] ? 'checked' : ''}> The transcript has a mistake (misheard name, time or word)</label>` : ''}`);
  const thinking = reasoning.length ? section('reasoning', '🧠', 'Reasoning: what it understood and decided', clip(reasoning.map((step) => step.text.split('\n')[0]).join(' → ')),
    reasoning.map((step) => step.anchor), reasoning.map(stepBlock).join('')) : '';
  const toolCalls = tools.length ? section('tools', '🔧', `Tool calls (${tools.length}${tools.some((step) => step.error) ? `, ${tools.filter((step) => step.error).length} failed` : ''}): what code did`, clip(tools.map((step) => step.short ?? step.label).join(' · ')),
    tools.map((step) => step.anchor), tools.map(stepBlock).join(''), tools.some((step) => step.error)) : '';
  const product = data.domain.labels?.product ?? 'Assistant';
  const assistant = section('assistant', '💬', proactive(trace) ? `${product} sent` : `Assistant (${product})`,
    [trace.metrics?.replyChars != null && `${trace.metrics.replyChars} characters`, trace.output?.detail].filter(Boolean).join(' · '), ['output'],
    block('output', 'output', trace.output?.label ?? 'Output', trace.output?.text ?? '', trace.output?.detail));
  return `${user}${thinking}${toolCalls}${assistant}`;
}

function casePanel(trace) {
  blockNotes = trace ? notesFor(trace.id) : [];
  if (!trace) return `<section class="panel case overview">${checksOverview()}<div class="empty">Pick a conversation in the list, or press <b>Review next</b>.</div></section>`;
  const m = trace.metrics ?? {};
  const failedSteps = (trace.steps ?? []).filter((step) => step.error);
  const tools = (trace.steps ?? []).filter((step) => step.section !== 'reasoning');
  const story = trace.summary || [tools.length ? `${tools.length} tool call${tools.length === 1 ? '' : 's'}` : 'No tools used', failedSteps.length && `${failedSteps.length} failed`, 'replied'].filter(Boolean).join(' → ');
  const meta = [m.latency != null && `⏱ ${m.latency} s`, m.cost != null && `💵 ${money(m.cost)}`, m.tokens ? `🔤 ${m.tokens.toLocaleString('en-US')} tokens` : null,
    m.steps != null && `🧩 ${m.steps} steps`, m.replyChars != null && `✉️ ${m.replyChars} characters`, trace.person && `👤 ${trace.person}`, trace.group && `👥 ${trace.group}`]
    .filter(Boolean).map((item) => `<span>${esc(item)}</span>`).join('');
  return `<section class="panel case">
    <div class="back"><a data-do="back-to-list">← All ${data.traces.length} conversations</a><span><a data-do="step" data-step="-1">‹ Previous</a> · <a data-do="step" data-step="1">Next ›</a></span></div>
    <h2>${esc(trace.id)} <span class="tag ${proactive(trace) ? 'kind-alt' : ''}">${esc(proactive(trace) ? kindName(trace.kind) : trace.input?.label ?? 'Message')}</span>
      ${trace.release ? `<span class="tag kind-alt">${esc(trace.release)}</span>` : ''} <span class="small" style="font-size:13px;color:var(--muted);font-weight:400">${when(trace.at)}</span></h2>
    <div class="meta">${meta}</div>
    <div class="chips">${(trace.chips ?? []).map((chip) => `<span class="chip">${esc(chip.text)}</span>`).join('')}
      ${(trace.flags ?? []).filter((flag) => !BUILT_IN_FLAGS[flag]).map((flag) => `<span class="chip flag">⚑ ${esc(flagLabel(flag))}</span>`).join('')}</div>
    <div class="summary"><b>What happened:</b> ${esc(story)}</div>
    ${aroundStrip(trace)}
    ${failedSteps.length ? `<div class="banner warn">⚠ ${failedSteps.length === 1 ? 'A tool failed' : `${failedSteps.length} tools failed`}: ${failedSteps.map((step) => `<b>${esc(step.label ?? step.fn ?? 'a tool')}</b>`).join(', ')}. Check whether the reply dealt with it.</div>` : ''}
    ${checkPills(trace)}
    ${trace.meta ? `<div class="extra"><b>Extra metadata:</b> ${esc(typeof trace.meta === 'string' ? trace.meta : JSON.stringify(trace.meta))}</div>` : ''}
    <div class="secbar"><a data-sections="open">Open all</a> · <a data-sections="close">Close all</a></div>
    ${conversationSections(trace)}
  </section>`;
}

// Why there are no patterns yet, naming the one thing that is actually in the way.
function noPatternsYet(grouping) {
  const notes = data.state.notes.length;
  const conversations = new Set(data.state.notes.map((note) => note.traceId)).size;
  const ready = `Your ${notes} note${notes === 1 ? '' : 's'} on ${conversations} conversation${conversations === 1 ? '' : 's'}`;
  if (conversations < 5) return `No patterns yet. Write notes on at least 5 conversations, then group them. You have notes on ${conversations} so far.`;
  if (!grouping.available) return backend.mode === 'local'
    ? `${ready} are ready to group. The only thing missing is an OpenRouter key: add OPENROUTER_API_KEY to .env and restart.`
    : `${ready} are ready to group. The only thing missing is an OpenRouter key, because grouping uses an AI model. <a data-do="open-settings"><b>Add your key in Settings</b></a>, then press “Group my notes now”.`;
  if (grouping.running) return `Grouping ${ready.replace(/^Y/, 'y')} now. A first grouping of many notes can take a few minutes; the page updates by itself, so leave it open.`;
  return `${ready} are ready. Press <b>Group my notes now</b>.`;
}

// "2 s earlier", "26 s later", "1 min later"
function offsetText(seconds) {
  const size = Math.abs(seconds);
  const amount = size < 60 ? `${size} s` : `${Math.round(size / 60)} min`;
  return seconds === 0 ? 'same moment' : `${amount} ${seconds < 0 ? 'earlier' : 'later'}`;
}

// Other conversations from the same person within a few minutes, so a run of messages can be read together.
function aroundStrip(trace) {
  const near = nearbyTraces(data.traces, trace);
  if (!near.length) return '';
  const clip = (text) => (text.length > 70 ? `${text.slice(0, 69)}…` : text);
  return `<div class="around"><b>Around this time</b> <span class="small">${esc(trace.person ?? trace.group)} sent ${near.length} messages within a few minutes. Each is its own conversation; read them together.</span>
    <ol>${near.map((item) => item.current
      ? `<li class="here"><span class="when">this one</span> <span class="what">${esc(clip(item.text))}</span></li>`
      : `<li><a data-do="open-trace" data-id="${esc(item.id)}"><span class="when">${esc(offsetText(item.seconds))}</span> <span class="what">${esc(clip(item.text))}</span> <span class="id">${esc(item.id)}${reviewed(item.id) ? ' · reviewed' : ''}</span></a></li>`).join('')}</ol></div>`;
}

// The automatic checks on one conversation: rules that ran without any AI.
function checkPills(trace) {
  const checks = (trace.checks ?? []).filter((check) => check.result !== 'na');
  if (!checks.length) return '';
  const failed = checks.filter((check) => check.result === 'fail');
  return `<div class="checks"><span class="checks-title" title="Plain rules that run on every conversation. No AI, nothing sent anywhere. A fail means: look at this one.">Automatic checks</span>
    ${checks.map((check) => `<span class="pill ${check.result}" title="${esc(check.why)}">${check.result === 'pass' ? '✓' : '✕'} ${esc(check.name)}</span>`).join('')}
    ${failed.map((check) => `<div class="check-why"><b>${esc(check.name)}:</b> ${esc(check.why)}</div>`).join('')}</div>`;
}

// Shown before a conversation is opened: what the automatic checks found across the whole file.
function checksOverview() {
  // A check that applies to no conversation in this file is left out of the table and named underneath.
  const all = data.checkSummary ?? [];
  const rows = all.filter((row) => row.failed + row.passed > 0);
  const idle = all.filter((row) => row.failed + row.passed === 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  const idleNote = idle.length ? `<p class="small" style="color:var(--muted)">${rows.length ? 'Not shown' : 'None of the checks apply to this file'}: ${idle.map((row) => `<b>${esc(row.name)}</b> (${esc(row.idle ?? 'nothing to check')})`).join('; ')}. See the <a href="https://github.com/ganeshiyer316/evaldesk/blob/main/docs/trace-format.md" target="_blank" rel="noopener">trace format</a> for the fields each check reads.</p>` : '';
  if (!rows.length) return `<h2>Automatic checks <span class="small" style="font-weight:400;color:var(--muted)">on all ${data.traces.length} conversations</span></h2>${idleNote}`;
  return `<h2>Automatic checks <span class="small" style="font-weight:400;color:var(--muted)">on all ${data.traces.length} conversations</span></h2>
    <p class="small" style="color:var(--muted)">These are plain rules that ran the moment the file was loaded. No AI was used and nothing was sent anywhere. They are rules of thumb: a fail means “look at this one”, not a verdict. ${failed ? '' : 'Nothing failed.'}</p>
    <table class="grid checks-table"><thead><tr><th class="left">Check</th><th>Failed</th><th>Passed</th><th>Doesn’t apply</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td class="left"><b>${esc(row.name)}</b><div class="small" style="color:var(--muted)">${esc(row.about)}</div></td>
      <td>${row.failed ? `<span class="pill fail">${row.failed}</span>` : '0'}</td><td>${row.passed}</td><td>${row.na}</td>
      <td>${row.failed ? `<a data-do="show-flag" data-name="${esc(row.key)}">Show ${row.failed === 1 ? 'it' : 'them'}</a>` : ''}</td></tr>`).join('')}</tbody></table>${idleNote}`;
}

function sidePanel(trace) {
  if (!trace) return '<aside></aside>';
  const verdict = data.state.verdicts[trace.id];
  const general = notesFor(trace.id).filter((note) => note.anchor === 'trace');
  const inMargin = notesFor(trace.id).length - general.length;
  return `<aside class="panel side sticky">
    <h3>Your verdict</h3>
    <div class="verdict"><button class="good ${verdict === 'good' ? 'on' : ''}" data-verdict="good">👍 Good <kbd>G</kbd></button>
      <button class="bad ${verdict === 'bad' ? 'on' : ''}" data-verdict="bad">👎 Bad <kbd>B</kbd></button></div>
    <h3>Comment on any words</h3>
    <p class="small" style="font-size:13px;color:var(--muted);margin-top:0">Select words anywhere in the conversation and click <b>💬 Comment</b>. Add as many as you like, even on parts of the same sentence. ${inMargin ? `<b>${inMargin}</b> in the margin.` : ''}</p>
    <h3>Note on the whole conversation</h3>
    ${composer?.anchor === 'trace' ? composerHtml('the whole conversation') : '<button id="addNote">+ Overall note <kbd>N</kbd></button>'}
    ${general.map(noteCard).join('')}
    <h3>Test case</h3>
    ${testCaseLine(trace)}
    <div class="keys"><kbd>←</kbd> <kbd>→</kbd> previous / next · <kbd>R</kbd> review next · <kbd>N</kbd> overall note · <kbd>G</kbd>/<kbd>B</kbd> good / bad</div>
  </aside>`;
}

function testCaseLine(trace) {
  const test = data.tests.find((item) => item.traceId === trace.id);
  if (test) return `<p class="small">✓ A <b>${test.kind}</b> test case. <a href="#/${esc(domainId)}/tests/${esc(test.id)}">Open it</a></p>`;
  return `<button data-test-create="${esc(trace.id)}">＋ Make a test case</button>
    <p class="small" style="color:var(--muted)">Turns this conversation into a check you can re-run after every change.</p>`;
}

function starterPage() {
  const pack = data.domain;
  const where = backend.mode === 'local' ? 'It is saved in the <code>evaldesk-data</code> folder on this computer.'
    : 'The file is read by this page and kept in this browser’s own storage. It is not uploaded anywhere.';
  return `<section class="panel starter" style="max-width:900px;margin:0 auto">
    <h2 style="margin-top:0">Find out where your AI product goes wrong, without writing code</h2>
    <p>Your product’s logs are the <b>camera</b>: they show what happened. EvalDesk is the <b>referee</b>: it helps you decide whether it was any good.</p>
    <p>EvalDesk is a review desk for the people who know the subject. Read real conversations, comment on them like a Google Doc, and let the tool turn your notes into named failure patterns, AI checkers you can trust, and test cases to re-run after every change.</p>
    <ol class="steps"><li><b>Automatic checks</b> run the moment you load a file, with no AI: failed tools the reply ignored, figures that came from nowhere, slow or costly replies.</li><li><b>Review</b> conversations and write what went wrong.</li><li><b>Patterns</b>: your notes are grouped into failure patterns; you correct them.</li>
      <li><b>Judges</b> and <b>Test cases</b>: measure each pattern, and watch it drop in <b>Trends</b>.</li></ol>
    <div class="startrow">${pack.demo ? `<button class="primary" data-do="load-demo">Try the ${esc(pack.name)} demo</button>` : ''}
      <button class="${pack.demo ? '' : 'primary'}" data-do="load-traces">Load your own traces file</button></div>
    <p class="small" style="color:var(--muted)">${pack.demo ? 'The demo is fictional: invented conversations, already part-reviewed so every tab has something to show. ' : ''}Your own file is a <code>traces.json</code> exported from your product. ${where} Remove names and personal details before loading it.</p>
    <details><summary>What a traces file looks like</summary><pre class="code">${esc(`[
  {
    "id": "t-001",
    "input":  { "label": "Customer", "text": "Where is my refund?" },
    "steps":  [ { "section": "tool", "label": "Look up the refund", "fn": "get_refund", "request": "order 1182", "text": "status: pending" } ],
    "output": { "label": "Assistant", "text": "Your refund is still being processed." }
  }
]`)}</pre><p class="small">Only <code>id</code>, <code>input</code> and <code>output</code> are required. The full format is in <code>docs/trace-format.md</code>.</p></details>
    <h3>${esc(pack.name)}: common failure modes (a checklist, not a verdict)</h3>
    <p class="small" style="color:var(--muted)">${esc(pack.description)} Pick another domain in the menu at the top.</p>
    <ul>${pack.starterFailureModes.map((mode) => `<li><b>${esc(mode.name)}.</b> ${esc(mode.definition)} <span class="small" style="color:var(--muted)">${esc(mode.boundaries ?? '')}</span></li>`).join('')}</ul>
    ${Object.keys(pack.dimensions ?? {}).length ? `<h3>Dimensions for synthetic test cases</h3>
    <ul>${Object.entries(pack.dimensions).map(([key, values]) => `<li><b>${esc(key)}:</b> ${values.map(esc).join(' · ')}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function renderReview() {
  if (!data.traces.length) return starterPage();
  const list = filtered();
  const trace = data.traces.find((item) => item.id === currentId);
  return `<div class="review ${trace ? 'open' : ''}">${listPanel(list)}${casePanel(trace)}${sidePanel(trace)}</div>`;
}

function patternCard(mode, list) {
  const noteById = new Map(data.state.notes.map((note) => [note.id, note]));
  const prevalence = data.grid.prevalence[mode.key];
  const others = (list === 'good' ? data.patterns.goodPatterns : data.patterns.failureModes).filter((item) => item.key !== mode.key);
  const examples = (mode.noteIds ?? []).map((id) => noteById.get(id)).filter(Boolean).map((note) => `<li>${traceLink(note.traceId)}:
      ${note.quote ? `<i>“${esc(note.quote.slice(0, 120))}”</i>: ` : ''}${esc(note.text)}
      <a class="remove" title="This example doesn't belong here" data-remove-note="${esc(note.id)}" data-key="${esc(mode.key)}" data-list="${list}">✕</a></li>`).join('');
  const isEditing = editing === `${list}:${mode.key}`;
  return `<div class="pcard ${mode.locked ? 'locked' : ''}">
    ${isEditing ? `<div class="edit">
        <input id="e-name" value="${esc(mode.name)}" placeholder="Name">
        <textarea id="e-definition" placeholder="Definition: one sentence">${esc(mode.definition)}</textarea>
        ${list === 'good' ? '' : `<textarea id="e-boundaries" placeholder="Boundaries: what is in, what is out">${esc(mode.boundaries ?? '')}</textarea>`}
        <div class="acts"><button class="primary" data-save-edit="${mode.key}" data-list="${list}">Save</button><button data-cancel-edit>Cancel</button></div></div>`
    : `<h4>${esc(mode.name)} <span class="count">${(mode.noteIds ?? []).length} notes${prevalence && list !== 'good' ? ` · ${prevalence.count} of ${data.grid.rows.length} reviewed (${prevalence.pct}%)` : ''}</span>
        ${mode.locked ? '<span class="badge">✓ confirmed</span>' : ''}${mode.isNew && !mode.locked ? '<span class="badge new">new</span>' : ''}</h4>
      <p>${esc(mode.definition)}</p>
      ${mode.boundaries ? `<p class="small"><b>Boundaries:</b> ${esc(mode.boundaries)}</p>` : ''}
      ${mode.suggestedFix ? `<p class="small"><b>Likely fix:</b> ${esc(mode.suggestedFix)}</p>` : ''}
      ${mode.howToMeasure ? `<p class="small"><b>How to measure:</b> ${esc(mode.howToMeasure)}</p>` : ''}
      ${(mode.feedback ?? []).length ? `<p class="small"><b>Your feedback:</b> ${mode.feedback.map((item) => esc(item.text)).join(' · ')}</p>` : ''}
      ${list === 'good' ? '' : handlingRow(mode)}`}
    <ul>${examples || '<li class="small">No examples yet.</li>'}</ul>
    <div class="acts">
      ${mode.locked ? '' : `<button data-approve="${mode.key}" data-list="${list}">✓ Looks right</button>`}
      <button data-start-edit="${mode.key}" data-list="${list}">✎ Edit</button>
      ${others.length ? `<select data-merge-target="${mode.key}"><option value="">Merge into…</option>${others.map((item) => `<option value="${item.key}">${esc(item.name)}</option>`).join('')}</select>
        <button data-merge="${mode.key}" data-list="${list}">Merge</button>` : ''}
      <button data-feedback="comment" data-key="${mode.key}" data-list="${list}">💬 Feedback</button>
      <button data-feedback="split" data-key="${mode.key}" data-list="${list}">✂︎ Split</button>
      <button data-delete-pattern="${mode.key}" data-list="${list}">Delete</button>
    </div></div>`;
}

// For each failure pattern, decide whether to just fix it, catch it with a code
// check, or build an LLM judge. The page suggests one; the reviewer decides.
function handlingRow(mode) {
  const suggestion = data.handling?.[mode.key];
  const chosen = mode.handle?.choice;
  const active = chosen ?? suggestion?.choice;
  const examples = data.grid.rows.filter((row) => row.cells[mode.key]?.value).length;
  const next = {
    fix: 'Fix the cause, then check Trends: the rate should drop after that release.',
    code_check: `${suggestion?.flag ? `The warning “${esc(flagLabel(suggestion.flag))}” already spots it. ` : ''}Ask for the check to be added to the evals, so every release runs it.`,
    judge: `<a href="#/${esc(domainId)}/judges/${esc(mode.key)}">Open in Judges →</a>`
  }[active];
  return `<div class="handle"><div><b>How we’ll handle it:</b>
      ${Object.entries(HANDLING).map(([key, item]) => `<button class="${chosen === key ? 'on' : ''}" data-handle="${key}" data-key="${esc(mode.key)}">${item.icon} ${item.label}</button>`).join('')}</div>
    ${suggestion ? `<p class="small"><b>${chosen ? (chosen === suggestion.choice ? 'Matches the suggestion' : `Suggested: ${HANDLING[suggestion.choice].label}`) : `Suggested: ${HANDLING[suggestion.choice].icon} ${HANDLING[suggestion.choice].label}`}.</b> ${esc(suggestion.why)}</p>` : ''}
    <p class="small">${next ?? ''}${examples ? ` <button data-tests-from="${esc(mode.key)}">Make test cases from its ${examples} example${examples === 1 ? '' : 's'}</button>` : ''}</p></div>`;
}

function renderPatterns() {
  const p = data.patterns;
  const g = data.grouping;
  const newNotes = data.state.notes.length - (p.lastRunNoteCount ?? 0);
  const sat = data.saturation;
  const assigned = new Set([...p.failureModes, ...p.goodPatterns].flatMap((mode) => mode.noteIds ?? []));
  const unassigned = data.state.notes.filter((note) => !assigned.has(note.id));
  return `<section class="patterns">
    <div class="statusbar">
      <button class="primary" id="groupNow" ${!g.available || g.running || !data.state.notes.length ? 'disabled' : ''}>${g.running ? 'Grouping…' : 'Group my notes now'}</button>
      <span class="small" style="color:var(--muted)">${g.available ? `Last grouped ${ago(p.lastRunAt)} · ${Math.max(0, newNotes)} new notes since · groups automatically every ${g.autoEvery} new notes · ${esc(g.model)}`
        : backend.mode === 'local' ? 'Add OPENROUTER_API_KEY to .env and restart to group notes with AI.' : 'Grouping uses an AI model. <a data-do="open-settings">Add your OpenRouter key in Settings</a>.'}
        ${data.state.notes.length ? ' · <a data-do="group-preview">See what is sent</a>' : ''}</span>
    </div>
    ${g.error ? `<div class="banner warn">Grouping failed: ${esc(g.error)}</div>` : ''}
    ${!g.error && p.warning ? `<div class="banner warn">${esc(p.warning)}</div>` : ''}
    ${sat.likelySaturated ? `<div class="banner">No new failure pattern in the last ${sat.quietRuns} groupings (${sat.notesSinceNewMode} notes). You may have reviewed enough for now (saturation).</div>` : ''}
    ${!p.failureModes.length && !p.goodPatterns.length ? `<div class="banner warn">${noPatternsYet(g)}</div>` : ''}
    <div class="cols">
      <div><h3>Failure patterns (${p.failureModes.length})</h3>${p.failureModes.map((mode) => patternCard(mode, 'failure')).join('') || '<p class="small">None yet.</p>'}</div>
      <div><h3>Good patterns (${p.goodPatterns.length})</h3>${p.goodPatterns.map((mode) => patternCard(mode, 'good')).join('') || '<p class="small">None yet. Notes about what works well end up here.</p>'}
        ${unassigned.length ? `<h3>Not in any pattern yet (${unassigned.length})</h3><div class="pcard"><ul>${unassigned.map((note) => `<li>${traceLink(note.traceId)}: ${esc(note.text)}</li>`).join('')}</ul></div>` : ''}
        <details><summary>Common failure modes in ${esc(data.domain.name)} (starter checklist)</summary>
          <div class="pcard"><ul>${data.domain.starterFailureModes.map((mode) => `<li><b>${esc(mode.name)}.</b> ${esc(mode.definition)}</li>`).join('')}</ul></div></details>
      </div>
    </div></section>`;
}

function renderGrid() {
  const g = data.grid;
  if (!g.modes.length) return '<div class="empty">The grid fills in once your notes are grouped into failure patterns (Patterns tab).</div>';
  if (!g.rows.length) return '<div class="empty">Review a few conversations first.</div>';
  const cell = (row, mode) => {
    const c = row.cells[mode.key];
    const mark = c.source === 'you' ? (c.value ? '<span class="yes-you">✓</span>' : '<span class="no-you">✕</span>') : c.value ? '<span class="yes-notes">●</span>' : '';
    return `<td><button data-cell="${esc(row.traceId)}" data-mode="${esc(mode.key)}" title="● from your notes · ✓ you said yes · ✕ you said no · click to change">${mark || '·'}</button></td>`;
  };
  return `<section>
    <p class="small" style="color:var(--muted)">Does each failure pattern apply to each reviewed conversation? ● comes from your notes. Click a cell to say yes (✓) or no (✕); click again to go back to your notes.</p>
    <p><a data-do="export" data-name="grid.csv">Download grid (CSV)</a> · <a data-do="export" data-name="failure-modes.md">Download failure modes (write-up)</a> · <a data-do="export" data-name="notes.csv">Download notes (CSV)</a></p>
    <div style="overflow:auto"><table class="grid"><thead><tr><th>Conversation</th>${g.modes.map((mode) => `<th>${esc(mode.name)}</th>`).join('')}</tr></thead>
      <tbody>${g.rows.map((row) => `<tr><td>${traceLink(row.traceId)} <span class="small" style="color:var(--faint)">${when(row.at)}</span></td>${g.modes.map((mode) => cell(row, mode)).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><th>Prevalence</th>${g.modes.map((mode) => `<th>${g.prevalence[mode.key].count} / ${g.rows.length} (${g.prevalence[mode.key].pct}%)</th>`).join('')}</tr></tfoot></table></div>
  </section>`;
}

function releaseEditor() {
  const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return `<div class="pcard releases"><h4>Releases</h4>
    <p class="small">A release is a version of your product going live. Add each one with its date and time, so the table can show before and after. (Or put a <code>"release"</code> field on every trace and skip this.)</p>
    <ul>${data.manualReleases.map((item) => `<li><b>${esc(item.name)}</b> · ${when(item.at)} <a class="remove" data-do="release-remove" data-name="${esc(item.name)}" title="Remove">✕</a></li>`).join('') || '<li class="small">None added yet.</li>'}</ul>
    <div class="acts"><input id="r-name" placeholder="Name, e.g. v1.4 or prompt fix" size="28"> <input id="r-at" type="datetime-local" value="${local}"> <button data-do="release-add">Add release</button></div></div>`;
}

function renderTrends() {
  const g = data.grid;
  if (!g.modes.length || !data.trends.length) return `<div class="empty">Trends appear once you have failure patterns and reviewed conversations.</div>${releaseEditor()}`;
  const rows = data.trends.map((row, index) => {
    const previous = data.trends[index - 1];
    return `<tr><td>${esc(row.release)}</td><td>${row.reviewed}</td>${g.modes.map((mode) => {
      const now = row.modes[mode.key].pct;
      const before = previous?.modes[mode.key]?.pct;
      const arrow = before == null || before === now ? '' : now < before ? ' <span class="down">↓</span>' : ' <span class="up">↑</span>';
      return `<td>${now}%${arrow}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<section><p class="small" style="color:var(--muted)">How often each failure pattern appears among reviewed conversations, per release. ↓ means it dropped after that release. Review a fresh sample every week; small samples swing a lot.</p>
    <div style="overflow:auto"><table class="grid"><thead><tr><th>Release</th><th>Reviewed</th>${g.modes.map((mode) => `<th>${esc(mode.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    ${releaseEditor()}</section>`;
}


// ---------- Judges, in plain words ----------
const pct = (value) => (value == null ? '–' : `${Math.round(value * 100)}%`);
const SET_NAMES = { train: 'examples', dev: 'tuning', test: 'final test' };

function rangeBar(part) {
  if (part.rate == null) return '';
  const [low, high] = part.range;
  return `<div class="rangebar" title="Likely between ${pct(low)} and ${pct(high)}"><span class="range" style="left:${low * 100}%;width:${(high - low) * 100}%"></span>
    <span class="point" style="left:${part.rate * 100}%"></span><span class="target" style="left:85%"></span></div>`;
}

function scorecard(result, title) {
  if (!result) return '';
  const { score } = result;
  return `<div class="scorecard"><h4>${esc(title)} <span class="small">${result.count} conversations · ${ago(result.at)}</span></h4>
    <div class="tiles">
      <div class="tile"><div class="big">${pct(score.catches.rate)}</div><div><b>Catches real failures</b>: ${score.catches.count} of ${score.catches.of}</div>
        <div class="small">Likely ${pct(score.catches.range[0])}–${pct(score.catches.range[1])}. ${score.missed ? `${score.missed} failure${score.missed === 1 ? '' : 's'} slipped through.` : ''}</div>${rangeBar(score.catches)}</div>
      <div class="tile"><div class="big">${pct(score.leavesAlone.rate)}</div><div><b>Leaves good replies alone</b>: ${score.leavesAlone.count} of ${score.leavesAlone.of}</div>
        <div class="small">Likely ${pct(score.leavesAlone.range[0])}–${pct(score.leavesAlone.range[1])}. ${score.falseAlarms ? `${score.falseAlarms} false alarm${score.falseAlarms === 1 ? '' : 's'}.` : ''}</div>${rangeBar(score.leavesAlone)}</div>
    </div>
    <div class="verdictline ${result.verdict === 'Meets the target' ? 'ok' : ''}">${esc(result.verdict)} <span class="small">(target: 85% on both; the dashed line)</span></div>
    ${score.unanswered ? `<div class="small">${score.unanswered} conversation${score.unanswered === 1 ? '' : 's'} got no clear answer from the judge.</div>` : ''}
    <details><summary>Why there's no single "agreement" score</summary><p class="small">Agreement here is ${pct(score.agreement)}, but it can mislead: if only 5 in 100 replies fail, a judge that passes everything agrees 95% of the time and catches nothing. That's why the two numbers above are shown separately. (In evals terms, "catches real failures" is the true negative rate and "leaves good replies alone" is the true positive rate.)</p></details>
  </div>`;
}

function judgeList() {
  return data.patterns.failureModes.map((mode) => {
    const judge = data.judges.find((item) => item.modeKey === mode.key);
    const fails = data.grid.rows.filter((row) => row.cells[mode.key]?.value).length;
    const latest = judge?.versions.filter((version) => version.dev).at(-1);
    const status = !judge ? 'No judge yet' : judge.final ? `✓ Final test done (v${judge.final.v})` : latest ? `v${latest.v}: catches ${pct(latest.dev.score.catches.rate)}, leaves alone ${pct(latest.dev.score.leavesAlone.rate)}` : 'Drafted, not run yet';
    return `<li data-judge-mode="${esc(mode.key)}" class="${mode.key === judgeMode ? 'current' : ''}"><div class="row2"><b>${esc(mode.name)}</b></div>
      <div class="row1">${fails} fail · ${data.grid.rows.length - fails} pass · ${esc(status)}${mode.handle && mode.handle.choice !== 'judge' ? ` · decided: ${esc(HANDLING[mode.handle.choice]?.label ?? '')}` : ''}</div></li>`;
  }).join('');
}

function judgePanel(mode) {
  const judge = data.judges.find((item) => item.modeKey === mode.key);
  if (!judge) {
    const fails = data.grid.rows.filter((row) => row.cells[mode.key]?.value).length;
    const passes = data.grid.rows.length - fails;
    return `<section class="panel"><h2 style="margin-top:0">${esc(mode.name)}</h2><p>${esc(mode.definition)}</p>
      <p>A <b>judge</b> is an AI that checks every conversation for this one problem and answers Pass or Fail, so you don't have to read them all.
      You check it against your own labels first, so you know how far to trust it.</p>
      <p>Your labels so far: <b>${fails} fail</b> and <b>${passes} pass</b>. Aim for at least 20 of each${fails < 20 || passes < 20 ? `; you need ${Math.max(0, 20 - fails)} more fail and ${Math.max(0, 20 - passes)} more pass` : ''}. You can start before that; the numbers are just less certain.</p>
      <p class="small">Tip: if this problem can be spotted with a simple rule (a word, a number, a missing field), a code check is cheaper and never drifts. The judge page shows any warning flags that already match your labels.</p>
      <button class="primary" data-judge-create="${esc(mode.key)}">Create a judge for this pattern</button></section>`;
  }
  const selected = judgeVersion[judge.id] ?? judge.versions.at(-1).v;
  const version = judge.versions.find((item) => item.v === selected) ?? judge.versions.at(-1);
  const counts = judge.counts;
  const run = judge.run;
  const devRun = version.results?.dev;
  // What a run is likely to cost, from what this judge's earlier runs actually cost per conversation.
  const paid = judge.versions.flatMap((item) => [item.dev, item.test]).filter((item) => item?.cost > 0 && item.count);
  const perCall = paid.length ? paid.reduce((sum, item) => sum + item.cost, 0) / paid.reduce((sum, item) => sum + item.count, 0) : null;
  judgePanel.perCall = perCall;
  const price = (count) => (perCall ? `about ${money(perCall * count)}` : `${count} AI call${count === 1 ? '' : 's'}`);
  const traceIds = new Set(data.traces.map((trace) => trace.id));
  const wrong = (devRun?.rows ?? []).filter((row) => row.human && row.judge !== row.human);
  const versionRows = judge.versions.map((item, index) => {
    const before = judge.versions.slice(0, index).reverse().find((entry) => entry.dev)?.dev?.score;
    const arrow = (now, then) => (then == null || now == null || now === then ? '' : now > then ? ' <span class="down">↑</span>' : ' <span class="up">↓</span>');
    const d = item.dev?.score;
    return `<tr class="${item.v === version.v ? 'sel' : ''}" data-judge-version="${item.v}" data-judge-id="${esc(judge.id)}"><td>v${item.v}</td><td class="left">${esc(item.note)}${item.leaks?.length ? ' <span class="chip flag">⚠ quotes held-out conversations</span>' : ''}</td>
      <td>${d ? `${pct(d.catches.rate)}${arrow(d.catches.rate, before?.catches.rate)}` : '–'}</td><td>${d ? `${pct(d.leavesAlone.rate)}${arrow(d.leavesAlone.rate, before?.leavesAlone.rate)}` : '–'}</td>
      <td>${item.test ? `${pct(item.test.score.catches.rate)} / ${pct(item.test.score.leavesAlone.rate)}` : ''}</td></tr>`;
  }).join('');
  const lastTwo = judge.versions.filter((item) => item.dev).slice(-3);
  const stuck = lastTwo.length === 3 && Math.max(...lastTwo.map((item) => item.dev.score.catches.rate ?? 0)) - Math.min(...lastTwo.map((item) => item.dev.score.catches.rate ?? 0)) < 0.05;
  return `<section class="panel judge">
    <h2 style="margin-top:0">${esc(judge.modeName)}</h2>
    <label class="small">Criterion: one sentence that is true for a good reply</label>
    <textarea id="j-criterion" rows="2">${esc(judge.criterion)}</textarea>
    <div class="acts"><button data-judge-save="${esc(judge.id)}">Save criterion</button>
      <label class="small">Model <input id="j-model" value="${esc(judge.model)}" size="34"></label>
      <button data-judge-delete="${esc(judge.id)}">Delete judge</button></div>

    <div class="cards3">
      ${['train', 'dev', 'test'].map((set) => `<div class="mini-card"><b>${SET_NAMES[set]}</b> <span class="small">${{ train: 'shown to the judge as examples', dev: 'used to tune the judge', test: 'locked until the end' }[set]}</span>
        <div>${counts[set].fail} fail · ${counts[set].pass} pass</div></div>`).join('')}
    </div>
    ${counts.needFail || counts.needPass ? `<div class="banner warn">For trustworthy numbers, label ${counts.needFail ? `${counts.needFail} more failing` : ''}${counts.needFail && counts.needPass ? ' and ' : ''}${counts.needPass ? `${counts.needPass} more passing` : ''} conversations (Review, then the Grid). The tool sorts them into the three sets for you.</div>` : ''}
    ${judge.codeChecks.length ? `<div class="banner">Code checks that already match your labels: ${judge.codeChecks.map((check) => `<b>⚑ ${esc(flagLabel(check.flag))}</b> catches ${check.catches.count} of ${check.catches.of} failures and leaves ${check.leavesAlone.count} of ${check.leavesAlone.of} good replies alone`).join('; ')}. A code check is cheaper and never drifts, so prefer it where it's good enough.</div>` : ''}

    <h3>Versions</h3>
    <table class="grid versions"><thead><tr><th>Version</th><th class="left">What changed</th><th>Catches failures</th><th>Leaves good alone</th><th>Final test</th></tr></thead><tbody>${versionRows}</tbody></table>
    ${stuck ? '<div class="banner warn">The last three versions barely moved. Label more conversations, try a stronger model, or split this pattern into narrower ones.</div>' : ''}

    <h3>v${version.v} <span class="small">${esc(version.note)}</span></h3>
    ${run?.running ? `<div class="banner">Running${run.kind === 'improve' ? ': writing a better prompt' : ` on ${({ dev: 'the tuning set', test: 'the final test', all: 'all conversations' })[run.kind] ?? ''}`}… ${run.total ? `${run.done} of ${run.total}` : ''}</div>` : ''}
    ${run?.error ? `<div class="banner warn">${esc(run.error)}</div>` : ''}
    ${version.leaks?.length ? `<div class="banner warn">This version quotes conversations from the tuning or final test set (${version.leaks.map(traceLink).join(', ')}), which makes its scores look better than they are. Edit the prompt to keep only general rules.</div>` : ''}
    <div class="acts">
      <button class="primary" data-judge-run="dev" data-judge-id="${esc(judge.id)}" data-v="${version.v}" ${run?.running ? 'disabled' : ''}>Run on the tuning set (${counts.dev.fail + counts.dev.pass})</button>
      <button data-judge-improve="${esc(judge.id)}" data-v="${version.v}" ${run?.running || !devRun ? 'disabled' : ''} title="${devRun ? '' : 'Run on the tuning set first'}">Improve with AI → v${judge.versions.length}</button>
      <button data-judge-run="test" data-judge-id="${esc(judge.id)}" data-v="${version.v}" ${run?.running || judge.final ? 'disabled' : ''}>${judge.final ? `Final test used (v${judge.final.v})` : `Run the final test on v${version.v} (once)`}</button>
      <button data-judge-run="all" data-judge-id="${esc(judge.id)}" data-v="${version.v}" ${run?.running ? 'disabled' : ''}>Run on all ${data.traces.length} conversations</button>
    </div>
    <p class="small">What a run costs on your OpenRouter key: tuning set ${price(counts.dev.fail + counts.dev.pass)} · final test ${price(counts.test.fail + counts.test.pass)} · all conversations ${price(data.traces.length)}${perCall ? ', going by this judge’s earlier runs' : '. Each call is one conversation, usually a fraction of a cent'}.</p>
    ${scorecard(version.dev, 'Tuning set')}
    ${scorecard(version.test, 'Final test (held out)')}
    ${version.all ? `<div class="banner">Judge's estimate: <b>${pct(version.all.failRate)}</b> of ${version.all.count} conversations have this problem (v${version.v}, ${ago(version.all.at)}). Trust it as far as the final test says.</div>` : ''}
    ${devRun ? `<h3>Where you and the judge disagree (${wrong.length})</h3>
      ${wrong.map((row) => `<div class="note"><div>${traceIds.has(row.traceId) ? traceLink(row.traceId) : esc(row.traceId)} · You: <b>${esc(row.human)}</b> · Judge: <b>${esc(row.judge ?? 'no answer')}</b></div>
        <div class="small">${esc(row.critique)}</div></div>`).join('') || '<p class="small">None. Every tuning conversation matched your label.</p>'}` : ''}
    <h3>The judge's prompt (v${version.v})</h3>
    <textarea id="j-prompt" class="mono" rows="18">${esc(version.prompt)}</textarea>
    <div class="acts"><button data-judge-saveprompt="${esc(judge.id)}">Save my edits as v${judge.versions.length}</button>
      <button data-judge-redraft="${esc(judge.id)}">Redraft from the criterion</button></div>
    <p class="small">Downloads (open in Google Sheets with File → Import): <a data-do="export" data-name="judge-scores.csv">scores per version</a> · <a data-do="export" data-name="judges.csv">every verdict with the judge's reasoning</a> · <a data-do="sent-log">see what was sent to the AI</a></p>
  </section>`;
}

function renderJudges() {
  const modes = data.patterns.failureModes;
  if (!modes.length) return '<div class="empty">Judges are built from failure patterns. Group your notes on the Patterns tab first.</div>';
  if (!modes.some((mode) => mode.key === judgeMode)) judgeMode = modes[0].key;
  return `<div class="judges"><aside class="panel sticky"><h3>Failure patterns</h3><ul class="list">${judgeList()}</ul>
    <p class="small">Labels come from the Grid: a ● or ✓ means fail, anything else on a reviewed conversation means pass.</p></aside>
    ${judgePanel(modes.find((mode) => mode.key === judgeMode))}</div>`;
}

function testCard(test) {
  const modes = data.patterns.failureModes;
  const expected = data.domain.testExpected;
  const last = test.results?.at(-1);
  const field = (name) => `t-${test.id}-${name}`;
  return `<div class="pcard test ${test.id === focusTest ? 'focus' : ''}" id="card-${esc(test.id)}">
    <h4>${traceLink(test.traceId)} <span class="kind ${test.kind}">${test.kind === 'regression' ? 'Regression' : 'Capability'}</span>
      ${last ? `<span class="badge ${last.pass ? '' : 'fail'}">${last.pass ? '✓ passed' : '✕ failed'} ${when(last.at)}</span>` : '<span class="count">not re-checked yet</span>'}</h4>
    <p class="small"><b>${esc(test.input.label)}:</b> ${esc(test.input.text)}</p>
    ${test.context?.length ? `<details class="small"><summary>Earlier in the conversation (${test.context.length})</summary>${test.context.map((turn) => `<p><b>${esc(turn.who)}:</b> ${esc(turn.text)}</p>`).join('')}</details>` : ''}
    <div class="tgrid">
      <label>Kind <select id="${field('kind')}">${options(['capability', 'regression'], test.kind, { capability: 'Capability: a goal it fails today', regression: 'Regression: works today, must keep working' })}</select></label>
      <label>Pattern <select id="${field('mode')}"><option value="">(none)</option>${modes.map((mode) => `<option value="${esc(mode.key)}" ${mode.key === test.modeKey ? 'selected' : ''}>${esc(mode.name)}</option>`).join('')}</select></label>
      <label>Checked by <select id="${field('check')}">${options(['by_hand', 'code_check', 'judge', 'exact'], test.check, { by_hand: 'You, by hand', code_check: 'A code check', judge: 'An LLM judge', exact: 'An exact expected answer' })}</select></label>
      ${Object.entries(expected ?? {}).map(([key, item]) => `<label>${esc(item.label ?? key)} <select id="${field(`x-${key}`)}"><option value="">(not set)</option>${options(item.options ?? [], test.expected?.[key] ?? '')}</select></label>`).join('')}
    </div>
    <label class="small">What ${esc(data.domain.labels?.product ?? 'the product')} already knew (starting state)
      <textarea id="${field('state')}" placeholder="e.g. The refund was already issued yesterday">${esc(test.startingState)}</textarea></label>
    <label class="small">Pass if…
      <textarea id="${field('should')}">${esc(test.shouldDo)}</textarea></label>
    <div class="acts"><button class="primary" data-test-save="${esc(test.id)}">Save</button>
      <button data-test-result="${esc(test.id)}" data-pass="1">✓ Passes now</button><button data-test-result="${esc(test.id)}" data-pass="0">✕ Fails now</button>
      ${test.kind === 'capability' && last?.pass ? `<button data-test-promote="${esc(test.id)}">Move to regression</button>` : ''}
      <button data-test-delete="${esc(test.id)}">Delete</button></div></div>`;
}

function renderTests() {
  const summary = data.testSummary;
  const product = data.domain.labels?.product ?? 'the product';
  const rate = (part) => (part.checked ? `${part.passing} of ${part.checked} re-checked pass` : 'none re-checked yet');
  const shown = data.tests.filter((test) => testFilter === 'all' || test.kind === testFilter);
  return `<section class="tests">
    <div class="pcard intro"><p>A <b>test case</b> is one conversation turned into a check: the message, what ${esc(product)} already knew, and a rule for what counts as a pass. Re-run it after every change.</p>
      <ul class="small"><li><b>Regression</b>: ${esc(product)} gets it right today and must keep getting it right.</li>
        <li><b>Capability</b>: ${esc(product)} gets it wrong today. It’s a goal; it’s fine that it fails for now. When it passes, move it to regression.</li></ul>
      <p class="small">Make them from the Review tab (<b>＋ Make a test case</b>) or from a pattern (<b>Make test cases from its examples</b>). After a change, try each message again (or run the evals) and record <b>Passes now</b> or <b>Fails now</b>.</p></div>
    <div class="statusbar"><b>${summary.total}</b> test cases · <b>${summary.regression.count}</b> regression (${rate(summary.regression)}) · <b>${summary.capability.count}</b> capability (${rate(summary.capability)})
      <select id="testFilter">${options(['all', 'regression', 'capability'], testFilter, { all: 'Show all', regression: 'Regression only', capability: 'Capability only' })}</select></div>
    ${summary.warnings.map((text) => `<div class="banner warn">${esc(text)}</div>`).join('')}
    ${summary.promotable ? `<div class="banner">${summary.promotable} capability case${summary.promotable === 1 ? '' : 's'} now pass${summary.promotable === 1 ? 'es' : ''}: move ${summary.promotable === 1 ? 'it' : 'them'} to regression so ${summary.promotable === 1 ? 'it stays' : 'they stay'} fixed.</div>` : ''}
    <p><a data-do="export" data-name="tests.csv">Download test cases (CSV, for Google Sheets)</a> · <a data-do="export" data-name="tests.jsonl">Download for an eval runner (JSONL)</a></p>
    ${shown.map(testCard).join('') || '<div class="empty">No test cases yet.</div>'}
  </section>`;
}

// Puts the conversation list back where the reviewer left it. It only moves when the open
// conversation would otherwise be out of sight (Review next, the arrow keys, a link from another
// tab), and then it brings that conversation to the middle of the list.
function keepListInPlace(was) {
  const panel = $('#listPanel');
  if (!panel || panel.scrollHeight <= panel.clientHeight) return;
  if (was != null) panel.scrollTop = was;
  const current = panel.querySelector('.list li.current');
  if (!current) return;
  const top = current.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
  const hidden = top < panel.scrollTop || top + current.offsetHeight > panel.scrollTop + panel.clientHeight;
  if (hidden) panel.scrollTop = Math.max(0, top - (panel.clientHeight - current.offsetHeight) / 2);
}

function render() {
  header();
  const main = $('#main');
  // The page is redrawn whole. Remember how far the conversation list was scrolled, so opening a
  // conversation doesn't make the list jump.
  const listWas = $('#listPanel')?.scrollTop ?? null;
  const notice = backend.persistent ? '' : '<div class="banner warn"><b>This browser is blocking storage</b> (private window?), so your work will be lost when you close the tab. Use <b>Data → Download a backup</b> before you leave.</div>';
  try {
    main.innerHTML = notice + (TAB_INTRO[view] && data.traces.length ? `<p class="tab-intro">${TAB_INTRO[view]}</p>` : '') + (view === 'patterns' ? renderPatterns() : view === 'judges' ? renderJudges() : view === 'grid' ? renderGrid() : view === 'trends' ? renderTrends() : view === 'tests' ? renderTests() : renderReview());
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="empty">This page hit an error: ${esc(error.message)}. Refresh the page; if it keeps happening, please report it with a screenshot of this message.</div>`;
  }
  if (view === 'tests' && scrollToTest) { $(`#card-${CSS.escape(focusTest)}`)?.scrollIntoView({ block: 'start' }); scrollToTest = false; }
  if (composer) $('#noteText')?.focus();
  keepListInPlace(listWas);
  // On a phone each conversation is its own screen, so start it from the top.
  if (view === 'review' && render.shown !== currentId && matchMedia('(max-width: 700px)').matches) window.scrollTo(0, 0);
  render.shown = currentId;
  clearInterval(poll);
  const busy = () => data.grouping.running || data.judges.some((judge) => judge.run?.running);
  if (busy()) poll = setInterval(async () => {
    const typing = document.activeElement?.tagName === 'TEXTAREA';
    data = await backend.data(domainId);
    if (!busy()) clearInterval(poll);
    if (!typing) render();
  }, 2000);
}

function move(step) {
  const list = filtered();
  if (!list.length) return;
  const index = list.findIndex((trace) => trace.id === currentId);
  const next = list[Math.min(list.length - 1, Math.max(0, index + step))] ?? list[0];
  composer = null;
  setHash('review', next.id);
}

async function reviewNext() {
  const { id } = await backend.ask(domainId, 'next', { strategy, ids: strategy === 'slice' ? filtered().map((trace) => trace.id) : undefined });
  if (!id) return toast('Everything here has been reviewed.');
  composer = null;
  setHash('review', id);
}

async function saveNote() {
  const text = $('#noteText')?.value.trim();
  if (!text) return toast('Write a note first.');
  if (await act('note', { traceId: currentId, anchor: composer.anchor, anchorLabel: composer.label ?? '', quote: composer.quote, start: composer.start, end: composer.end, text })) {
    composer = null;
    render();
    toast('Note saved');
  }
}

document.addEventListener('click', async (event) => {
  const t = event.target.closest('[data-judge-mode],[data-judge-create],[data-judge-save],[data-judge-delete],[data-judge-version],[data-judge-run],[data-judge-improve],[data-judge-saveprompt],[data-judge-redraft],[data-note-anchor],[data-id],[data-verdict],[data-edit-note],[data-delete-note],[data-approve],[data-start-edit],[data-save-edit],[data-cancel-edit],[data-merge],[data-feedback],[data-delete-pattern],[data-remove-note],[data-cell],[data-sections],[data-handle],[data-tests-from],[data-test-create],[data-test-save],[data-test-result],[data-test-promote],[data-test-delete],#nextBtn,#addNote,#saveNote,#cancelNote,#groupNow,#noteFromSelection');
  if (!t) return;
  if (t.matches('#noteFromSelection')) {
    composer = { ...t._pending };
    t.hidden = true;
    window.getSelection()?.removeAllRanges();
    return render();
  }
  if (t.dataset.sections) {
    for (const key of Object.keys(openSections)) openSections[key] = t.dataset.sections === 'open';
    rememberSections();
    return render();
  }
  if (t.dataset.judgeMode) { judgeMode = t.dataset.judgeMode; return render(); }
  if (t.dataset.handle) {
    const mode = data.patterns.failureModes.find((item) => item.key === t.dataset.key);
    return act('pattern', { action: 'handle', key: t.dataset.key, list: 'failure', choice: mode?.handle?.choice === t.dataset.handle ? null : t.dataset.handle });
  }
  if (t.dataset.testsFrom) {
    if (await act('test-from-pattern', { modeKey: t.dataset.testsFrom })) toast('Added to the Test cases tab as capability cases.');
    return;
  }
  if (t.dataset.testCreate) {
    if (await act('test-create', { traceId: t.dataset.testCreate })) toast('Added. Edit it on the Test cases tab.');
    return;
  }
  if (t.dataset.testSave) {
    const id = t.dataset.testSave;
    const value = (name) => document.getElementById(`t-${id}-${name}`)?.value;
    if (await act('test-update', { id, kind: value('kind'), modeKey: value('mode'), check: value('check'), startingState: value('state'), shouldDo: value('should'),
      ...(data.domain.testExpected ? { expected: Object.fromEntries(Object.keys(data.domain.testExpected).map((key) => [key, value(`x-${key}`) ?? ''])) } : {}) })) toast('Saved.');
    return;
  }
  if (t.dataset.testResult) return act('test-result', { id: t.dataset.testResult, pass: t.dataset.pass === '1' });
  if (t.dataset.testPromote) return act('test-update', { id: t.dataset.testPromote, kind: 'regression' });
  if (t.dataset.testDelete) { if (window.confirm('Delete this test case?')) return act('test-delete', { id: t.dataset.testDelete }); return; }
  if (t.dataset.judgeCreate) return act('judge-create', { modeKey: t.dataset.judgeCreate });
  if (t.dataset.judgeSave) return act('judge-update', { judgeId: t.dataset.judgeSave, criterion: $('#j-criterion').value, model: $('#j-model').value });
  if (t.dataset.judgeDelete) { if (window.confirm('Delete this judge and all its versions?')) return act('judge-delete', { judgeId: t.dataset.judgeDelete }); return; }
  if (t.dataset.judgeVersion) { judgeVersion[t.dataset.judgeId] = Number(t.dataset.judgeVersion); return render(); }
  if (t.dataset.judgeRun) {
    if (t.dataset.judgeRun === 'test' && !window.confirm('The final test can only be run once, on the version you trust most. Running it again would make it just another tuning set. Run it now on this version?')) return;
    if (t.dataset.judgeRun === 'all' && !window.confirm(`Run this judge on all ${data.traces.length} conversations? It makes one AI call per conversation${judgePanel.perCall ? `, about ${money(judgePanel.perCall * data.traces.length)} in total` : ' (usually a few cents in total)'}.`)) return;
    return act('judge-run', { judgeId: t.dataset.judgeId, v: Number(t.dataset.v), set: t.dataset.judgeRun });
  }
  if (t.dataset.judgeImprove) { judgeVersion[t.dataset.judgeImprove] = undefined; return act('judge-improve', { judgeId: t.dataset.judgeImprove, v: Number(t.dataset.v) }); }
  if (t.dataset.judgeSaveprompt) { judgeVersion[t.dataset.judgeSaveprompt] = undefined; return act('judge-version', { judgeId: t.dataset.judgeSaveprompt, prompt: $('#j-prompt').value, note: 'Edited by you' }); }
  if (t.dataset.judgeRedraft) { judgeVersion[t.dataset.judgeRedraft] = undefined; return act('judge-version', { judgeId: t.dataset.judgeRedraft }); }
  if (t.dataset.noteAnchor) { composer = { anchor: t.dataset.noteAnchor, label: t.dataset.noteLabel, quote: '' }; return render(); }
  if (t.dataset.id) { composer = null; return setHash('review', t.dataset.id); }
  if (t.id === 'nextBtn') return reviewNext();
  if (t.id === 'addNote') { composer = { anchor: 'trace', label: 'the whole conversation', quote: '' }; return render(); }
  if (t.id === 'saveNote') return saveNote();
  if (t.id === 'cancelNote') { composer = null; return render(); }
  if (t.id === 'groupNow') { data.grouping.running = true; render(); return act('group', {}); }
  if (t.dataset.verdict) {
    const same = data.state.verdicts[currentId] === t.dataset.verdict;
    return act('verdict', { traceId: currentId, verdict: same ? null : t.dataset.verdict });
  }
  if (t.dataset.editNote) {
    const note = data.state.notes.find((item) => item.id === t.dataset.editNote);
    const text = window.prompt('Edit note', note.text);
    if (text != null) return act('note-edit', { id: note.id, text });
    return;
  }
  if (t.dataset.deleteNote) return act('note-edit', { id: t.dataset.deleteNote, delete: true });
  const list = t.dataset.list === 'good' ? 'good' : 'failure';
  if (t.dataset.approve) return act('pattern', { action: 'approve', key: t.dataset.approve, list });
  if (t.dataset.startEdit) { editing = `${list}:${t.dataset.startEdit}`; return render(); }
  if (t.hasAttribute('data-cancel-edit')) { editing = null; return render(); }
  if (t.dataset.saveEdit) {
    const ok = await act('pattern', { action: 'update', key: t.dataset.saveEdit, list, name: $('#e-name').value, definition: $('#e-definition').value,
      ...($('#e-boundaries') ? { boundaries: $('#e-boundaries').value } : {}) });
    if (ok) { editing = null; render(); }
    return;
  }
  if (t.dataset.merge) {
    const into = $(`select[data-merge-target="${t.dataset.merge}"]`).value;
    if (!into) return toast('Pick a pattern to merge into.');
    return act('pattern', { action: 'merge', key: t.dataset.merge, into, list });
  }
  if (t.dataset.feedback) {
    const text = window.prompt(t.dataset.feedback === 'split' ? 'How should this pattern be split?' : 'Feedback for the next grouping (e.g. "this is really about X")');
    if (text) return act('pattern', { action: t.dataset.feedback === 'split' ? 'split' : 'comment', key: t.dataset.key, list, text });
    return;
  }
  if (t.dataset.deletePattern) { if (window.confirm('Delete this pattern? Its notes become ungrouped.')) return act('pattern', { action: 'delete', key: t.dataset.deletePattern, list }); return; }
  if (t.dataset.removeNote) return act('pattern', { action: 'remove-note', key: t.dataset.key, noteId: t.dataset.removeNote, list: t.dataset.list });
  if (t.dataset.cell) {
    const override = data.state.grid?.[t.dataset.cell]?.[t.dataset.mode];
    const fromNotes = data.grid.rows.find((row) => row.traceId === t.dataset.cell)?.cells[t.dataset.mode];
    const value = typeof override === 'boolean' ? null : !(fromNotes?.value);
    return act('grid', { traceId: t.dataset.cell, modeKey: t.dataset.mode, value });
  }
});

document.addEventListener('change', (event) => {
  const t = event.target;
  if (t.id === 'domain') { data = null; currentId = null; location.hash = `#/${t.value}/review`; return; }
  if (t.id === 'strategy') { strategy = t.value; return; }
  if (t.id === 'sort') { sortOrder = t.value === 'oldest' ? 'oldest' : 'newest'; try { localStorage.setItem('evaldesk-sort', sortOrder); } catch {} render(); return; }
  if (t.id === 'testFilter') { testFilter = t.value; render(); return; }
  if (t.id === 'transcription') { act('transcription', { traceId: currentId, value: t.checked }); return; }
  if (t.id?.startsWith('d-')) { filters.dims[t.id.slice(2)] = t.value; render(); return; }
  const key = t.id?.startsWith('f-') ? t.id.slice(2) : null;
  if (key && key !== 'search' && key in filters) { filters[key] = t.value; render(); }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'f-search') {
    filters.search = event.target.value;
    clearTimeout(document.searchTimer);
    document.searchTimer = setTimeout(() => { render(); const box = $('#f-search'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 250);
  }
  if (event.target.id === 'noteText' && composer) composer.text = event.target.value;
});

// Character offsets of the selection inside one part's text, so the exact words stay marked.
function selectionInText() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const element = (node) => (node.nodeType === 1 ? node : node.parentElement);
  const block = element(range.startContainer)?.closest('[data-anchor]');
  if (!block || block !== element(range.endContainer)?.closest('[data-anchor]')) return null;
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote) return null;
  const textEl = block.querySelector('.text');
  const pending = { anchor: block.dataset.anchor, label: block.querySelector('.label')?.firstChild?.textContent?.trim() ?? '', quote: quote.slice(0, 500) };
  if (textEl?.contains(range.startContainer) && textEl.contains(range.endContainer)) {
    const before = document.createRange();
    before.selectNodeContents(textEl);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length + (raw.length - raw.trimStart().length);
    if (quote.length <= 500) Object.assign(pending, { start, end: start + quote.length });
  }
  return { pending, rect: range.getBoundingClientRect() };
}

// A touch selection has no mouseup, so phones offer the Comment button once the selection settles.
document.addEventListener('selectionchange', () => {
  if (!matchMedia('(pointer: coarse)').matches || view !== 'review') return;
  clearTimeout(document.selectionTimer);
  document.selectionTimer = setTimeout(() => {
    const button = $('#noteFromSelection');
    const found = selectionInText();
    if (found) button._pending = found.pending;
    button.hidden = !found;
  }, 400);
});

document.addEventListener('mouseup', (event) => {
  const button = $('#noteFromSelection');
  if (event.target === button) return;
  const found = view === 'review' ? selectionInText() : null;
  if (!found) { button.hidden = true; return; }
  button._pending = found.pending;
  button.style.left = `${found.rect.left + window.scrollX}px`;
  button.style.top = `${found.rect.bottom + window.scrollY + 6}px`;
  button.hidden = false;
});

// Hovering a comment lights up its words, and clicking marked words finds their comment.
document.addEventListener('mouseover', (event) => {
  const card = event.target.closest?.('[data-note-card]');
  document.querySelectorAll('mark.active').forEach((mark) => mark.classList.remove('active'));
  if (card) document.querySelectorAll('mark[data-notes]').forEach((mark) => { if (mark.dataset.notes.split(' ').includes(card.dataset.noteCard)) mark.classList.add('active'); });
});
document.addEventListener('click', (event) => {
  const mark = event.target.closest?.('mark[data-notes]');
  if (!mark || !window.getSelection()?.isCollapsed) return;
  for (const id of mark.dataset.notes.split(' ')) {
    const card = document.querySelector(`[data-note-card="${CSS.escape(id)}"]`);
    card?.classList.add('flash');
    setTimeout(() => card?.classList.remove('flash'), 1200);
  }
});

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && document.activeElement.id === 'noteText') { event.preventDefault(); saveNote(); }
    if (event.key === 'Escape') {
      if (document.activeElement.id === 'noteText') { composer = null; render(); } else document.activeElement.blur();
    }
    return;
  }
  if (view !== 'review' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'ArrowRight' || event.key === 'j') { event.preventDefault(); move(1); }
  else if (event.key === 'ArrowLeft' || event.key === 'k') { event.preventDefault(); move(-1); }
  else if (event.key === 'r') reviewNext();
  else if (currentId && event.key === 'n') { event.preventDefault(); composer = { anchor: 'trace', label: 'the whole conversation', quote: '' }; render(); }
  else if (currentId && (event.key === 'g' || event.key === 'b')) {
    const verdict = event.key === 'g' ? 'good' : 'bad';
    act('verdict', { traceId: currentId, verdict: data.state.verdicts[currentId] === verdict ? null : verdict });
  }
});

// Remember which parts are open, so every conversation opens the same way.
document.addEventListener('toggle', (event) => {
  const key = event.target.dataset?.section;
  if (!key || openSections[key] === event.target.open) return;
  openSections[key] = event.target.open;
  rememberSections();
}, true);

// ---------- Loading traces, backups, settings, and what is sent to the AI ----------
function download(name, type, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try { resolve(JSON.parse(await file.text())); } catch { reject(new Error(`“${file.name}” is not valid JSON, so it can’t be read.`)); }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function dialog(html) {
  const el = $('#dialog');
  el.innerHTML = `<button class="close" data-do="close-dialog" title="Close">✕</button>${html}`;
  if (!el.open) el.showModal();
}

// After the set of traces changes: refresh the menu counts and go back to the Review tab.
async function reloaded(message) {
  domains = await backend.domains();
  currentId = null;
  $('#dialog').close();
  toast(message);
  setHash('review');
}

const hasWork = () => Boolean(data.state.notes.length || Object.keys(data.state.verdicts).length || data.tests.length || data.judges.length);

function dataDialog() {
  const where = backend.mode === 'local' ? 'as files in the <code>evaldesk-data</code> folder on this computer' : 'in this browser’s own storage, on this computer only';
  dialog(`<h2>Your data: ${esc(data.domain.name)}</h2>
    <p class="small">${data.traces.length} conversations, ${data.state.notes.length} notes, ${data.tests.length} test cases. Kept ${where}.${backend.mode === 'browser' ? ' Clearing your browser’s site data deletes it, so download a backup now and then.' : ''}</p>
    <h3>Traces</h3>
    <div class="acts"><button data-do="load-traces">Load a traces file (replace)</button><button data-do="add-traces">Add more traces</button>
      ${data.domain.demo ? '<button data-do="load-demo">Load the demo</button>' : ''}</div>
    <p class="small">Your notes and labels are kept when you load a newer file, as long as each conversation keeps the same id. Remove names and personal details before loading.</p>
    <h3>Your own labels</h3>
    <div class="acts"><button data-do="load-pack">Load a label pack</button>${data.domain.ownPack ? '<button data-do="remove-pack">Remove it</button>' : ''}</div>
    <p class="small">${data.domain.ownPack ? `Using your label pack${data.domain.name ? ` “${esc(data.domain.name)}”` : ''}. ` : ''}A label pack is a small file that gives this domain your product’s name, readable names for your warning flags and kinds of conversation, and your own starter checklist. It changes names only: your traces, notes and labels are untouched. <a href="https://github.com/ganeshiyer316/evaldesk/blob/main/docs/label-pack.md" target="_blank" rel="noopener">What goes in it</a>.</p>
    <h3>Backup</h3>
    <div class="acts"><button data-do="export" data-name="backup.json">Download a backup</button><button data-do="restore">Restore from a backup</button></div>
    <p class="small">A backup is one file with the traces, your notes, patterns, judges and test cases for this domain. Use it to move to another browser or share your review with a colleague.</p>
    <h3>Start again</h3>
    <div class="acts"><button class="danger" data-do="clear">Delete everything for ${esc(data.domain.name)}</button></div>`);
}

function settingsDialog() {
  const saved = readSettings();
  const keyLine = saved.apiKey ? `A key is saved in this browser (ends in …${esc(saved.apiKey.slice(-4))}). <a data-do="forget-key">Forget it</a>` : 'No key saved yet.';
  const ai = backend.mode === 'local'
    ? `<p class="small">In local mode the key and models come from the <code>.env</code> file: <code>OPENROUTER_API_KEY</code>, <code>EVALDESK_MODEL</code>, <code>EVALDESK_JUDGE_MODEL</code>. Restart after changing them. Grouping model now: <b>${esc(data.grouping.model)}</b>; judges: <b>${esc(data.judgeModel)}</b>.</p>`
    : `<label class="small">OpenRouter key <input id="s-key" type="password" autocomplete="off" placeholder="${saved.apiKey ? 'Paste a new key to replace the saved one' : 'sk-or-…'}"></label>
      <p class="small">${keyLine}<br>Create one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a> and <b>give it a small spending limit</b> (a few dollars is plenty). It is kept only in this browser and sent only to OpenRouter. Don’t save it on a shared computer.</p>
      <div class="tgrid"><label class="small">Model for grouping notes <input id="s-model" value="${esc(saved.model ?? '')}" placeholder="${esc(data.grouping.model)}"></label>
        <label class="small">Model for new judges <input id="s-judge" value="${esc(saved.judgeModel ?? '')}" placeholder="${esc(data.judgeModel)}"></label>
        <label class="small">Group automatically every … new notes <input id="s-auto" type="number" min="1" value="${esc(saved.autoGroupEvery ?? data.grouping.autoEvery)}"></label></div>`;
  dialog(`<h2>Settings</h2>
    <p class="small" style="color:var(--faint)">EvalDesk version ${esc(VERSION)}${VERSION === 'dev' ? ' (running from the files, not a published release)' : ''}</p>
    <h3>AI features</h3>
    <p class="small">Reviewing, the grid, test cases and trends need no AI. Two things do: <b>grouping notes into patterns</b> and <b>judges</b>.</p>
    ${ai}
    <h3>What is sent, and where</h3>
    <ul class="small"><li><b>Grouping</b> sends your notes, the words you quoted, and the first 200 characters of each noted conversation’s input.</li>
      <li><b>Judges</b> send the judge’s prompt and one conversation at a time (up to 4,000 characters).</li>
      <li>Both go only to OpenRouter, and only to providers that keep no data (zero data retention). Nothing is sent anywhere else.</li></ul>
    <div class="acts"><button data-do="sent-log">See exactly what was sent</button></div>
    <h3>Your product (${esc(data.domain.name)})</h3>
    <label class="small">One or two sentences about the product whose conversations you are reviewing. It is included in AI prompts.
      <textarea id="s-description" placeholder="${esc(data.domain.packDescription ?? data.domain.description)}">${esc(data.profile?.description ?? '')}</textarea></label>
    <div class="acts"><button class="primary" data-do="save-settings">Save</button><button data-do="close-dialog">Cancel</button></div>`);
}

async function sentDialog() {
  const { log } = await backend.ask(domainId, 'sent-log');
  dialog(`<h2>What was sent to the AI</h2>
    <p class="small">The last ${log.length} request${log.length === 1 ? '' : 's'} since this ${backend.mode === 'local' ? 'server started' : 'page was opened'}, newest first, exactly as sent. Your key is not shown.</p>
    ${log.map((item) => `<details><summary>${esc(item.purpose)} · ${esc(item.body.model)} · ${ago(item.at)}</summary><p class="small">To: ${esc(item.to)}</p><pre class="code">${esc(JSON.stringify(item.body, null, 2))}</pre></details>`).join('') || '<p class="empty">Nothing has been sent yet.</p>'}`);
}

async function previewDialog() {
  const preview = await backend.ask(domainId, 'group-preview');
  dialog(`<h2>What grouping sends</h2>
    <p class="small">When you group your notes, this text goes to <b>${esc(preview.model)}</b> through OpenRouter (zero-data-retention providers only). Nothing has been sent by opening this preview.</p>
    <h3>Instructions</h3><pre class="code">${esc(preview.system)}</pre><h3>Your notes</h3><pre class="code">${esc(preview.user)}</pre>`);
}

async function doAction(t) {
  const name = t.dataset.do;
  if (name === 'close-dialog') return $('#dialog').close();
  if (name === 'step') return move(Number(t.dataset.step));
  if (name === 'open-trace') { composer = null; return setHash('review', t.dataset.id); }
  if (name === 'show-flag') {
    Object.assign(filters, { search: '', show: 'all', kind: 'all', flag: t.dataset.name, dims: {} });
    const first = filtered()[0];
    return first ? setHash('review', first.id) : render();
  }
  if (name === 'back-to-list') { currentId = null; composer = null; return setHash('review'); }
  if (name === 'open-data') return dataDialog();
  if (name === 'open-settings') return settingsDialog();
  if (name === 'sent-log') return sentDialog();
  if (name === 'group-preview') return previewDialog();
  if (name === 'export') {
    const file = await backend.exportFile(domainId, t.dataset.name);
    return download(`evaldesk-${domainId}-${t.dataset.name}`, file.type, file.text);
  }
  if (name === 'load-traces' || name === 'add-traces') {
    const traces = await pickJsonFile();
    if (!traces) return;
    data = await backend.act(domainId, 'import-traces', { traces, mode: name === 'add-traces' ? 'add' : 'replace' });
    return reloaded(`${data.traces.length} conversations loaded.`);
  }
  if (name === 'load-pack') {
    const pack = await pickJsonFile();
    if (!pack) return;
    data = await backend.act(domainId, 'pack', { pack });
    return reloaded(`Label pack loaded${data.domain.name ? `: ${data.domain.name}` : ''}.`);
  }
  if (name === 'remove-pack') {
    data = await backend.act(domainId, 'pack', { pack: null });
    return reloaded('Label pack removed. Your traces, notes and labels are unchanged.');
  }
  if (name === 'load-demo') {
    if (hasWork() && !window.confirm(`Loading the demo replaces the traces, notes and results you have for ${data.domain.name}. Continue?`)) return;
    const response = await fetch(`demo/${domainId}.json`);
    if (!response.ok) throw new Error('The demo file could not be loaded.');
    data = await backend.act(domainId, 'restore', { bundle: await response.json() });
    return reloaded('Demo loaded. Every conversation in it is fictional.');
  }
  if (name === 'restore') {
    const bundle = await pickJsonFile();
    if (!bundle) return;
    if (hasWork() && !window.confirm(`Restoring replaces the traces, notes and results you have for ${data.domain.name}. Continue?`)) return;
    data = await backend.act(domainId, 'restore', { bundle });
    return reloaded('Backup restored.');
  }
  if (name === 'clear') {
    if (!window.confirm(`Delete every trace, note, pattern, judge and test case for ${data.domain.name}? This can’t be undone.`)) return;
    data = await backend.act(domainId, 'clear', {});
    return reloaded('Deleted.');
  }
  if (name === 'forget-key') {
    const { apiKey, ...rest } = readSettings();
    writeSettings(rest);
    data = await backend.data(domainId);
    render();
    return settingsDialog();
  }
  if (name === 'save-settings') {
    if (backend.mode === 'browser') {
      const saved = readSettings();
      const key = $('#s-key').value.trim();
      const auto = Number($('#s-auto').value);
      writeSettings({ ...saved, ...(key ? { apiKey: key } : {}), model: $('#s-model').value.trim(), judgeModel: $('#s-judge').value.trim(), ...(auto > 0 ? { autoGroupEvery: auto } : {}) });
    }
    const description = $('#s-description').value.trim();
    data = description !== (data.profile?.description ?? '') ? await backend.act(domainId, 'profile', { description }) : await backend.data(domainId);
    $('#dialog').close();
    render();
    return toast('Saved.');
  }
  if (name === 'release-add') {
    const releaseName = $('#r-name').value.trim();
    const at = new Date($('#r-at').value);
    if (!releaseName || Number.isNaN(at.getTime())) return toast('Give the release a name and a date.');
    return act('releases', { releases: [...data.manualReleases.filter((item) => item.name !== releaseName), { name: releaseName, at: at.toISOString() }] });
  }
  if (name === 'release-remove') return act('releases', { releases: data.manualReleases.filter((item) => item.name !== t.dataset.name) });
}

document.addEventListener('click', (event) => {
  const t = event.target.closest('[data-do]');
  if (!t) return;
  event.preventDefault();
  doAction(t).catch((error) => toast(error.message));
});

window.addEventListener('hashchange', route);
// Look for a newer release when the page opens, when the reviewer comes back to the tab, and every few minutes.
checkForNewerVersion();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewerVersion(); });
setInterval(checkForNewerVersion, 5 * 60000);
route().catch((error) => { $('#main').innerHTML = `<div class="empty">Couldn't load: ${esc(error.message)}</div>`; });

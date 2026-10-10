// Axial coding: groups the reviewer's open-coding notes into
// failure patterns and good patterns, and keeps the reviewer's corrections (locked
// names, merges, removed examples, comments) across re-runs. Only notes, the quoted
// text and the first 200 characters of each conversation's input are sent, to a
// zero-data-retention provider on OpenRouter.
import { chat, NO_KEY } from './openrouter.js';

// The model that completed a real 57-note grouping (2026-10-10) for about a cent. The earlier default
// timed out on the same job and cost twenty times as much.
export const DEFAULT_REVIEW_MODEL = 'deepseek/deepseek-v4.1-flash';

export function emptyPatterns() {
  return { failureModes: [], goodPatterns: [], excluded: [], unassigned: [], history: [], lastRunAt: null, lastRunNoteCount: 0 };
}

const slug = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'pattern';

function describe(mode, excluded) {
  const lines = [`- key: ${mode.key}${mode.locked ? ' (LOCKED: keep this exact name, definition and boundaries)' : ''}`,
    `  name: ${mode.name}`, `  definition: ${mode.definition ?? ''}`];
  if (mode.boundaries) lines.push(`  boundaries: ${mode.boundaries}`);
  for (const item of mode.feedback ?? []) lines.push(`  reviewer feedback: ${item.text}`);
  const never = excluded.filter((item) => item.modeKey === mode.key).map((item) => item.noteId);
  if (never.length) lines.push(`  never include notes: ${never.join(', ')}`);
  return lines.join('\n');
}

export function buildGroupingPrompt({ domain, notes, traces, patterns }) {
  const traceById = new Map(traces.map((trace) => [trace.id, trace]));
  const noteLines = notes.map((note) => {
    const trace = traceById.get(note.traceId);
    const snippet = trace ? `${trace.input?.text ?? ''}`.replace(/\s+/g, ' ').slice(0, 200) : '';
    return JSON.stringify({ id: note.id, trace: note.traceId, verdict: note.verdict ?? null, on: note.anchorLabel || undefined, quote: (note.quote ?? '').slice(0, 300),
      note: note.text, message: snippet });
  });
  const existing = [...(patterns.failureModes ?? [])].map((mode) => describe(mode, patterns.excluded ?? []));
  const good = [...(patterns.goodPatterns ?? [])].map((mode) => describe(mode, patterns.excluded ?? []));
  const system = `You help a product reviewer do axial coding: grouping their open-coding notes about an AI product into a small taxonomy.
Product: ${domain.description}
Rules:
- Group notes about problems into 5 to 8 distinct failure patterns when there is enough material (fewer is fine for few notes). Group positive notes into good patterns.
- Use the reviewer's own words. Names are short and plain (no jargon). Definitions are one sentence. Boundaries say what is in and what is out.
- Each pattern needs at least one note. A note may belong to more than one pattern only if it clearly describes two problems.
- Keep existing pattern keys when a pattern still fits. Never change a LOCKED pattern's name, definition or boundaries; only assign notes to it.
- Follow every piece of reviewer feedback. Never put a note in a pattern it is excluded from.
- For each failure pattern, suggest the most likely fix and how to measure it (a code check or an eval case), in one sentence each.
- For each failure pattern, also say how to handle it: "fix" when the cause is a clear bug or a missing instruction (just fix it), "code_check" when a simple rule on the reply or the saved data can spot it, "judge" when spotting it needs judgement about meaning or tone. Give the reason in one plain sentence.
- Return JSON only.`;
  const user = `Existing failure patterns:\n${existing.join('\n') || '(none yet)'}\n\nExisting good patterns:\n${good.join('\n') || '(none yet)'}\n
Notes (one JSON object per line):\n${noteLines.join('\n')}\n
Return: {"failure_modes":[{"key","name","definition","boundaries","note_ids":[],"suggested_fix","how_to_measure","handle","handle_why"}],"good_patterns":[{"key","name","definition","note_ids":[]}],"unassigned_note_ids":[]}`;
  return { system, user };
}

// Pulls every complete {...} object out of the array that follows "key": [ in a text, even when the
// text stops part-way through (an answer cut off at the token limit). Braces inside strings are ignored.
function salvageArray(text, keys) {
  for (const key of keys) {
    const at = text.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
    if (at < 0) continue;
    const items = [];
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = text.indexOf('[', at) + 1; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { items.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip a broken item */ } start = -1; } }
      else if (c === ']' && depth === 0) break;
    }
    if (items.length) return items;
  }
  return [];
}

const FAILURE_KEYS = ['failure_modes', 'failure_patterns', 'failureModes', 'failures'];
const GOOD_KEYS = ['good_patterns', 'goodPatterns', 'good'];

export function parseGrouping(content) {
  const text = String(content ?? '');
  let parsed = null;
  try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { parsed = null; }
  const list = (value) => (Array.isArray(value) ? value : []);
  const first = (keys) => keys.map((key) => parsed?.[key]).find(Array.isArray);
  // A whole answer is read as it is. A cut-off one is searched for the patterns that did arrive.
  const failures = parsed ? list(first(FAILURE_KEYS)) : salvageArray(text, FAILURE_KEYS);
  const good = parsed ? list(first(GOOD_KEYS)) : salvageArray(text, GOOD_KEYS);
  const mode = (item) => ({ key: slug(item?.key || item?.name), name: String(item?.name ?? '').trim(), definition: String(item?.definition ?? '').trim(),
    boundaries: String(item?.boundaries ?? '').trim(), noteIds: list(item?.note_ids ?? item?.noteIds).map(String),
    suggestedFix: String(item?.suggested_fix ?? '').trim(), howToMeasure: String(item?.how_to_measure ?? '').trim(),
    ...(['fix', 'code_check', 'judge'].includes(item?.handle) ? { handleSuggestion: item.handle, handleWhy: String(item?.handle_why ?? '').trim() } : {}) });
  return {
    failureModes: failures.map(mode).filter((item) => item.name),
    goodPatterns: good.map(mode).filter((item) => item.name),
    unassigned: list(parsed?.unassigned_note_ids).map(String),
    partial: !parsed && (failures.length > 0 || good.length > 0)
  };
}

// Says, in plain words, why an answer held no patterns, so the next step is clear.
export function emptyGroupingReason(reply, model) {
  const text = String(reply?.content ?? '').trim();
  if (!text) return reply?.thought || reply?.finish === 'length'
    ? `${model} used up its answer on thinking and wrote nothing. Choose a different model for grouping in Settings.`
    : `${model} sent back an empty answer. Try again, or choose a different model for grouping in Settings.`;
  if (reply?.finish === 'length') return `${model}’s answer was cut off before the first pattern was complete. Choose a different model for grouping in Settings.`;
  return `${model} answered, but not with patterns in the form asked for. Try again, or choose a different model in Settings. Its answer began: “${text.replace(/\s+/g, ' ').slice(0, 140)}”`;
}

// Combines a fresh grouping with what the reviewer already decided.
export function mergeGrouping({ previous, result, notes, now = new Date(), model = null }) {
  const noteIds = new Set(notes.map((note) => note.id));
  const excluded = previous.excluded ?? [];
  const allowed = (modeKey) => (id) => noteIds.has(id) && !excluded.some((item) => item.modeKey === modeKey && item.noteId === id);
  function combine(oldList, newList) {
    const oldByKey = new Map((oldList ?? []).map((item) => [item.key, item]));
    const used = new Set();
    const merged = newList.map((item) => {
      const old = oldByKey.get(item.key);
      used.add(item.key);
      const base = old?.locked ? { ...item, name: old.name, definition: old.definition, boundaries: old.boundaries } : item;
      return { ...base, noteIds: [...new Set(item.noteIds)].filter(allowed(item.key)), locked: Boolean(old?.locked),
        feedback: old?.feedback ?? [], ...(old?.handle ? { handle: old.handle } : {}), createdAt: old?.createdAt ?? now.toISOString(), isNew: !old };
    });
    for (const old of oldList ?? []) {
      if (old.locked && !used.has(old.key)) merged.push({ ...old, noteIds: (old.noteIds ?? []).filter(allowed(old.key)), isNew: false });
    }
    return merged.filter((item) => item.noteIds.length || item.locked);
  }
  const failureModes = combine(previous.failureModes, result.failureModes);
  const goodPatterns = combine(previous.goodPatterns, result.goodPatterns);
  const newModes = failureModes.filter((item) => item.isNew).length;
  return {
    ...previous,
    failureModes, goodPatterns,
    unassigned: result.unassigned.filter((id) => noteIds.has(id)),
    lastRunAt: now.toISOString(), lastRunNoteCount: notes.length,
    history: [...(previous.history ?? []), { at: now.toISOString(), notes: notes.length, newModes, model }].slice(-50)
  };
}

export async function groupNotes({ domain, notes, traces, patterns, apiKey, model = DEFAULT_REVIEW_MODEL,
  baseUrl = 'https://openrouter.ai', fetchImpl = fetch, now = new Date(), timeoutMs = 300000 }) {
  // Five minutes: a first grouping can hold dozens of notes and a long answer, and two minutes was not enough for a slower model.
  if (!apiKey) throw new Error(NO_KEY);
  if (!notes.length) throw new Error('Add a few notes first.');
  const { system, user } = buildGroupingPrompt({ domain, notes, traces, patterns });
  const reply = await chat({ purpose: 'Grouping notes into patterns', apiKey, model, baseUrl, fetchImpl, json: true, temperature: 0.2, maxTokens: 16000, timeoutMs,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const result = parseGrouping(reply.content);
  if (!result.failureModes.length && !result.goodPatterns.length) throw new Error(emptyGroupingReason(reply, model));
  const merged = mergeGrouping({ previous: patterns, result, notes, now, model });
  // A cut-off answer still gives the patterns that arrived whole; say so, since some notes will be left over.
  if (!result.partial) return { ...merged, warning: null };
  // A cut-off answer: say how the model used its room, which shows whether thinking crowded the answer out.
  const t = reply.tokens ?? {};
  const used = t.reply ? ` It used ${t.reply.toLocaleString('en-US')} of ${t.room.toLocaleString('en-US')} tokens${t.thinking ? `, ${t.thinking.toLocaleString('en-US')} of them on thinking` : ''}.` : '';
  return { ...merged, warning: `${model}’s answer was cut off, so this grouping is incomplete: some notes are not in a pattern yet.${used} Group again, or choose a different model in Settings.` };
}

// The reviewer's corrections. Every edit locks the pattern so the next run keeps it.
export function applyEdit(patterns, edit, now = new Date()) {
  const next = structuredClone(patterns);
  const listName = edit.list === 'good' ? 'goodPatterns' : 'failureModes';
  const list = next[listName];
  const find = (key) => list.find((item) => item.key === key);
  const target = find(edit.key);
  if (!target && edit.action !== 'add') throw new Error('Pattern not found');
  switch (edit.action) {
    case 'approve': target.locked = true; break;
    case 'update':
      for (const field of ['name', 'definition', 'boundaries', 'suggestedFix', 'howToMeasure']) if (typeof edit[field] === 'string') target[field] = edit[field].trim();
      target.locked = true; break;
    case 'comment': target.feedback = [...(target.feedback ?? []), { text: String(edit.text ?? '').trim(), at: now.toISOString() }].filter((item) => item.text); break;
    case 'split':
      target.feedback = [...(target.feedback ?? []), { text: `Split this pattern: ${String(edit.text ?? '').trim() || 'it mixes different problems'}`, at: now.toISOString() }];
      target.locked = false; break;
    case 'merge': {
      const into = find(edit.into);
      if (!into || into === target) throw new Error('Pick another pattern to merge into');
      into.noteIds = [...new Set([...(into.noteIds ?? []), ...(target.noteIds ?? [])])];
      into.feedback = [...(into.feedback ?? []), { text: `Merged “${target.name}” into this pattern.`, at: now.toISOString() }];
      into.locked = true;
      next[listName] = list.filter((item) => item !== target);
      break;
    }
    case 'remove-note':
      target.noteIds = (target.noteIds ?? []).filter((id) => id !== edit.noteId);
      next.excluded = [...(next.excluded ?? []), { modeKey: target.key, noteId: edit.noteId }];
      break;
    case 'delete': next[listName] = list.filter((item) => item !== target); break;
    // How the reviewer decided to handle a failure pattern. Doesn't lock it: names can still change.
    case 'handle':
      if (['fix', 'code_check', 'judge'].includes(edit.choice)) target.handle = { choice: edit.choice, at: now.toISOString() };
      else delete target.handle;
      break;
    case 'add':
      list.push({ key: `${slug(edit.name)}-${Date.now().toString(36)}`, name: String(edit.name ?? '').trim(), definition: String(edit.definition ?? '').trim(),
        boundaries: '', noteIds: [], locked: true, feedback: [], createdAt: now.toISOString() });
      break;
    default: throw new Error(`Unknown edit: ${edit.action}`);
  }
  return next;
}

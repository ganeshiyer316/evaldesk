// Where the page's data lives. Two choices, picked automatically:
//   browser: everything runs in this tab. Traces and notes are kept in this browser's own
//            storage (IndexedDB) and the OpenRouter key in localStorage. Nothing is uploaded.
//   local:   the optional local server (npm start) keeps the same data as files on disk.
import { createEngine, memoryStore } from './core/engine.js';

const PACKS = ['payments', 'healthcare', 'general'];
const SETTINGS_KEY = 'evaldesk-settings';

function indexedDbStore() {
  const open = new Promise((resolve, reject) => {
    const request = indexedDB.open('evaldesk', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('docs');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, work) => {
    const db = await open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const result = work(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(result?.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    ready: open,
    get: (domainId, name) => run('readonly', (docs) => docs.get(`${domainId}/${name}`)),
    set: (domainId, name, value) => run('readwrite', (docs) => (value == null ? docs.delete(`${domainId}/${name}`) : docs.put(value, `${domainId}/${name}`))),
    remove: (domainId) => run('readwrite', (docs) => docs.delete(IDBKeyRange.bound(`${domainId}/`, `${domainId}/￿`)))
  };
}

export function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'); } catch { return {}; }
}

export function writeSettings(value) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}

async function browserBackend() {
  const packs = await Promise.all(PACKS.map(async (id) => (await fetch(`packs/${id}.json`)).json()));
  let store = null;
  let persistent = true;
  try {
    store = indexedDbStore();
    await store.ready;
  } catch {
    store = memoryStore();
    persistent = false;
  }
  const engine = createEngine({ store, packs, settings: async () => readSettings(), linkBase: `${location.origin}${location.pathname}` });
  return {
    mode: 'browser', persistent,
    domains: () => engine.listDomains(),
    data: (domainId) => engine.snapshot(domainId),
    act: (domainId, action, payload) => engine.action(domainId, action, payload),
    ask: (domainId, name, payload) => engine.query(domainId, name, payload),
    exportFile: async (domainId, name) => {
      const result = await engine.exportFile(domainId, name);
      if (!result) throw new Error('Unknown download');
      return { type: result[0], text: result[1] };
    }
  };
}

function localBackend() {
  const call = async (path, payload) => {
    const response = await fetch(path, payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? 'Something went wrong');
    return json;
  };
  return {
    mode: 'local', persistent: true,
    domains: () => call('api/domains'),
    data: (domainId) => call(`api/${domainId}/data`),
    act: (domainId, action, payload) => call(`api/${domainId}/${action}`, payload ?? {}),
    ask: (domainId, name, payload) => call(`api/${domainId}/ask/${name}`, payload ?? {}),
    exportFile: async (domainId, name) => {
      const response = await fetch(`api/${domainId}/export/${name}`);
      if (!response.ok) throw new Error('Unknown download');
      return { type: response.headers.get('content-type') ?? 'text/plain', text: await response.text() };
    }
  };
}

export async function connect() {
  // The local server only ever runs on this computer, so the hosted site never asks.
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return browserBackend();
  try {
    const response = await fetch('api/ping');
    if (response.ok && (await response.json()).evaldesk === 'local') return localBackend();
  } catch { /* no local server: run in the browser */ }
  return browserBackend();
}

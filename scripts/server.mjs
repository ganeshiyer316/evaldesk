// EvalDesk on your own computer (127.0.0.1 only).
//   npm start      local mode: traces, notes and results are files in ./evaldesk-data,
//                  and the OpenRouter key comes from .env
//   npm run site   serves the page only, exactly as the hosted site runs it (data stays
//                  in the browser)
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../site/core/engine.js';
import { normalizeReleases } from '../site/core/stats.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, 'site');
const staticOnly = process.argv.includes('--static');
const dataDir = resolve(process.env.EVALDESK_DATA_DIR ?? join(root, 'evaldesk-data'));
const port = Number(process.env.EVALDESK_PORT ?? (staticOnly ? 8022 : 8021));
const apiKey = process.env.OPENROUTER_API_KEY ?? '';

// Optional: read releases from git tags of your product's repository, e.g.
// EVALDESK_RELEASE_REPO=../my-product EVALDESK_RELEASE_TAGS='v*'
function gitReleases() {
  const repo = process.env.EVALDESK_RELEASE_REPO;
  if (!repo) return [];
  try {
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)\t%(creatordate:iso-strict)', `refs/tags/${process.env.EVALDESK_RELEASE_TAGS ?? '*'}`], { cwd: resolve(repo), encoding: 'utf8' });
    return normalizeReleases(out.split('\n').filter(Boolean).map((line) => { const [name, at] = line.split('\t'); return { name, at }; }));
  } catch {
    return [];
  }
}

const safe = (value) => { if (!/^[a-z0-9-]+$/.test(value)) throw new Error('Not found'); return value; };
const file = (domainId, name) => join(dataDir, safe(domainId), `${safe(name)}.json`);
const fileStore = {
  async get(domainId, name) {
    let value = null;
    try { value = JSON.parse(await readFile(file(domainId, name), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return value;
  },
  async set(domainId, name, value) {
    const target = file(domainId, name);
    if (value == null) return rm(target, { force: true });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${target}.tmp`, target);
  },
  async remove(domainId) {
    await rm(join(dataDir, safe(domainId)), { recursive: true, force: true });
  }
};

const packs = [];
for (const name of (await readdir(join(siteDir, 'packs'))).filter((item) => item.endsWith('.json'))) packs.push(JSON.parse(await readFile(join(siteDir, 'packs', name), 'utf8')));
const engine = createEngine({
  store: fileStore, packs, extraReleases: async () => gitReleases(), linkBase: `http://localhost:${port}/`,
  settings: async () => ({ apiKey, model: process.env.EVALDESK_MODEL, judgeModel: process.env.EVALDESK_JUDGE_MODEL, baseUrl: process.env.OPENROUTER_BASE_URL, autoGroupEvery: process.env.EVALDESK_AUTO_GROUP_EVERY })
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (response, status, value, type = 'application/json') => {
  response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  response.end(type === 'application/json' ? JSON.stringify(value) : value);
};

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function serveFile(pathname, response) {
  const target = resolve(siteDir, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`);
  if (target !== siteDir && !target.startsWith(siteDir + sep)) return send(response, 404, { error: 'Not found' });
  try {
    const content = await readFile(target);
    response.writeHead(200, { 'content-type': `${TYPES[extname(target)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
    return response.end(content);
  } catch {
    return send(response, 404, { error: 'Not found' });
  }
}

async function handle(request, response) {
  const url = new URL(request.url, `http://localhost:${port}`);
  if (!url.pathname.startsWith('/api/')) return request.method === 'GET' ? serveFile(url.pathname, response) : send(response, 405, { error: 'Method not allowed' });
  if (url.pathname === '/api/ping') return send(response, 200, { evaldesk: staticOnly ? 'browser' : 'local' });
  if (staticOnly) return send(response, 404, { error: 'Not found' });
  if (url.pathname === '/api/domains') return send(response, 200, await engine.listDomains());
  const match = url.pathname.match(/^\/api\/([a-z0-9-]+)\/([a-z-]+)(?:\/([A-Za-z0-9._-]+))?$/);
  if (!match) return send(response, 404, { error: 'Not found' });
  const [, domainId, action, param] = match;
  if (request.method === 'GET' && action === 'data') return send(response, 200, await engine.snapshot(domainId));
  if (request.method === 'GET' && action === 'export') {
    const result = await engine.exportFile(domainId, param);
    if (!result) return send(response, 404, { error: 'Unknown export' });
    return send(response, 200, result[1], result[0]);
  }
  if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' });
  // Only this page may change data: other websites open in the same browser are refused.
  const origin = request.headers.origin;
  if (origin && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) return send(response, 403, { error: 'Not allowed' });
  const input = await body(request);
  if (action === 'ask') return send(response, 200, await engine.query(domainId, param, input));
  return send(response, 200, await engine.action(domainId, action, input));
}

createServer((request, response) => {
  handle(request, response).catch((error) => send(response, 400, { error: error.message }));
}).listen(port, '127.0.0.1', () => {
  console.log(`EvalDesk: http://localhost:${port}`);
  if (staticOnly) return console.log('Page only: data stays in your browser, as on the hosted site.');
  console.log(`Data and notes: ${dataDir} (local only, ignored by Git)`);
  console.log(apiKey ? 'AI features use your OpenRouter key from .env (zero-data-retention providers only).'
    : 'OPENROUTER_API_KEY is not set, so grouping and judges are off. Everything else works.');
});

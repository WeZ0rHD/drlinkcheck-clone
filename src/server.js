#!/usr/bin/env node
/**
 * Zero-dependency HTTP server: serves the UI + crawl API.
 *  POST /api/crawls { url, options } -> { id }
 *  GET  /api/crawls/:id             -> progress + summary + groups + links + pages
 *  GET  /api/crawls/:id/export?format=csv|json
 *  GET  /                           -> UI
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { crawl } from './crawler.js';
import { toCSV, toJSON } from './export.js';
import { diffCrawls } from './diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data', 'crawls');
const PORT = Number(process.env.PORT || 4177);

const crawls = new Map(); // id -> { id, status, progress, result?, error? }

function send(res, code, body, type = 'application/json') {
  const buf = Buffer.from(body);
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

function sendFile(res, file) {
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return send(res, 404, JSON.stringify({ error: 'not found' }));
  }
  const ext = path.extname(full).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(full).pipe(res);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function persist(id, result) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, `${id}.json`), toJSON(result), 'utf8');
  } catch { /* best-effort */ }
}

function loadPersisted(id) {
  try {
    if (!/^[0-9a-f-]{1,64}$/i.test(id)) return null;
    return JSON.parse(fs.readFileSync(path.join(DATA, `${id}.json`), 'utf8'));
  } catch { return null; }
}

/** Project history: live entries first, then every persisted crawl on disk. */
function historyIndex() {
  const out = [...crawls.values()].map((c) => ({
    id: c.id, status: c.status, url: c.url, progress: c.progress,
    summary: c.result?.summary || null, error: c.error || null,
    createdAt: c.createdAt || null, recrawlOf: c.recrawlOf || null,
  }));
  try {
    fs.mkdirSync(DATA, { recursive: true });
    for (const f of fs.readdirSync(DATA)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (crawls.has(id)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
        out.push({
          id, status: 'done', url: r.startUrl, progress: null,
          summary: r.summary || null, error: null,
          createdAt: r.finishedAt || null, recrawlOf: null, persisted: true,
        });
      } catch { /* skip corrupt files, never crash history */ }
    }
  } catch { /* history is best-effort */ }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/** Full result for an id: live entry when done, else persisted file. */
function loadResult(id) {
  const entry = crawls.get(id);
  if (entry && entry.status === 'done' && entry.result) return entry.result;
  return loadPersisted(id);
}

function sanitizeOpts(o = {}) {
  const arr = Array.isArray(o.exclude) ? o.exclude.filter((s) => typeof s === 'string').slice(0, 50)
    : typeof o.exclude === 'string' && o.exclude ? o.exclude.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  return {
    maxPages: Math.min(5000, Math.max(1, Number(o.maxPages) || 100)),
    maxDepth: Math.min(20, Math.max(0, Number(o.maxDepth ?? 5))),
    concurrency: Math.min(16, Math.max(1, Number(o.concurrency) || 5)),
    delayMs: Math.min(10000, Math.max(0, Number(o.delayMs ?? 200))),
    timeoutMs: Math.min(60000, Math.max(2000, Number(o.timeoutMs) || 15000)),
    exclude: arr,
    respectRobots: o.respectRobots !== false,
    includeExternal: o.includeExternal !== false,
    checkImages: o.checkImages === true,
    checkResources: o.checkResources === true,
    js: 'off', // JS-rendered mode lives in the CLI with an explicit renderer; UI stays static (clearly separate)
  };
}

function startCrawl(startUrl, opts, extra = {}) {
  const id = randomUUID();
  const entry = {
    id, status: 'running', url: startUrl,
    progress: { crawled: 0, queued: 1, links: 0, maxPages: opts.maxPages || 100 },
    result: null, error: null, createdAt: new Date().toISOString(),
    recrawlOf: extra.recrawlOf || null,
  };
  crawls.set(id, entry);
  crawl(startUrl, {
    ...opts,
    userAgent: 'LinkAuditorMVP/1.0 (+polite; respects robots.txt)',
    onProgress: (pr) => { entry.progress = pr; },
  }).then((result) => {
    entry.status = 'done';
    entry.result = result;
    entry.progress = { crawled: result.summary.pages, queued: 0, links: result.summary.links, maxPages: result.options.maxPages };
    persist(id, result);
  }).catch((e) => {
    entry.status = 'error';
    entry.error = String(e?.message || e);
  });
  return entry;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/assets/')) return sendFile(res, p.slice(1));
    if (req.method === 'GET' && (p === '/app.js' || p === '/styles.css')) return sendFile(res, p.slice(1));

    if (req.method === 'GET' && p === '/api/crawls') {
      return send(res, 200, JSON.stringify(historyIndex()));
    }

    if (req.method === 'POST' && p === '/api/crawls') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON body' })); }
      if (!body || !body.url) return send(res, 400, JSON.stringify({ error: 'url is required' }));
      let startUrl;
      try {
        startUrl = new URL(body.url).toString();
        if (!['http:', 'https:'].includes(new URL(startUrl).protocol)) throw new Error('bad protocol');
      } catch { return send(res, 400, JSON.stringify({ error: 'url must be an absolute http(s) URL' })); }
      const o = sanitizeOpts(body.options || {});
      const entry = startCrawl(startUrl, o);
      return send(res, 201, JSON.stringify({ id: entry.id, status: 'running', url: startUrl }));
    }

    const rm = /^\/api\/crawls\/([^/]+)\/recrawl$/.exec(p);
    if (req.method === 'POST' && rm) {
      const base = loadResult(rm[1]);
      if (!base) return send(res, 404, JSON.stringify({ error: 'unknown crawl id' }));
      let raw = {};
      try { raw = JSON.parse(await readBody(req) || '{}'); }
      catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON body' })); }
      // re-crawl = same stored options; caller-supplied option fields win
      const user = raw && typeof raw.options === 'object' ? raw.options : {};
      const merged = { ...(base.options || {}) };
      for (const k of ['maxPages', 'maxDepth', 'concurrency', 'delayMs', 'timeoutMs', 'exclude', 'respectRobots', 'includeExternal', 'checkImages', 'checkResources']) {
        if (user[k] !== undefined) merged[k] = user[k];
      }
      const entry = startCrawl(base.startUrl, sanitizeOpts(merged), { recrawlOf: rm[1] });
      return send(res, 201, JSON.stringify({ id: entry.id, status: 'running', url: base.startUrl, recrawlOf: rm[1] }));
    }

    const dm = /^\/api\/crawls\/([^/]+)\/diff\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && dm) {
      const a = loadResult(dm[1]);
      const b = loadResult(dm[2]);
      if (!a || !b) return send(res, 404, JSON.stringify({ error: 'unknown crawl id (need two finished crawls)' }));
      return send(res, 200, JSON.stringify({ ...diffCrawls(a, b), aId: dm[1], bId: dm[2] }));
    }

    const m = /^\/api\/crawls\/([^/]+)(\/export)?$/.exec(p);
    if (req.method === 'GET' && m) {
      const entry = crawls.get(m[1]);
      const result = entry?.result || loadPersisted(m[1]);
      if (!entry && !result) return send(res, 404, JSON.stringify({ error: 'unknown crawl id' }));
      if (m[2] === '/export') {
        if (!result) {
          return send(res, 409, JSON.stringify({ error: `crawl not done (status=${entry.status})` }));
        }
        const format = (u.searchParams.get('format') || 'json').toLowerCase();
        if (format === 'csv') {
          return send(res, 200, toCSV(result.links), 'text/csv; charset=utf-8');
        }
        return send(res, 200, toJSON(result), 'application/json; charset=utf-8');
      }
      if (result) {
        return send(res, 200, JSON.stringify({
          id: m[1], status: entry?.status || 'done', url: entry?.url || result.startUrl, ...result,
        }));
      }
      return send(res, 200, JSON.stringify({
        version: 1, id: entry.id, status: entry.status, url: entry.url,
        progress: entry.progress, error: entry.error,
      }));
    }

    return send(res, 404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`drlinkcheck-clone UI on http://localhost:${PORT}`);
});

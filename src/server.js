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

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/assets/')) return sendFile(res, p.slice(1));
    if (req.method === 'GET' && (p === '/app.js' || p === '/styles.css')) return sendFile(res, p.slice(1));

    if (req.method === 'GET' && p === '/api/crawls') {
      return send(res, 200, JSON.stringify([...crawls.values()].map((c) => ({
        id: c.id, status: c.status, url: c.url, progress: c.progress,
        summary: c.result?.summary || null, error: c.error || null,
      }))));
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
      const o = body.options || {};
      const id = randomUUID();
      const entry = {
        id, status: 'running', url: startUrl,
        progress: { crawled: 0, queued: 1, links: 0, maxPages: o.maxPages || 100 },
        result: null, error: null, createdAt: new Date().toISOString(),
      };
      crawls.set(id, entry);
      crawl(startUrl, {
        maxPages: Math.min(5000, Math.max(1, Number(o.maxPages) || 100)),
        maxDepth: Math.min(20, Math.max(0, Number(o.maxDepth ?? 5))),
        concurrency: Math.min(16, Math.max(1, Number(o.concurrency) || 5)),
        delayMs: Math.min(10000, Math.max(0, Number(o.delayMs ?? 200))),
        timeoutMs: Math.min(60000, Math.max(2000, Number(o.timeoutMs) || 15000)),
        userAgent: 'LinkAuditorMVP/1.0 (+polite; respects robots.txt)',
        exclude: Array.isArray(o.exclude) ? o.exclude.filter((s) => typeof s === 'string').slice(0, 50)
          : typeof o.exclude === 'string' && o.exclude ? o.exclude.split('\n').map((s) => s.trim()).filter(Boolean) : [],
        respectRobots: o.respectRobots !== false,
        includeExternal: o.includeExternal !== false,
        checkImages: o.checkImages === true,
        checkResources: false,
        js: 'off', // JS-rendered mode lives in the CLI with an explicit renderer; UI stays static (clearly separate)
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
      return send(res, 201, JSON.stringify({ id, status: 'running', url: startUrl }));
    }

    const m = /^\/api\/crawls\/([^/]+)(\/export)?$/.exec(p);
    if (req.method === 'GET' && m) {
      const entry = crawls.get(m[1]);
      if (!entry) return send(res, 404, JSON.stringify({ error: 'unknown crawl id' }));
      if (m[2] === '/export') {
        if (entry.status !== 'done' || !entry.result) {
          return send(res, 409, JSON.stringify({ error: `crawl not done (status=${entry.status})` }));
        }
        const format = (u.searchParams.get('format') || 'json').toLowerCase();
        if (format === 'csv') {
          return send(res, 200, toCSV(entry.result.links), 'text/csv; charset=utf-8');
        }
        return send(res, 200, toJSON(entry.result), 'application/json; charset=utf-8');
      }
      if (entry.status === 'done') {
        return send(res, 200, JSON.stringify({
          id: entry.id, status: entry.status, url: entry.url, ...entry.result,
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

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { crawl } from '../src/crawler.js';
import { startFixtureServer } from '../src/fixture.js';
import { diffCrawls } from '../src/diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'crawls');
const createdIds = [];
after(() => {
  for (const id of createdIds) {
    try { fs.unlinkSync(path.join(DATA, `${id}.json`)); } catch { /* best-effort */ }
  }
});

function baseOpts(extra = {}) {
  return {
    maxPages: 30, maxDepth: 4, concurrency: 4, delayMs: 0, timeoutMs: 8000,
    checkImages: true, respectRobots: true, includeExternal: true, ...extra,
  };
}

describe('orphan-ish indicators', () => {
  it('flags sitemap-only pages as orphan and never flags the start page', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    try {
      const r = await crawl(`http://127.0.0.1:${port}/`, baseOpts());
      assert.ok((r.summary.orphans || 0) >= 1, `expected >=1 orphan, got ${JSON.stringify(r.summary)}`);
      assert.ok(Array.isArray(r.summary.orphanUrls) && r.summary.orphanUrls.length >= 1);
      const lonely = Object.values(r.pages).find((p) => (p.finalUrl || p.url).endsWith('/lonely'));
      assert.ok(lonely, 'sitemap-seeded /lonely must be crawled');
      assert.equal(lonely.orphan, true);
      assert.equal(lonely.inbound, 0);
      const start = r.pages[Object.keys(r.pages).find((k) => r.pages[k].url === `http://127.0.0.1:${port}/`)];
      assert.ok(start && start.orphan === false, 'start page is never orphan');
      const home = Object.values(r.pages).find((p) => (p.finalUrl || p.url).endsWith('/about'));
      assert.ok(home && home.orphan === false && home.inbound > 0, '/about is linked, not orphan');
    } finally {
      server.close();
    }
  });
});

describe('diffCrawls', () => {
  const link = (over = {}) => ({
    sourceUrl: 'http://e.com/', anchorText: 'x', targetUrl: 'http://e.com/a', kind: 'a',
    internal: true, status: 200, statusLabel: '200', finalUrl: 'http://e.com/a',
    issue: 'ok', redirectHops: 0, chain: [], observedAt: '2026-01-01T00:00:00.000Z',
    renderer: 'static', error: null, ...over,
  });
  const res = (links, startUrl = 'http://e.com/') => ({
    version: 1, startUrl, finishedAt: '2026-01-02T00:00:00.000Z',
    summary: { pages: 1, links: links.length }, pages: {}, links,
  });

  it('reports added / removed / fixed / newly_broken with before+after evidence', () => {
    const a = res([
      link({ targetUrl: 'http://e.com/stays', issue: 'ok' }),
      link({ targetUrl: 'http://e.com/heals', issue: 'broken', status: 404, statusLabel: '404' }),
      link({ targetUrl: 'http://e.com/vanishes', issue: 'ok' }),
    ]);
    const b = res([
      link({ targetUrl: 'http://e.com/stays', issue: 'ok' }),
      link({ targetUrl: 'http://e.com/heals', issue: 'ok', status: 200, statusLabel: '200' }),
      link({ targetUrl: 'http://e.com/breaks', issue: 'ok' }),
      link({ targetUrl: 'http://e.com/breaks2', issue: 'ok' }),
    ]);
    // break "breaks" in b only: rebuild with a broken record
    b.links = b.links.map((l) => (l.targetUrl.endsWith('/breaks')
      ? { ...l, issue: 'broken', status: 500, statusLabel: '500' } : l));
    const d = diffCrawls(a, b);
    assert.equal(d.sameScope, true);
    assert.equal(d.links.added, 2);
    assert.equal(d.links.removed, 1);
    assert.equal(d.links.fixed, 1);
    assert.equal(d.links.newlyBroken, 1); // /breaks arrived already broken
    assert.equal(d.links.changed, 1); // only /heals changed signature
    const fixed = d.links.changedItems.find((c) => c.targetUrl.endsWith('/heals'));
    assert.ok(fixed && fixed.before.status === 404 && fixed.after.status === 200);
  });

  it('flags different scopes without failing', () => {
    const d = diffCrawls(res([]), res([], 'http://other.com/'));
    assert.equal(d.sameScope, false);
    assert.equal(d.links.added, 0);
  });
});

describe('server history / recrawl / diff API', () => {
  const PORT = 4181;
  let child = null;

  async function api(p, opts = {}) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, opts);
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* csv/text */ }
    return { status: r.status, json, body };
  }
  async function waitDone(id, timeoutMs = 25000) {
    const t0 = Date.now();
    for (;;) {
      const r = await api(`/api/crawls/${id}`);
      assert.equal(r.status, 200);
      if (r.json.status === 'done') return r.json;
      assert.notEqual(r.json.status, 'error', `crawl errored: ${r.json.error}`);
      assert.ok(Date.now() - t0 < timeoutMs, 'crawl did not finish in time');
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  it('crawl -> history -> recrawl -> diff -> export', async (t) => {
    t.timeout = 90000;
    const fixture = await startFixtureServer(0);
    const fport = fixture.address().port;
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
    });
    t.after(() => { try { child.kill(); } catch { /* ignore */ } });
    // wait for server boot
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await api('/api/crawls');
        if (r.status === 200) break;
      } catch { /* retry */ }
      assert.ok(Date.now() - t0 < 15000, 'server did not boot');
      await new Promise((res) => setTimeout(res, 200));
    }
    try {
      const created = await api('/api/crawls', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `http://127.0.0.1:${fport}/`,
          options: { maxPages: 15, maxDepth: 3, concurrency: 3, delayMs: 0, checkImages: true },
        }),
      });
      assert.equal(created.status, 201);
      const id = created.json.id;
      createdIds.push(id);
      const done = await waitDone(id);
      assert.ok(done.summary.pages >= 5, `expected pages>=5, got ${done.summary.pages}`);
      assert.ok((done.summary.orphans || 0) >= 1, 'history crawl must carry orphan summary');

      const hist = await api('/api/crawls');
      assert.equal(hist.status, 200);
      assert.ok(hist.json.some((c) => c.id === id), 'finished crawl appears in history');

      const again = await api(`/api/crawls/${id}/recrawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(again.status, 201);
      assert.equal(again.json.recrawlOf, id);
      createdIds.push(again.json.id);
      await waitDone(again.json.id);

      const d = await api(`/api/crawls/${id}/diff/${again.json.id}`);
      assert.equal(d.status, 200);
      assert.equal(d.json.sameScope, true);
      assert.ok(typeof d.json.links.added === 'number');

      const csv = await api(`/api/crawls/${id}/export?format=csv`);
      assert.equal(csv.status, 200);
      assert.ok(csv.body.startsWith('source_url,anchor_text,target_url'));

      const missing = await api('/api/crawls/nope/diff/nope2');
      assert.equal(missing.status, 404);
    } finally {
      fixture.close();
    }
  });
});

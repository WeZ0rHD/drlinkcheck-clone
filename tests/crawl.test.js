import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawl, fetchChain } from '../src/crawler.js';
import { startFixtureServer } from '../src/fixture.js';
import { toCSV } from '../src/export.js';

function baseOpts(extra = {}) {
  return {
    maxPages: 30, maxDepth: 4, concurrency: 4, delayMs: 0, timeoutMs: 8000,
    checkImages: true, respectRobots: true, includeExternal: true, ...extra,
  };
}

describe('fetchChain', () => {
  it('detects redirect loops instead of hanging', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    try {
      const fc = await fetchChain(`http://127.0.0.1:${port}/loop-a`, {
        fetchImpl: globalThis.fetch.bind(globalThis), timeoutMs: 8000, userAgent: 'test',
      });
      assert.equal(fc.loop, true);
      assert.ok(fc.chain.length >= 2, 'chain must show the A->B->A walk');
      const viaCrawl = await crawl(`http://127.0.0.1:${port}/`, baseOpts());
      assert.ok(viaCrawl.links.some((l) => l.issue === 'redirect_loop'), 'crawl must label the looping link');
    } finally {
      server.close();
    }
  });
});

describe('fixture crawl', () => {
  it('finds broken, redirect, anchor_missing, noindex and canonicalized with real evidence', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    try {
      const r = await crawl(`http://127.0.0.1:${port}/`, baseOpts());
      const issues = r.summary.groups;
      assert.ok((issues.broken || 0) >= 2, `expected broken>=2, got ${JSON.stringify(issues)}`);
      assert.ok((issues.redirect || 0) >= 1, 'expected a redirect');
      assert.ok((issues.anchor_missing || 0) >= 1, 'expected anchor_missing');
      assert.ok((issues.noindex_destination || 0) >= 1, 'expected noindex_destination');
      assert.ok((issues.canonicalized || 0) >= 1, 'expected canonicalized');
      for (const l of r.links) {
        assert.ok(l.observedAt, 'every link needs observed_at');
        assert.ok(l.renderer === 'static', 'renderer must be labeled');
        if (l.status == null && !['NOT_CHECKED', 'EXCLUDED', 'BLOCKED'].includes(l.statusLabel)) {
          assert.equal(l.statusLabel, 'UNKNOWN');
        }
      }
      const broken = r.links.find((l) => l.targetUrl.endsWith('/gone'));
      assert.ok(broken && broken.status === 404, 'dead page must carry real 404 evidence');
    } finally {
      server.close();
    }
  });

  it('marks unreachable hosts UNKNOWN (never faked)', async () => {
    // closed port on loopback: connection refused, fast and deterministic
    const probe = await new Promise((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const r = await crawl(`http://127.0.0.1:${probe}/`, baseOpts({ maxPages: 2 }));
    const pg = Object.values(r.pages)[0];
    assert.equal(pg.status, null);
    assert.equal(pg.statusLabel, 'UNKNOWN');
    assert.ok(pg.error, 'UNKNOWN must carry error evidence');
  });

  it('resume continues from checkpoint without losing pages', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const cp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'cp.json');
    try {
      const first = await crawl(`http://127.0.0.1:${port}/`, baseOpts({ maxPages: 3, checkpointPath: cp }));
      assert.ok(fs.existsSync(cp), 'checkpoint file must exist');
      const resumed = await crawl(`http://127.0.0.1:${port}/`, baseOpts({ checkpointPath: cp, resume: true }));
      assert.ok(resumed.resumedAt, 'resumed run must be labeled');
      assert.ok(resumed.summary.pages >= first.summary.pages, 'resume must not lose pages');
    } finally {
      server.close();
    }
  });

  it('CSV export carries header + one row per link', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    try {
      const r = await crawl(`http://127.0.0.1:${port}/`, baseOpts());
      const csv = toCSV(r.links);
      const lines = csv.trim().split('\r\n');
      assert.ok(lines[0].startsWith('source_url,anchor_text,target_url'), 'CSV header');
      assert.equal(lines.length - 1, r.links.length, 'one row per link');
    } finally {
      server.close();
    }
  });

  it('exclusions skip matching targets', async () => {
    const server = await startFixtureServer(0);
    const port = server.address().port;
    try {
      const r = await crawl(`http://127.0.0.1:${port}/`, baseOpts({ exclude: ['/gone', '/old'] }));
      const gone = r.links.filter((l) => l.targetUrl.endsWith('/gone'));
      assert.ok(gone.length > 0 && gone.every((l) => l.issue === 'excluded'), 'excluded targets labeled');
    } finally {
      server.close();
    }
  });

  it('js:on without renderer fails with a typed error (separate mode)', async () => {
    delete process.env.LINKAUDIT_JS_RENDERER;
    await assert.rejects(
      () => crawl('http://127.0.0.1:9/', baseOpts({ js: 'on' })),
      /JS_RENDERER_NOT_CONFIGURED/,
    );
  });
});

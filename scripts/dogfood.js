#!/usr/bin/env node
/**
 * Dogfood proof: controlled fixture crawl + one small public site
 * (https://example.com — single page, robots allow all) with polite
 * rate (concurrency 2, 1000ms delay). Writes evidence JSON files.
 * Set DOGFOOD_PUBLIC=0 to run the fixture part only (offline-safe).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from '../src/crawler.js';
import { startFixtureServer } from '../src/fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(__dirname, '..', 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const summary = { at: new Date().toISOString(), parts: [] };

// 1) controlled fixture
{
  const server = await startFixtureServer(0);
  const port = server.address().port;
  const r = await crawl(`http://127.0.0.1:${port}/`, {
    maxPages: 30, maxDepth: 4, concurrency: 4, delayMs: 0,
    checkImages: true, respectRobots: true,
  });
  server.closeAllConnections?.();
  server.close();
  fs.writeFileSync(path.join(EVIDENCE, `dogfood-${stamp}-fixture.json`), JSON.stringify({
    target: 'fixture (local controlled site)',
    summary: r.summary, links: r.links,
  }, null, 2));
  summary.parts.push({ target: 'fixture', pages: r.summary.pages, links: r.summary.links, groups: r.summary.groups });
  console.log(`[fixture] pages=${r.summary.pages} links=${r.summary.links} groups=${JSON.stringify(r.summary.groups)}`);
}

// 2) public small site (polite)
if (process.env.DOGFOOD_PUBLIC !== '0') {
  try {
    const r = await crawl('https://example.com/', {
      maxPages: 5, maxDepth: 2, concurrency: 2, delayMs: 1000,
      checkImages: false, respectRobots: true, includeExternal: false,
    });
    fs.writeFileSync(path.join(EVIDENCE, `dogfood-${stamp}-example.json`), JSON.stringify({
      target: 'https://example.com/', robotsRespected: true,
      summary: r.summary, links: r.links,
    }, null, 2));
    summary.parts.push({ target: 'https://example.com/', pages: r.summary.pages, links: r.summary.links, groups: r.summary.groups });
    console.log(`[example.com] pages=${r.summary.pages} links=${r.summary.links} groups=${JSON.stringify(r.summary.groups)}`);
  } catch (e) {
    summary.parts.push({ target: 'https://example.com/', error: String(e?.message || e) });
    console.log(`[example.com] SKIPPED/FAILED: ${e.message}`);
  }
}

fs.writeFileSync(path.join(EVIDENCE, `dogfood-${stamp}-summary.json`), JSON.stringify(summary, null, 2));
console.log(`evidence in evidence/dogfood-${stamp}-*.json`);
process.exit(0);

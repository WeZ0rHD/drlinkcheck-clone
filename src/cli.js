#!/usr/bin/env node
/** Headless crawl CLI: node src/cli.js --url https://example.com [--max-pages 50] [--out result.json] [--format json|csv] */
import fs from 'node:fs';
import path from 'node:path';
import { crawl } from './crawler.js';
import { toCSV, toJSON } from './export.js';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const url = arg('url');
if (!url) {
  console.error('Usage: node src/cli.js --url <start-url> [--max-pages N] [--max-depth N] [--concurrency N] [--delay-ms N] [--timeout-ms N] [--exclude sub [--exclude ...]] [--images] [--resources] [--no-external] [--no-robots] [--js] [--checkpoint path] [--resume] [--out path] [--format json|csv]');
  process.exit(2);
}
const excludes = process.argv.flatMap((a, i, arr) => (a === '--exclude' ? [arr[i + 1]] : [])).filter(Boolean);

const started = Date.now();
const result = await crawl(url, {
  maxPages: Number(arg('max-pages', '100')),
  maxDepth: Number(arg('max-depth', '5')),
  concurrency: Number(arg('concurrency', '5')),
  delayMs: Number(arg('delay-ms', '200')),
  timeoutMs: Number(arg('timeout-ms', '15000')),
  exclude: excludes,
  includeExternal: !flag('no-external'),
  respectRobots: !flag('no-robots'),
  checkImages: flag('images'),
  checkResources: flag('resources'),
  js: flag('js') ? 'on' : 'off',
  checkpointPath: arg('checkpoint', null),
  resume: flag('resume'),
  onProgress: (p) => process.stderr.write(`\r[crawl] pages=${p.crawled} queued=${p.queued} links=${p.links}`),
}).catch((e) => {
  console.error(`\nCRAWL_FAILED: ${e.message}`);
  process.exit(1);
});
process.stderr.write('\n');

const format = (arg('format', 'json') || 'json').toLowerCase();
const out = arg('out', null);
const payload = format === 'csv' ? toCSV(result.links) : toJSON(result);
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, payload, 'utf8');
  console.log(`wrote ${out} (${result.summary.pages} pages, ${result.summary.links} links)`);
} else {
  process.stdout.write(payload + (format === 'csv' ? '' : '\n'));
}
console.error(`done in ${((Date.now() - started) / 1000).toFixed(1)}s — pages=${result.summary.pages} links=${result.summary.links} broken=${result.summary.broken} redirects=${result.summary.redirects} loops=${result.summary.loops} unknown=${result.summary.unknown}`);

/**
 * Bounded-concurrency website link auditor.
 *
 * Each check carries real HTTP evidence + observed_at.
 * Unreachable/blocked targets are reported as UNKNOWN — never faked.
 *
 * JS-rendered mode is intentionally separate: `js: 'off'` (default, static
 * fetch) vs `js: 'on'` which requires an external renderer endpoint
 * (LINKAUDIT_JS_RENDERER) and is labeled as such in every record.
 */
import {
  toAbsolute, normalizeKey, sameHost, extractLinks, extractCanonical,
  extractMetaRobots, extractTitle, extractAnchors,
} from './normalize.js';
import { parseRobots, isAllowed, extractSitemapLocs } from './robots.js';

export const MAX_REDIRECTS = 10;

export function defaultOptions() {
  return {
    maxPages: 100,
    maxDepth: 5,
    concurrency: 5,
    delayMs: 200,
    timeoutMs: 15000,
    userAgent: 'LinkAuditorMVP/1.0 (+polite; respects robots.txt)',
    exclude: [],            // substrings or /regex/ strings
    respectRobots: true,
    includeExternal: true,
    checkImages: false,
    checkResources: false,
    js: 'off',              // 'off' | 'on' (separate renderer, see below)
    checkpointPath: null,
    resume: false,
    onProgress: null,
    fetchImpl: null,        // override for tests
  };
}

export function compileExclusions(list) {
  return (list || []).map((s) => {
    const t = String(s);
    if (t.startsWith('/') && t.lastIndexOf('/') > 0) {
      const end = t.lastIndexOf('/');
      try { return new RegExp(t.slice(1, end), t.slice(end + 1)); } catch { /* fallthrough */ }
    }
    return t;
  });
}

function isExcluded(url, compiled) {
  for (const e of compiled) {
    if (typeof e === 'string') { if (url.includes(e)) return true; }
    else if (e.test(url)) return true;
  }
  return false;
}

async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

function fetchWithTimeout(fetchImpl, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  return fetchImpl(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

/**
 * Manual redirect walk. Returns { chain, finalUrl, status, headers, error }.
 * chain: [{ url, status, location }]. Loop => { loop: true }.
 */
export async function fetchChain(rawUrl, o, rendererLabel = 'static') {
  const chain = [];
  const seen = new Set();
  let current = rawUrl;
  let status = null;
  let headers = {};
  let error = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const key = current.split('#')[0];
    if (seen.has(key)) {
      return { chain, finalUrl: current, status, headers, error: null, loop: true, renderer: rendererLabel };
    }
    seen.add(key);
    let res;
    try {
      res = await fetchWithTimeout(o.fetchImpl, current, {
        redirect: 'manual',
        headers: { 'User-Agent': o.userAgent, Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8' },
      }, o.timeoutMs);
    } catch (e) {
      error = e?.name === 'AbortError' ? `timeout after ${o.timeoutMs}ms` : (e?.message || String(e));
      return { chain, finalUrl: current, status: null, headers, error, loop: false, renderer: rendererLabel };
    }
    status = res.status;
    headers = {};
    try {
      for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
    } catch { /* ignore */ }
    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location');
      try { await res.arrayBuffer(); } catch { /* drain */ }
      if (!loc) {
        chain.push({ url: current, status, location: null });
        return { chain, finalUrl: current, status, headers, error: 'redirect without Location', loop: false, renderer: rendererLabel };
      }
      chain.push({ url: current, status, location: loc });
      try {
        current = new URL(loc, current).toString();
      } catch {
        return { chain, finalUrl: current, status, headers, error: `bad redirect Location: ${loc}`, loop: false, renderer: rendererLabel };
      }
      continue;
    }
    // non-redirect final
    return { chain, finalUrl: current, status, headers, error: null, loop: false, renderer: rendererLabel, response: res };
  }
  return { chain, finalUrl: current, status, headers, error: `too many redirects (>${MAX_REDIRECTS})`, loop: false, renderer: rendererLabel };
}

async function readBodySafe(res, maxChars = 2_000_000) {
  try {
    const text = await res.text();
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return '';
  }
}

export async function crawl(startUrl, userOpts = {}) {
  const o = { ...defaultOptions(), ...userOpts };
  o.fetchImpl = o.fetchImpl || globalThis.fetch.bind(globalThis);
  if (!o.fetchImpl) throw new Error('NO_FETCH: global fetch unavailable (Node>=20 required)');
  if (o.js === 'on' && !process.env.LINKAUDIT_JS_RENDERER) {
    throw new Error('JS_RENDERER_NOT_CONFIGURED: js:"on" requires LINKAUDIT_JS_RENDERER external renderer URL. Static mode remains available with js:"off".');
  }
  const rendererLabel = o.js === 'on' ? `js-via:${process.env.LINKAUDIT_JS_RENDERER}` : 'static';

  const start = new URL(startUrl);
  start.hash = '';
  const startHref = start.toString();
  const exclusions = compileExclusions(o.exclude);

  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    startUrl: startHref,
    options: { ...o, fetchImpl: undefined, onProgress: undefined },
    queue: [{ url: startHref, depth: 0, source: null }],
    visitedPages: {},   // key -> page record
    visitedSet: [],
    links: [],          // link records
    linkKeys: [],
    robotsCache: {},    // host -> { txt, allowed... } (parsed not serialized)
    sitemapSeeded: {},
    stats: { fetched: 0, blocked: 0, excluded: 0, unknown: 0 },
  };
  const visited = new Set();
  const linkKeySet = new Set();
  const robotsParsed = {};

  // ---- resume ----
  if (o.resume && o.checkpointPath) {
    try {
      const fs = await import('node:fs');
      const raw = fs.readFileSync(o.checkpointPath, 'utf8');
      const saved = JSON.parse(raw);
      if (saved && saved.version === 1 && saved.startUrl === startHref) {
        state.queue = saved.queue || state.queue;
        state.visitedPages = saved.visitedPages || {};
        state.links = saved.links || [];
        state.stats = saved.stats || state.stats;
        for (const k of Object.keys(state.visitedPages)) visited.add(k);
        for (const l of state.links) linkKeySet.add(`${l.sourceUrl}||${l.targetUrl}`);
        state.resumedAt = new Date().toISOString();
      }
    } catch { /* fresh start when checkpoint unreadable */ }
  }

  async function saveCheckpoint() {
    if (!o.checkpointPath) return;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(path.dirname(o.checkpointPath), { recursive: true });
      fs.writeFileSync(o.checkpointPath, JSON.stringify({
        version: 1, startUrl: startHref, queue: state.queue,
        visitedPages: state.visitedPages, links: state.links, stats: state.stats,
        savedAt: new Date().toISOString(),
      }), 'utf8');
    } catch { /* checkpoint is best-effort */ }
  }

  async function robotsCheck(url) {
    if (!o.respectRobots) return { allowed: true, crawlDelay: null, robotsTxt: null };
    const host = new URL(url).origin;
    if (!robotsParsed[host]) {
      let txt = null;
      try {
        const res = await fetchWithTimeout(o.fetchImpl, `${host}/robots.txt`, {
          redirect: 'follow', headers: { 'User-Agent': o.userAgent },
        }, Math.min(o.timeoutMs, 10000));
        if (res.status === 200) txt = await res.text();
      } catch { txt = null; }
      robotsParsed[host] = { parsed: parseRobots(txt), txt };
      // sitemap awareness: seed same-host locs once
      if (!state.sitemapSeeded[host]) {
        state.sitemapSeeded[host] = true;
        const seeds = [];
        for (const s of robotsParsed[host].parsed.sitemaps) seeds.push(s);
        seeds.push(`${host}/sitemap.xml`);
        for (const s of seeds.slice(0, 3)) {
          try {
            const r = await fetchWithTimeout(o.fetchImpl, s, {
              redirect: 'follow', headers: { 'User-Agent': o.userAgent },
            }, Math.min(o.timeoutMs, 10000));
            if (r.status === 200) {
              const ct = (r.headers.get('content-type') || '').toLowerCase();
              if (ct.includes('xml') || s.endsWith('.xml')) {
                const xml = await r.text();
                for (const loc of extractSitemapLocs(xml)) {
                  try {
                    if (sameHost(loc, startHref) && !visited.has(normalizeKey(loc))) {
                      state.queue.push({ url: loc.split('#')[0], depth: 1, source: `sitemap:${s}` });
                    }
                  } catch { /* skip bad loc */ }
                }
                break;
              }
            }
          } catch { /* next candidate */ }
        }
      }
    }
    const { allowed, crawlDelay } = isAllowed(robotsParsed[host].parsed, url, o.userAgent);
    return { allowed, crawlDelay, robotsTxt: robotsParsed[host].txt };
  }

  function emitProgress() {
    if (typeof o.onProgress === 'function') {
      try {
        o.onProgress({
          crawled: Object.keys(state.visitedPages).length,
          queued: state.queue.length,
          links: state.links.length,
          maxPages: o.maxPages,
        });
      } catch { /* ignore */ }
    }
  }

  function addLink(rec) {
    const k = `${rec.sourceUrl}||${rec.targetUrl}`;
    if (linkKeySet.has(k)) return;
    linkKeySet.add(k);
    state.links.push(rec);
  }

  function classifyLink({ status, chain, loop, error, blocked, excluded, fragment, fragmentExists, destPage, finalUrl, requestedUrl }) {
    if (excluded) return 'excluded';
    if (blocked) return 'blocked_robots';
    if (loop) return 'redirect_loop';
    if (error && status == null) return 'unreachable';
    if (status == null) return 'unreachable';
    if (fragment && fragmentExists === false) return 'anchor_missing';
    if (status >= 400) return 'broken';
    if (chain.length > 3) return 'redirect_chain_long';
    if (chain.length > 0) return 'redirect';
    if (destPage?.noindex) return 'noindex_destination';
    if (destPage?.canonical && normalizeKey(destPage.canonical) !== normalizeKey(finalUrl)) return 'canonicalized';
    // canonical mismatch on the target itself
    try {
      if (destPage?.canonical && normalizeKey(destPage.canonical) !== normalizeKey(requestedUrl.split('#')[0])) {
        // requested URL declares a different canonical -> canonicalized
        return 'canonicalized';
      }
    } catch { /* ignore */ }
    return 'ok';
  }

  async function verifyTarget({ targetUrl, kind, anchorText, sourceUrl, depth }) {
    const observedAt = new Date().toISOString();
    const base = {
      sourceUrl, anchorText, targetUrl, kind,
      internal: sameHost(targetUrl, startHref),
      observedAt, renderer: rendererLabel,
    };
    if (isExcluded(targetUrl, exclusions)) {
      state.stats.excluded++;
      return { ...base, status: null, statusLabel: 'EXCLUDED', finalUrl: targetUrl, issue: 'excluded', redirectHops: 0, chain: [], error: null, fragment: '', evidence: { excludedBy: 'exclude-pattern' } };
    }
    const { fragment } = toAbsolute(targetUrl, targetUrl) || { fragment: '' };
    const checkBody = kind === 'a' || (kind === 'image' && o.checkImages) || (kind === 'resource' && o.checkResources);
    const targetKey = (() => { try { return normalizeKey(targetUrl); } catch { return null; } })();
    const knownPage = targetKey ? state.visitedPages[targetKey] : null;

    if (knownPage) {
      const fragmentExists = fragment ? knownPage.anchors.includes(fragment) : null;
      const issue = classifyLink({
        status: knownPage.status, chain: knownPage.chain || [], loop: !!knownPage.loop,
        error: knownPage.error, fragment, fragmentExists, destPage: knownPage,
        finalUrl: knownPage.finalUrl, requestedUrl: targetUrl,
      });
      return {
        ...base, status: knownPage.status, statusLabel: knownPage.status == null ? 'UNKNOWN' : String(knownPage.status),
        finalUrl: knownPage.finalUrl, issue, redirectHops: (knownPage.chain || []).length,
        chain: knownPage.chain || [], fragment, error: knownPage.error,
        evidence: { reusedPage: true, contentType: knownPage.contentType, title: knownPage.title },
      };
    }

    if (!checkBody) {
      return {
        ...base, status: null, statusLabel: 'NOT_CHECKED', finalUrl: targetUrl, issue: 'not_checked',
        redirectHops: 0, chain: [], fragment, error: null,
        evidence: { reason: kind === 'image' ? 'checkImages disabled' : 'checkResources disabled' },
      };
    }

    const rb = await robotsCheck(targetUrl);
    if (!rb.allowed) {
      state.stats.blocked++;
      return {
        ...base, status: null, statusLabel: 'BLOCKED', finalUrl: targetUrl, issue: 'blocked_robots',
        redirectHops: 0, chain: [], fragment, error: null, evidence: { robots: 'disallowed' },
      };
    }

    const t0 = Date.now();
    const fc = await fetchChain(targetUrl.split('#')[0], o, rendererLabel);
    const ms = Date.now() - t0;
    let destPage = null;
    let statusLabel;
    if (fc.loop) statusLabel = 'LOOP';
    else if (fc.status == null) { statusLabel = 'UNKNOWN'; state.stats.unknown++; }
    else statusLabel = String(fc.status);
    const issue = classifyLink({
      status: fc.status, chain: fc.chain, loop: fc.loop, error: fc.error,
      fragment, fragmentExists: null, destPage, finalUrl: fc.finalUrl, requestedUrl: targetUrl,
    });
    try { if (fc.response) await fc.response.arrayBuffer(); } catch { /* drain */ }
    return {
      ...base, status: fc.status, statusLabel, finalUrl: fc.finalUrl, issue,
      redirectHops: fc.chain.length, chain: fc.chain, fragment, error: fc.error,
      evidence: { ms, headers: fc.headers, loop: fc.loop },
    };
  }

  async function crawlPage(item) {
    const { url, depth, source } = item;
    let key;
    try { key = normalizeKey(url); } catch { return; }
    if (visited.has(key)) return;
    if (Object.keys(state.visitedPages).length >= o.maxPages) return;
    visited.add(key);

    if (isExcluded(url, exclusions)) {
      state.stats.excluded++;
      state.visitedPages[key] = {
        url, key, status: null, statusLabel: 'EXCLUDED', finalUrl: url, chain: [],
        contentType: null, title: '', canonical: null, noindex: false, nofollow: false,
        anchors: [], outCount: 0, ms: 0, observedAt: new Date().toISOString(),
        renderer: rendererLabel, issue: 'excluded', error: null,
      };
      return;
    }
    const rb = await robotsCheck(url);
    if (!rb.allowed) {
      state.stats.blocked++;
      state.visitedPages[key] = {
        url, key, status: null, statusLabel: 'BLOCKED', finalUrl: url, chain: [],
        contentType: null, title: '', canonical: null, noindex: false, nofollow: false,
        anchors: [], outCount: 0, ms: 0, observedAt: new Date().toISOString(),
        renderer: rendererLabel, issue: 'blocked_robots', error: null, evidence: { robots: 'disallowed' },
      };
      await saveCheckpoint();
      emitProgress();
      return;
    }
    const wait = Math.max(o.delayMs, (rb.crawlDelay || 0) * 1000);
    await sleep(wait);

    const observedAt = new Date().toISOString();
    const t0 = Date.now();
    const fc = await fetchChain(url, o, rendererLabel);
    const ms = Date.now() - t0;
    state.stats.fetched++;

    const contentType = fc.status != null ? (fc.headers['content-type'] || null) : null;
    const isHtml = contentType ? /text\/html|application\/xhtml/i.test(contentType) : (fc.status === 200 && fc.response != null);
    let html = '';
    if (fc.status != null && !fc.loop && fc.response && isHtml) html = await readBodySafe(fc.response);
    else if (fc.response) { try { await fc.response.arrayBuffer(); } catch { /* drain */ } }

    const title = html ? extractTitle(html) : '';
    const canonical = html ? extractCanonical(html, fc.finalUrl) : null;
    const meta = html ? extractMetaRobots(html) : { noindex: false, nofollow: false };
    const headerNoindex = /noindex/i.test(fc.headers['x-robots-tag'] || '');
    const anchors = html ? [...extractAnchors(html)] : [];

    const pageIssue = fc.loop ? 'redirect_loop'
      : fc.status == null ? 'unreachable'
      : fc.status >= 400 ? 'broken'
      : fc.chain.length > 3 ? 'redirect_chain_long'
      : fc.chain.length > 0 ? 'redirect'
      : (meta.noindex || headerNoindex) ? 'noindex_page' : 'ok';

    const page = {
      url, key, status: fc.status, statusLabel: fc.loop ? 'LOOP' : fc.status == null ? 'UNKNOWN' : String(fc.status),
      finalUrl: fc.finalUrl, chain: fc.chain, loop: fc.loop, contentType, title,
      canonical, noindex: meta.noindex || headerNoindex, nofollow: meta.nofollow,
      anchors, outCount: 0, ms, observedAt, renderer: rendererLabel,
      issue: pageIssue, error: fc.error, depth, source,
      evidence: { headers: fc.headers },
    };
    state.visitedPages[key] = page;

    if (html && depth < o.maxDepth && Object.keys(state.visitedPages).length < o.maxPages) {
      const found = extractLinks(html);
      page.outCount = found.length;
      for (const f of found) {
        const abs = toAbsolute(f.raw, fc.finalUrl);
        if (!abs) continue;
        const internal = sameHost(abs.href, startHref);
        if (f.kind === 'a' && internal) {
          try {
            const k = normalizeKey(abs.href);
            if (!visited.has(k) && Object.keys(state.visitedPages).length + state.queue.length < o.maxPages + 20) {
              state.queue.push({ url: abs.href.split('#')[0], depth: depth + 1, source: url });
            }
          } catch { /* skip */ }
        }
        if (!internal && f.kind !== 'a') continue; // never fetch off-site images/resources
        if (!internal && f.kind === 'a' && !o.includeExternal) {
          // labelled without fetching: user opted out of external checks
          const absNoFrag = abs.href.split('#')[0];
          addLink({
            sourceUrl: url, anchorText: f.anchorText, targetUrl: abs.href, kind: f.kind,
            internal: false, observedAt: new Date().toISOString(), renderer: rendererLabel,
            status: null, statusLabel: 'NOT_CHECKED', finalUrl: absNoFrag, issue: 'not_checked',
            redirectHops: 0, chain: [], fragment: abs.fragment, error: null,
            evidence: { reason: 'includeExternal disabled' },
          });
          continue;
        }
        const rec = await verifyTarget({
          targetUrl: abs.href, kind: f.kind, anchorText: f.anchorText, sourceUrl: url, depth,
        });
        addLink(rec);
      }
    } else if (html) {
      page.outCount = extractLinks(html).length;
    }
    await saveCheckpoint();
    emitProgress();
  }

  // bounded worker pool
  const workers = [];
  const n = Math.max(1, Math.min(32, o.concurrency | 0 || 1));
  async function worker() {
    while (state.queue.length > 0 && Object.keys(state.visitedPages).length < o.maxPages) {
      const item = state.queue.shift();
      if (!item) break;
      try {
        const k = normalizeKey(item.url);
        if (visited.has(k)) continue;
      } catch { continue; }
      await crawlPage(item);
    }
  }
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  // post-pass: anchor validation against crawled pages
  for (const l of state.links) {
    if (!l.fragment || l.issue === 'anchor_missing') continue;
    if (!l.internal) continue;
    try {
      const tk = normalizeKey(l.targetUrl);
      const tp = state.visitedPages[tk];
      if (tp && !tp.anchors.includes(l.fragment)) {
        if (l.status != null && l.status < 400) l.issue = 'anchor_missing';
      }
    } catch { /* ignore */ }
  }
  // explicit anchor_missing for same-page fragments checked at source
  for (const l of state.links) {
    if (l.fragment && l.issue === 'ok' && l.internal) {
      try {
        const tk = normalizeKey(l.targetUrl);
        const tp = state.visitedPages[tk];
        if (tp && !tp.anchors.includes(l.fragment)) l.issue = 'anchor_missing';
      } catch { /* ignore */ }
    }
  }

  // post-pass: destination metadata (noindex / canonical) for targets
  // that were verified before being crawled
  for (const l of state.links) {
    if (l.issue !== 'ok' || !l.internal || l.status == null || l.status >= 400) continue;
    try {
      const tk = normalizeKey(l.targetUrl);
      const tp = state.visitedPages[tk];
      if (!tp || tp.status == null || tp.status >= 400) continue;
      if (tp.noindex) l.issue = 'noindex_destination';
      else if (tp.canonical) {
        try {
          if (normalizeKey(tp.canonical) !== tk) l.issue = 'canonicalized';
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  const finishedAt = new Date().toISOString();
  const groups = {};
  for (const l of state.links) groups[l.issue] = (groups[l.issue] || 0) + 1;
  const pageGroups = {};
  for (const p of Object.values(state.visitedPages)) pageGroups[p.issue] = (pageGroups[p.issue] || 0) + 1;

  const result = {
    version: 1,
    startUrl: startHref,
    startedAt: state.startedAt,
    finishedAt,
    resumedAt: state.resumedAt || null,
    options: state.options,
    summary: {
      pages: Object.keys(state.visitedPages).length,
      links: state.links.length,
      broken: groups.broken || 0,
      redirects: (groups.redirect || 0) + (groups.redirect_chain_long || 0),
      loops: groups.redirect_loop || 0,
      unknown: state.stats.unknown,
      blocked: state.stats.blocked,
      excluded: state.stats.excluded,
      groups,
      pageGroups,
    },
    pages: state.visitedPages,
    links: state.links,
  };
  return result;
}

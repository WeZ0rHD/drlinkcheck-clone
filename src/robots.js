/**
 * Minimal robots.txt parser + sitemap awareness.
 * Supports: User-agent groups (* + substring match of our UA),
 * Allow / Disallow (longest-match wins), Crawl-delay, Sitemap: lines.
 */

export function parseRobots(txt) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  for (const rawLine of String(txt || '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.finished) {
        current = { agents: [], rules: [], crawlDelay: null, finished: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (!current) {
      continue;
    } else if (field === 'disallow' || field === 'allow') {
      current.finished = current.finished; // rules keep group open
      current.rules.push({ type: field, path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    } else {
      current.finished = true; // unknown directive ends group affinity
    }
  }
  return { groups, sitemaps };
}

function groupFor(groups, userAgent) {
  const ua = userAgent.toLowerCase();
  let wildcard = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === '*') wildcard = wildcard || g;
      else if (a && (ua.includes(a) || a.includes(ua.split('/')[0]))) return g;
    }
  }
  return wildcard;
}

/** Longest-match Allow/Disallow. Empty Disallow = allow all. */
export function isAllowed(parsed, url, userAgent) {
  const g = groupFor(parsed.groups, userAgent);
  if (!g) return { allowed: true, crawlDelay: null };
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch { return { allowed: false, crawlDelay: null }; }
  let best = null;
  for (const r of g.rules) {
    if (!r.path) {
      best = best || { type: 'allow', path: '' };
      continue; // Disallow: <empty> allows everything unless longer rule
    }
    if (path.startsWith(r.path)) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return {
    allowed: !best || best.type === 'allow',
    crawlDelay: g.crawlDelay,
  };
}

export function extractSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<>\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) locs.push(m[1].trim());
  return locs.slice(0, 5000);
}

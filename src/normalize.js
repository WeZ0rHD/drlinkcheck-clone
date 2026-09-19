/**
 * URL normalization + link extraction helpers.
 * Zero dependencies. Feature-level concepts only — no third-party code copied.
 */

export const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * Resolve a raw href/src against a base URL.
 * Returns { href, fragment } or null when unresolvable / non-http(s) / empty.
 */
export function toAbsolute(raw, base) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.startsWith('#')) {
    if (!s.startsWith('#')) return null;
    // bare fragment -> same document
    try {
      const b = new URL(base);
      b.hash = s;
      return { href: b.toString(), fragment: s.slice(1) };
    } catch { return null; }
  }
  const lower = s.toLowerCase();
  if (
    lower.startsWith('javascript:') || lower.startsWith('mailto:') ||
    lower.startsWith('tel:') || lower.startsWith('data:') ||
    lower.startsWith('blob:') || lower.startsWith('ftp:')
  ) return null;
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const fragment = u.hash ? u.hash.slice(1) : '';
    return { href: u.toString(), fragment };
  } catch {
    return null;
  }
}

/**
 * Canonical dedup key for a page: lowercase host, drop default port,
 * strip fragment, drop trailing slash (except root), sort query params.
 */
export function normalizeKey(rawUrl) {
  const u = new URL(rawUrl);
  u.hostname = u.hostname.toLowerCase();
  if (DEFAULT_PORTS[u.protocol] === u.port) u.port = '';
  u.hash = '';
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  u.pathname = path;
  if (u.search) {
    const params = [...u.searchParams.entries()].sort(([a, ka], [b, kb]) =>
      a < b ? -1 : a > b ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0);
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
  }
  return u.toString();
}

export function sameHost(a, b) {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch { return false; }
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Extract links/resources from HTML. Returns array of
 * { raw, kind: 'a'|'image'|'resource', anchorText }.
 * Regex-based (MVP): notes limitation for malformed markup in README.
 */
export function extractLinks(html) {
  const out = [];
  const push = (raw, kind, anchorText = '') => {
    if (raw != null && String(raw).trim() !== '') out.push({ raw: String(raw).trim(), kind, anchorText });
  };
  const aRe = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    push(m[2] ?? m[3] ?? m[4], 'a', stripTags(m[5] ?? ''));
  }
  // anchors without closing tag handling: also catch bare <a href> without match
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const alt = /alt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    push(m[2] ?? m[3] ?? m[4], 'image', alt ? (alt[2] ?? alt[3] ?? alt[4] ?? '') : '');
  }
  const linkRe = /<link\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) push(m[2] ?? m[3] ?? m[4], 'resource', '');
  const scriptRe = /<script\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((m = scriptRe.exec(html)) !== null) push(m[2] ?? m[3] ?? m[4], 'resource', '');
  return out;
}

export function extractCanonical(html, base) {
  const m = /<link\b[^>]*?\brel\s*=\s*("canonical"|'canonical'|canonical)[^>]*>/i.exec(html);
  if (!m) return null;
  const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
  if (!href) return null;
  const abs = toAbsolute(href[2] ?? href[3] ?? href[4], base);
  return abs ? abs.href : null;
}

export function extractMetaRobots(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  let noindex = false;
  let nofollow = false;
  for (const tag of metas) {
    if (!/name\s*=\s*("robots"|'robots'|robots)/i.test(tag)) continue;
    const c = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const content = (c ? (c[2] ?? c[3] ?? c[4] ?? '') : '').toLowerCase();
    if (content.includes('noindex')) noindex = true;
    if (content.includes('nofollow')) nofollow = true;
  }
  return { noindex, nofollow };
}

export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 200) : '';
}

/** Collect id=".." and <a name=".."> anchors for fragment validation. */
export function extractAnchors(html) {
  const set = new Set();
  const idRe = /\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = idRe.exec(html)) !== null) {
    const v = decodeURIComponentSafe(m[2] ?? m[3] ?? m[4] ?? '');
    if (v) set.add(v);
  }
  const nameRe = /<a\b[^>]*?\bname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  while ((m = nameRe.exec(html)) !== null) {
    const v = decodeURIComponentSafe(m[2] ?? m[3] ?? m[4] ?? '');
    if (v) set.add(v);
  }
  return set;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

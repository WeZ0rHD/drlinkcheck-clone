import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, extractSitemapLocs } from '../src/robots.js';

const UA = 'LinkAuditorMVP/1.0';

describe('robots', () => {
  it('allows everything when no robots match', () => {
    const p = parseRobots('User-agent: *\nDisallow:\n');
    assert.equal(isAllowed(p, 'https://e.com/a', UA).allowed, true);
  });
  it('disallows longest-match paths', () => {
    const p = parseRobots('User-agent: *\nDisallow: /priv\nAllow: /priv/ok\n');
    assert.equal(isAllowed(p, 'https://e.com/priv/secret', UA).allowed, false);
    assert.equal(isAllowed(p, 'https://e.com/priv/ok/x', UA).allowed, true);
    assert.equal(isAllowed(p, 'https://e.com/pub', UA).allowed, true);
  });
  it('honours crawl-delay and sitemap lines', () => {
    const p = parseRobots('User-agent: *\nCrawl-delay: 2\nSitemap: https://e.com/sitemap.xml\n');
    assert.equal(isAllowed(p, 'https://e.com/', UA).crawlDelay, 2);
    assert.deepEqual(p.sitemaps, ['https://e.com/sitemap.xml']);
  });
});

describe('sitemap locs', () => {
  it('extracts <loc> urls', () => {
    const xml = `<urlset><url><loc>https://e.com/a</loc></url><url><loc>https://e.com/b</loc></url></urlset>`;
    assert.deepEqual(extractSitemapLocs(xml), ['https://e.com/a', 'https://e.com/b']);
  });
});

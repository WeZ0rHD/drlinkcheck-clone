import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, toAbsolute, sameHost, extractLinks, extractCanonical, extractMetaRobots, extractAnchors } from '../src/normalize.js';

describe('normalizeKey', () => {
  it('strips fragments, lowercases host, drops default ports and trailing slash', () => {
    assert.equal(normalizeKey('HTTP://Example.COM:80/About/#sec'), 'http://example.com/About');
    assert.equal(normalizeKey('https://example.com:443/'), 'https://example.com/');
  });
  it('sorts query params for stable dedup', () => {
    assert.equal(normalizeKey('https://e.com/?b=2&a=1'), normalizeKey('https://e.com/?a=1&b=2'));
  });
  it('keeps distinct paths distinct', () => {
    assert.notEqual(normalizeKey('https://e.com/a'), normalizeKey('https://e.com/b'));
  });
});

describe('toAbsolute', () => {
  it('resolves relative hrefs and rejects non-http schemes', () => {
    assert.equal(toAbsolute('/a', 'https://e.com/x').href, 'https://e.com/a');
    assert.equal(toAbsolute('mailto:a@b.c', 'https://e.com/'), null);
    assert.equal(toAbsolute('javascript:void(0)', 'https://e.com/'), null);
    assert.equal(toAbsolute('https://other.com/y#frag', 'https://e.com/').fragment, 'frag');
  });
});

describe('extractors', () => {
  it('extracts a/img/link/script refs with anchor text', () => {
    const html = `<a href="/a"><b>Click</b> me</a><img src="i.png" alt="pic"><link href="s.css"><script src="x.js"></script>`;
    const links = extractLinks(html);
    assert.equal(links.length, 4);
    assert.deepEqual(links[0], { raw: '/a', kind: 'a', anchorText: 'Click me' });
    assert.equal(links[1].kind, 'image');
  });
  it('finds canonical, meta robots and anchors', () => {
    const html = `<link rel="canonical" href="/about"><meta name="robots" content="noindex, follow"><h1 id="sec">x</h1><a name="old"></a>`;
    assert.equal(extractCanonical(html, 'https://e.com/src'), 'https://e.com/about');
    assert.deepEqual(extractMetaRobots(html), { noindex: true, nofollow: false });
    assert.ok(extractAnchors(html).has('sec'));
    assert.ok(extractAnchors(html).has('old'));
  });
  it('sameHost compares case-insensitively', () => {
    assert.ok(sameHost('https://E.com/a', 'https://e.com/b'));
    assert.ok(!sameHost('https://e.com/a', 'https://other.com/'));
  });
});

/**
 * Controlled dogfood fixture: deterministic routes covering
 * ok / broken / redirect chain / redirect loop / noindex /
 * canonical / missing anchor / missing image / robots+sitemap.
 */
import http from 'node:http';

export function fixtureHandler() {
  return (req, res) => {
    const u = new URL(req.url || '/', 'http://fixture');
    const p = u.pathname;
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n');
      return;
    }
    if (p === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        `<url><loc>http://FIXTURE/</loc></url><url><loc>http://FIXTURE/about</loc></url></urlset>`.replaceAll('http://FIXTURE', `http://${req.headers.host}`));
      return;
    }
    switch (p) {
      case '/':
        return html(`<!doctype html><html><head><title>Fixture home</title></head><body>
<h1>Fixture</h1>
<a href="/about">About us</a>
<a href="/gone">Dead page</a>
<a href="/old">Old location</a>
<a href="/loop-a">Loop start</a>
<a href="/page#missing-frag">Bad anchor</a>
<a href="/page#exists">Good anchor</a>
<a href="/noindex">Noindex page</a>
<a href="/canonical-src">Canonicalized page</a>
<img src="/img-404.png" alt="missing image">
</body></html>`);
      case '/about':
        return html(`<!doctype html><html><head><title>About</title><link rel="canonical" href="/about"></head><body><h1 id="top">About</h1><a href="/">Home</a></body></html>`);
      case '/gone':
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<h1>not found</h1>');
        return;
      case '/old':
        res.writeHead(302, { location: '/new' });
        res.end();
        return;
      case '/new':
        return html(`<!doctype html><html><head><title>New</title></head><body><h1>New location</h1><a href="/">Home</a></body></html>`);
      case '/loop-a':
        res.writeHead(302, { location: '/loop-b' });
        res.end();
        return;
      case '/loop-b':
        res.writeHead(302, { location: '/loop-a' });
        res.end();
        return;
      case '/page':
        return html(`<!doctype html><html><head><title>Anchors</title></head><body><h1 id="exists">Section</h1><a href="/">Home</a></body></html>`);
      case '/noindex':
        return html(`<!doctype html><html><head><title>Hidden</title><meta name="robots" content="noindex, follow"></head><body><h1>Hidden</h1><a href="/">Home</a></body></html>`);
      case '/canonical-src':
        return html(`<!doctype html><html><head><title>Src</title><link rel="canonical" href="/about"></head><body><h1>Src</h1><a href="/">Home</a></body></html>`);
      case '/img-404.png':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such image');
        return;
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
  };
}

export function startFixtureServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(fixtureHandler());
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

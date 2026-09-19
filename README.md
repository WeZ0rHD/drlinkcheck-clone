# Link Auditor — DrLinkCheck-like MVP

Bounded website link auditor: crawl a site, classify every link with **real HTTP
evidence** (`status`, redirect chain, `observed_at`, renderer label), group issues,
search/filter, inspect source → target detail, export CSV/JSON.

Zero dependencies. Node ≥ 20. No Slack/Discord scope. Feature-level inspiration
from tools like Screaming Frog — no proprietary code copied.

## Quick start

```bash
node src/server.js        # UI on http://localhost:4177  (PORT=… to change)
node src/cli.js --url https://example.com --max-pages 50 --out result.json
npm test                  # node:test suites, no deps
node scripts/dogfood.js   # fixture + polite https://example.com crawl → evidence/
```

## What it checks

- Internal vs external links, status codes, final URL after redirects
- Redirect chains (flagged `redirect_chain_long` past 3 hops) and **loops**
- Broken links (4xx/5xx) with the actual status as evidence
- Source page per link + anchor text; missing `#fragment` targets
- Canonical link + `noindex` (meta robots / `X-Robots-Tag`) basics
- Images/resources: listed always, fetched only with `--images` / CLI flags
- `robots.txt` respected by default (+ `Crawl-delay`), `sitemap.xml` seeded
- Exclusions: substring or `/regex/` via UI textarea or `--exclude`
- Bounded concurrency + per-host politeness delay + timeout per request

## No-fake rule

Every link record carries `observedAt` and an `evidence` object.
Unreachable targets (DNS/timeout/refused/robots-blocked) are reported as
`UNKNOWN` / `BLOCKED` — never invented. CSV uses the same labels.

## JS-rendered mode (separate)

The UI and default CLI run **static fetch only**. A separate opt-in exists:

```bash
LINKAUDIT_JS_RENDERER=https://my-renderer/render?url= node src/cli.js --url … --js
```

Without the env var, `--js` fails fast with `JS_RENDERER_NOT_CONFIGURED`.
Renderer-provided records are labeled `js-via:<endpoint>`.

## Resume / checkpoint

```bash
node src/cli.js --url https://example.com --checkpoint ./data/cp.json
node src/cli.js --url https://example.com --checkpoint ./data/cp.json --resume
```

State (queue, pages, links) is written after every page and reloaded on `--resume`.

## API

| Method | Route | Description |
|---|---|---|
| POST | `/api/crawls` | `{ url, options }` → `{ id }` (crawl runs in background) |
| GET | `/api/crawls/:id` | progress while running, full result when done |
| GET | `/api/crawls/:id/export?format=csv\|json` | download (409 until done) |
| GET | `/api/crawls` | list sessions |

## Limits (MVP)

- Link extraction is regex-based: handles well-formed markup, may miss
  links in heavily malformed HTML or shadow DOM (that's what JS mode is for).
- Bodies are capped at ~2 MB per page; non-HTML targets record headers only.
- External images/resources are never fetched (listed as `not_checked`).
- UI table renders the first 2000 filtered rows for responsiveness.

/* Link Auditor UI: progress, filters, issue groups, searchable table, detail + graph, CSV/JSON export. */
let crawlId = null;
let result = null;
let activeGroup = '';
let pollTimer = null;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
function statusClass(link) {
  if (link.status == null) return (link.statusLabel || 'UNKNOWN') === 'NOT_CHECKED' || (link.statusLabel || '') === 'EXCLUDED' || (link.statusLabel || '') === 'BLOCKED' ? 'other' : 'unreachable';
  if (link.status >= 400) return 'broken';
  if (link.status >= 300) return 'redirect';
  return 'ok';
}

$('crawl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('form-error').textContent = '';
  const url = $('f-url').value.trim();
  const options = {
    maxPages: Number($('f-maxpages').value) || 100,
    maxDepth: Number($('f-depth').value || 0),
    concurrency: Number($('f-conc').value) || 5,
    delayMs: Number($('f-delay').value || 0),
    exclude: $('f-exclude').value.split('\n').map((s) => s.trim()).filter(Boolean),
    includeExternal: $('f-external').checked,
    checkImages: $('f-images').checked,
    respectRobots: $('f-robots').checked,
  };
  $('btn-start').disabled = true;
  try {
    const r = await fetch('/api/crawls', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, options }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    crawlId = data.id;
    result = null;
    activeGroup = '';
    $('results').classList.add('hidden');
    $('progress').classList.remove('hidden');
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1200);
    poll();
  } catch (err) {
    $('form-error').textContent = String(err.message || err);
    $('btn-start').disabled = false;
  }
});

async function poll() {
  if (!crawlId) return;
  try {
    const r = await fetch(`/api/crawls/${encodeURIComponent(crawlId)}`);
    const data = await r.json();
    if (data.status === 'done') {
      clearInterval(pollTimer);
      result = data;
      $('progress').classList.add('hidden');
      $('btn-start').disabled = false;
      render();
    } else if (data.status === 'error') {
      clearInterval(pollTimer);
      $('progress-text').textContent = `Failed: ${data.error || 'unknown error'}`;
      $('btn-start').disabled = false;
    } else {
      const p = data.progress || {};
      const pct = p.maxPages ? Math.min(100, Math.round((100 * (p.crawled || 0)) / p.maxPages)) : 0;
      $('bar-fill').style.width = `${pct}%`;
      $('progress-text').textContent = `Crawling… pages=${p.crawled ?? 0} queued=${p.queued ?? 0} links=${p.links ?? 0}`;
    }
  } catch { /* keep polling */ }
}

function render() {
  $('results').classList.remove('hidden');
  const s = result.summary;
  const stat = (v, label, cls = '') => `<div class="stat ${cls}"><b>${v}</b><span>${label}</span></div>`;
  $('summary').innerHTML =
    stat(s.pages, 'pages') + stat(s.links, 'links') +
    stat(s.broken, 'broken', s.broken ? 'bad' : 'ok') +
    stat(s.redirects, 'redirects', s.redirects ? 'warn' : '') +
    stat(s.loops, 'loops', s.loops ? 'bad' : '') +
    stat(s.unknown, 'UNKNOWN', s.unknown ? 'warn' : '');
  const groups = Object.entries(s.groups || {}).sort((a, b) => b[1] - a[1]);
  $('groups').innerHTML = `<button class="chip${activeGroup === '' ? ' active' : ''}" data-g="">all (${s.links})</button>` +
    groups.map(([g, n]) => `<button class="chip${activeGroup === g ? ' active' : ''}" data-g="${esc(g)}">${esc(g)} (${n})</button>`).join('');
  document.querySelectorAll('#groups .chip').forEach((c) => {
    c.addEventListener('click', () => { activeGroup = c.dataset.g; render(); });
  });
  renderTable();
}

function filteredLinks() {
  const q = $('q').value.trim().toLowerCase();
  const kind = $('f-kind').value;
  const st = $('f-status').value;
  return (result.links || []).filter((l) => {
    if (activeGroup && l.issue !== activeGroup) return false;
    if (kind === 'internal' && !l.internal) return false;
    if (kind === 'external' && l.internal) return false;
    if (st === 'UNKNOWN' && l.status != null) return false;
    if (st === '2xx' && !(l.status >= 200 && l.status < 300)) return false;
    if (st === '3xx' && !(l.status >= 300 && l.status < 400)) return false;
    if (st === '4xx' && !(l.status >= 400 && l.status < 500)) return false;
    if (st === '5xx' && !(l.status >= 500 && l.status < 600)) return false;
    if (q && !(`${l.sourceUrl} ${l.targetUrl} ${l.anchorText}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderTable() {
  const rows = filteredLinks().slice(0, 2000);
  $('count').textContent = `${rows.length} shown`;
  $('links').querySelector('tbody').innerHTML = rows.map((l, i) => {
    const st = l.status == null ? esc(l.statusLabel || 'UNKNOWN') : l.status;
    return `<tr data-i="${result.links.indexOf(l)}">` +
      `<td class="url">${esc(hostOf(l.sourceUrl))}${esc(new URL(l.sourceUrl, 'http://x').pathname)}</td>` +
      `<td>${esc(l.anchorText || '—')}</td>` +
      `<td class="url">${esc(l.targetUrl)}</td>` +
      `<td><span class="pill ${statusClass(l)}">${st}</span></td>` +
      `<td><span class="pill ${/^(ok)$/.test(l.issue) ? 'ok' : /broken|unreachable|redirect_loop/.test(l.issue) ? 'broken' : /redirect|canonical|noindex|anchor/.test(l.issue) ? 'redirect' : 'other'}">${esc(l.issue)}</span></td>` +
      `<td>${esc((l.observedAt || '').slice(11, 19))}</td></tr>`;
  }).join('');
  document.querySelectorAll('#links tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => showDetail(result.links[Number(tr.dataset.i)]));
  });
}

$('q').addEventListener('input', () => result && renderTable());
$('f-kind').addEventListener('change', () => result && renderTable());
$('f-status').addEventListener('change', () => result && renderTable());
$('detail-close').addEventListener('click', () => $('detail').classList.add('hidden'));

function showDetail(l) {
  if (!l) return;
  $('detail').classList.remove('hidden');
  const rows = [
    ['Source', l.sourceUrl], ['Anchor', l.anchorText || '—'], ['Target', l.targetUrl],
    ['Kind', `${l.kind} · ${l.internal ? 'internal' : 'external'}`],
    ['Status', `${l.status == null ? (l.statusLabel || 'UNKNOWN') : l.status}`],
    ['Final URL', l.finalUrl || '—'], ['Issue', l.issue],
    ['Hops', String(l.redirectHops ?? 0)], ['Observed', l.observedAt || '—'],
    ['Renderer', l.renderer || 'static'], ['Error', l.error || '—'],
  ];
  $('detail-dl').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const chain = l.chain || [];
  $('chain').innerHTML = chain.length
    ? chain.map((c) => `<li><b>${c.status}</b> ${esc(c.url)} → <i>${esc(c.location || '')}</i></li>`).join('')
    : '<li><i>direct (no redirects)</i></li>';
  drawGraph(l);
}

function drawGraph(l) {
  const svg = $('graph');
  const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';
  const short = (u) => {
    try { const x = new URL(u); return x.hostname + (x.pathname.length > 18 ? x.pathname.slice(0, 17) + '…' : x.pathname); }
    catch { return String(u).slice(0, 34); }
  };
  const box = (x, label, color) => {
    const g = document.createElementNS(NS, 'g');
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', 45); r.setAttribute('width', 180);
    r.setAttribute('height', 60); r.setAttribute('rx', 8);
    r.setAttribute('fill', 'none'); r.setAttribute('stroke', color); r.setAttribute('stroke-width', 2);
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', x + 90); t1.setAttribute('y', 70); t1.setAttribute('text-anchor', 'middle');
    t1.setAttribute('fill', 'currentColor'); t1.setAttribute('font-size', '11');
    t1.textContent = label;
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', x + 90); t2.setAttribute('y', 88); t2.setAttribute('text-anchor', 'middle');
    t2.setAttribute('fill', 'currentColor'); t2.setAttribute('font-size', '10'); t2.setAttribute('opacity', '.7');
    t2.textContent = short(label === 'SOURCE' ? l.sourceUrl : (l.finalUrl || l.targetUrl));
    g.append(r, t1, t2);
    svg.append(g);
  };
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', 185); line.setAttribute('y1', 75); line.setAttribute('x2', 375);
  line.setAttribute('y2', 75); line.setAttribute('stroke', '#4da3ff'); line.setAttribute('stroke-width', 2);
  line.setAttribute('marker-end', 'url(#arr)');
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = `<marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="none" stroke="#4da3ff" stroke-width="1.5"/></marker>`;
  const lbl = document.createElementNS(NS, 'text');
  lbl.setAttribute('x', 280); lbl.setAttribute('y', 65); lbl.setAttribute('text-anchor', 'middle');
  lbl.setAttribute('fill', 'currentColor'); lbl.setAttribute('font-size', '11');
  lbl.textContent = l.status == null ? (l.statusLabel || 'UNKNOWN') : `${l.status} · ${l.issue}`;
  svg.append(defs, line, lbl);
  box(5, 'SOURCE', '#93a1b3');
  box(375, 'TARGET', l.issue === 'ok' ? '#51d88a' : /broken|unreachable|redirect_loop/.test(l.issue) ? '#ff6b6b' : '#ffb454');
}

$('btn-csv').addEventListener('click', () => {
  if (crawlId) window.location = `/api/crawls/${encodeURIComponent(crawlId)}/export?format=csv`;
});
$('btn-json').addEventListener('click', () => {
  if (crawlId) window.location = `/api/crawls/${encodeURIComponent(crawlId)}/export?format=json`;
});

/** CSV / JSON export of link records. */

export const CSV_COLUMNS = [
  'source_url', 'anchor_text', 'target_url', 'kind', 'internal',
  'status', 'final_url', 'issue', 'redirect_hops', 'observed_at', 'renderer', 'error',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(links) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const l of links || []) {
    lines.push([
      l.sourceUrl, l.anchorText, l.targetUrl, l.kind, l.internal ? 'yes' : 'no',
      l.status == null ? l.statusLabel || 'UNKNOWN' : l.status,
      l.finalUrl, l.issue, l.redirectHops, l.observedAt, l.renderer, l.error || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function toJSON(result) {
  return JSON.stringify(result, null, 2);
}

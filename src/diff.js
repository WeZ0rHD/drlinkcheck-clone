/**
 * Deterministic diff between two crawl results (same shape as crawl() output).
 *
 * Links are matched by `sourceUrl||targetUrl` (fragments kept: an anchor fix
 * is a real change). A link is "changed" when status / statusLabel / issue /
 * finalUrl / error moves. Fixed/newly-broken are derived from a small
 * broken-issue set — everything else is reported, never inferred.
 */

export const BROKEN_ISSUES = new Set(['broken', 'unreachable', 'redirect_loop']);
const CAP = 5000;

export function linkKey(l) {
  return `${l.sourceUrl}||${l.targetUrl}`;
}

function linkSig(l) {
  return JSON.stringify([
    l.status ?? null, l.statusLabel ?? null, l.issue ?? null,
    l.finalUrl ?? null, l.error ?? null, l.redirectHops ?? 0,
  ]);
}

function changeKind(before, after) {
  const wasBad = BROKEN_ISSUES.has(before.issue);
  const isBad = BROKEN_ISSUES.has(after.issue);
  if (wasBad && !isBad) return 'fixed';
  if (!wasBad && isBad) return 'newly_broken';
  return 'changed';
}

/**
 * @param {object} a earlier crawl result
 * @param {object} b later crawl result
 */
export function diffCrawls(a, b) {
  const aLinks = new Map((a.links || []).map((l) => [linkKey(l), l]));
  const bLinks = new Map((b.links || []).map((l) => [linkKey(l), l]));
  const added = [];
  const removed = [];
  const changed = [];
  const fixed = [];
  const newlyBroken = [];

  for (const [k, bl] of bLinks) {
    const al = aLinks.get(k);
    if (!al) {
      if (added.length < CAP) {
        added.push({ key: k, sourceUrl: bl.sourceUrl, targetUrl: bl.targetUrl, issue: bl.issue, status: bl.status });
      }
      // a brand-new link that is already broken is newly broken too
      if (BROKEN_ISSUES.has(bl.issue) && newlyBroken.length < CAP) {
        newlyBroken.push({
          key: k, sourceUrl: bl.sourceUrl, targetUrl: bl.targetUrl, kind: 'newly_broken',
          before: null,
          after: { status: bl.status, statusLabel: bl.statusLabel, issue: bl.issue, finalUrl: bl.finalUrl, error: bl.error },
        });
      }
      continue;
    }
    if (linkSig(al) !== linkSig(bl)) {
      const kind = changeKind(al, bl);
      const rec = {
        key: k, sourceUrl: bl.sourceUrl, targetUrl: bl.targetUrl, kind,
        before: { status: al.status, statusLabel: al.statusLabel, issue: al.issue, finalUrl: al.finalUrl, error: al.error },
        after: { status: bl.status, statusLabel: bl.statusLabel, issue: bl.issue, finalUrl: bl.finalUrl, error: bl.error },
      };
      if (changed.length < CAP) changed.push(rec);
      if (kind === 'fixed' && fixed.length < CAP) fixed.push(rec);
      if (kind === 'newly_broken' && newlyBroken.length < CAP) newlyBroken.push(rec);
    }
  }
  for (const [k, al] of aLinks) {
    if (!bLinks.has(k) && removed.length < CAP) {
      removed.push({ key: k, sourceUrl: al.sourceUrl, targetUrl: al.targetUrl, issue: al.issue, status: al.status });
    }
  }

  const aPages = a.pages || {};
  const bPages = b.pages || {};
  const addedPages = Object.keys(bPages).filter((k) => !aPages[k]).slice(0, CAP);
  const removedPages = Object.keys(aPages).filter((k) => !bPages[k]).slice(0, CAP);

  return {
    version: 1,
    a: { startUrl: a.startUrl, finishedAt: a.finishedAt || null, pages: a.summary?.pages ?? null, links: a.summary?.links ?? null },
    b: { startUrl: b.startUrl, finishedAt: b.finishedAt || null, pages: b.summary?.pages ?? null, links: b.summary?.links ?? null },
    sameScope: a.startUrl === b.startUrl,
    links: {
      added: added.length, removed: removed.length, changed: changed.length,
      fixed: fixed.length, newlyBroken: newlyBroken.length,
      addedItems: added, removedItems: removed, changedItems: changed,
    },
    pages: {
      added: addedPages.length, removed: removedPages.length,
      addedKeys: addedPages, removedKeys: removedPages,
    },
  };
}

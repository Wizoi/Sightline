// Auto-scroll's systemBands are stored *page-relative* — a page index plus
// center/top/bottom as fractions of that page's rendered height — rather than
// as absolute document pixels captured once at Analyze time. That's the whole
// point: a window resize, a phone rotation, a zoom change, or collapsing the
// side panel all reflow the PDF to a new width (and therefore a new height and
// new page offsets), which used to leave the baked-in pixel coordinates stale
// and force a re-analyze. Page-relative fractions re-project onto whatever the
// current layout is, so this resolver just reads the live canvas geometry and
// hands back today's document pixels.
//
// One resolve is one getBoundingClientRect() per band — cheap enough to run in
// the auto-scroll rAF tick, which is what keeps playback tracking a mid-drag
// resize frame by frame with no explicit invalidation.

// The rendered page canvases, in page order — index N matches band.page N.
export function scoreCanvases() {
  return document.querySelectorAll('#score canvas');
}

// Resolve one stored band to current document pixels ({ center, rowMin,
// rowMax }). Returns null if its page canvas isn't present (e.g. mid re-render
// before every page has been appended) so callers can skip rather than scroll
// to a bogus position.
export function resolveBand(band, canvases) {
  const cv = canvases[band.page];
  if (!cv) return null;
  const rect = cv.getBoundingClientRect();
  const top = rect.top + window.scrollY;
  const h = rect.height;
  return {
    center: top + band.fracCenter * h,
    rowMin: top + band.fracMin * h,
    rowMax: top + band.fracMax * h,
  };
}

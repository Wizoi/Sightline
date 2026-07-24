// Shared staff-line row detection: scan a rendered page's pixels for rows
// where a continuous run of "ink" spans most of the page width (a staff
// line), and collect those row indices. Both the automatic/lightweight Snap
// mode (src/systemDetection.js) and the heavier, user-triggered Analyze pass
// (src/scoreAnalysis.js) fed this exact same scan into lib/systemDetection.js's
// pageSystems()/pageSystemsDetailed() clustering — before this module existed,
// the isInk test, the run-length row scan, and the 0.45-width/570-brightness
// thresholds were duplicated character-for-character between the two files
// (docs/reviews/2026-07-19-fable-review.md, finding B4). The two callers'
// render setup (how each gets from a page/canvas to pixel data) and their
// invocation context (automatic vs. user-triggered) are legitimately
// different and stay separate -- only the pixel scan itself moves here.
//
// Takes an isInk(row, col) callback + explicit width/height, matching the
// calling convention already used by every other pixel-scanner in this
// codebase (src/timeSigDetection.js's findInkBlobs, src/lib/
// measureNumberLocate.js's locateInBand/locateMeasureNumber) rather than a
// raw ImageData array: both current callers already build an isInk(r, c)
// closure over their own getImageData() buffer before this scan runs, so
// taking the callback here costs nothing and keeps this module (and any
// future caller) agnostic to how pixels are actually sourced.
export function detectStaffRows(isInk, aw, ah, opts = {}) {
  const widthFrac = opts.widthFrac ?? 0.45;  // a staff line spans most of the width
  const need = widthFrac * aw;
  const lineRows = [];
  for (let r = 0; r < ah; r++) {
    let best = 0, cur = 0;
    for (let c = 0; c < aw; c++) {
      if (isInk(r, c)) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    if (best > need) lineRows.push(r);
  }
  return lineRows;
}

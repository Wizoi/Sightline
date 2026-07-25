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
  // A real SCANNED staff line (as opposed to one drawn by a clean vector
  // PDF) commonly isn't one unbroken run of ink across its whole length --
  // confirmed by dumping real per-row ink data for a badly-undercounting
  // page ("Full band arrangements/Teutonia.pdf," Oboe part): every one of
  // that page's 7-8 real staves had its longest continuous run fall well
  // short of the 0.45*aw need (as low as 0.42, some staves scoring 0 -- not
  // one of their 5 lines ever registered), even though each row's TOTAL ink
  // coverage was 50-80% of the width. The gaps interrupting each line are
  // small and frequent (median 5px, 90th percentile 19px, out of an
  // ~1550px-wide analysis canvas) -- a real degraded-scan/downsampling
  // artifact (aging print, photocopy toner variation, antialiasing when a
  // sub-pixel-thin scanned line is resampled to this module's fixed ah=1200
  // canvas), not scattered unrelated ink: genuinely separate features (note
  // heads, stems, beams, rests) are surrounded by MUCH bigger gaps (tens to
  // hundreds of px -- this file's own largest real gaps ran 60-227px).
  // Bridging over any single gap no wider than gapBridgePx when measuring a
  // row's longest run recovers these real, physically-continuous-looking
  // lines without also bridging genuinely separate ink blobs apart from
  // each other. Calibrated, not guessed: this file's own real noise-gap
  // distribution (median 5px, 75th pct 11px, 90th pct 19px) puts 10px around
  // its 70-75th percentile -- comfortably past the bulk of the noise without
  // reaching anywhere near the smallest real gap this same file's dense note
  // passages showed between genuinely separate ink features (60px, a 6x
  // margin), and it barely moves an ALREADY-correctly-detected page's own
  // passing-row count (89 -> 90 on this file's Flute part) -- see
  // docs/personas/omr/investigation-log.md's 2026-07-25 entry for the full
  // per-page sweep this was chosen from.
  const gapBridgePx = opts.gapBridgePx ?? 10;
  // Bridging alone is NOT enough: a real printed paragraph of TEXT (found on
  // a real clean/vector PDF, "Personal conditioning duets and music/.../
  // CavalliniNo1-a4.pdf" -- a Mutopia license-notice box at the page bottom)
  // can ALSO reach a long bridged "run" this way, since word/letter spacing
  // in ordinary body text is frequently just as small as a scanned staff
  // line's own noise gaps -- there's no gap-size threshold that cleanly
  // separates the two, they overlap in scale. What DOES separate them: a
  // real (even degraded) staff line's recognized run is still made of
  // mostly-ACTUAL ink once bridged (93% of this module's own real recovered
  // Teutonia row), while a text paragraph's recognized run is mostly
  // whitespace BETWEEN/WITHIN letters stitched together by bridging (54-74%
  // across this Cavallini box's 4 offending rows, confirmed by dumping its
  // real segment data) -- a text line simply has much more true white space
  // per unit width than a printed staff rule does, even after the small
  // gaps get bridged. inkDensityMin=0.85 sits with real margin above the
  // worst confirmed false positive (0.74) and real margin below the
  // confirmed true positive (0.93) -- same calibration discipline as this
  // module's other thresholds. Only applied to bridged runs (the win case
  // pre-fix already required the WHOLE need-length to be unbroken ink, i.e.
  // density 1.0, so this never rejects anything the old algorithm accepted).
  const inkDensityMin = opts.inkDensityMin ?? 0.85;
  const lineRows = [];
  for (let r = 0; r < ah; r++) {
    // Qualification is checked per-run, as each run grows -- NOT by finding
    // the single longest run and testing that one. Testing only the longest
    // run is subtly wrong once inkDensityMin exists: a row can hold BOTH a
    // genuine solid staff-line run that clears `need` at density 1.0 AND,
    // elsewhere on the same row, a longer but sparser bridged stretch (a
    // dotted/dashed rule, a widely-letter-spaced text line). The sparse one
    // wins "longest," fails the density gate, and the row is rejected --
    // silently losing a real staff line the ORIGINAL (pre-bridging)
    // algorithm would have accepted. Confirmed reachable with a synthetic
    // row (solid 460px run + a later sparse bridged stretch, need=450):
    // longest-run logic rejects it, per-run logic accepts it. Not observed
    // on the current 39-file corpus, but it's a real latent trap in exactly
    // the mixed-content rows (staff + nearby text/dashes) this module now
    // deliberately scans over, so it's gated correctly rather than left to
    // chance.
    let qualifies = false;
    let cur = 0, curInk = 0, gap = 0, started = false;
    for (let c = 0; c < aw && !qualifies; c++) {
      if (isInk(r, c)) {
        if (started && gap > 0 && gap <= gapBridgePx) cur += gap;      // bridge a small gap: it doesn't break the run
        else if (gap > gapBridgePx) { cur = 0; curInk = 0; }          // a real break: start a new run
        cur++; curInk++; gap = 0; started = true;
        if (cur > need && curInk / cur >= inkDensityMin) qualifies = true;
      } else if (started) {
        gap++;
      }
    }
    if (qualifies) lineRows.push(r);
  }
  return lineRows;
}

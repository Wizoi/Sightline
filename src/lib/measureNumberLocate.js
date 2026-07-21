import { findInkBlobs } from '../timeSigDetection.js';

// Pass 1 of OCR measure-number reading: find *where* a system's measure number
// is printed, using ink structure alone (no OCR). A measure number sits above a
// system's top staff line, at the far left. Two facts isolate it:
//   • vertically it is the TOP-most ink in that left band — the clef, key and
//     noteheads live on/near the staff below it, with a clear gap between;
//   • horizontally it is the LEFT-most blob in its own row-band — music begins
//     further right.
// So: take the top-most contiguous inked row-cluster (the number's rows), then
// the left-most ink blob within those rows. Returning that tight box lets the
// OCR pass read a clean, isolated number instead of a fixed guess-region that
// clips it or drags in neighbouring music (which is what capped accuracy).
//
// Everything is in the caller's pixel space: isInk(r, c) is the rendered page's
// ink predicate; systemTop is the row of the top staff line; staffHeight is
// rowMax - rowMin; width is the page width in px. Returns { x0, y0, x1, y1 }
// (half-open in x, inclusive in y) or null if no number-like blob is found.
export function locateMeasureNumber(isInk, {
  systemTop, staffHeight, width,
  leftFrac = 0.2,     // measure numbers live in the far-left margin
  bandAbove = 1.6,    // how far above the staff to look (× staff height)
  bandBelow = 0.05,   // stop just above the top staff line (music is on/below it)
} = {}) {
  const rowTop = Math.max(0, Math.round(systemTop - bandAbove * staffHeight));
  const rowBot = Math.round(systemTop - bandBelow * staffHeight);
  const colEnd = Math.max(1, Math.round(width * leftFrac));
  if (rowBot <= rowTop) return null;

  // Step 1 — the number's FIRST DIGIT: the left-most ink blob (small mergeGap so
  // it's a single digit, not merged with anything to its right). Its columns are
  // clean — no note lives in the number's own left-most columns.
  const firstBlobs = findInkBlobs(isInk, rowTop, rowBot, 0, colEnd, {
    strokeNeed: Math.max(2, Math.round(staffHeight * 0.14)),
    mergeGap: Math.max(2, Math.round(staffHeight * 0.1)),
    minWidth: Math.max(2, Math.round(staffHeight * 0.08)),
  });
  if (!firstBlobs.length) return null;
  const [fx0, fx1] = firstBlobs[0];

  // Step 2 — the number's tight ROW-band: the TOP-most contiguous run of inked
  // rows within the first digit's columns, stopping at the first vertical gap.
  // The number sits above the staff with clear space beneath, so this run is the
  // digit's own height and stops before any note that happens to sit right below
  // it in the same columns.
  const rowGap = Math.max(1, Math.round(staffHeight * 0.15));
  const colHasInk = (r) => { for (let c = fx0; c < fx1; c++) { if (isInk(r, c)) return true; } return false; };
  let y0 = null, y1 = null, lastInk = null;
  for (let r = rowTop; r <= rowBot; r++) {
    if (colHasInk(r)) {
      if (y0 === null) y0 = r;
      y1 = r; lastInk = r;
    } else if (y0 !== null && r - lastInk > rowGap) {
      break;
    }
  }
  if (y0 === null) return null;

  // Step 3 — the number's full width: left-most→right-most ink WITHIN that thin
  // row-band. The clef/first note sit lower than the number, so they're outside
  // this band and can't extend the box; the remaining digits (same height) are
  // included. The caller whitens everything outside this box, so any stray note
  // ink that does poke into the band's corners is dropped before OCR.
  let x0 = null, x1 = null;
  for (let c = 0; c < colEnd; c++) {
    let inked = false;
    for (let r = y0; r <= y1; r++) { if (isInk(r, c)) { inked = true; break; } }
    if (inked) { if (x0 === null) x0 = c; x1 = c; }
  }
  if (x0 === null) return null;

  return { x0, y0, x1: x1 + 1, y1 };
}

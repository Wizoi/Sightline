import { matchDigit } from './lib/timeSigMatch.js';

// Best-effort time-signature reading via shape matching — see
// lib/timeSigMatch.js's header for why this exists and why it's never
// trusted blindly. This file is the DOM-facing half: locating a candidate
// glyph region on the real rendered page and rendering reference digit
// bitmaps (via canvas text, since there's no bundled copy of the actual
// music engraving font — a plain bold sans-serif is close enough for
// coarse shape matching, not exact-font OCR).

const GRID_W = 16, GRID_H = 20;       // normalized comparison size
const CONFIDENCE_THRESHOLD = 0.55;    // tuned against a real test score — see scoreAnalysis.js callers

let cachedTemplates = null;
function getDigitTemplates() {
  if (cachedTemplates) return cachedTemplates;
  const canvas = document.createElement('canvas');
  canvas.width = GRID_W; canvas.height = GRID_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const templates = {};
  for (let d = 0; d <= 9; d++) {
    ctx.clearRect(0, 0, GRID_W, GRID_H);
    ctx.fillStyle = '#000';
    ctx.font = `bold ${GRID_H}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(String(d), GRID_W / 2, 0);
    templates[String(d)] = canvasToGrid(ctx, GRID_W, GRID_H);
  }
  cachedTemplates = templates;
  return templates;
}

function canvasToGrid(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const grid = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      row.push(data[(r * w + c) * 4 + 3] > 128 ? 1 : 0); // alpha channel -- a filled pixel
    }
    grid.push(row);
  }
  return grid;
}

// Nearest-neighbor resamples the isInk(r,c) region [rowStart,rowEnd) x
// [colStart,colEnd) into a fixed GRID_W x GRID_H binary grid for
// comparison against the (also fixed-size) digit templates.
function extractGrid(isInk, rowStart, rowEnd, colStart, colEnd) {
  const srcH = Math.max(1, rowEnd - rowStart), srcW = Math.max(1, colEnd - colStart);
  const grid = [];
  for (let r = 0; r < GRID_H; r++) {
    const row = [];
    for (let c = 0; c < GRID_W; c++) {
      const sr = Math.floor(rowStart + (r / GRID_H) * srcH);
      const sc = Math.floor(colStart + (c / GRID_W) * srcW);
      row.push(isInk(sr, sc) ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

// Column ranges containing a real glyph stroke within [rowMin,rowMax],
// merging small gaps together (bridging the natural gaps within one
// glyph's own disconnected strokes) and discarding anything narrower than
// a minimum width (stray marks, not a real glyph).
//
// A column "has ink" here if its longest *continuous* run of ink rows
// exceeds a small threshold -- not merely "any ink at all". That went
// through two wrong versions, both found by looking directly at a real
// rendered time signature rather than guessing: requiring a run covering
// half the band (matching how a barline looks) found nothing, since a
// clef/flat/digit's curved and diagonal strokes never produce one
// unbroken tall stroke in any single column. But "any ink at all" was
// wrong the other way -- the staff's own horizontal lines run the full
// width of the system, so every single column has "some" ink regardless
// of whether a real glyph is there, merging the entire region into one
// blob. A small run-length threshold (comfortably thicker than one staff
// line, comfortably thinner than a real stroke) separates the two.
function findInkBlobs(isInk, rowMin, rowMax, colStart, colEnd) {
  const bandHeight = rowMax - rowMin + 1;
  const strokeNeed = Math.max(2, Math.round(bandHeight * 0.04));
  const mergeGap = Math.max(1, Math.round(bandHeight * 0.02));
  const minWidth = Math.max(2, Math.round(bandHeight * 0.08));

  const blobs = [];
  let start = null, lastInk = null;
  for (let c = colStart; c < colEnd; c++) {
    let best = 0, cur = 0;
    for (let r = rowMin; r <= rowMax; r++) {
      if (isInk(r, c)) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    const hasInk = best >= strokeNeed;
    if (hasInk) {
      if (start === null) start = c;
      lastInk = c;
    } else if (start !== null && c - lastInk > mergeGap) {
      blobs.push([start, lastInk + 1]);
      start = null;
    }
  }
  if (start !== null) blobs.push([start, lastInk + 1]);
  return blobs.filter(([s, e]) => e - s >= minWidth);
}

// Tries each early ink blob after the clef (skipping blob 0) as a
// candidate time-signature location, since a key signature (if present)
// interferes with a fixed-position guess -- the confidence threshold, not
// blob position, is what actually discriminates a real time-signature
// match from a clef/accidental/note fragment. Returns null below
// threshold rather than a low-confidence guess; the caller only ever
// offers this as a "detected — use this?" suggestion, never applies it
// silently.
export function detectTimeSignature(isInk, rowMin, rowMax, colStart, colEnd) {
  const blobs = findInkBlobs(isInk, rowMin, rowMax, colStart, colEnd);
  const templates = getDigitTemplates();
  const midRow = rowMin + (rowMax - rowMin) / 2;

  let best = null;
  for (const [bStart, bEnd] of blobs.slice(1, 4)) { // skip blob 0 (the clef)
    const numGrid = extractGrid(isInk, rowMin, midRow, bStart, bEnd);
    const denGrid = extractGrid(isInk, midRow, rowMax, bStart, bEnd);
    const num = matchDigit(numGrid, templates);
    const den = matchDigit(denGrid, templates);
    if (!num || !den) continue;
    const confidence = Math.min(num.confidence, den.confidence);
    if (!best || confidence > best.confidence) {
      best = { beatsPerMeasure: parseInt(num.digit, 10), noteValue: parseInt(den.digit, 10), confidence };
    }
  }
  return best && best.confidence >= CONFIDENCE_THRESHOLD ? best : null;
}

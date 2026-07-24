import { matchDigit, pickBestTimeSig } from './lib/timeSigMatch.js';
import { ocrDigitsBox } from './ocr.js';

// Best-effort time-signature reading, via TWO independent methods compared
// against each other — see lib/timeSigMatch.js's header for why this exists
// and why it's never trusted blindly. This file is the DOM-facing half:
// locating a candidate glyph region on the real rendered page, then reading
// it two ways:
//   • GRID — resample the region into a fixed-size binary grid and
//     Jaccard-match it against reference digit templates rendered from the
//     bundled Bravura SMuFL font (falling back to a plain sans-serif render
//     if that font isn't available — see getDigitTemplates()).
//   • OCR  — feed the same high-res crop to the tesseract.js worker already
//     used for image-only-PDF measure numbers (see ocr.js), PSM 8 (single
//     word), separately for the numerator and denominator halves.
// Both report a confidence on the same 0-1 scale; pickBestTimeSig() (pure,
// lib/timeSigMatch.js) takes whichever is higher. See docs/PERSONAS.md
// persona 3's 2026-07-23 write-up for what this comparison actually found on
// real files, and why "highest confidence wins" was the chosen combination
// rather than a fixed primary/fallback order.

const GRID_W = 16, GRID_H = 20;       // normalized comparison size
const CONFIDENCE_THRESHOLD = 0.55;    // tuned against a real test score — see scoreAnalysis.js callers

// SMuFL fixed codepoints for the ten time-signature digit glyphs
// (timeSig0..timeSig9) — see https://www.smufl.org, confirmed against
// Bravura's own glyphnames metadata. Every SMuFL-conformant engraving font
// (Bravura, Leland, Petaluma, etc.) places these digits at the same
// codepoints, so this mapping doesn't need to change if a different
// SMuFL font is ever bundled instead.
const SMUFL_TIMESIG_0 = 0xE080;
const BRAVURA_FAMILY = 'SightlineBravura';

let bravuraLoadPromise = null;
// Loads the self-hosted Bravura webfont (see scripts/fetch-bravura-assets.mjs)
// via the FontFace API rather than a stylesheet @font-face rule -- lets this
// module await actual readiness (a canvas fillText() with a not-yet-loaded
// custom font silently falls back to the default font with NO error, which
// would have quietly re-introduced the plain-sans-serif-template problem
// this exists to fix). Resolves to false (not a throw) on any failure --
// missing/blocked font file, corrupt asset, browser without FontFace -- so a
// broken/missing font asset degrades to the previous, still-functional
// plain-digit template rather than breaking time-signature detection
// entirely.
function loadBravuraFont() {
  if (bravuraLoadPromise) return bravuraLoadPromise;
  bravuraLoadPromise = (async () => {
    try {
      if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
      const base = import.meta.env.BASE_URL + 'fonts/';
      const face = new FontFace(BRAVURA_FAMILY, `url(${base}Bravura.woff2)`);
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (e) {
      return false;
    }
  })();
  return bravuraLoadPromise;
}

let cachedTemplates = null;
async function getDigitTemplates() {
  if (cachedTemplates) return cachedTemplates;
  const haveBravura = await loadBravuraFont();
  const canvas = document.createElement('canvas');
  canvas.width = GRID_W; canvas.height = GRID_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const templates = {};
  for (let d = 0; d <= 9; d++) {
    ctx.clearRect(0, 0, GRID_W, GRID_H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    if (haveBravura) {
      // Bravura's time-signature glyphs are drawn well above their own
      // nominal em-box top (a SMuFL convention: the glyph is designed to sit
      // centered on a staff line, not flush against a text baseline like an
      // ordinary digit) -- rendering at 2x the target size and centering
      // vertically in the grid, rather than textBaseline:'top' at GRID_H,
      // keeps the actual glyph ink inside the comparison grid instead of
      // rendering mostly (or entirely) above row 0. Confirmed empirically
      // against the real bundled font, not guessed.
      ctx.font = `${GRID_H}px "${BRAVURA_FAMILY}"`;
      ctx.textBaseline = 'middle';
      ctx.fillText(String.fromCodePoint(SMUFL_TIMESIG_0 + d), GRID_W / 2, GRID_H / 2);
    } else {
      ctx.font = `bold ${GRID_H}px sans-serif`;
      ctx.fillText(String(d), GRID_W / 2, 0);
    }
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
export function findInkBlobs(isInk, rowMin, rowMax, colStart, colEnd, opts = {}) {
  const bandHeight = rowMax - rowMin + 1;
  // Thresholds default to fractions of the band height (tuned for time-sig
  // glyphs) but can be overridden absolutely — the measure-number locate pass
  // needs a larger mergeGap so a multi-digit number's digits join into one blob
  // instead of splitting. See src/lib/measureNumberLocate.js.
  const strokeNeed = opts.strokeNeed ?? Math.max(2, Math.round(bandHeight * 0.04));
  const mergeGap = opts.mergeGap ?? Math.max(1, Math.round(bandHeight * 0.02));
  const minWidth = opts.minWidth ?? Math.max(2, Math.round(bandHeight * 0.08));

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

// Tries each early ink blob after the clef (skipping blob 0) as a candidate
// time-signature location, since a key signature (if present) interferes
// with a fixed-position guess -- the confidence threshold, not blob
// position, is what actually discriminates a real time-signature match from
// a clef/accidental/note fragment. Returns the best-scoring candidate found
// (which may still be below CONFIDENCE_THRESHOLD -- gating happens once, in
// detectTimeSignature(), after combining with the OCR method below) or null
// if no blob produced a matchable digit pair at all.
//
// Tries up to 7 candidates (not the original 3) -- confirmed a real miss
// against a real file (see docs/PERSONAS.md persona 3, 2026-07-23): a busy
// 5-flat key signature produces 4 accidental blobs before the real
// time-signature glyph, which the original `slice(1, 4)` window never
// reached at all.
async function detectTimeSignatureGrid(isInk, rowMin, rowMax, colStart, colEnd) {
  const blobs = findInkBlobs(isInk, rowMin, rowMax, colStart, colEnd);
  const templates = await getDigitTemplates();
  const midRow = rowMin + (rowMax - rowMin) / 2;

  let best = null;
  for (const [bStart, bEnd] of blobs.slice(1, 8)) { // skip blob 0 (the clef)
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
  return best;
}

// Same candidate blobs as the grid method, read instead via the tesseract.js
// worker already loaded for image-only-PDF measure numbers (ocr.js) -- PSM 8
// (single word), separately for each blob's numerator/denominator half (the
// same split the grid method makes). `canvas` is the same high-res candidate
// region canvas the caller already rendered (see renderHighResRegion in
// scoreAnalysis.js) — box coordinates are plain canvas pixels since the
// caller always passes rowMin=0/colStart=0 for this region already.
//
// Best-effort in the strongest sense: any worker-load or recognition failure
// here must never break the (already-working) grid method, so the caller
// wraps this in its own try/catch. Confidence is Tesseract's native 0-100
// scale, normalized to 0-1 by dividing by 100 -- see pickBestTimeSig()'s own
// doc comment for why every candidate must share one scale before comparing.
//
// Requiring BOTH halves to independently recognize a digit at all (num.value
// AND den.value non-null) -- not any confidence floor -- is what actually
// filters out non-digit blobs here: confirmed directly against 5 real files
// (see docs/PERSONAS.md persona 3, 2026-07-23) that a spurious blob (a clef
// swirl, a key-signature flat) reads as a digit on AT MOST one side by
// chance, never cleanly on both, so this gate alone did all the real
// filtering work in every test file. Once past that gate, the pair's
// confidence is the MAX (not min) of the two sides -- also confirmed
// directly: Tesseract's own per-character confidence for a genuinely
// CORRECT short digit read is itself unreliable (a real, correctly-read "4"
// denominator self-reported 0% confidence, reproduced consistently across
// multiple PSM modes against the real production worker), while an
// incorrect read on a non-digit fragment was already excluded by the
// both-sides gate above -- so by the time confidence is compared, the risk
// min() was guarding against (one side being a low-confidence fluke) is
// already handled structurally, and min() was actively throwing away the
// one genuinely correct real match found in this testing (a true 94%-
// confidence numerator dragged down to a 0% combined score by its own
// correctly-read-but-0%-confidence denominator).
async function detectTimeSignatureOCR(canvas, isInk, rowMin, rowMax, colStart, colEnd) {
  const blobs = findInkBlobs(isInk, rowMin, rowMax, colStart, colEnd);
  const midRow = rowMin + (rowMax - rowMin) / 2;

  let best = null;
  for (const [bStart, bEnd] of blobs.slice(1, 8)) {
    const numBox = { x0: bStart, y0: rowMin, x1: bEnd, y1: midRow };
    const denBox = { x0: bStart, y0: midRow, x1: bEnd, y1: rowMax };
    const [num, den] = await Promise.all([ocrDigitsBox(canvas, numBox), ocrDigitsBox(canvas, denBox)]);
    if (num.value == null || den.value == null) continue;
    const confidence = Math.max(num.confidence, den.confidence) / 100;
    if (!best || confidence > best.confidence) {
      best = { beatsPerMeasure: num.value, noteValue: den.value, confidence };
    }
  }
  return best;
}

// Best-effort time-signature detection, combining the two methods above.
// Returns null below CONFIDENCE_THRESHOLD rather than a low-confidence
// guess; the caller only ever offers this as a "detected — use this?"
// suggestion, never applies it silently (see scoreAnalysis.js /
// autoScrollUI.js). `canvas` is the same high-res region render the grid
// method's `isInk` was itself derived from (see scoreAnalysis.js).
export async function detectTimeSignature(canvas, isInk, rowMin, rowMax, colStart, colEnd) {
  const grid = await detectTimeSignatureGrid(isInk, rowMin, rowMax, colStart, colEnd);
  let ocr = null;
  try {
    ocr = await detectTimeSignatureOCR(canvas, isInk, rowMin, rowMax, colStart, colEnd);
  } catch (e) { /* OCR is a bonus signal -- a worker/model load failure must not cost the grid result */ }
  const best = pickBestTimeSig([
    grid ? { ...grid, source: 'grid' } : null,
    ocr ? { ...ocr, source: 'ocr' } : null,
  ]);
  return best && best.confidence >= CONFIDENCE_THRESHOLD ? best : null;
}

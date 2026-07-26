// OCR fallback for image-only PDFs — the ones with no extractable text layer,
// where page.getTextContent() returns nothing (a flattened/scanned export, as
// opposed to notation software's real text). The measure numbers are still
// *printed* on such a page; this reads them back off the rendered image so
// scoreAnalysis.js can refine measure counts from real numbers instead of
// falling all the way back to the (over-counting) barline estimate.
//
// Two independent reading methods are offered, because different engravings
// favour different ones (a tightly-set score defeats per-number cropping; a
// generously-spaced one defeats the strip). scoreAnalysis.js runs both and, when
// they disagree, lets the user pick:
//   • BOX   — locate each number's tight pixel box (lib/measureNumberLocate.js)
//             and OCR just it, one isolated number per image (PSM 8).
//   • STRIP — OCR the whole left margin at once and keep the left-column numbers
//             (PSM 11 "sparse"), correlating them to systems by position.
//
// Everything is lazy and self-hosted: tesseract.js is dynamically imported the
// first time OCR is needed (never touching the base bundle for normal PDFs), and
// its worker/core/model are served from this app's own origin (public/tesseract/,
// populated by scripts/fetch-ocr-assets.mjs) — no CDN, nothing uploaded.
//
// A third, unrelated caller reuses this same worker-lifecycle machinery:
// timeSigDetection.js's OCR-based time-signature reading (ocrDigitsBox()
// below) — same lazy self-hosted worker, same PSM-8 single-word digit
// recognition, applied to a numerator/denominator crop instead of a measure
// number. See docs/personas/omr/investigation-log.md's 2026-07-23 write-up for why this
// was tried (a cheaper, zero-new-dependency alternative to bundling
// engraving-font reference glyphs) and what it actually measured.
//
// A FOURTH method, added later, reads ordinary LETTERS rather than digits:
//   • WORDS — OCR the top of the page (PSM 3, no digit whitelist) for
//             instrument names / section titles, so a scanned/image-only
//             PDF's section names can be matched the same way a born-digital
//             PDF's real text layer already is (lib/scoreText.js). See
//             ocrPageWords() below and docs/personas/omr/investigation-log.md.

import { createLeasePool } from './lib/leasePool.js';

// A recognized word's canvas-pixel bbox -> a pdfjs-style text point { x, y } in
// PDF points (y flips: the text layer's origin is the page's bottom-left).
// pxPerPt = canvas.width / pageWidthPts. Pure and exported for unit testing.
export function bboxToPoint(bbox, pxPerPt, pageHeightPts) {
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  return { x: cx / pxPerPt, y: pageHeightPts - cy / pxPerPt };
}

/* --- Worker pool ---------------------------------------------------------
 *
 * Recognition dominates analysis time and is the only part that does: on a
 * real 40-page scanned score (KingCotton) a profiled run spent 73s of its
 * 81s inside these calls -- 451 per-number BOX recognitions at ~72ms and 34
 * whole-margin STRIP recognitions at ~1.0s -- against ~3s for every
 * page.render() in the entire pipeline combined. Those recognitions are
 * mutually independent (BOX and STRIP are deliberately separate readings of
 * the same page, and each box is its own image), but they used to run
 * strictly serially on ONE worker, i.e. on one core of however many the
 * machine has. This pool exists to use the rest.
 *
 * Each job leases a worker for its whole recognize() call, which also fixes
 * a hazard the single-worker design had to defend against by hand: the four
 * kinds of pass here need different Tesseract parameters (digits-only vs.
 * letters, four different page-segmentation modes), and with one shared
 * worker every call site had to re-set its own parameters immediately before
 * recognizing, trusting that nothing interleaved in between. A leased worker
 * cannot be reconfigured underneath a job, so the parameters are now a
 * property OF the job (see PROFILES) rather than a global that each caller
 * defensively rewrites.
 */

// Bounded well below hardwareConcurrency: each worker is a real thread that
// loads its own copy of the ~15MB LSTM model, so this trades memory for
// wall-clock and there's little left to win past a handful. Minus one to
// leave the main thread a core for page rendering and the UI.
const MAX_WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

const PROFILES = {
  // One isolated number (PSM 8 "single word"): the BOX measure-number path
  // and the time-signature digit path.
  digitsBox: { tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '8' },
  // One uniform block running down the left column (PSM 6): the STRIP path.
  digitsStrip: { tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '6' },
  // Ordinary title/running text, letters included (PSM 3, no whitelist):
  // the WORDS path. An empty whitelist means "no restriction" -- with the
  // digit whitelist left set, the engine is structurally incapable of ever
  // returning a letter, which is what this pass exists to read.
  words: { tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' },
};

async function spawnWorker() {
  const base = import.meta.env.BASE_URL + 'tesseract/';
  const { createWorker } = await import('tesseract.js');
  return createWorker('eng', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'tesseract-core-lstm.wasm.js', // non-SIMD LSTM: works everywhere
    langPath: base,
    gzip: true, // model is eng.traineddata.gz
  });
}

// The lease bookkeeping itself lives in lib/leasePool.js, where it can be
// unit-tested without a browser or a Tesseract worker -- pool sizing and
// hand-off bugs are invisible in normal operation and catastrophic when they
// happen (a leaked lease deadlocks the analysis).
const pool = createLeasePool({
  max: MAX_WORKERS,
  spawn: spawnWorker,
  configure: (worker, profile) => worker.setParameters(PROFILES[profile]),
});

// Runs one recognition on a leased worker configured for `profileName`.
const withWorker = (profileName, fn) => pool.run(profileName, fn);

// Blanks any row that's dark across nearly its full width -- a real digit
// stroke is always narrower than the full crop width, but a staff line
// crossing straight through it is not. Time-signature digits sit DIRECTLY ON
// the staff (unlike a measure number, which sits in the clear margin above/
// below it, never crossed by a staff line) -- confirmed directly against a
// real crop (see docs/personas/omr/investigation-log.md, 2026-07-23): Tesseract fails
// completely (0% confidence, empty string) on a raw numerator/denominator
// crop with staff lines crossing the glyph, and correctly reads the same
// glyph once those rows are blanked out first. Only ever applied to the
// time-signature path (ocrDigitsBox, via recognizeDigitsInBox's
// stripStaffLines option) -- never to the already-tuned/validated
// measure-number BOX path (recognizeBox), whose crops don't have this
// problem in the first place (a number in the clear margin has no staff
// lines to strip).
function stripStaffLineRows(ctx, w, h, { minDarkFrac = 0.85 } = {}) {
  const img = ctx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    let dark = 0;
    for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4] < 128) dark++;
    }
    if (dark > w * minDarkFrac) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- Method BOX -----------------------------------------------------------
// Crops+upscales one located box and runs Tesseract on it, returning the raw
// digit string + Tesseract's own 0-100 confidence with NO gate applied --
// shared by recognizeBox() below (which gates it for the measure-number
// path) and ocrDigitsBox() (exported for the time-signature OCR path in
// timeSigDetection.js, which needs the raw confidence to weigh against the
// grid-Jaccard matcher's own 0-1 scale itself, not a fixed pass/fail here).
// box is { x0, y0, x1, y1 } in canvas pixels. The box is cropped to its own
// canvas and upscaled — tesseract.js's `rectangle` option is unreliable
// in-browser, and a small crop reads better enlarged.
async function recognizeDigitsInBox(canvas, box, { padPx = 6, upscale = 3, stripStaffLines = false } = {}) {
  const x = Math.max(0, Math.round(box.x0 - padPx));
  const y = Math.max(0, Math.round(box.y0 - padPx));
  const w = Math.min(canvas.width - x, Math.round(box.x1 - box.x0 + 2 * padPx));
  const h = Math.min(canvas.height - y, Math.round(box.y1 - box.y0 + 2 * padPx));
  if (w < 3 || h < 3) return { digits: null, confidence: 0 };
  const crop = document.createElement('canvas');
  crop.width = w * upscale;
  crop.height = h * upscale;
  const cctx = crop.getContext('2d');
  cctx.fillStyle = '#fff';
  cctx.fillRect(0, 0, crop.width, crop.height);
  cctx.drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
  if (stripStaffLines) stripStaffLineRows(cctx, crop.width, crop.height);
  // The crop is built before leasing a worker -- it's ordinary canvas work
  // and holding a pool slot through it would serialize the cheap part along
  // with the expensive one.
  const { data } = await withWorker('digitsBox', (worker) => worker.recognize(crop));
  const digits = (data.text || '').replace(/\D+/g, '');
  return { digits: digits || null, confidence: data.confidence };
}

async function recognizeBox(canvas, box, opts = {}) {
  const { minConfidence = 55, ...rest } = opts;
  const { digits, confidence } = await recognizeDigitsInBox(canvas, box, rest);
  if (!digits || confidence < minConfidence) return null;
  return parseInt(digits, 10);
}

// Reads one candidate digit box (e.g. a time-signature numerator/denominator
// half — see timeSigDetection.js's findInkBlobs) via the same lazy
// self-hosted worker as the measure-number paths above, PSM 8 (single word:
// a time-signature digit run is exactly that). Returns the parsed number (or
// null if nothing recognized) alongside Tesseract's own UNGATED 0-100
// confidence, so the caller can combine it against a differently-scaled
// confidence signal (the grid-Jaccard matcher's 0-1) itself — a fixed gate
// here would bake in an assumption about which method should win that
// belongs to that caller, not this shared OCR plumbing.
export async function ocrDigitsBox(canvas, box, opts = {}) {
  const { digits, confidence } = await recognizeDigitsInBox(canvas, box, { stripStaffLines: true, ...opts });
  return { value: digits ? parseInt(digits, 10) : null, confidence };
}

// boxes: [{ systemIndex, box, boxBelow }]. `box` is the usual above-the-staff
// candidate (locateMeasureNumber); `boxBelow` (optional) is the mirrored
// below-the-staff candidate (locateMeasureNumberBelow) for engravings that
// print the number under the staff instead (a real 2008 scanned combo/jazz
// chart, "Fat Burger" -- see docs/personas/omr/investigation-log.md). Tried in that
// order and the first one whose OCR passes the confidence gate wins, so a
// file where `box` already reads correctly is completely unaffected by
// `boxBelow` even being present -- purely an additional fallback, not a
// competing candidate. Returns [{ systemIndex, measureNumber }].
// Boxes are independent images, so they go out to the pool together rather
// than one after another -- this is the bulk of the recognition work on a
// scanned page (one box per system). Note what stays SEQUENTIAL: `boxBelow`
// is only tried when `box` itself failed the confidence gate, so the fallback
// still costs nothing on a file where the primary candidate reads fine.
// Results keep input order (Promise.all preserves it), matching the previous
// loop exactly.
export async function ocrNumbersByBox(canvas, boxes) {
  const results = await Promise.all(boxes.map(async ({ systemIndex, box, boxBelow }) => {
    let num = box ? await recognizeBox(canvas, box) : null;
    if (num == null && boxBelow) num = await recognizeBox(canvas, boxBelow);
    return num == null ? null : { systemIndex, measureNumber: num };
  }));
  return results.filter(Boolean);
}

// --- Method STRIP ---------------------------------------------------------
// OCR the whole left slice of the page at once and return the left-margin
// numbers as pdfjs-shaped items { str, x, y } in PDF points, for the caller to
// correlate to systems (extractMeasureNumbers). Cropped to its own canvas (a
// ~1/3 width keeps a workable aspect ratio; a thin strip reads as empty), then
// x-filtered so only the far-left number column survives.
export async function ocrNumbersByStrip(canvas, pageWidthPts, pageHeightPts, { cropFrac = 0.33, leftFrac = 0.2, minConfidence = 55 } = {}) {
  const cropW = Math.max(1, Math.round(canvas.width * cropFrac));
  const strip = document.createElement('canvas');
  strip.width = cropW;
  strip.height = canvas.height;
  strip.getContext('2d').drawImage(canvas, 0, 0, cropW, canvas.height, 0, 0, cropW, canvas.height);
  const { data } = await withWorker('digitsStrip', (worker) => worker.recognize(strip, {}, { blocks: true }));

  const pxPerPt = canvas.width / pageWidthPts;
  const maxX = pageWidthPts * leftFrac; // keep only the far-left number column
  const items = [];
  for (const block of (data.blocks || [])) {
    for (const par of (block.paragraphs || [])) {
      for (const line of (par.lines || [])) {
        for (const w of (line.words || [])) {
          const str = (w.text || '').trim();
          if (!str || w.confidence < minConfidence) continue;
          const pt = bboxToPoint(w.bbox, pxPerPt, pageHeightPts);
          if (pt.x > maxX) continue;
          items.push({ str, ...pt });
        }
      }
    }
  }
  return items;
}

// --- Method WORDS -----------------------------------------------------
// Reads real LETTERS (instrument/part names, tempo words) off a scanned
// page's rendered image — the piece the digit-only paths above structurally
// cannot provide. `tessedit_char_whitelist: '0123456789'` (set immediately
// before every digit-reading recognize() call above) makes the OCR engine
// itself incapable of ever recognizing a letter, not merely something that
// gets filtered out afterward -- see docs/personas/omr/investigation-log.md's
// 2026-07 write-up for why scanned-file section-name accuracy sat fixed at
// 28.6% across every benchmark snapshot before this existed: every OCR pass
// available for a scanned page could only ever recognize digits, so
// fillMissingSectionNames/collectKnownNames-style name matching (lib/
// scoreText.js) had literally nothing to work with on an image-only file,
// no matter how good the position/repetition logic itself was.
//
// Returns pdfjs-shaped items ({ str, x, y } in PDF points), the SAME shape
// page.getTextContent() produces for a real text layer -- deliberately, so
// the caller (scoreAnalysis.js) can feed OCR'd words into the exact same,
// already real-corpus-validated groupIntoRows/collectKnownNames/
// findSectionTitle pipeline used for born-digital PDFs, rather than
// building a second, parallel name-matching path. Cropped to the page's TOP
// topFrac (instrument names and tempo markings sit at/near the very top of
// a part's opening page — the same "position, not repetition" convention
// collectKnownNames already relies on for the text-layer case) both to keep
// this cheap (only ever called for pages already on the OCR path -- see
// scoreAnalysis.js) and to reduce misreads (a full page of staff notation
// OCR'd as "text" produces much more garbage than just its title block).
// PSM 3 (fully automatic page segmentation) rather than the digit paths'
// PSM 6/8/11 — this is ordinary running/title text, not one isolated number
// or a single left-hand column.
export async function ocrPageWords(canvas, pageWidthPts, pageHeightPts, { topFrac = 0.3, minConfidence = 55 } = {}) {
  const cropH = Math.max(1, Math.round(canvas.height * topFrac));
  const crop = document.createElement('canvas');
  crop.width = canvas.width;
  crop.height = cropH;
  crop.getContext('2d').drawImage(canvas, 0, 0, canvas.width, cropH, 0, 0, canvas.width, cropH);
  const { data } = await withWorker('words', (worker) => worker.recognize(crop, {}, { blocks: true }));

  const pxPerPt = canvas.width / pageWidthPts;
  const items = [];
  for (const block of (data.blocks || [])) {
    for (const par of (block.paragraphs || [])) {
      for (const line of (par.lines || [])) {
        for (const w of (line.words || [])) {
          const str = (w.text || '').trim();
          if (!str || w.confidence < minConfidence) continue;
          items.push({ str, ...bboxToPoint(w.bbox, pxPerPt, pageHeightPts) });
        }
      }
    }
  }
  return items;
}

// Frees every pooled worker (each is a thread plus a loaded model). Call once
// the analysis pass that used OCR has finished. No-op if OCR never ran.
// Waiters are dropped rather than resolved: reaching here with jobs still
// queued would mean the analysis that owns them has already finished, and
// handing them a terminated worker would be worse than leaving them pending.
export async function terminateOcr() {
  await pool.drain(async (worker) => {
    try { await worker.terminate(); } catch { /* already gone */ }
  });
}

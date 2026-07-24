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
// number. See docs/PERSONAS.md persona 3's 2026-07-23 write-up for why this
// was tried (a cheaper, zero-new-dependency alternative to bundling
// engraving-font reference glyphs) and what it actually measured.

// A recognized word's canvas-pixel bbox -> a pdfjs-style text point { x, y } in
// PDF points (y flips: the text layer's origin is the page's bottom-left).
// pxPerPt = canvas.width / pageWidthPts. Pure and exported for unit testing.
export function bboxToPoint(bbox, pxPerPt, pageHeightPts) {
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  return { x: cx / pxPerPt, y: pageHeightPts - cy / pxPerPt };
}

let workerPromise = null;

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const base = import.meta.env.BASE_URL + 'tesseract/';
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'tesseract-core-lstm.wasm.js', // non-SIMD LSTM: works everywhere
      langPath: base,
      gzip: true, // model is eng.traineddata.gz
    });
    await worker.setParameters({ tessedit_char_whitelist: '0123456789' }); // measure numbers are digits only
    return worker;
  })();
  return workerPromise;
}

// Blanks any row that's dark across nearly its full width -- a real digit
// stroke is always narrower than the full crop width, but a staff line
// crossing straight through it is not. Time-signature digits sit DIRECTLY ON
// the staff (unlike a measure number, which sits in the clear margin above/
// below it, never crossed by a staff line) -- confirmed directly against a
// real crop (see docs/PERSONAS.md persona 3, 2026-07-23): Tesseract fails
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
async function recognizeDigitsInBox(worker, canvas, box, { padPx = 6, upscale = 3, stripStaffLines = false } = {}) {
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
  const { data } = await worker.recognize(crop.toDataURL('image/png'));
  const digits = (data.text || '').replace(/\D+/g, '');
  return { digits: digits || null, confidence: data.confidence };
}

async function recognizeBox(worker, canvas, box, opts = {}) {
  const { minConfidence = 55, ...rest } = opts;
  const { digits, confidence } = await recognizeDigitsInBox(worker, canvas, box, rest);
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
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '8' });
  const { digits, confidence } = await recognizeDigitsInBox(worker, canvas, box, { stripStaffLines: true, ...opts });
  return { value: digits ? parseInt(digits, 10) : null, confidence };
}

// boxes: [{ systemIndex, box, boxBelow }]. `box` is the usual above-the-staff
// candidate (locateMeasureNumber); `boxBelow` (optional) is the mirrored
// below-the-staff candidate (locateMeasureNumberBelow) for engravings that
// print the number under the staff instead (a real 2008 scanned combo/jazz
// chart, "Fat Burger" -- see docs/PERSONAS.md persona 3). Tried in that
// order and the first one whose OCR passes the confidence gate wins, so a
// file where `box` already reads correctly is completely unaffected by
// `boxBelow` even being present -- purely an additional fallback, not a
// competing candidate. Returns [{ systemIndex, measureNumber }].
export async function ocrNumbersByBox(canvas, boxes) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '8' }); // single word = one isolated number
  const out = [];
  for (const { systemIndex, box, boxBelow } of boxes) {
    let num = box ? await recognizeBox(worker, canvas, box) : null;
    if (num == null && boxBelow) num = await recognizeBox(worker, canvas, boxBelow);
    if (num != null) out.push({ systemIndex, measureNumber: num });
  }
  return out;
}

// --- Method STRIP ---------------------------------------------------------
// OCR the whole left slice of the page at once and return the left-margin
// numbers as pdfjs-shaped items { str, x, y } in PDF points, for the caller to
// correlate to systems (extractMeasureNumbers). Cropped to its own canvas (a
// ~1/3 width keeps a workable aspect ratio; a thin strip reads as empty), then
// x-filtered so only the far-left number column survives.
export async function ocrNumbersByStrip(canvas, pageWidthPts, pageHeightPts, { cropFrac = 0.33, leftFrac = 0.2, minConfidence = 55 } = {}) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '6' }); // one uniform block down the left column
  const cropW = Math.max(1, Math.round(canvas.width * cropFrac));
  const strip = document.createElement('canvas');
  strip.width = cropW;
  strip.height = canvas.height;
  strip.getContext('2d').drawImage(canvas, 0, 0, cropW, canvas.height, 0, 0, cropW, canvas.height);
  const { data } = await worker.recognize(strip.toDataURL('image/png'), {}, { blocks: true });

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

// Frees the worker (a dedicated OS thread + the loaded model). Call once the
// analysis pass that used OCR has finished. No-op if OCR never ran.
export async function terminateOcr() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { (await p).terminate(); } catch { /* already gone */ }
}

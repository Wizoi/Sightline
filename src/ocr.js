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

// --- Method BOX -----------------------------------------------------------
// Read one located box. box is { x0, y0, x1, y1 } in canvas pixels. The box is
// cropped to its own canvas and upscaled — tesseract.js's `rectangle` option is
// unreliable in-browser, and a small crop reads better enlarged.
async function recognizeBox(worker, canvas, box, { padPx = 6, upscale = 3, minConfidence = 55 } = {}) {
  const x = Math.max(0, Math.round(box.x0 - padPx));
  const y = Math.max(0, Math.round(box.y0 - padPx));
  const w = Math.min(canvas.width - x, Math.round(box.x1 - box.x0 + 2 * padPx));
  const h = Math.min(canvas.height - y, Math.round(box.y1 - box.y0 + 2 * padPx));
  if (w < 3 || h < 3) return null;
  const crop = document.createElement('canvas');
  crop.width = w * upscale;
  crop.height = h * upscale;
  const cctx = crop.getContext('2d');
  cctx.fillStyle = '#fff';
  cctx.fillRect(0, 0, crop.width, crop.height);
  cctx.drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
  const { data } = await worker.recognize(crop.toDataURL('image/png'));
  const digits = (data.text || '').replace(/\D+/g, '');
  if (!digits || data.confidence < minConfidence) return null;
  return parseInt(digits, 10);
}

// boxes: [{ systemIndex, box }]. Returns [{ systemIndex, measureNumber }].
export async function ocrNumbersByBox(canvas, boxes) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '8' }); // single word = one isolated number
  const out = [];
  for (const { systemIndex, box } of boxes) {
    const num = await recognizeBox(worker, canvas, box);
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

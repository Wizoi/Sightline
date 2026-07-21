// OCR fallback for image-only PDFs — the ones with no extractable text layer,
// where page.getTextContent() returns nothing (a flattened/scanned export, as
// opposed to notation software's real text). The measure numbers are still
// *printed* on such a page; this reads them back off the rendered image so
// scoreAnalysis.js can refine measure counts from real numbers instead of
// falling all the way back to the (over-counting) barline estimate.
//
// Everything is lazy and self-hosted: tesseract.js is dynamically imported the
// first time OCR is actually needed (so it never touches the base bundle for
// normal PDFs), and its worker/core/model are served from this app's own origin
// (public/tesseract/, populated by scripts/fetch-ocr-assets.mjs) — no
// third-party CDN, nothing uploaded, consistent with the app's privacy story.
//
// The output is deliberately shaped like pdfjs' text-layer items ({ str, x, y }
// in PDF points, y=0 at the bottom) so the caller can feed it straight into the
// same extractMeasureNumbers()/refineMeasureCounts() path the real text layer
// already uses — see src/scoreAnalysis.js.

// A recognized word's canvas-pixel bounding box -> a pdfjs-style text item point
// { x, y } in PDF points. y flips because pdfjs' text layer (which this output
// mimics) puts the origin at the page's bottom-left, increasing upward, while
// canvas pixels increase downward. pxPerPt = canvas.width / pageWidthPts. Pure
// and exported so the mapping is unit-testable without a worker.
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
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789', // measure numbers are digits only
      tessedit_pageseg_mode: '6',            // treat the strip as one uniform block (best on the left number column)
    });
    return worker;
  })();
  return workerPromise;
}

// OCR the printed measure numbers on a rendered page image. Measure numbers sit
// in the far-left margin above each staff, so only a narrow left strip is
// scanned — that isolates the numbers from the dense music to their right,
// which is what makes recognition reliable (full-page OCR of a score is mostly
// noise). Returns pdfjs-shaped items { str, x, y } in PDF points.
//
// canvas: a page rendered to a canvas at any scale. pageWidthPts/pageHeightPts:
// the page's intrinsic size in PDF points (page.getViewport({scale:1})).
export async function ocrNumberItems(canvas, pageWidthPts, pageHeightPts, { cropFrac = 0.33, leftFrac = 0.2, minConfidence = 60 } = {}) {
  const worker = await getWorker();
  // OCR the whole rendered page, then keep only words in the left margin. (A
  // pre-cropped thin strip and tesseract.js's `rectangle` option both misread
  // as empty here — the extreme aspect ratio defeats its layout analysis — but
  // the full page reads fine.) Measure numbers are engraved in the far-left
  // margin above each staff, so an x-position filter isolates them from the
  // dense music to the right, which is where the misread noise comes from.
  // OCR only the left slice of the page — measure numbers live in the far-left
  // margin, and dropping the dense music to the right removes both the misread
  // noise and most of the OCR cost. Crop into its own canvas (a moderate ~1/3
  // width keeps a workable aspect ratio; a very thin strip defeats tesseract's
  // layout analysis and reads as empty). x within the crop equals x on the full
  // page (left-aligned, same scale), so no offset to undo.
  const cropW = Math.max(1, Math.round(canvas.width * cropFrac));
  const strip = document.createElement('canvas');
  strip.width = cropW;
  strip.height = canvas.height;
  strip.getContext('2d').drawImage(canvas, 0, 0, cropW, canvas.height, 0, 0, cropW, canvas.height);
  const { data } = await worker.recognize(strip.toDataURL('image/png'), {}, { blocks: true });

  const pxPerPt = canvas.width / pageWidthPts;
  const maxX = pageWidthPts * leftFrac; // left-margin cutoff, in PDF points
  const items = [];
  for (const block of (data.blocks || [])) {
    for (const par of (block.paragraphs || [])) {
      for (const line of (par.lines || [])) {
        for (const w of (line.words || [])) {
          const str = (w.text || '').trim();
          if (!str || w.confidence < minConfidence) continue;
          const pt = bboxToPoint(w.bbox, pxPerPt, pageHeightPts);
          if (pt.x > maxX) continue; // drop music-column misreads to the right
          items.push({ str, ...pt });
        }
      }
    }
  }
  return items;
}

// Frees the worker (a dedicated OS thread + the loaded model). Call once the
// analysis pass that used OCR has finished — a fresh one is created lazily next
// time. No-op if OCR never ran.
export async function terminateOcr() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { (await p).terminate(); } catch { /* already gone */ }
}

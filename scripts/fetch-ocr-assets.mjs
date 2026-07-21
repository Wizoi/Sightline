// Populates public/tesseract/ with the Tesseract.js worker, the OCR core WASM,
// and the English trained-data model, so the OCR fallback (see src/ocr.js) can
// serve them from this app's own origin instead of a third-party CDN — same
// reasoning as scripts/fetch-mediapipe-assets.mjs (school networks that block
// CDNs; keep everything client-side/self-hosted). Runs automatically before
// `npm run dev`/`npm run build` (see package.json pre-scripts); safe to run
// repeatedly — it skips work already done.
//
// public/tesseract/ is git-ignored: the worker + core come straight out of the
// already-installed tesseract.js / tesseract.js-core packages (so they can
// never drift from the pinned versions), and the model is fetched once from a
// stable, version-pinned URL. OCR only ever runs for image-only PDFs with no
// text layer, and only these assets are loaded then — never for normal
// notation-software PDFs.

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const DEST = path.join(root, 'public', 'tesseract');

// The non-SIMD LSTM core works in every browser (OCR speed isn't critical for a
// one-time Analyze pass), avoiding a SIMD-capability branch. src/ocr.js points
// corePath straight at this file so tesseract.js doesn't auto-select a variant
// we haven't hosted.
const CORE_FILES = [
  ['tesseract.js-core', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-lstm.wasm'],
];
const WORKER = ['tesseract.js', 'dist', 'worker.min.js'];

// tessdata_fast English — the smallest LSTM model that reads printed numerals
// reliably (validated against a real image-only lead sheet). Pinned to the
// same host tesseract.js defaults to, fetched once here instead of at runtime.
const MODEL_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz';
const MODEL_DEST = path.join(DEST, 'eng.traineddata.gz');

function copyLocal() {
  mkdirSync(DEST, { recursive: true });
  copyFileSync(path.join(root, 'node_modules', ...WORKER), path.join(DEST, 'worker.min.js'));
  for (const parts of CORE_FILES) {
    copyFileSync(path.join(root, 'node_modules', ...parts), path.join(DEST, parts[parts.length - 1]));
  }
  console.log(`[ocr-assets] copied worker + core WASM from node_modules -> public/tesseract/`);
}

async function fetchModelIfMissing() {
  if (existsSync(MODEL_DEST) && statSync(MODEL_DEST).size > 0) {
    console.log('[ocr-assets] model already present, skipping download');
    return;
  }
  mkdirSync(DEST, { recursive: true });
  console.log('[ocr-assets] downloading eng.traineddata.gz (one-time)...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Failed to download Tesseract model: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_DEST, buf);
  console.log(`[ocr-assets] saved model to public/tesseract/ (${(buf.length / 1e6).toFixed(2)}MB)`);
}

copyLocal();
await fetchModelIfMissing();

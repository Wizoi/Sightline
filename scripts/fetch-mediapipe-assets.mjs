// Populates public/mediapipe/ with the MediaPipe WASM runtime + face-landmark
// model, so the app can serve them from its own origin instead of Google's
// CDN/jsDelivr at runtime (see docs/PERSONAS.md persona 7 — this app's core
// audience is on school networks that sometimes block third-party CDNs, and
// the assets turned out to be small enough — ~13MB combined — that there's
// no real tradeoff in hosting them ourselves). Runs automatically before
// `npm run dev`/`npm run build` (see package.json's pre-scripts); safe to
// run repeatedly — it skips work that's already done.
//
// public/mediapipe/ is git-ignored: the WASM files are copied straight out
// of the already-installed @mediapipe/tasks-vision npm package (so they can
// never drift from the pinned dependency version), and the model file is
// fetched once from its stable, version-pinned Google Cloud Storage URL —
// the same URL this app used to point the browser at directly. Keeping a
// ~4MB binary out of git history is worth one network fetch per fresh
// install/CI run.

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const WASM_SRC_DIR = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST_DIR = path.join(root, 'public', 'mediapipe', 'wasm');
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

// Must match the version pinned in camera.js's history / this project's
// @mediapipe/tasks-vision dependency — this is the exact URL the app used
// to fetch at runtime, now fetched once here instead.
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_DEST_DIR = path.join(root, 'public', 'mediapipe', 'models');
const MODEL_DEST = path.join(MODEL_DEST_DIR, 'face_landmarker.task');

function copyWasmFiles() {
  mkdirSync(WASM_DEST_DIR, { recursive: true });
  for (const f of WASM_FILES) {
    copyFileSync(path.join(WASM_SRC_DIR, f), path.join(WASM_DEST_DIR, f));
  }
  console.log(`[mediapipe-assets] copied ${WASM_FILES.length} WASM files from node_modules -> public/mediapipe/wasm/`);
}

async function fetchModelIfMissing() {
  if (existsSync(MODEL_DEST) && statSync(MODEL_DEST).size > 0) {
    console.log('[mediapipe-assets] model already present, skipping download');
    return;
  }
  mkdirSync(MODEL_DEST_DIR, { recursive: true });
  console.log('[mediapipe-assets] downloading face_landmarker.task (~4MB, one-time)...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Failed to download MediaPipe model: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_DEST, buf);
  console.log(`[mediapipe-assets] saved model to public/mediapipe/models/ (${(buf.length / 1e6).toFixed(2)}MB)`);
}

copyWasmFiles();
await fetchModelIfMissing();

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { cfg, state } from './appState.js';
import { $, scoreEl, emptyEl } from './ui.js';
import { detectSystems } from './systemDetection.js';
import { canFollow } from './tracking/index.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export async function loadPdf(arrayBuffer) {
  state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  await renderAll();
  emptyEl.style.display = 'none';
  $('runBtn').disabled = !canFollow();
}

export async function renderAll() {
  scoreEl.innerHTML = '';
  // zoom = 100% fits the page width to the window; lower = smaller (see more
  // of the page at once); higher = bigger (may add a horizontal scrollbar).
  const fitWidth = (scoreEl.clientWidth || document.documentElement.clientWidth) - 8;   // space beside the pane
  const targetWidth = Math.max(200, Math.round(fitWidth * cfg.zoom));
  const dpr = window.devicePixelRatio || 1;
  for (let i = 1; i <= state.pdfDoc.numPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = targetWidth / base.width;
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = targetWidth + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    scoreEl.appendChild(canvas);
  }
  detectSystems();
}

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { cfg, state } from './appState.js';
import { $, scoreEl, emptyEl, toast, syncAutoScrollButton } from './ui.js';
import { detectSystems } from './systemDetection.js';
import { canFollow } from './tracking/index.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export async function loadPdf(arrayBuffer) {
  try {
    state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    toast('Could not open that PDF: ' + err.message);
    return;
  }
  await renderAll();
  emptyEl.style.display = 'none';
  $('runBtn').disabled = !canFollow();
}

// A generation counter guards against overlapping calls (resize/zoom/panel-
// collapse can each trigger a render while a previous one is still awaiting
// page.render()) — without it, an older call's appendChild()s can land
// after a newer call has already cleared scoreEl for its own pass,
// interleaving two page sets. Every await is followed by a generation check
// so a superseded call stops touching the DOM as soon as it's superseded,
// rather than only at the very end.
let renderGeneration = 0;

export async function renderAll() {
  const myGen = ++renderGeneration;
  scoreEl.innerHTML = '';
  // zoom = 100% fits the page width to the window; lower = smaller (see more
  // of the page at once); higher = bigger (may add a horizontal scrollbar).
  const fitWidth = (scoreEl.clientWidth || document.documentElement.clientWidth) - 8;   // space beside the pane
  const targetWidth = Math.max(200, Math.round(fitWidth * cfg.zoom));
  const dpr = window.devicePixelRatio || 1;
  for (let i = 1; i <= state.pdfDoc.numPages; i++) {
    if (myGen !== renderGeneration) return;
    const page = await state.pdfDoc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = targetWidth / base.width;
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = targetWidth + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (myGen !== renderGeneration) return;
    scoreEl.appendChild(canvas);
  }
  if (myGen !== renderGeneration) return;
  detectSystems();

  // A re-render means the page layout just changed (resize, zoom, panel
  // collapse) — auto-scroll's systemBands/highlight coordinates were
  // captured as absolute document pixels at Analyze time and are now stale.
  // Snap mode re-detects on every renderAll() automatically; auto-scroll
  // doesn't, so it needs an explicit invalidation rather than silently
  // scrolling/highlighting the wrong place next time it's started.
  if (state.autoScroll.analyzed) {
    state.autoScroll.analyzed = false;
    // Uses the shared sync helper, not a blind disable: if auto-scroll is
    // actively playing right now, this button is the only way to pause it,
    // and must stay enabled/labeled "Pause" -- see ui.js's
    // syncAutoScrollButton() for why analyzed=false alone doesn't disable it
    // while playing.
    syncAutoScrollButton();
    toast('Score layout changed — re-analyze for auto-scroll before starting.');
  }
}

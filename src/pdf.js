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
  // A genuinely new document invalidates any prior auto-scroll analysis —
  // different pages, different system count, different measure counts — so
  // clear it before rendering. This is the ONE place analysis resets: a plain
  // re-render of the same document (resize / zoom / rotation / sidebar
  // collapse) deliberately does not, because systemBands are page-relative and
  // reflow-stable (see systemGeometry.js).
  resetAutoScrollAnalysis();
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
  // No auto-scroll invalidation here: systemBands are page-relative (see
  // systemGeometry.js), so this reflow — whatever triggered it — is picked up
  // automatically the next time the position is applied. Snap mode's own
  // detection is re-run above via detectSystems().
}

// Clears auto-scroll analysis + playback back to its pre-Analyze state. Called
// only from loadPdf() (a new document). Kept here rather than importing
// stopAutoScroll() from the controller to avoid pulling the whole playback
// module — and its ui.js chain — into the PDF loader for a plain field reset.
function resetAutoScrollAnalysis() {
  const as = state.autoScroll;
  as.playing = false;
  as.schedule = null;
  as.scheduleElapsed = 0;
  as.analyzed = false;
  as.systemBands = [];
  as.measuresPerSystem = [];
  as.measureReadings = null;
  as.sections = [];
  as.activeSectionIndex = 0;
  const hl = $('autoScrollHighlight');
  if (hl) hl.style.display = 'none';
  syncAutoScrollButton();
}

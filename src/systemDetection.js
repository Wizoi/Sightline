import { state } from './appState.js';
import { $, scoreEl, sysMarksEl } from './ui.js';
import { pageSystems } from './lib/systemDetection.js';
import { detectStaffRows } from './lib/inkScan.js';

// Find staff systems: scan a downsampled copy of each page for rows of ink,
// group contiguous dark rows into systems (via lib/systemDetection.js), and
// record each weighted-center in document coordinates. Used by Snap mode.
export function detectSystems() {
  state.systemCentersDoc = [];
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  scoreEl.querySelectorAll('canvas').forEach((cv) => {
    const rect = cv.getBoundingClientRect();
    const docTop = rect.top + window.scrollY, docH = rect.height;
    const ah = 1200, aw = Math.max(60, Math.round(ah * cv.width / cv.height));
    tmp.width = aw; tmp.height = ah;
    tctx.drawImage(cv, 0, 0, aw, ah);
    let data;
    try { data = tctx.getImageData(0, 0, aw, ah).data; } catch (e) { return; }
    const isInk = (r, c) => {
      const i = (r * aw + c) * 4;
      return data[i] + data[i + 1] + data[i + 2] < 570;
    };
    const lineRows = detectStaffRows(isInk, aw, ah);
    pageSystems(lineRows).forEach((rowY) => state.systemCentersDoc.push(docTop + (rowY / ah) * docH));
  });
  state.systemCentersDoc.sort((a, b) => a - b);
  renderSysMarks();
  if (state.snapOn) $('snapBtn').textContent = '▦ Snap: on (' + state.systemCentersDoc.length + ')';
}

export function renderSysMarks() {
  sysMarksEl.innerHTML = '';
  if (!state.showSys) return;
  state.systemCentersDoc.forEach((y) => {
    const m = document.createElement('div');
    m.className = 'sysMark';
    m.style.display = 'block';
    m.style.top = y + 'px';
    m.style.position = 'absolute';
    sysMarksEl.appendChild(m);
  });
}

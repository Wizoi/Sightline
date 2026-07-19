import { state } from './appState.js';
import { $, scoreEl, sysMarksEl } from './ui.js';
import { pageSystems } from './lib/systemDetection.js';

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
    const need = 0.45 * aw;                            // a staff line spans most of the width
    const lineRows = [];
    for (let r = 0; r < ah; r++) {
      let best = 0, cur = 0; const base = r * aw * 4;
      for (let c = 0; c < aw; c++) {
        const i = base + c * 4;
        if (data[i] + data[i + 1] + data[i + 2] < 570) { cur++; if (cur > best) best = cur; } else cur = 0;
      }
      if (best > need) lineRows.push(r);
    }
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

import { state } from './appState.js';
import { scoreEl } from './ui.js';
import { pageSystemsDetailed } from './lib/systemDetection.js';
import { estimateMeasureCount } from './lib/barlineDetection.js';

// Scans the rendered score for systems (the same staff-line detection Snap
// mode uses — src/systemDetection.js) and, for each system, estimates its
// measure count via barline detection. This is the "Analyze score" step for
// auto-scroll: it deliberately duplicates the row-scanning part of
// src/systemDetection.js's detectSystems() rather than sharing it, since
// this is a heavier, explicitly user-triggered one-time pass (also scans
// columns for barlines), not something that should run automatically on
// every resize/zoom the way Snap mode's detection does.
export function analyzeScore() {
  const systemBands = [];
  const measuresPerSystem = [];

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

    const need = 0.45 * aw;                            // a staff line spans most of the width
    const lineRows = [];
    for (let r = 0; r < ah; r++) {
      let best = 0, cur = 0;
      for (let c = 0; c < aw; c++) {
        if (isInk(r, c)) { cur++; if (cur > best) best = cur; } else cur = 0;
      }
      if (best > need) lineRows.push(r);
    }

    pageSystemsDetailed(lineRows).forEach((sys) => {
      // sys.rowMin/rowMax can be fractional (they're means of collapsed
      // thickness-duplicate rows — see lib/systemDetection.js). Row indices
      // must be whole numbers here: they're multiplied into a flat pixel
      // array offset below, and a fractional row silently reads a shifted,
      // wrong set of pixels instead of erroring (confirmed against a real
      // rendered PDF — this cost a correct barline count without it).
      const rowMin = Math.round(sys.rowMin), rowMax = Math.round(sys.rowMax);
      const bandHeight = rowMax - rowMin + 1;
      const columnRunLengths = new Array(aw).fill(0);
      for (let c = 0; c < aw; c++) {
        let best = 0, cur = 0;
        for (let r = rowMin; r <= rowMax; r++) {
          if (isInk(r, c)) { cur++; if (cur > best) best = cur; } else cur = 0;
        }
        columnRunLengths[c] = best;
      }
      systemBands.push({
        center: docTop + (sys.center / ah) * docH,
        rowMin: docTop + (sys.rowMin / ah) * docH,
        rowMax: docTop + (sys.rowMax / ah) * docH,
      });
      measuresPerSystem.push(estimateMeasureCount(columnRunLengths, bandHeight));
    });
  });

  state.autoScroll.systemBands = systemBands;
  state.autoScroll.measuresPerSystem = measuresPerSystem;
  state.autoScroll.analyzed = systemBands.length > 0;

  const warnings = [];
  if (!systemBands.length) {
    warnings.push('No systems were detected — make sure a PDF is loaded and rendered.');
  } else {
    const min = Math.min(...measuresPerSystem), max = Math.max(...measuresPerSystem);
    if (max - min > Math.max(2, min)) {
      warnings.push(`Measure counts vary a lot across systems (${min}-${max}) — check the list below, a barline may have been missed or double-counted somewhere.`);
    }
  }

  return { systemCount: systemBands.length, measuresPerSystem, warnings };
}

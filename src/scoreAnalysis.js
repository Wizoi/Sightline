import { state } from './appState.js';
import { scoreEl } from './ui.js';
import { pageSystemsDetailed } from './lib/systemDetection.js';
import { estimateMeasureCount } from './lib/barlineDetection.js';
import {
  groupIntoRows, collectKnownNames, findSectionTitle, findTempoMarking,
  extractMeasureNumbers, refineMeasureCounts,
} from './lib/scoreText.js';
import { buildSections } from './lib/scoreSections.js';
import { detectTimeSignature } from './timeSigDetection.js';

// Time-signature glyphs are small — at the shared analysis canvas's
// resolution (tuned for staff-line/barline detection, not fine shape
// detail) a single staff is only ~30px tall and individual strokes come
// out just 1-2px wide, far too coarse for reliable digit matching
// (confirmed empirically: match confidence topped out around 0.2-0.3
// against a real score). So time-signature detection re-renders just the
// small candidate region directly from the PDF at much higher resolution,
// rather than reusing that shared canvas — cheap, since the region itself
// is tiny and this only runs once per detected section, not per page.
const TIMESIG_RENDER_SCALE = 10;

async function renderHighResRegion(page, pageWidthPts, pageHeightPts, ah, aw, rowMin, rowMax, colEnd) {
  const pointsPerRow = pageHeightPts / ah, pointsPerCol = pageWidthPts / aw;
  const topPt = rowMin * pointsPerRow, bottomPt = rowMax * pointsPerRow;
  const rightPt = colEnd * pointsPerCol;

  const width = Math.max(1, Math.round(rightPt * TIMESIG_RENDER_SCALE));
  const height = Math.max(1, Math.round((bottomPt - topPt) * TIMESIG_RENDER_SCALE));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const viewport = page.getViewport({ scale: TIMESIG_RENDER_SCALE });
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: [1, 0, 0, 1, 0, -topPt * TIMESIG_RENDER_SCALE],
  }).promise;

  const data = ctx.getImageData(0, 0, width, height).data;
  const isInk = (r, c) => {
    if (r < 0 || r >= height || c < 0 || c >= width) return false;
    const i = (r * width + c) * 4;
    return data[i] + data[i + 1] + data[i + 2] < 570;
  };
  return { isInk, width, height };
}

// Scans the rendered score for systems (the same staff-line detection Snap
// mode uses — src/systemDetection.js) and, for each system, estimates its
// measure count via barline detection. This is the "Analyze score" step for
// auto-scroll: it deliberately duplicates the row-scanning part of
// src/systemDetection.js's detectSystems() rather than sharing it, since
// this is a heavier, explicitly user-triggered one-time pass (also scans
// columns for barlines), not something that should run automatically on
// every resize/zoom the way Snap mode's detection does.
//
// Alongside that pixel scan, this also reads each page's *real* PDF text
// layer (page.getTextContent() — pdfjs already provides this for free) to
// find part/section boundaries, tempo markings, and real printed measure
// numbers — see lib/scoreText.js for why this is possible without OCR for
// PDFs exported from notation software. Known instrument/part names are
// bootstrapped from page 1 alone (a combined score's opening page lists
// every instrument once per system); a PDF that's just individual parts
// with no combined score first won't have that bootstrap signal, so its
// parts won't be auto-split — a real, accepted limitation, not a bug.
export async function analyzeScore() {
  const systemBands = [];
  const measuresPerSystem = [];
  const boundaries = [];
  const measureNumberEntries = [];
  const timeSigByIndex = {}; // global system index -> best-effort {beatsPerMeasure, noteValue, confidence}
  let knownNames = [];

  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });

  const canvases = Array.from(scoreEl.querySelectorAll('canvas'));
  for (let pageIdx = 0; pageIdx < canvases.length; pageIdx++) {
    const cv = canvases[pageIdx];
    const ah = 1200, aw = Math.max(60, Math.round(ah * cv.width / cv.height));
    tmp.width = aw; tmp.height = ah;
    tctx.drawImage(cv, 0, 0, aw, ah);
    let data;
    try { data = tctx.getImageData(0, 0, aw, ah).data; } catch (e) { continue; }

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

    const systemsOnThisPage = []; // {index (global), rowMin, rowMax} in this page's own canvas-pixel space
    let firstSystemPixelInfo = null; // for the high-res time-signature re-render below
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
      const globalIndex = systemBands.length;
      // Stored page-relative (page index + fractions of the page's height),
      // NOT as absolute document pixels: any later reflow (resize, zoom,
      // rotation, sidebar collapse) moves docTop/docH, so baking them in here
      // would go stale silently. systemGeometry.js re-projects these onto the
      // live canvas geometry at scroll/highlight time instead.
      systemBands.push({
        page: pageIdx,
        fracCenter: sys.center / ah,
        fracMin: sys.rowMin / ah,
        fracMax: sys.rowMax / ah,
      });
      measuresPerSystem.push(estimateMeasureCount(columnRunLengths, bandHeight));
      systemsOnThisPage.push({ index: globalIndex, rowMin, rowMax });

      // Stashed for the high-res time-signature re-render below, which only
      // actually runs once we know (further down, once the text layer is
      // read) whether this page's first system is a real section start —
      // no point re-rendering at high res for every page.
      if (systemsOnThisPage.length === 1) {
        const barlineNeed = bandHeight * 0.85;
        let firstBarlineCol = columnRunLengths.findIndex((len) => len >= barlineNeed);
        if (firstBarlineCol === -1) firstBarlineCol = aw;
        firstSystemPixelInfo = { globalIndex, rowMin, rowMax, firstBarlineCol };
      }
    });

    // Real PDF text layer, if any — pixel-based detection above already
    // stands on its own, so a page/PDF without extractable text (a scanned
    // score, say) just skips this part rather than failing anything.
    try {
      const page = await state.pdfDoc.getPage(pageIdx + 1);
      const content = await page.getTextContent();
      const pageViewport1x = page.getViewport({ scale: 1 });
      const pdfHeight = pageViewport1x.height;
      const pageItems = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
      if (!pageItems.length) continue;

      // Convert this page's systems from downsampled-canvas pixel space
      // (row 0 = top, increasing downward) to the text layer's PDF-point
      // space (y = 0 at the bottom, increasing upward) to correlate them.
      const systemsForText = systemsOnThisPage.map((s) => ({
        index: s.index,
        yTop: pdfHeight * (1 - s.rowMin / ah),
        yBottom: pdfHeight * (1 - s.rowMax / ah),
      }));

      const pageRows = groupIntoRows(pageItems);
      let isSectionStart = false;
      if (pageIdx === 0) {
        // Page 1 is always the *source* of known instrument names (a full
        // score lists every instrument once per system), never itself a
        // title-match target -- checking it too would match its own
        // just-collected names and wrongly rename the opening "Score"
        // section after whichever instrument happens to be listed first.
        knownNames = collectKnownNames(pageRows, systemsForText[0] ? systemsForText[0].yTop : null);
        isSectionStart = true; // page 1 is always the first section's start
      } else {
        const title = findSectionTitle(pageItems, pageRows, knownNames);
        if (title && systemsOnThisPage.length) {
          const tempo = findTempoMarking(pageItems);
          boundaries.push({
            systemIndex: systemsOnThisPage[0].index,
            name: title,
            tempoMarking: tempo ? tempo.word : null,
          });
          isSectionStart = true;
        }
      }

      // Best-effort time-signature glyph detection (see timeSigDetection.js)
      // — only worth the (small, but non-zero) cost of a dedicated high-res
      // re-render on a page that's actually a section's start, since that's
      // the only place a "detected — use this?" suggestion attaches.
      if (isSectionStart && firstSystemPixelInfo) {
        const { globalIndex, rowMin, rowMax, firstBarlineCol } = firstSystemPixelInfo;
        const { isInk: hiResIsInk, width, height } = await renderHighResRegion(
          page, pageViewport1x.width, pdfHeight, ah, aw, rowMin, rowMax, firstBarlineCol,
        );
        const detected = detectTimeSignature(hiResIsInk, 0, height - 1, 0, width);
        if (detected) timeSigByIndex[globalIndex] = detected;
      }

      measureNumberEntries.push(...extractMeasureNumbers(pageItems, systemsForText));
    } catch (e) { /* no text layer on this page — pixel detection above is unaffected */ }
  }

  const refinedMeasures = refineMeasureCounts(measuresPerSystem, measureNumberEntries);

  state.autoScroll.systemBands = systemBands;
  state.autoScroll.measuresPerSystem = refinedMeasures;
  state.autoScroll.analyzed = systemBands.length > 0;
  state.autoScroll.sections = buildSections({
    boundaries,
    systemBands,
    measuresPerSystem: refinedMeasures,
    defaultBeatsPerMeasure: state.autoScroll.beatsPerMeasure,
    defaultBpm: state.autoScroll.bpm,
  });
  // Attach each section's best-effort detected time signature, if any --
  // never applied automatically (see timeSigDetection.js); the Sections
  // list UI offers it as a suggestion the user can accept or ignore.
  state.autoScroll.sections.forEach((sec) => {
    const detected = timeSigByIndex[sec.startSystemIndex];
    if (detected) sec.detectedTimeSig = detected;
  });

  const warnings = [];
  if (!systemBands.length) {
    warnings.push('No systems were detected — make sure a PDF is loaded and rendered.');
  } else {
    const min = Math.min(...refinedMeasures), max = Math.max(...refinedMeasures);
    if (max - min > Math.max(2, min)) {
      warnings.push(`Measure counts vary a lot across systems (${min}-${max}) — check the list below, a barline may have been missed or double-counted somewhere.`);
    }
  }

  return { systemCount: systemBands.length, measuresPerSystem: refinedMeasures, warnings, sections: state.autoScroll.sections };
}

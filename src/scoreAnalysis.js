import { state } from './appState.js';
import { setStatus } from './ui.js';
import { pageSystemsDetailed } from './lib/systemDetection.js';
import { estimateMeasureCount } from './lib/barlineDetection.js';
import {
  groupIntoRows, collectKnownNames, findSectionTitle, findTempoMarking,
  extractMeasureNumbers, refineMeasureCounts, extractTempoMarks, filterMeasureNumberOutliers,
} from './lib/scoreText.js';
import { buildSections } from './lib/scoreSections.js';
import { resolveBpmPerSystem } from './lib/tempoSchedule.js';
import { detectTimeSignature } from './timeSigDetection.js';
import { locateMeasureNumber } from './lib/measureNumberLocate.js';
import { ocrNumbersByBox, ocrNumbersByStrip, terminateOcr } from './ocr.js';

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

// Reads the printed measure numbers off an image-only page (no text layer) with
// BOTH methods, so the caller can compare them (see ocr.js's header). Renders
// the page crisp once, then:
//   • BOX   — for each system, LOCATE its number's tight box from ink structure
//             (lib/measureNumberLocate.js) and OCR just that box.
//   • STRIP — OCR the whole left margin (sparse mode) and correlate the numbers
//             to systems by position (extractMeasureNumbers), same as the text
//             layer.
// systemsOnPage rows are in the ah-tall analysis space, so they're scaled to
// this render's height. Returns { boxEntries, stripEntries }, each
// [{ systemIndex, measureNumber }].
const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Render a page to an offscreen white-backed canvas ~targetW px wide.
async function renderPageCanvas(page, viewport1x, targetW) {
  const vp = page.getViewport({ scale: targetW / viewport1x.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// The two methods have opposite resolution sweet-spots: the per-number BOX
// method needs a crisp high-res render so a tiny number box has enough pixels,
// while the STRIP scan reads the whole left margin better at a lower resolution
// (higher res just feeds its layout analysis more music to misread). So each
// gets its own render.
const OCR_BOX_WIDTH = 2600;
const OCR_STRIP_WIDTH = 1500;
async function ocrPageNumbers(page, viewport1x, systemsOnPage, systemsForText, ah) {
  // BOX method: locate a tight box per system on the high-res render, OCR each.
  const boxCanvas = await renderPageCanvas(page, viewport1x, OCR_BOX_WIDTH);
  const data = boxCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, boxCanvas.width, boxCanvas.height).data;
  const isInk = (r, c) => {
    if (r < 0 || r >= boxCanvas.height || c < 0 || c >= boxCanvas.width) return false;
    const i = (r * boxCanvas.width + c) * 4;
    return data[i] + data[i + 1] + data[i + 2] < 570;
  };
  const rowScale = boxCanvas.height / ah;
  const boxes = [];
  for (const s of systemsOnPage) {
    const box = locateMeasureNumber(isInk, {
      systemTop: s.rowMin * rowScale,
      staffHeight: (s.rowMax - s.rowMin) * rowScale,
      width: boxCanvas.width,
    });
    if (box) boxes.push({ systemIndex: s.index, box });
  }
  const boxEntries = await ocrNumbersByBox(boxCanvas, boxes);

  // STRIP method: OCR the whole left margin on the lower-res render, correlate.
  const stripCanvas = await renderPageCanvas(page, viewport1x, OCR_STRIP_WIDTH);
  const stripItems = await ocrNumbersByStrip(stripCanvas, viewport1x.width, viewport1x.height);
  const stripEntries = extractMeasureNumbers(stripItems, systemsForText);

  return { boxEntries, stripEntries };
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
  const measureNumberEntries = [];       // from the PDF text layer
  const ocrEntriesBox = [];              // OCR method BOX (per-number), image-only PDFs
  const ocrEntriesStrip = [];            // OCR method STRIP (left-margin scan), image-only PDFs
  const tempoMarkEntries = []; // { systemIndex (global), bpm } from printed ♩=N marks
  const timeSigByIndex = {}; // global system index -> best-effort {beatsPerMeasure, noteValue, confidence}
  let knownNames = [];
  let usedOcrAnywhere = false; // any page fell back to OCR -> terminate the worker + note it in the summary

  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });

  const numPages = state.pdfDoc.numPages;
  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await state.pdfDoc.getPage(pageIdx + 1);

    // Render this page to a FIXED-resolution offscreen canvas for detection,
    // rather than reusing the on-screen display canvas. The display canvas's
    // pixel resolution varies with window size, zoom and devicePixelRatio, and
    // that variance made staff-line detection non-deterministic: at higher
    // resolutions a real 5-line staff could split into 2-3-line fragments
    // (inflating the system count) and a staff's top line could go undetected
    // (shifting a measure number just outside its correlation window, dropping
    // it). Both silently corrupted measure counts on some machines but not
    // others -- confirmed on a real lead sheet ("Departure!") that analyzed as
    // 21 systems at some window sizes and 23-24 at others. Rendering every page
    // at the same ah=1200-row scale makes analysis produce identical systems
    // and counts everywhere. systemBands are stored page-relative (fractions of
    // ah), so on-screen scroll/highlight still map correctly at any resolution.
    const ah = 1200;
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: ah / base.height });
    const aw = Math.max(60, Math.round(vp.width));
    tmp.width = aw; tmp.height = ah;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, aw, ah);      // ink test assumes a white ground; PDF pages may render transparent
    try { await page.render({ canvasContext: tctx, viewport: vp }).promise; } catch (e) { continue; }
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
      const content = await page.getTextContent();
      const pageViewport1x = page.getViewport({ scale: 1 });
      const pdfHeight = pageViewport1x.height;
      const pageItems = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

      // Image-only PDFs (flattened/scanned exports) carry no text layer, so the
      // reliable printed-number path finds nothing and every system would fall
      // all the way back to the over-counting barline estimate. When a page has
      // detected systems but no numeric text item, read the printed measure
      // numbers off the rendered image instead (targeted OCR below) — only on
      // such pages, so normal notation-software PDFs pay nothing.
      const usedOcr = !pageItems.some((it) => /^\d+$/.test(it.str.trim())) && systemsOnThisPage.length > 0;
      if (!pageItems.length && !usedOcr) continue;

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

      if (usedOcr) {
        // Image page: read the printed measure numbers off the render with BOTH
        // methods (per-number box + left-margin scan), kept separate so the two
        // can be compared after the loop. Each is filtered per page to the
        // coherent, strictly-increasing set, so an OCR misread can't corrupt a
        // count worse than the barline fallback (and a multi-part score's
        // per-part number reset isn't mistaken for a break). Section titles /
        // tempo words / time-sig digits aren't text here, so nothing else to read.
        usedOcrAnywhere = true;
        setStatus('', `Reading printed measure numbers (page ${pageIdx + 1}/${numPages})…`);
        const { boxEntries, stripEntries } = await ocrPageNumbers(page, pageViewport1x, systemsOnThisPage, systemsForText, ah);
        ocrEntriesBox.push(...filterMeasureNumberOutliers(boxEntries));
        ocrEntriesStrip.push(...filterMeasureNumberOutliers(stripEntries));
      } else {
        // Text-layer page: read the real printed numbers + tempo marks directly.
        measureNumberEntries.push(...extractMeasureNumbers(pageItems, systemsForText));
        tempoMarkEntries.push(...extractTempoMarks(pageItems, systemsForText));
      }
    } catch (e) { /* no text layer + OCR unavailable/failed — pixel detection above is unaffected */ }
  }

  if (usedOcrAnywhere) await terminateOcr(); // free the OCR worker thread + model

  // Measure counts. For text-layer PDFs there's one reading. For image PDFs the
  // two OCR methods each yield one; default to whichever read more systems, and
  // when they disagree keep the other as a switchable alternative (some
  // engravings suit one method, some the other — the user decides).
  let refinedMeasures;
  let readings = null;
  if (usedOcrAnywhere) {
    const box = { label: 'Per-number', measures: refineMeasureCounts(measuresPerSystem, ocrEntriesBox), coverage: ocrEntriesBox.length };
    const strip = { label: 'Margin scan', measures: refineMeasureCounts(measuresPerSystem, ocrEntriesStrip), coverage: ocrEntriesStrip.length };
    const ordered = strip.coverage > box.coverage ? [strip, box] : [box, strip];
    refinedMeasures = ordered[0].measures;
    if (!arraysEqual(ordered[0].measures, ordered[1].measures)) {
      readings = { options: ordered.map((o) => ({ label: o.label, measures: o.measures })), active: 0 };
    }
  } else {
    refinedMeasures = refineMeasureCounts(measuresPerSystem, measureNumberEntries);
  }
  state.autoScroll.measureReadings = readings;

  // Collapse the printed ♩=N marks into one tempo per system (first mark on a
  // system wins; carried forward from there). Only build a bpmPerSystem when
  // marks were actually found — otherwise leave it null so playback stays flat
  // on the manual Tempo slider exactly as before.
  const tempoByIndex = {};
  for (const e of tempoMarkEntries) if (tempoByIndex[e.systemIndex] == null) tempoByIndex[e.systemIndex] = e.bpm;
  const hasTempoMarks = Object.keys(tempoByIndex).length > 0;
  const bpmPerSystem = hasTempoMarks
    ? resolveBpmPerSystem(systemBands.length, tempoByIndex, state.autoScroll.bpm)
    : null;

  // When the score prints its own tempo, adopt the opening tempo as the base
  // the manual slider starts from (so the slider reads the real tempo and
  // scales the whole piece proportionally from there). With no marks, keep the
  // user's current slider value as the flat tempo, exactly as before.
  if (hasTempoMarks) state.autoScroll.bpm = bpmPerSystem[0];
  state.autoScroll.bpmBase = state.autoScroll.bpm;

  state.autoScroll.systemBands = systemBands;
  state.autoScroll.measuresPerSystem = refinedMeasures;
  state.autoScroll.bpmPerSystem = bpmPerSystem;
  state.autoScroll.analyzed = systemBands.length > 0;
  state.autoScroll.sections = buildSections({
    boundaries,
    systemBands,
    measuresPerSystem: refinedMeasures,
    bpmPerSystem,
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

  // Distinct tempos in document order (e.g. [86, 128]) for the UI's
  // "tempo changes detected" note — only meaningful when there's more than one.
  const tempoSequence = [];
  if (bpmPerSystem) for (const b of bpmPerSystem) if (b !== tempoSequence[tempoSequence.length - 1]) tempoSequence.push(b);

  return {
    systemCount: systemBands.length, measuresPerSystem: refinedMeasures, warnings,
    sections: state.autoScroll.sections, tempoSequence, usedOcr: usedOcrAnywhere,
    measureReadings: readings,
  };
}

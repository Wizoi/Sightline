import { state } from './appState.js';
import { setStatus } from './ui.js';
import { pageSystemsDetailed } from './lib/systemDetection.js';
import { estimateMeasureCount } from './lib/barlineDetection.js';
import {
  groupIntoRows, collectKnownNames, findSectionTitle, findTempoMarking,
  extractMeasureNumbers, extractTempoMarks, filterMeasureNumberOutliers,
} from './lib/scoreText.js';
import { buildSections } from './lib/scoreSections.js';
import {
  pickPrimaryEntries, addMeasureNumberResetBoundaries, resolveTempoSchedule,
  chooseMeasureReadings, computeWarnings,
} from './lib/scoreAssembly.js';
import { detectTimeSignature } from './timeSigDetection.js';
import { locateMeasureNumber, locateMeasureNumberBelow } from './lib/measureNumberLocate.js';
import { ocrNumbersByBox, ocrNumbersByStrip, terminateOcr } from './ocr.js';
import { scoreOrientation, chooseRotation } from './lib/pageRotation.js';

// Some source PDFs carry a wrong /Rotate flag on individual pages — a real
// scanning/assembly artifact (confirmed on two real combined-score PDFs: a
// portrait page declares /Rotate 270 when 0 is actually correct, feeding
// vertical-staff pixels into the horizontal staff-line scanner below and
// producing nonsense measure counts on just that page). probePageRotation()
// renders each page at all 4 absolute rotations at this small fixed
// resolution — cheap (this budget keeps the longer rendered edge to ~220px,
// vs. the detailed pass's ah=1200 below — on the order of 30x fewer pixels),
// so every page gets probed unconditionally rather than only ones whose
// declared rotation "looks suspicious": the failure mode doesn't fail
// cleanly (a page like this still detects a FEW garbage systems, not zero),
// so there's no reliable trigger to gate a conditional retry on.
const ROTATION_PROBE_LONG_EDGE = 220;

// Calibrated against real scores dumped from 3 real files (see docs/
// PERSONAS.md section 3 for the full writeup) at this exact probe
// resolution, not guessed:
//   - MUST override: Teutonia.pdf p.3/22 (declares /Rotate 270, scores 89 at
//     rotation 0 vs 0 at 270) and MonogramMarch.pdf p.4/28 (score 57 at 0)
//     and p.5/28 (score 29 at 0 -- the tightest real margin found, since
//     it's a sparser continuation page with fewer systems than p.4).
//   - MUST NOT override (floor guard): blank/cover/text-only pages score at
//     most 6 (Teutonia p.1, a text-only cover with no music in any
//     rotation) across every candidate rotation.
//   - MUST NOT override (regression guard): every one of "Fat Burger parts
//     with drums (1).pdf"'s 41 pages declares /Rotate 270 and IS genuinely
//     correct there, but scores surprisingly low even in its own correct
//     orientation (at most 8) -- this file's individual-part pages are
//     sparser than the two combined scores above, and 90 vs 270 (both
//     valid "portrait" candidates for a landscape-stored page) often score
//     within 1-2 of each other, a real instance of the same 0-vs-180
//     ambiguity noted on chooseRotation() -- but never enough to threaten
//     the floor.
// floor=15 sits with real margin above the highest observed noise (8) and
// real margin below the tightest genuine signal (29). ratio=3 is a general
// safety net for a future file where a wrong declared rotation's own score
// isn't 0 (every real override case found had a 0 declared-rotation score,
// so ratio wasn't actually exercised by this calibration -- floor did all
// the real work here).
const ROTATION_DECISION = { floor: 15, ratio: 3 };

async function probePageRotation(page) {
  const scores = {};
  for (const rotation of [0, 90, 180, 270]) {
    const rotVp1 = page.getViewport({ scale: 1, rotation });
    const longEdge = Math.max(rotVp1.width, rotVp1.height);
    const scale = ROTATION_PROBE_LONG_EDGE / longEdge;
    const vp = page.getViewport({ scale, rotation });
    const w = Math.max(20, Math.round(vp.width));
    const h = Math.max(20, Math.round(vp.height));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h); // ink test assumes a white ground; PDF pages may render transparent
    try {
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const data = ctx.getImageData(0, 0, w, h).data;
      const isInk = (r, c) => {
        const i = (r * w + c) * 4;
        return data[i] + data[i + 1] + data[i + 2] < 570;
      };
      scores[rotation] = scoreOrientation(isInk, w, h);
    } catch (e) {
      scores[rotation] = 0; // failed render for this candidate -- treat as no signal, never as a reason to override
    }
  }
  return chooseRotation(scores, page.rotate, ROTATION_DECISION);
}

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

async function renderHighResRegion(page, pageWidthPts, pageHeightPts, ah, aw, rowMin, rowMax, colEnd, rotation) {
  const pointsPerRow = pageHeightPts / ah, pointsPerCol = pageWidthPts / aw;
  const topPt = rowMin * pointsPerRow, bottomPt = rowMax * pointsPerRow;
  const rightPt = colEnd * pointsPerCol;

  const width = Math.max(1, Math.round(rightPt * TIMESIG_RENDER_SCALE));
  const height = Math.max(1, Math.round((bottomPt - topPt) * TIMESIG_RENDER_SCALE));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Must match the rotation used everywhere else for this page (see
  // probePageRotation) -- pageWidthPts/pageHeightPts and the row/col math
  // above are already expressed in that resolved rotation's space, so the
  // render itself needs the same rotation or the region would be cropped
  // from the wrong part of a differently-oriented page.
  const viewport = page.getViewport({ scale: TIMESIG_RENDER_SCALE, rotation });
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
  // `canvas` itself is returned (not just the derived isInk/pixel data) so
  // the caller can also feed this exact same crop to the OCR-based
  // time-signature reading (timeSigDetection.js's detectTimeSignature) --
  // both methods read the SAME rendered region, just via different means.
  return { isInk, width, height, canvas };
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

// Shallow key/value equality for the {pageIndex: rotation} override map.
const overridesEqual = (a, b) => {
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
};

// Render a page to an offscreen white-backed canvas ~targetW px wide.
async function renderPageCanvas(page, viewport1x, targetW, rotation) {
  const vp = page.getViewport({ scale: targetW / viewport1x.width, rotation });
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
async function ocrPageNumbers(page, viewport1x, systemsOnPage, systemsForText, ah, rotation) {
  // BOX method: locate a tight box per system on the high-res render, OCR each.
  const boxCanvas = await renderPageCanvas(page, viewport1x, OCR_BOX_WIDTH, rotation);
  const data = boxCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, boxCanvas.width, boxCanvas.height).data;
  const isInk = (r, c) => {
    if (r < 0 || r >= boxCanvas.height || c < 0 || c >= boxCanvas.width) return false;
    const i = (r * boxCanvas.width + c) * 4;
    return data[i] + data[i + 1] + data[i + 2] < 570;
  };
  const rowScale = boxCanvas.height / ah;
  const boxes = [];
  for (const s of systemsOnPage) {
    const staffHeight = (s.rowMax - s.rowMin) * rowScale;
    const box = locateMeasureNumber(isInk, {
      systemTop: s.rowMin * rowScale,
      staffHeight,
      width: boxCanvas.width,
    });
    // boxBelow: a fallback candidate for engravings that print the number
    // BELOW the staff instead (a real scanned combo/jazz chart -- see
    // docs/PERSONAS.md persona 3). Always located (cheap, pure ink-geometry,
    // no OCR yet); ocrNumbersByBox only actually OCRs it when `box` itself
    // fails the confidence gate, so a file where `box` already works is
    // unaffected by this being present.
    const boxBelow = locateMeasureNumberBelow(isInk, {
      systemBottom: s.rowMax * rowScale,
      staffHeight,
      width: boxCanvas.width,
    });
    if (box || boxBelow) boxes.push({ systemIndex: s.index, box, boxBelow });
  }
  const boxEntries = await ocrNumbersByBox(boxCanvas, boxes);

  // STRIP method: OCR the whole left margin on the lower-res render, correlate.
  const stripCanvas = await renderPageCanvas(page, viewport1x, OCR_STRIP_WIDTH, rotation);
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
// every instrument once per system); a PDF that's just individual scanned
// parts with no combined score first won't have that bootstrap signal, so
// title-matching alone can't split it into named sections. It still gets
// split into sections, though, via the other, title-independent boundary
// signal: a printed measure number resetting (see detectMeasureNumberResets
// in lib/scoreText.js) — this was found to matter for more than naming:
// without it, a later part's own correctly-read measure numbers looked like
// "outliers" relative to an earlier part's bigger numbers in one whole-
// document refinement pass, corrupting that part's measure counts back to
// the raw (often wildly wrong) barline estimate. See lib/scoreAssembly.js's
// refineMeasuresPerSection. Such a reset-only boundary starts out nameless
// (buildSections() would fall back to generic "Section N"); fillMissingSectionNames()
// below gives it a real name where possible by treating THAT boundary's own
// first page as a one-off mini-bootstrap page (the same collectKnownNames
// left-margin/letter-run logic as the page-1 bootstrap, just scoped to a
// single page instead of relying on "a combined score lists everyone").
//
// Cheap by design: re-fetches page.getTextContent() (no pixel rendering, no
// canvas) for only the handful of pages that actually have a nameless
// boundary landing on them -- typically a small number of pages even on a
// many-part booklet. `rotationOverrides` is the same map probePageRotation()
// built during the main pass, so a page whose declared /Rotate was wrong
// still gets its text read in the correctly-resolved orientation. Quietly
// does nothing when that page has no extractable text at all (a scanned/
// image-only part, same as why the page-1 bootstrap only works on pages
// with a real text layer) -- the boundary just keeps its generic name,
// exactly as before this function existed.
async function fillMissingSectionNames(boundaries, systemBands, rotationOverrides) {
  for (const b of boundaries) {
    if (b.name) continue; // already named via title-match
    const sys = systemBands[b.systemIndex];
    if (!sys) continue;
    const pageIdx = sys.page;

    // Use the BOUNDARY's own system as the reference band, NOT necessarily
    // "this page's topmost system" -- found to matter on a real scanned
    // booklet ("Teutonia.pdf"): a short part can end and the next part begin
    // partway down the SAME physical page, so the new part's own label sits
    // beside ITS system, not the page's first one. collectKnownNames's
    // isFull logic (label at/up-to-pad-above the referenced band = a real
    // full name; further above = title-block text) works exactly the same
    // either way, so using the boundary's own system is both simpler and
    // correct for the (more common) case where it IS also the page's first.

    let page, content;
    try {
      page = await state.pdfDoc.getPage(pageIdx + 1);
      content = await page.getTextContent();
    } catch (e) { continue; }
    const pageItems = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
    if (!pageItems.length) continue; // image-only page -- nothing to read here

    const declaredRotation = ((page.rotate % 360) + 360) % 360;
    const rotation = rotationOverrides[pageIdx] ?? declaredRotation;
    const pdfHeight = page.getViewport({ scale: 1, rotation }).height;
    const firstSystemForText = {
      yTop: pdfHeight * (1 - sys.fracMin),
      yBottom: pdfHeight * (1 - sys.fracMax),
    };
    const pageRows = groupIntoRows(pageItems);
    const names = collectKnownNames(pageRows, firstSystemForText);
    const full = names.find((n) => n.isFull);
    if (full) b.name = full.text;
  }
}

// Dev/benchmark-only override: forces every page's measure-number reading
// down the OCR path (ocrPageNumbers()) even when a real PDF text layer is
// present, so OCR's measure-reading accuracy can be measured against the
// same trusted ground truth normally only available for scanned files (which
// have no equally-precise ground truth of their own -- see
// scripts/benchmark/run-ocr-validation.mjs). Read fresh from the page's own
// URL every call, not cached at module load, since the benchmark navigates a
// fresh page per file. This is NOT a real user-facing feature: nothing in
// the UI reads or sets this, there's no toggle, and no ordinary user would
// ever add ?forceOcr=1 to the app's URL by hand -- it only exists to be
// driven by scripts/benchmark/run-ocr-validation.mjs.
//
// Scoped narrowly to the measure-number-reading decision only (see the
// `usedOcr` line below) -- it does NOT touch section-title matching
// (findSectionTitle/collectKnownNames), which reads `pageItems` directly and
// unconditionally regardless of usedOcr. It DOES, as a side effect of the
// existing branch structure, also suppress `extractTempoMarks()` for any
// page it forces onto the OCR path -- that call lives in the same `else`
// (non-OCR) branch as `extractMeasureNumbers()`, not a separate unconditional
// call, so a forced-OCR page loses its printed tempo marks too even though
// there's no OCR-based tempo reading to replace them with. Harmless for a
// REAL usedOcr=true page (image-only, so there was never any tempo text to
// extract anyway) but real for a forced page that does have one -- this is
// exactly why the OCR validation script scores measures-per-system/system
// count only, never BPM (or section names, unaffected either way but still
// not a full 4-dimension comparison).
function isForceOcrRequested() {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('forceOcr') === '1';
}

export async function analyzeScore() {
  const forceOcr = isForceOcrRequested();
  const systemBands = [];
  const measuresPerSystem = [];
  let boundaries = [];
  const measureNumberEntries = [];       // from the PDF text layer
  const ocrEntriesBox = [];              // OCR method BOX (per-number), image-only PDFs
  const ocrEntriesStrip = [];            // OCR method STRIP (left-margin scan), image-only PDFs
  const tempoMarkEntries = []; // { systemIndex (global), bpm } from printed ♩=N marks
  const timeSigByIndex = {}; // global system index -> best-effort {beatsPerMeasure, noteValue, confidence}
  let knownNames = [];
  let usedOcrAnywhere = false; // any page fell back to MEASURE-NUMBER OCR -> note it in the "No embedded text" summary
  let ocrWorkerTouched = false; // usedOcrAnywhere OR time-sig OCR ran -> terminate the worker either way (see below)
  const rotationOverrides = {}; // rebuilt fresh each run, same as systemBands/measuresPerSystem below

  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d', { willReadFrequently: true });

  const numPages = state.pdfDoc.numPages;
  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await state.pdfDoc.getPage(pageIdx + 1);

    // Resolve this page's ACTUAL orientation before anything else touches it
    // -- every subsequent render/measurement for this page (the detailed
    // pass just below, the text-layer viewport, the OCR renders, the
    // time-sig high-res re-render) uses this resolved rotation instead of
    // implicitly trusting page.rotate. See probePageRotation() above for why
    // this runs unconditionally rather than only on pages that "look wrong".
    const rotation = await probePageRotation(page);
    const declaredRotation = ((page.rotate % 360) + 360) % 360;
    if (rotation !== declaredRotation) rotationOverrides[pageIdx] = rotation;

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
    const base = page.getViewport({ scale: 1, rotation });
    const vp = page.getViewport({ scale: ah / base.height, rotation });
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
      const pageViewport1x = page.getViewport({ scale: 1, rotation });
      const pdfHeight = pageViewport1x.height;
      const pageItems = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));

      // Image-only PDFs (flattened/scanned exports) carry no text layer, so the
      // reliable printed-number path finds nothing and every system would fall
      // all the way back to the over-counting barline estimate. When a page has
      // detected systems but no numeric text item, read the printed measure
      // numbers off the rendered image instead (targeted OCR below) — only on
      // such pages, so normal notation-software PDFs pay nothing.
      const usedOcr = (forceOcr || !pageItems.some((it) => /^\d+$/.test(it.str.trim()))) && systemsOnThisPage.length > 0;
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
        knownNames = collectKnownNames(pageRows, systemsForText[0] || null);
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
        const { isInk: hiResIsInk, width, height, canvas: hiResCanvas } = await renderHighResRegion(
          page, pageViewport1x.width, pdfHeight, ah, aw, rowMin, rowMax, firstBarlineCol, rotation,
        );
        // This also triggers the same lazy tesseract worker load as the
        // image-only-PDF measure-number OCR path below (detectTimeSignature
        // tries both the grid matcher and an OCR read of the same crop) --
        // tracked separately from usedOcrAnywhere (which drives the "No
        // embedded text" summary message: a normal text-layer PDF's measure
        // numbers were NOT read via OCR just because time-sig detection also
        // used the worker) but still needs the worker freed at the end.
        ocrWorkerTouched = true;
        const detected = await detectTimeSignature(hiResCanvas, hiResIsInk, 0, height - 1, 0, width);
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
        ocrWorkerTouched = true;
        setStatus('', `Reading printed measure numbers (page ${pageIdx + 1}/${numPages})…`);
        const { boxEntries, stripEntries } = await ocrPageNumbers(page, pageViewport1x, systemsOnThisPage, systemsForText, ah, rotation);
        ocrEntriesBox.push(...filterMeasureNumberOutliers(boxEntries));
        ocrEntriesStrip.push(...filterMeasureNumberOutliers(stripEntries));
      } else {
        // Text-layer page: read the real printed numbers + tempo marks directly.
        measureNumberEntries.push(...extractMeasureNumbers(pageItems, systemsForText));
        tempoMarkEntries.push(...extractTempoMarks(pageItems, systemsForText));
      }
    } catch (e) { /* no text layer + OCR unavailable/failed — pixel detection above is unaffected */ }
  }

  if (ocrWorkerTouched) await terminateOcr(); // free the OCR worker thread + model

  // Whether any page's resolved rotation differs from its declared one --
  // the caller (autoScrollUI.js) uses this to trigger one renderAll() pass
  // so the visible canvases match what was just analyzed (system-band
  // highlighting is computed against the RESOLVED geometry, so a still-
  // sideways displayed page would otherwise disagree with it).
  const rotationOverridesChanged = !overridesEqual(state.autoScroll.pageRotationOverrides, rotationOverrides);
  state.autoScroll.pageRotationOverrides = rotationOverrides;

  // Section boundaries: a matched instrument-name title page (above) PLUS a
  // printed measure number resetting (e.g. back to 1) -- the latter needs no
  // instrument-name bootstrap at all, so it's what still splits a booklet of
  // individual scanned parts with no combined-score first page for
  // collectKnownNames to draw names from (a real, previously-undetectable
  // case -- see detectMeasureNumberResets in lib/scoreText.js). See
  // lib/scoreAssembly.js's own doc comments for why the primary-entries pick
  // is independent of the measure-COUNT refinement's own source choice below.
  const primaryEntries = pickPrimaryEntries([measureNumberEntries, ocrEntriesBox, ocrEntriesStrip]);
  boundaries = addMeasureNumberResetBoundaries(boundaries, primaryEntries, systemBands.length);

  // A nameless (reset-only) boundary still has no instrument name at this
  // point -- try to find one on THAT boundary's own first page (see
  // fillMissingSectionNames()'s own doc comment above analyzeScore()).
  await fillMissingSectionNames(boundaries, systemBands, rotationOverrides);

  // Collapse the printed ♩=N marks into one tempo per system, carried
  // forward from each mark until the next one overrides it -- null when no
  // marks were found at all, so playback stays flat on the manual Tempo
  // slider exactly as before (lib/scoreAssembly.js's resolveTempoSchedule).
  const { bpmPerSystem, opening: openingBpm } = resolveTempoSchedule(tempoMarkEntries, systemBands.length, state.autoScroll.bpm);

  // When the score prints its own tempo, adopt the opening tempo as the base
  // the manual slider starts from (so the slider reads the real tempo and
  // scales the whole piece proportionally from there). With no marks, keep the
  // user's current slider value as the flat tempo, exactly as before.
  if (openingBpm != null) state.autoScroll.bpm = openingBpm;
  state.autoScroll.bpmBase = state.autoScroll.bpm;

  // Build sections from the RAW (unrefined) per-system estimate -- measure-
  // number refinement happens PER SECTION next (chooseMeasureReadings below),
  // so a part's own printed numbers never bleed into a neighboring part's
  // systems. Everything else about a section (name, tempoMarking,
  // systemBands slice, bpm) is unaffected by which measure-count reading
  // eventually wins, so this only needs computing once.
  const rawSections = buildSections({
    boundaries,
    systemBands,
    measuresPerSystem,
    bpmPerSystem,
    defaultBeatsPerMeasure: state.autoScroll.beatsPerMeasure,
    defaultBpm: state.autoScroll.bpm,
  });

  // Measure counts. For text-layer PDFs there's one reading. For image PDFs the
  // two OCR methods each yield one; default to whichever read more systems, and
  // when they disagree keep the other as a switchable alternative (some
  // engravings suit one method, some the other — the user decides).
  // measureNumberEntries (the real PDF text layer) is merged into BOTH OCR
  // candidates rather than being an either/or choice gated on
  // usedOcrAnywhere — see lib/scoreAssembly.js's chooseMeasureReadings for
  // the real "mixed document" bug this fixes.
  const { refinedMeasures, readings } = chooseMeasureReadings({
    usedOcrAnywhere, measureNumberEntries, ocrEntriesBox, ocrEntriesStrip, measuresPerSystem, rawSections,
  });
  state.autoScroll.measureReadings = readings;

  state.autoScroll.systemBands = systemBands;
  state.autoScroll.measuresPerSystem = refinedMeasures;
  state.autoScroll.bpmPerSystem = bpmPerSystem;
  state.autoScroll.analyzed = systemBands.length > 0;
  // Re-slice the already-built sections against the FINAL (per-section-
  // refined) measures rather than rebuilding from scratch -- boundaries,
  // bpm, tempoMarking and name are all unaffected by which measure-count
  // reading won.
  state.autoScroll.sections = rawSections.map((sec) => ({
    ...sec,
    measuresPerSystem: refinedMeasures.slice(sec.startSystemIndex, sec.endSystemIndex + 1),
  }));
  // Attach each section's best-effort detected time signature, if any --
  // never applied automatically (see timeSigDetection.js); the Sections
  // list UI offers it as a suggestion the user can accept or ignore.
  state.autoScroll.sections.forEach((sec) => {
    const detected = timeSigByIndex[sec.startSystemIndex];
    if (detected) sec.detectedTimeSig = detected;
  });

  const warnings = computeWarnings(systemBands.length, refinedMeasures);

  // The "tempo changes detected" banner is computed PER SECTION, from each
  // section's own bpmPerSystem slice (autoScrollUI.js, via
  // lib/tempoSchedule.js's tempoSequence()) — not from a whole-document
  // sequence here, so a multi-part document whose parts each reprint the
  // same tempo structure doesn't look like it oscillates once per part (see
  // Finding 4 / tempoSchedule.js's tempoSequence() doc comment).
  return {
    systemCount: systemBands.length, measuresPerSystem: refinedMeasures, warnings,
    sections: state.autoScroll.sections, usedOcr: usedOcrAnywhere,
    measureReadings: readings, rotationOverridesChanged,
  };
}

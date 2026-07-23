// Pure, DOM/canvas-free composition helpers extracted from
// src/scoreAnalysis.js's analyzeScore() — the post-page-loop assembly steps
// that turn per-page raw detections (systems, measure-number entries, tempo
// marks, OCR readings) into the final sections/measure-counts/warnings the
// UI renders. Split out specifically because this "glue" layer is where
// real composition bugs have slipped through before (a buildSections()
// name-fallback bug, a bootstrap-page self-match bug — see docs/
// PERSONAS.md persona 3) despite every individual helper it calls
// (refineMeasureCounts, filterMeasureNumberOutliers, detectMeasureNumberResets,
// resolveBpmPerSystem) already having its own tests. None of these functions
// touch pdf.js, canvas, or DOM — analyzeScore() itself still owns the
// per-page rendering/detection loop that genuinely needs a real PDF.js Page
// object, which is why that part isn't extracted here (see docs/
// PERSONAS.md persona 3's Phase 1b write-up for why: no `canvas` npm
// package/jsdom is installed in this project, and this project's QA persona
// treats Playwright as ad hoc, session-only verification, never committed
// test infra -- so anything that NEEDS page.render() stays integration-
// tested by hand against the real corpus, not unit-tested here).

import { detectMeasureNumberResets, filterMeasureNumberOutliers, refineMeasureCounts } from './scoreText.js';
import { resolveBpmPerSystem } from './tempoSchedule.js';

// Of the three raw measure-number-entry sources collected per page (the
// real PDF text layer, and two independent OCR reading methods for
// image-only pages), returns whichever has the most data points — used ONLY
// to decide WHERE a section boundary falls (detectMeasureNumberResets),
// independent of which source later wins the actual measure-COUNT
// refinement. Necessary on a real mixed scanned booklet ("Teutonia.pdf"):
// most pages fall back to OCR, but a handful genuinely have real text, and
// that handful was both richer and where the only clean, confidently-read
// reset showed up — an OCR-only choice would have discarded it entirely.
export function pickPrimaryEntries(sources) {
  return sources.reduce((best, cur) => (cur.length > best.length ? cur : best));
}

// Appends a { systemIndex, name: null, tempoMarking: null } boundary for
// every printed-measure-number reset found in `primaryEntries`, skipping
// system 0 (already the implicit first section) and any system that
// already has a (presumably named, instrument-title-matched) boundary —
// title matches are the stronger signal when both fire on the same system.
// Returns a NEW array rather than mutating `boundaries`, so callers can
// reason about/test it as a pure step.
export function addMeasureNumberResetBoundaries(boundaries, primaryEntries, systemCount) {
  const out = [...boundaries];
  for (const systemIndex of detectMeasureNumberResets(primaryEntries, { systemCount })) {
    if (systemIndex > 0 && systemIndex < systemCount && !out.some((b) => b.systemIndex === systemIndex)) {
      out.push({ systemIndex, name: null, tempoMarking: null });
    }
  }
  return out;
}

// Collapses per-system printed tempo-mark entries [{ systemIndex, bpm }]
// into one BPM per system, carried forward from each mark until the next
// one overrides it (resolveBpmPerSystem). Returns { bpmPerSystem, opening }
// where bpmPerSystem is null (not an array of one flat value) when no marks
// were found at all — the caller's existing convention for "nothing
// detected, playback stays on the manual Tempo slider exactly as before".
// `opening` is bpmPerSystem[0] when marks exist, otherwise null — the value
// analyzeScore() adopts as the new base for the manual Tempo slider.
export function resolveTempoSchedule(tempoMarkEntries, systemCount, currentBpm) {
  const tempoByIndex = {};
  for (const e of tempoMarkEntries) if (tempoByIndex[e.systemIndex] == null) tempoByIndex[e.systemIndex] = e.bpm;
  const hasTempoMarks = Object.keys(tempoByIndex).length > 0;
  if (!hasTempoMarks) return { bpmPerSystem: null, opening: null };
  const bpmPerSystem = resolveBpmPerSystem(systemCount, tempoByIndex, currentBpm);
  return { bpmPerSystem, opening: bpmPerSystem[0] };
}

// Refines one whole-document measuresPerSystem[] array using printed
// measure-number `entries`, running filterMeasureNumberOutliers +
// refineMeasureCounts SEPARATELY within each section's own system range
// (re-based to section-local indices) so a part's own printed numbers never
// bleed into a neighboring part's systems — see docs/PERSONAS.md persona 3
// for the real bug this fixes (a later part's smaller, correctly-read
// numbers looked like "outliers" relative to an earlier part's bigger ones
// when refined in one whole-document pass).
export function refineMeasuresPerSection(measuresPerSystem, rawSections, entries) {
  const flat = [...measuresPerSystem];
  for (const sec of rawSections) {
    const local = entries
      .filter((e) => e.systemIndex >= sec.startSystemIndex && e.systemIndex <= sec.endSystemIndex)
      .map((e) => ({ systemIndex: e.systemIndex - sec.startSystemIndex, measureNumber: e.measureNumber }));
    const cleaned = filterMeasureNumberOutliers(local);
    const rawSlice = measuresPerSystem.slice(sec.startSystemIndex, sec.endSystemIndex + 1);
    const refinedSlice = refineMeasureCounts(rawSlice, cleaned);
    for (let i = 0; i < refinedSlice.length; i++) flat[sec.startSystemIndex + i] = refinedSlice[i];
  }
  return flat;
}

// Shallow array equality -- used below to decide whether the two OCR
// readings actually disagree (only then is a switchable alternative worth
// surfacing to the user).
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Picks the final measuresPerSystem[] the UI displays/edits, and (for
// image-only PDFs where the two OCR methods disagree) a switchable
// `readings` alternative. measureNumberEntries (the real PDF text layer) is
// merged into BOTH OCR candidates rather than being an either/or choice
// gated on usedOcrAnywhere — see docs/PERSONAS.md persona 3, Finding 3: a
// MIXED document (most pages OCR fallback, a few genuinely have real text)
// must not have that handful's exact numbers discarded just because other
// pages needed OCR. The merge is always safe: a given system's page took
// EITHER the OCR path OR the real-text path in the per-page loop, never
// both, so the two entry lists can never both carry an entry for the same
// systemIndex.
export function chooseMeasureReadings({
  usedOcrAnywhere, measureNumberEntries, ocrEntriesBox, ocrEntriesStrip, measuresPerSystem, rawSections,
}) {
  const refine = (entries) => refineMeasuresPerSection(measuresPerSystem, rawSections, entries);
  if (!usedOcrAnywhere) {
    return { refinedMeasures: refine(measureNumberEntries), readings: null };
  }
  const box = { label: 'Per-number', measures: refine([...measureNumberEntries, ...ocrEntriesBox]), coverage: measureNumberEntries.length + ocrEntriesBox.length };
  const strip = { label: 'Margin scan', measures: refine([...measureNumberEntries, ...ocrEntriesStrip]), coverage: measureNumberEntries.length + ocrEntriesStrip.length };
  const ordered = strip.coverage > box.coverage ? [strip, box] : [box, strip];
  const readings = arraysEqual(ordered[0].measures, ordered[1].measures)
    ? null
    : { options: ordered.map((o) => ({ label: o.label, measures: o.measures })), active: 0 };
  return { refinedMeasures: ordered[0].measures, readings };
}

// The "measure counts vary a lot" warning (surfaced so a user can spot-check
// the list below, per this project's general "surface the estimate for
// review" pattern — see docs/PERSONAS.md persona 3) plus the "no systems"
// warning when analysis found nothing at all.
export function computeWarnings(systemCount, refinedMeasures) {
  const warnings = [];
  if (!systemCount) {
    warnings.push('No systems were detected — make sure a PDF is loaded and rendered.');
    return warnings;
  }
  const min = Math.min(...refinedMeasures);
  const max = Math.max(...refinedMeasures);
  if (max - min > Math.max(2, min)) {
    warnings.push(`Measure counts vary a lot across systems (${min}-${max}) — check the list below, a barline may have been missed or double-counted somewhere.`);
  }
  return warnings;
}

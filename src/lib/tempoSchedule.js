// Builds a per-system playback schedule (when each system's turn begins and
// how long it lasts) from a measure-count-per-system estimate, a time
// signature (beats per measure), and a BPM — the data the user reviews and
// confirms before starting auto-scroll (src/scoreAnalysis.js). See
// src/autoScrollController.js for how this schedule drives actual scrolling.

// measuresPerSystem: number[], one entry per system, in document order.
// beatsPerMeasure: number (e.g. 4 for 4/4, 3 for 3/4).
// bpm: beats per minute — the flat fallback used for any system without its
//   own entry in bpmPerSystem (and for the whole piece when bpmPerSystem is
//   absent, i.e. no printed metronome marks were detected).
// bpmPerSystem: optional number[] parallel to measuresPerSystem — each
//   system's own tempo, from printed ♩=N marks carried forward (see
//   resolveBpmPerSystem + scoreAnalysis.js). This is what makes auto-scroll
//   change tempo mid-piece to match the score instead of running everything
//   at one BPM.
// Returns: { systems: [{ index, measures, duration, start, end, bpm }], totalDuration }
export function buildSchedule({ measuresPerSystem, beatsPerMeasure, bpm, bpmPerSystem }) {
  let t = 0;
  const systems = measuresPerSystem.map((measures, index) => {
    const sysBpm = bpmPerSystem && bpmPerSystem[index] > 0 ? bpmPerSystem[index] : bpm;
    const duration = measures * beatsPerMeasure * (60 / sysBpm);
    const start = t;
    t += duration;
    return { index, measures, duration, start, end: t, bpm: sysBpm };
  });
  return { systems, totalDuration: t };
}

// Expands sparse printed tempo marks into one BPM per system by carrying each
// mark forward until the next one — a ♩=N at system k sets the tempo for
// system k and every system after it, until another mark overrides it.
// Systems before the first mark use baseBpm (the manual Tempo slider). Returns
// a number[] parallel to the systems. tempoByIndex: { systemIndex: bpm }.
export function resolveBpmPerSystem(total, tempoByIndex, baseBpm) {
  const out = [];
  let cur = baseBpm;
  for (let i = 0; i < total; i++) {
    if (tempoByIndex[i] > 0) cur = tempoByIndex[i];
    out.push(cur);
  }
  return out;
}

// Collapses a per-system bpm array into the distinct tempos in document
// order (e.g. [86, 128]) -- used for the "tempo changes detected" banner
// (src/autoScrollUI.js). Deliberately takes whatever SLICE of bpmPerSystem
// the caller passes in (a whole document's, or a single section's own --
// see below) rather than assuming "the whole document" itself, so a
// multi-part document doesn't look like it oscillates many times just
// because each part reprints the same tempo structure (Finding 4, a real
// multi-part "Score and Parts"-style file: the banner used to be computed
// from the whole-document tempoSequence, so a normal "speeds up once, slows
// down once" piece looked like it changed tempo 2x per part).
export function tempoSequence(bpmPerSystem) {
  const seq = [];
  if (bpmPerSystem) for (const b of bpmPerSystem) if (b !== seq[seq.length - 1]) seq.push(b);
  return seq;
}

// Which system is "current" at elapsed time t (clamped to the schedule's
// range). Returns -1 for an empty schedule.
export function systemIndexAtElapsed(schedule, t) {
  const { systems } = schedule;
  if (!systems.length) return -1;
  if (t <= systems[0].start) return 0;
  if (t >= schedule.totalDuration) return systems.length - 1;
  for (const s of systems) if (t >= s.start && t < s.end) return s.index;
  return systems.length - 1;
}

// 0..1 progress through the CURRENT system at elapsed time t — used to
// interpolate scroll position smoothly between system i and i+1 instead of
// jumping. A zero-duration system (a degenerate 0-measure estimate) reports
// progress 1 (already "done") rather than dividing by zero.
export function progressWithinSystem(schedule, t) {
  const idx = systemIndexAtElapsed(schedule, t);
  if (idx < 0) return { index: -1, progress: 0 };
  const s = schedule.systems[idx];
  if (s.duration <= 0) return { index: idx, progress: 1 };
  const frac = (t - s.start) / s.duration;
  return { index: idx, progress: Math.min(1, Math.max(0, frac)) };
}

// Nearest system index to an already-scrolled document Y position, given
// the same systemCentersDoc array Snap mode already computes — used to
// start playback from wherever the user has manually scrolled to.
export function nearestSystemIndex(systemCentersDoc, scrollDocY) {
  if (!systemCentersDoc.length) return 0;
  let best = 0, bestDist = Infinity;
  systemCentersDoc.forEach((y, i) => {
    const d = Math.abs(y - scrollDocY);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// Flat list of expected beat timestamps across the whole schedule (each
// system's duration divided evenly across its measures x beatsPerMeasure
// beats) — the "when should a note happen" reference lib/tempoCorrection.js
// compares live onsets against for the live-tempo-correction feature.
export function beatTimestamps(schedule, beatsPerMeasure) {
  const out = [];
  for (const s of schedule.systems) {
    const totalBeats = s.measures * beatsPerMeasure;
    if (totalBeats <= 0) continue;
    const beatDur = s.duration / totalBeats;
    for (let b = 0; b < totalBeats; b++) out.push(s.start + b * beatDur);
  }
  return out;
}

// The expected beat timestamp nearest to elapsed time t. A plain linear
// scan is fine here: beat lists top out in the hundreds for a typical
// piece, and this only runs once per detected onset (at most a few times a
// second), not per animation frame.
export function nearestBeatTime(beats, t) {
  if (!beats.length) return null;
  let best = beats[0], bestDist = Math.abs(t - beats[0]);
  for (const b of beats) {
    const d = Math.abs(t - b);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return best;
}

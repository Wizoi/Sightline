// Estimates the number of measures in a system by detecting barlines: thin
// vertical strokes that span (most of) the system's staff-line height. This
// is a much more tractable computer-vision problem than reading rhythm or
// note-duration values, and combined with a user-confirmed time signature
// and BPM, gives a reasonable per-system duration estimate for auto-scroll
// timing — see lib/tempoSchedule.js.
//
// It's a deliberate approximation: barline count doesn't distinguish
// single/double/final barlines, doesn't special-case repeat signs, and
// assumes uniform note values within a measure. The app surfaces this
// count for the user to verify/correct (src/scoreAnalysis.js) rather than
// trusting it blindly — that's the point, not a gap to hide.

// columnRunLengths[c] = length of the longest continuous run of "ink" rows
// within the system's staff-line band, for column c (already reduced from
// pixels by the caller — see src/scoreAnalysis.js). bandHeight is the
// system's row extent (rowMax - rowMin + 1): how tall a run must be to
// count as a full-height barline stroke rather than a stray mark.
export function countBarlines(columnRunLengths, bandHeight, opts = {}) {
  const minFrac = opts.minFrac ?? 0.95;  // must span at least this much of the band
  const mergeGap = opts.mergeGap ?? 2;   // merge candidate columns this close together (one stroke, anti-aliased/thick)
  const need = bandHeight * minFrac;

  const candidates = [];
  for (let c = 0; c < columnRunLengths.length; c++) {
    if (columnRunLengths[c] >= need) candidates.push(c);
  }
  if (!candidates.length) return 0;

  let count = 1;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - candidates[i - 1] > mergeGap) count++;
  }
  return count;
}

// Measures = number of barlines detected: a printed system's last measure
// is closed by a barline, so N visible strokes bound N measures (like fence
// posts). Falls back to 1 (not 0) when nothing was confidently detected —
// a system with a missed barline is still at least one measure, and 1 is a
// visible, obviously-wrong-if-wrong number the user will notice and fix,
// rather than a silent zero.
export function estimateMeasureCount(columnRunLengths, bandHeight, opts) {
  return Math.max(1, countBarlines(columnRunLengths, bandHeight, opts));
}

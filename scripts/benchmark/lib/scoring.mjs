// Pure scoring helpers for the Analyze-score accuracy benchmark. No DOM/
// Playwright/filesystem dependency here on purpose -- everything in this
// file takes plain arrays/numbers and returns plain numbers/objects, so it
// can be reasoned about (and, if useful later, unit-tested) independent of
// the browser-driving half of the benchmark.

// Longest-common-subsequence length between two arrays, using `equalFn` for
// element equality (defaults to ===). This is the one primitive both
// "section names matched in order" and "BPM values matched in order" boil
// down to: how many elements of `a` can be found in `b`, in the same
// relative order, without requiring them to be contiguous or requiring `b`
// to have nothing extra in between. Classic O(n*m) DP -- these arrays are
// always small (systems/sections/tempo-marks per piece, not pages of a
// novel), so no smarter algorithm is worth the complexity.
export function lcsLength(a, b, equalFn = (x, y) => x === y) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = equalFn(a[i - 1], b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

// Fraction of `truth`'s elements matched (in order, exact equality) inside
// `detected`. 1.0 when truth is empty (nothing to find, and finding nothing
// extra is the app's own business elsewhere -- e.g. section-name accuracy
// doesn't penalize a single-section file for not inventing sections).
export function orderedMatchFraction(truth, detected, equalFn) {
  if (truth.length === 0) return 1;
  return lcsLength(truth, detected, equalFn) / truth.length;
}

// How many of `detected`'s own entries were NOT part of the ordered match --
// i.e. spurious/extra values the app reported that ground truth didn't ask
// for. Always >= 0 since an LCS can never exceed either input's length.
export function spuriousCount(truth, detected, equalFn) {
  const matched = lcsLength(truth, detected, equalFn);
  return detected.length - matched;
}

// 1 - abs(app - truth)/truth, clamped to [0, 1]. truth === 0 is a real edge
// case (a malformed/empty ground-truth entry, not expected in practice) --
// defined as 1 if the app also reports 0, else 0, rather than dividing by
// zero.
export function systemCountAccuracy(appCount, truthCount) {
  if (truthCount === 0) return appCount === 0 ? 1 : 0;
  return Math.max(0, 1 - Math.abs(appCount - truthCount) / truthCount);
}

// Section-name accuracy: ordered, exact-match fraction of ground-truth
// section names found in the app's detected section names, in the same
// relative order (a section renamed or reordered doesn't count).
export function sectionNameAccuracy(truthNames, appNames) {
  return orderedMatchFraction(truthNames, appNames);
}

// Measures-per-system accuracy: only meaningful when the app detected the
// SAME TOTAL system count as ground truth (see the module doc in run.mjs
// for why index-alignment breaks down otherwise). Returns null when not
// comparable -- callers must check for that rather than silently averaging
// in a misleading 0.
export function measuresPerSystemAccuracy(truthMeasures, appMeasures) {
  if (truthMeasures.length !== appMeasures.length) return null;
  const n = truthMeasures.length;
  if (n === 0) return { fraction: 1, meanAbsError: 0 };
  let exact = 0, absErrSum = 0;
  for (let i = 0; i < n; i++) {
    if (appMeasures[i] === truthMeasures[i]) exact++;
    absErrSum += Math.abs(appMeasures[i] - truthMeasures[i]);
  }
  return { fraction: exact / n, meanAbsError: absErrSum / n };
}

// BPM accuracy: fraction of ground-truth tempo values the app's detected
// tempo sequence contains, order-preserving, plus a flat count of spurious
// extra values the app reported that don't correspond to any ground-truth
// mark (per the brief: "flatly checking for spurious extra values" -- not
// folded into the fraction itself, reported alongside it instead so a
// perfect-but-noisy detector doesn't get an artificially inflated score by
// one metric while quietly failing the other).
export function bpmAccuracy(truthBpms, appBpms) {
  return {
    fraction: orderedMatchFraction(truthBpms, appBpms),
    spuriousCount: spuriousCount(truthBpms, appBpms),
  };
}

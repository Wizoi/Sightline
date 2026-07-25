import { fitCalibration, looResiduals } from './calibrationModel.js';
import { mean } from './mathUtils.js';

// --- Smooth-pursuit calibration (item 3): an alternative to the 9-dot grid ---
//
// Instead of 9 discrete fixations, the user follows one continuously-moving
// target for ~10s. This produces hundreds of continuously-labeled samples
// along a known trajectory instead of 9 discrete points — materially less
// tedious for this app's audience (see the Music Educator persona doc on
// setup-friction/tedium being a real, documented concern), and, once fed
// through the SAME grouped-fit machinery item 1 built (fitCalibration/
// looResiduals accept many labeled rows tagged with a `pointId`, and group by
// it rather than by row), better spatial coverage than 9 fixed points, for
// less than half the sitting-still time, essentially for free.
//
// The one thing that makes a naive version of this technique actively wrong
// (not just noisier) is smooth-pursuit LAG: the literature on smooth pursuit
// eye movements (e.g. the "Pursuits" interaction technique — Vidal, Turner,
// Bulling & Gellersen, and the broader oculomotor-control literature it
// draws on) is consistent that the eye trails a moving target by a
// meaningful, human- and speed-dependent latency (order of 100-200ms for a
// comfortably slow target, not a fixed universal constant) — so pairing a
// frame's MEASURED gaze features with the target's CURRENT on-screen
// position at that same instant systematically mislabels every sample by a
// consistent offset.
//
// *** A real dead end hit and fixed while building this, worth recording ***
// The first version of this module tried to pick the lag the same way item 1
// picks a "good" calibration: fit the model once per candidate lag, then
// choose whichever lag gave the best held-out (leave-one-segment-out)
// residual. A synthetic experiment (fixed, known lag + additive Gaussian
// measurement noise, no other confound) showed this DOESN'T reliably recover
// the true lag: a smooth, periodic Lissajous trajectory means a *wrong* lag
// doesn't scramble the (rx,ry)->(sx,sy) relationship into something
// obviously bad, it just reparameterizes it into a different, still-smooth,
// still-fittable relationship (a small time-shift of a periodic signal is
// close to another phase of a similar-looking signal) — the quadratic ridge
// model is flexible enough to fit several wrong-lag hypotheses almost as
// well as the correct one, so LOO residual comparison across lag hypotheses
// was NOT a reliable discriminator here (confirmed by reproducing the
// failure with a seeded synthetic trace before writing this comment, not
// assumed). What DOES cleanly separate them, confirmed with the same
// synthetic trace: cross-correlating the raw measured rx(t)/ry(t) time
// series against the target's own x(t-lag)/y(t-lag) series and picking the
// lag that maximizes Pearson correlation — the same style of signal
// (trajectory-vs-trajectory correlation, not fit-quality comparison) the
// actual "Pursuits" paper uses to match a gaze trace to a candidate target
// trajectory in the first place. `estimateLag` below implements that; the
// LOO machinery from item 1 is still used, but only AFTER a lag is chosen,
// to validate/score the resulting fit, not to choose the lag itself.
//
// *** A second dead end, still open, documented rather than hidden ***
// Even applied only for scoring (not lag selection), item 1's leave-one-out
// philosophy doesn't port cleanly to a continuous trajectory either — see
// `pursuitQuality`'s own doc comment below for what was tried and why it's
// currently kept as a diagnostic only, not wired to any user-facing
// "recalibrate" gate the way the 9-dot flow's calibrationQuality is.

// Bounded to the same safe margins as the existing 9-dot grid (0.1-0.9 x,
// 0.12-0.88 y) so this can't ask the user to look at the very edge of the
// screen. A Lissajous path (different x/y frequencies, phase-offset) rather
// than e.g. a simple circle or rectangle: gives broader, more even coverage
// of the interior (a circle alone undersamples the center; a rectangle's
// corners require an abrupt direction change the eye can't smoothly pursue
// through) over one full sweep.
export const CX = 0.5, CY = 0.5, AX = 0.4, AY = 0.38, FX = 3, FY = 4, PHASE = Math.PI / 2;
export const DEFAULT_DURATION_SEC = 10;
export const DEFAULT_SEGMENTS = 10;
// Candidate smooth-pursuit lags to search over (see module doc comment
// above) — NOT tuned against real user sessions (no corpus of "real pursuit
// traces with known-true lag" exists to validate this against, the same
// "treat as a conservative, clearly-reasoned starting point, not a tuned
// constant" caveat the Applied Math persona doc already applies to
// gridSpacingThreshold). Spans the range the literature associates with
// comfortable smooth pursuit of a slow-moving target.
export const DEFAULT_CANDIDATE_LAGS_SEC = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

// Where the pursuit target sits at time tSec into a `durationSec`-long sweep
// (screen fraction, same 0-1 space sx/sy already live in throughout this
// app). Clamped outside [0, durationSec] rather than extrapolated.
export function pursuitTarget(tSec, durationSec) {
  const t = Math.max(0, Math.min(durationSec, tSec));
  const x = CX + AX * Math.sin((2 * Math.PI * FX * t) / durationSec);
  const y = CY + AY * Math.sin((2 * Math.PI * FY * t) / durationSec + PHASE);
  return { x, y };
}

// Which of `segments` equal-length time buckets tSec falls into — used as
// the `pointId` grouping key so leave-one-out validation (calibrationModel.js
// -- looResiduals groups by pointId) holds out one whole arc of the
// trajectory at a time (the continuous-trajectory analog of "leave one
// calibration dot out"), rather than one single sample the model has likely
// seen dozens of near-identical neighbors of.
export function segmentIndexAt(tSec, durationSec, segments = DEFAULT_SEGMENTS) {
  const frac = Math.max(0, Math.min(0.999999, tSec / durationSec));
  return Math.floor(frac * segments);
}

// Builds calibPoints (same shape fitCalibration/looResiduals already accept)
// from raw pursuit samples under one candidate lag hypothesis. `samples`:
// [{ tSec, rx, ry, bH, bV }] — tSec is capture time relative to the sweep's
// own start (t=0), NOT wall-clock time. A sample is dropped (not clamped)
// when shifting it by `lagSec` would place its implied target outside the
// sweep — clamping instead would silently pile spurious rows onto the
// first/last segment and bias the fit there.
export function buildPursuitCalibPoints(samples, durationSec, lagSec, segments = DEFAULT_SEGMENTS) {
  const out = [];
  for (const s of samples) {
    const targetT = s.tSec - lagSec;
    if (targetT < 0 || targetT > durationSec) continue;
    const { x, y } = pursuitTarget(targetT, durationSec);
    out.push({
      sx: x, sy: y, rx: s.rx, ry: s.ry, bH: s.bH || 0, bV: s.bV || 0,
      pointId: segmentIndexAt(targetT, durationSec, segments),
    });
  }
  return out;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 2) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  const denom = Math.sqrt(da * db);
  return denom > 1e-12 ? num / denom : 0;
}

// Estimates the smooth-pursuit lag by cross-correlating the raw measured
// rx(t)/ry(t) time series against the target's own x(t-lag)/y(t-lag) series
// for each candidate lag, and picking whichever lag maximizes the summed
// Pearson correlation (rx-vs-x plus ry-vs-y) — see the module doc comment's
// "dead end hit and fixed" note for why this, rather than a downstream
// fit-quality comparison, is the reliable way to do this. Returns the best
// candidate lag (seconds) and its correlation score, or null if no candidate
// left enough overlapping samples to correlate at all.
export function estimateLag(samples, durationSec = DEFAULT_DURATION_SEC, candidateLagsSec = DEFAULT_CANDIDATE_LAGS_SEC) {
  let best = null;
  for (const lagSec of candidateLagsSec) {
    const rows = samples.filter((s) => s.tSec - lagSec >= 0 && s.tSec - lagSec <= durationSec);
    if (rows.length < 8) continue; // too few overlapping samples for a meaningful correlation
    const targets = rows.map((s) => pursuitTarget(s.tSec - lagSec, durationSec));
    const score = pearson(rows.map((s) => s.rx), targets.map((t) => t.x))
      + pearson(rows.map((s) => s.ry), targets.map((t) => t.y));
    if (!best || score > best.score) best = { lagSec, score };
  }
  return best;
}

// Segment centroids in time order — the continuous-trajectory analog of the
// 9-dot grid's distinct sx/sy columns/rows, used below to derive a
// pursuit-appropriate "meaningfully bad" LOO threshold. A raw grid-spacing
// derivation (half the smallest gap between ALL distinct sx/sy values, as
// calibrationModel.js's gridSpacingThreshold does for the 9-dot grid) breaks
// down for a near-continuous trajectory: almost every sample has a distinct
// sx/sy, so that gap collapses toward zero and would flag every fit as
// "poor" regardless of how good it actually is (caught by this module's own
// tests before shipping, not assumed).
function segmentCentroids(calibPoints) {
  const groups = new Map();
  for (const p of calibPoints) {
    if (!groups.has(p.pointId)) groups.set(p.pointId, []);
    groups.get(p.pointId).push(p);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((id) => {
    const pts = groups.get(id);
    return { id, sx: mean(pts.map((p) => p.sx)), sy: mean(pts.map((p) => p.sy)) };
  });
}

// Half the smallest CONSECUTIVE (time-adjacent, not all-pairs) segment
// centroid distance — the trajectory equivalent of gridSpacingThreshold's
// "half the smallest grid spacing." A LOO error past this would place the
// held-out segment's predicted target closer to a neighboring segment's own
// position than to its true one.
function pursuitSpacingThreshold(calibPoints) {
  const centroids = segmentCentroids(calibPoints);
  let minGap = Infinity;
  for (let i = 1; i < centroids.length; i++) {
    const d = Math.hypot(centroids[i].sx - centroids[i - 1].sx, centroids[i].sy - centroids[i - 1].sy);
    if (d > 0 && d < minGap) minGap = d;
  }
  return Number.isFinite(minGap) ? minGap / 2 : 0.15;
}

// Same shape/semantics as calibrationModel.js's calibrationQuality (worst,
// worstIndex, threshold, poorIndices, poor), but with a pursuit-appropriate
// threshold (pursuitSpacingThreshold, above) instead of grid-column/row
// spacing, which doesn't apply to a continuous trajectory.
//
// *** Known, evidence-based limitation — deliberately NOT wired to any
// user-facing "recalibrate" gate (see fitPursuitCalibration's own callers) ***
// Reusing item 1's leave-one-out philosophy verbatim here (hold out one
// whole time-segment, refit, compare) turned out, when actually tested
// (src/lib/pursuitCalibration.test.js's "[known limitation]" test), to flag
// even a fit independently shown to generalize well (better held-out
// accuracy than an unlagged baseline) as "poor," across a wide range of
// segment counts. The likely reason: unlike the 9-dot grid, where holding
// one point out still leaves 8 neighbors surrounding it from every side,
// holding out one arc of a trajectory with only ~1-1.5 pattern repeats over
// 10s can remove the only near-visit to a region of the screen, making that
// "held-out" check extrapolation rather than interpolation — a structurally
// harder case than the discrete grid, not just a threshold that needs
// retuning. Kept here as a diagnostic (real numbers, useful for future
// research/a longer session's redesign) rather than deleted, but treat
// `poor` as unreliable for this trajectory-based flow until that's actually
// resolved — do not gate UI behavior on it the way calibrationQuality's
// `poor` gates the 9-dot flow's recalibration banner.
export function pursuitQuality(calibPoints, ridgeLambda = 0.05) {
  const distinctIds = new Set(calibPoints.map((p) => p.pointId)).size;
  if (!calibPoints || distinctIds < 4) {
    return { residuals: [], worst: 0, worstIndex: -1, threshold: 0, poorIndices: [], poor: false };
  }
  const residuals = looResiduals(calibPoints, ridgeLambda);
  const threshold = pursuitSpacingThreshold(calibPoints);
  let worst = 0, worstIndex = -1;
  for (const r of residuals) if (r.dist > worst) { worst = r.dist; worstIndex = r.index; }
  const poorIndices = residuals.filter((r) => r.dist > threshold).map((r) => r.index);
  return { residuals, worst, worstIndex, threshold, poorIndices, poor: poorIndices.length > 0 };
}

// Fits a calibration model from raw pursuit samples: estimates the lag by
// cross-correlation, builds calibPoints at that lag, then fits + scores
// exactly like the 9-dot flow (fitCalibration + a LOO quality check), just
// with a pursuit-appropriate threshold. Returns null if lag estimation or
// the resulting fit didn't have enough usable samples — callers should
// treat that the same as "capture failed," matching runCalibration()'s own
// too-few-samples handling.
export function fitPursuitCalibration(samples, durationSec = DEFAULT_DURATION_SEC, opts = {}) {
  const {
    candidateLagsSec = DEFAULT_CANDIDATE_LAGS_SEC,
    segments = DEFAULT_SEGMENTS,
    ridgeLambda = 0.05,
  } = opts;
  const lagEstimate = estimateLag(samples, durationSec, candidateLagsSec);
  if (!lagEstimate) return null;
  const calibPoints = buildPursuitCalibPoints(samples, durationSec, lagEstimate.lagSec, segments);
  if (calibPoints.length < segments) return null;
  const fit = fitCalibration(calibPoints, ridgeLambda);
  const quality = pursuitQuality(calibPoints, ridgeLambda);
  return {
    lagSec: lagEstimate.lagSec, lagCorrelation: lagEstimate.score,
    gnorm: fit.gnorm, coefX: fit.coefX, coefY: fit.coefY,
    quality, calibPoints,
  };
}

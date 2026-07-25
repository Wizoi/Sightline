import { fitCalibration, looResiduals, applyX, applyY } from './calibrationModel.js';
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
// FX/FY were 3/4 over a 10s sweep in the first shipped version. Real-user
// testing (2026-07-25, first hands-on session with this flow) measured it
// as clearly WORSE than the 9-dot grid on the app's own "Check accuracy"
// test — ~70% "lands on the right line" across two runs vs ~83% for 9-dot —
// while being strongly preferred for comfort. The most likely cause is
// simply that the target moved too fast to pursue smoothly: at 3 horizontal
// oscillations across 0.8 of screen width in 10s, peak target speed is
// roughly 900px/s on a typical laptop display, well past the ~30°/s where
// human smooth pursuit starts breaking down into catch-up saccades (at
// which point the eye is repeatedly NOT on the target, and every sample
// taken during a saccade is mislabeled). Lowered to 2/3 over 12s, which
// cuts peak angular speed by ~45%. This is a reasoned correction to a
// falsified starting guess, not a tuned constant — the honest next step is
// re-measuring with "Check accuracy" and adjusting again from real numbers.
// PHASE was Math.PI/2, which put the sweep's t=0 position at (0.5, 0.88) —
// the very bottom of the safe band. Combined with the stationary lead-in
// (which holds the dot at dead center), that made the dot TELEPORT 0.38 of
// the screen height downward the instant the sweep began, guaranteeing a
// catch-up saccade at exactly the moment sampling started. Reported from
// real use ("have the dot start moving from the center") and confirmed
// numerically. PHASE = 0 makes both axes start at their sine zero-crossing,
// i.e. exactly (CX, CY) — the sweep now begins from wherever the lead-in
// left the eye, with no discontinuity. The 2:3 frequency ratio still traces
// a proper Lissajous figure at zero phase offset, so interior coverage is
// preserved.
export const CX = 0.5, CY = 0.5, AX = 0.4, AY = 0.38, FX = 2, FY = 3, PHASE = 0;
export const DEFAULT_DURATION_SEC = 12;
// Ease the target up to full speed over the first RAMP_SEC rather than
// starting at full velocity from a dead stop — also requested from real use
// ("maybe move faster to the target speed after a second or two rampup for
// the user to get comfortable"). Implemented as a TIME WARP inside
// pursuitTarget rather than a separate display-only animation, so the fit's
// own labels (which call the same function) stay exactly consistent with
// what was actually on screen; a display/label mismatch here would
// systematically mislabel every early sample.
export const RAMP_SEC = 1.5;
// Stationary hold at screen center before the sweep starts, so the user can
// read the instructions and get their eyes settled on the target before it
// moves — requested directly from real use ("maybe it should just start in
// the center for 5s so i can read the text and get my eyes centered before
// it starts going around"). Samples captured during this hold are discarded
// rather than fitted: the eye is genuinely at center the whole time, so
// they'd be valid center-labeled data, but feeding a long stationary run
// into a fit whose lag estimator works by cross-correlating *movement*
// would swamp the signal it needs with a flat segment.
export const DEFAULT_LEAD_IN_SEC = 3;
export const DEFAULT_SEGMENTS = 10;

// Brief stops partway along the sweep, where the target holds still before
// moving on. Suggested from real use ("should the dot stop in a few places
// to get a resting accuracy reading and then go again?") and worth doing for
// a concrete reason, not just comfort: during a FIXATION there is no
// smooth-pursuit lag to estimate at all. The eye is simply on the target, so
// those samples are the same quality as a 9-dot flow's, and they anchor the
// fit at known screen positions. The moving segments still provide the broad,
// even coverage that a 9-point grid can't. A dwell is also inherently
// lag-INSENSITIVE: shifting a sample's time by ±100ms while the target is
// stationary barely changes where the target was, so these samples stay
// correctly labeled even if the lag estimate is somewhat off — which is
// exactly the failure mode that made pursuit inconsistent run to run.
export const DEFAULT_DWELL_COUNT = 4;
export const DEFAULT_DWELL_SEC = 0.6;
// Time spent easing INTO and OUT OF each dwell, rather than stopping and
// restarting instantly. Reported from real use as "seems to be abrupt," and
// it's a data problem as much as a comfort one: smooth pursuit carries
// momentum, so a target that stops dead is overshot by the eye, and one that
// restarts at full speed is caught up to with a saccade. Both corrupt the
// samples immediately around each dwell — precisely the samples the dwells
// exist to make clean. Velocity ramps linearly to zero and back, which makes
// the target's speed continuous through the stop (position stays smooth),
// the property the eye actually tracks.
export const DEFAULT_DWELL_EASE_SEC = 0.35;

// Real wall-clock length of the moving phase, including the dwell holds.
// The sweep's own trajectory time is still `durationSec`; dwells add real
// time without advancing the trajectory (see sweepTimeFromElapsed).
export function totalPursuitSec(durationSec = DEFAULT_DURATION_SEC, {
  dwellCount = DEFAULT_DWELL_COUNT, dwellSec = DEFAULT_DWELL_SEC,
  easeSec = DEFAULT_DWELL_EASE_SEC,
} = {}) {
  // Each dwell costs its hold plus the ease pair. The two ease phases run
  // for 2*easeSec of real time but only advance the trajectory by easeSec
  // (average velocity 0.5 across a linear ramp), so the NET extra real time
  // per dwell is dwellSec + easeSec, not dwellSec + 2*easeSec.
  return durationSec + dwellCount * (dwellSec + easeSec);
}

// Maps real elapsed time (since the sweep began) to the sweep's own
// trajectory time, freezing the trajectory during each dwell. Dwells are
// evenly spaced through trajectory time, excluding the very start and end
// (a dwell at t=0 would just extend the stationary lead-in, and one at the
// end would delay the finish for nothing).
//
// Deliberately kept SEPARATE from pursuitTarget rather than folded into it:
// the fit, the lag estimator and the display must all agree on where the
// target was at a given moment, and the cleanest way to guarantee that is a
// single conversion applied once (elapsed -> sweep time) with everything
// downstream continuing to work in sweep time exactly as before.
export function sweepTimeFromElapsed(elapsedSec, durationSec = DEFAULT_DURATION_SEC, {
  dwellCount = DEFAULT_DWELL_COUNT, dwellSec = DEFAULT_DWELL_SEC,
  easeSec = DEFAULT_DWELL_EASE_SEC,
} = {}) {
  if (dwellCount <= 0 || dwellSec <= 0) return Math.max(0, Math.min(durationSec, elapsedSec));
  const ease = Math.max(0, easeSec);
  const half = ease / 2;
  let remaining = Math.max(0, elapsedSec);
  let sweep = 0;
  for (let i = 1; i <= dwellCount; i++) {
    // Each dwell is centered on its trajectory position, with the decel
    // consuming the half-ease before it and the accel the half-ease after,
    // so the stop happens exactly where a hard freeze used to.
    const dwellAt = (durationSec * i) / (dwellCount + 1);

    // Full-speed run up to where deceleration begins.
    const untilDecel = (dwellAt - half) - sweep;
    if (remaining < untilDecel) return sweep + remaining;
    remaining -= untilDecel;
    sweep = dwellAt - half;

    // Decelerate: velocity 1 -> 0 linearly over `ease` real seconds, which
    // advances the trajectory by ease/2 (the integral of that ramp).
    if (ease > 0) {
      if (remaining < ease) {
        const f = remaining / ease;
        return sweep + ease * (f - (f * f) / 2);
      }
      remaining -= ease;
      sweep = dwellAt;
    }

    // Hold: trajectory frozen, clock still running.
    if (remaining < dwellSec) return sweep;
    remaining -= dwellSec;

    // Accelerate: velocity 0 -> 1, mirroring the decel.
    if (ease > 0) {
      if (remaining < ease) {
        const f = remaining / ease;
        return sweep + ease * ((f * f) / 2);
      }
      remaining -= ease;
      sweep = dwellAt + half;
    }
  }
  return Math.min(durationSec, sweep + remaining);
}
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
// Maps real elapsed time to "trajectory time," easing speed up from 0 to
// full over RAMP_SEC (speed profile s(t) = min(1, t/RAMP_SEC); this is its
// integral). Rescaled by `k` so a full durationSec of real time still
// completes exactly one full sweep — without that, the ramp would eat
// RAMP_SEC/2 of trajectory and silently truncate the path's last arc,
// losing the screen coverage that arc was there to provide.
function warpTime(t, durationSec, rampSec) {
  const ramp = Math.min(rampSec, durationSec);
  if (ramp <= 0) return t;
  const raw = t < ramp ? (t * t) / (2 * ramp) : ramp / 2 + (t - ramp);
  const k = durationSec / (durationSec - ramp / 2);
  return raw * k;
}

export function pursuitTarget(tSec, durationSec, { rampSec = RAMP_SEC } = {}) {
  const t = warpTime(Math.max(0, Math.min(durationSec, tSec)), durationSec, rampSec);
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

// Slider bounds for "Eye-tracking smoothing" (index.html's #sm) — the
// suggestion below is clamped into the same range a user could pick by hand.
export const SMOOTH_WIN_MIN = 3;
export const SMOOTH_WIN_MAX = 40;

// Per-frame gaze noise, in screen fractions, measured from a completed
// calibration. Takes the FIRST DIFFERENCE of the model's residual (predicted
// minus true target) between consecutive samples: differencing cancels both
// the target's own motion and any slowly-varying bias in the fit, leaving
// the frame-to-frame jitter that smoothing actually exists to suppress.
// Dividing by sqrt(2) converts the spread of that difference back to the
// spread of a single frame's noise (differencing two independent samples
// doubles the variance).
export function estimateGazeNoise(samples, durationSec, { gnorm, coefX, coefY }, opts = {}) {
  const rows = samples
    .filter((s) => s.tSec >= 0 && s.tSec <= durationSec)
    .sort((a, b) => a.tSec - b.tSec);
  if (rows.length < 8) return null;
  const resid = rows.map((s) => {
    const t = pursuitTarget(s.tSec, durationSec, opts);
    return { dx: applyX(s, coefX, gnorm) - t.x, dy: applyY(s, coefY, gnorm) - t.y };
  });
  const diffs = [];
  for (let i = 1; i < resid.length; i++) {
    diffs.push(Math.hypot(resid[i].dx - resid[i - 1].dx, resid[i].dy - resid[i - 1].dy));
  }
  if (!diffs.length) return null;
  // Median rather than mean: a blink or a lost frame produces a huge
  // one-off difference that would otherwise dominate the estimate.
  const sorted = diffs.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  return med / Math.SQRT2;
}

// Residual frame-to-frame jitter we aim to leave after smoothing, as a
// fraction of screen height. Anchored two ways rather than derived from a
// convenient-looking ratio: (a) ~0.7% of screen height is a handful of
// pixels on a laptop — below where the gaze dot reads as visibly jumpy, and
// far inside a single staff's height, so it can't cause a spurious
// system-to-system flip; (b) it is calibrated so that TYPICAL measured
// noise lands near smoothWin 12, the existing hand-tuned default, which
// means this suggestion refines that default rather than fighting it.
//
// An earlier version of this derived the target from cfg.deadZoneFrac
// (dead zone / 6). That was wrong and worth recording: the dead zone
// defaults to 0.18 — eighteen percent of the screen — so even a sixth of it
// is a huge tolerance, and the formula returned the minimum smoothing for
// every realistic noise level. The dead zone is what a SUSTAINED gaze
// offset must not cross; it says nothing about acceptable per-frame jitter.
export const TARGET_JITTER_FRAC = 0.007;

// Turns measured per-frame noise into a smoothing-slider value. Averaging
// over N frames reduces noise by ~sqrt(N) (the One Euro filter is adaptive
// rather than a plain N-frame mean, but its resting behavior is calibrated
// from smoothWin on exactly that N-frame time-constant basis — see
// followLogic.js's minCutoffFromSmoothWin), so N ~= (noise / target)^2.
export function suggestSmoothWin(noiseStd, targetJitter = TARGET_JITTER_FRAC) {
  if (!(noiseStd > 0) || !(targetJitter > 0)) return null;
  const n = Math.round((noiseStd / targetJitter) ** 2);
  return Math.max(SMOOTH_WIN_MIN, Math.min(SMOOTH_WIN_MAX, n));
}

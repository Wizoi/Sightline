import { mean, stddev, median } from './mathUtils.js';
import { lstsqRidge } from './linearAlgebra.js';

// Groups calibPoints by the physical dot they came from. `pointId` is set by
// runCalibration() (src/calibration.js) when it now feeds every raw sample of
// a 550ms dot-capture as its own row instead of collapsing them to one
// median row (see fitCalibration's doc comment below) — but any caller that
// still passes one row per point (no pointId, e.g. this file's own tests,
// which predate that change) gets exactly the old behavior: each row is
// treated as its own singleton group, by falling back to its array index as
// the group key. This is what makes every function below fully backward
// compatible with 9-rows-in, 9-rows-out callers.
function groupIndices(calibPoints) {
  const map = new Map();
  calibPoints.forEach((p, i) => {
    const key = p.pointId !== undefined && p.pointId !== null ? `id:${p.pointId}` : `row:${i}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  return [...map.values()];
}

// Ridge lambda was hand-tuned (0.05) for the original regime of exactly one
// (already-denoised, median-collapsed) row per calibration dot. Feeding every
// raw sample of a dot's ~550ms capture instead (hundreds of rows for the same
// 9 physical points) changes what that lambda means: ridge solves
// (X^T X + lambda*I) beta = X^T y, and X^T X scales ~linearly with row count,
// so a *fixed* lambda's regularization strength relative to the data term
// dilutes by roughly (rows-per-point) if left unscaled — silently making the
// fit progressively less regularized as more samples are captured per dot
// (e.g. from a higher-framerate camera), for no principled reason. Scaling
// lambda by (total rows / number of distinct calibration points) keeps the
// regularization-to-data-fit ratio the same as it was in the original
// 1-row-per-point regime that 0.05 was chosen for, whatever the sample count
// turns out to be — so this is a correctness fix for the *new* many-samples
// regime, not a re-tune of the constant itself. (Derivation: m near-duplicate
// noisy measurements of the same point make X^T X ~= m * X0^T X0, so solving
// with lambda gives the same beta as solving the single-measurement-per-point
// problem with lambda/m — scaling lambda by m up front restores the original
// per-point regularization strength.) With exactly one row per point (the old
// callers, and this file's own tests), rows/points == 1 and this is a no-op.
function effectiveLambda(calibPoints, ridgeLambda) {
  const groups = groupIndices(calibPoints);
  if (!groups.length) return ridgeLambda;
  return ridgeLambda * (calibPoints.length / groups.length);
}

// Gaze model: quadratic in standardized (rx,ry) + a linear blendshape term,
// fit separately for the X and Y screen axes. Standardization keeps the fit
// well-conditioned across different eye-ratio/pose scales.
export function stdz(p, gnorm) {
  return {
    rx: gnorm ? (p.rx - gnorm.m[0]) / gnorm.s[0] : p.rx,
    ry: gnorm ? (p.ry - gnorm.m[1]) / gnorm.s[1] : p.ry,
    bH: gnorm ? ((p.bH || 0) - gnorm.m[2]) / gnorm.s[2] : (p.bH || 0),
    bV: gnorm ? ((p.bV || 0) - gnorm.m[3]) / gnorm.s[3] : (p.bV || 0),
  };
}

export function featX(z) { return [1, z.rx, z.ry, z.rx * z.ry, z.rx * z.rx, z.ry * z.ry, z.bH]; }
export function featY(z) { return [1, z.rx, z.ry, z.rx * z.ry, z.rx * z.rx, z.ry * z.ry, z.bV]; }

export function dotv(c, f) {
  let s = 0;
  for (let i = 0; i < c.length; i++) s += c[i] * f[i];
  return s;
}

export function applyX(p, coefX, gnorm) { return dotv(coefX, featX(stdz(p, gnorm))); }
export function applyY(p, coefY, gnorm) { return dotv(coefY, featY(stdz(p, gnorm))); }

// Fits gnorm/coefX/coefY from a set of calibration samples, each shaped like
// { sx, sy, rx, ry, bH, bV, pointId? } (sx/sy = target screen fraction).
// `pointId` (which physical dot a row came from) is optional: pass it when
// feeding every raw sample of a dot's capture window rather than one
// median-collapsed row per dot, so LOO/lambda-scaling above can tell which
// rows belong together. ridgeLambda is scaled per effectiveLambda's doc
// comment; pass a pre-scaled lambda of your own via the same parameter if
// you need to bypass that (rows/points == 1 keeps it a no-op regardless).
export function fitCalibration(calibPoints, ridgeLambda = 0.05) {
  const col = (k) => calibPoints.map((p) => p[k]);
  const gnorm = {
    m: [mean(col('rx')), mean(col('ry')), mean(col('bH')), mean(col('bV'))],
    s: [
      stddev(col('rx')) || 1e-3,
      stddev(col('ry')) || 1e-3,
      stddev(col('bH')) || 1e-3,
      stddev(col('bV')) || 1e-3,
    ],
  };
  const zs = calibPoints.map((p) => stdz(p, gnorm));
  const lambda = effectiveLambda(calibPoints, ridgeLambda);
  const coefX = lstsqRidge(zs.map(featX), col('sx'), lambda);
  const coefY = lstsqRidge(zs.map(featY), col('sy'), lambda);
  return { gnorm, coefX, coefY };
}

// Leave-one-POINT-out residuals: refits the model once per *physical
// calibration dot* with every one of that dot's rows excluded (not just one
// row), then measures how far that dot's own held-out readings predict from
// where it was actually clicked (sx,sy). This is a genuine generalization
// check (unlike the fit's own training residual, which a 7-parameter model
// can nearly always drive to ~0 regardless of whether the fit is any good
// off-sample) — cheap here only because a handful of dots means a handful of
// refits, not because the method is approximate.
//
// Grouping by dot (via groupIndices, keyed on `pointId` when present) rather
// than by row is deliberate, not incidental, now that a dot can contribute
// many rows: leaving out a single *sample* of a dot the model has otherwise
// seen dozens of near-identical rows from would barely move the fit at all
// and would say nothing about generalizing to a genuinely new fixation —
// it'd mostly just be re-measuring how well the model fits data it has
// already memorized. Leaving out the whole dot is the only version of this
// test that still means "how well would this model have predicted a point it
// never saw," which is the entire reason A3 introduced LOO in the first
// place. Backward compatible: with the original one-row-per-dot input (no
// pointId — every existing caller/test before this change), each group is a
// singleton and this reduces to exactly the old per-row LOO.
export function looResiduals(calibPoints, ridgeLambda = 0.05) {
  const groups = groupIndices(calibPoints);
  const out = [];
  groups.forEach((idxs, gi) => {
    const heldSet = new Set(idxs);
    const rest = calibPoints.filter((_, i) => !heldSet.has(i));
    const { gnorm, coefX, coefY } = fitCalibration(rest, ridgeLambda);
    const rows = idxs.map((i) => calibPoints[i]);
    // Representative held-out reading: median across this dot's own rows
    // (all rows in a group share the same sx/sy target already) — the same
    // per-dot summary runCalibration() used to compute up front, just
    // computed here instead of baked into the stored calibration data.
    const held = {
      sx: rows[0].sx, sy: rows[0].sy,
      rx: median(rows.map((r) => r.rx)),
      ry: median(rows.map((r) => r.ry)),
      bH: median(rows.map((r) => r.bH || 0)),
      bV: median(rows.map((r) => r.bV || 0)),
    };
    const px = applyX(held, coefX, gnorm);
    const py = applyY(held, coefY, gnorm);
    const dx = px - held.sx, dy = py - held.sy;
    out.push({ index: gi, pointId: rows[0].pointId, dx, dy, dist: Math.hypot(dx, dy) });
  });
  return out;
}

// Derives a "this residual is meaningfully bad" cutoff directly from the
// calibration grid actually used, rather than a hand-picked constant: half
// the smallest spacing between distinct target columns/rows (in screen
// fraction). A LOO prediction error past that would land closer to an
// ADJACENT calibration target than to the true one — a concrete, legible
// failure mode, not an arbitrary number. Falls back to a conservative 0.15
// (screen-fraction) for a degenerate/non-grid point set (e.g. all-identical
// targets), where no real spacing exists to derive from.
export function gridSpacingThreshold(calibPoints) {
  const xs = [...new Set(calibPoints.map((p) => p.sx))].sort((a, b) => a - b);
  const ys = [...new Set(calibPoints.map((p) => p.sy))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1]);
  return gaps.length ? Math.min(...gaps) / 2 : 0.15;
}

// Summarizes LOO quality for a just-completed calibration: which points (if
// any) the model fails to generalize to, and whether that's bad enough to
// warrant a proactive recalibration prompt. Needs at least 4 distinct
// physical DOTS for LOO refits to be meaningful at all (below that, holding
// one out leaves too few points for the refit itself to mean anything) —
// real 9-point calibrations are always well above this floor; it only guards
// a pathological caller. Checked on group count, not raw row count: once a
// dot can contribute many sample rows, `calibPoints.length` alone no longer
// says anything about how many distinct points were actually calibrated.
export function calibrationQuality(calibPoints, ridgeLambda = 0.05) {
  if (!calibPoints || groupIndices(calibPoints).length < 4) {
    return { residuals: [], worst: 0, worstIndex: -1, threshold: 0, poorIndices: [], poor: false };
  }
  const residuals = looResiduals(calibPoints, ridgeLambda);
  const threshold = gridSpacingThreshold(calibPoints);
  let worst = 0, worstIndex = -1;
  for (const r of residuals) if (r.dist > worst) { worst = r.dist; worstIndex = r.index; }
  const poorIndices = residuals.filter((r) => r.dist > threshold).map((r) => r.index);
  return { residuals, worst, worstIndex, threshold, poorIndices, poor: poorIndices.length > 0 };
}

// Compares two "setup fingerprints" (camera, window size, DPR) and returns
// human-readable reasons a saved calibration may no longer be trustworthy.
export function calibMismatch(oldFp, newFp) {
  const r = [];
  if (oldFp.cam && newFp.cam && oldFp.cam !== newFp.cam) r.push('different camera');
  if (
    Math.abs(newFp.winW - oldFp.winW) / Math.max(1, oldFp.winW) > 0.05 ||
    Math.abs(newFp.winH - oldFp.winH) / Math.max(1, oldFp.winH) > 0.05
  ) r.push('window resized');
  if (oldFp.dpr && newFp.dpr && Math.abs(newFp.dpr - oldFp.dpr) > 0.01) r.push('display zoom changed');
  return r;
}

// Which eye's signal the fitted model should use. The two eyes are not
// always equally good predictors of gaze: ocular dominance is common, and a
// small misalignment between the eyes (a phoria) can make one eye's apparent
// iris offset a systematically worse fit to where the person is actually
// looking. Blindly averaging then mixes a good signal into a worse one.
// Rather than assume, this MEASURES it against the user's own calibration
// targets — the one moment the app has ground truth for where they were
// genuinely looking.
export const EYE_MODES = ['both', 'left', 'right'];

// Rewrites each calibration row's rx/ry to come from the requested eye.
// Rows that don't carry per-eye values (older saved calibrations, synthetic
// test fixtures) are returned untouched, which makes 'both' the safe
// fallback everywhere.
export function projectEyeMode(calibPoints, mode) {
  if (mode === 'left') {
    return calibPoints.map((p) => (p.rxL == null ? p : { ...p, rx: p.rxL, ry: p.ryL }));
  }
  if (mode === 'right') {
    return calibPoints.map((p) => (p.rxR == null ? p : { ...p, rx: p.rxR, ry: p.ryR }));
  }
  return calibPoints;
}

// Mean leave-one-point-out error for a candidate eye mode — the same
// genuine generalization measure the existing quality check uses, not the
// fit's own training residual (which a 7-parameter model can drive near
// zero regardless of whether it generalizes).
function looMeanError(calibPoints, ridgeLambda) {
  const res = looResiduals(calibPoints, ridgeLambda);
  if (!res.length) return Infinity;
  return mean(res.map((r) => r.dist));
}

// Picks whichever of both/left/right actually predicts this user's own
// calibration targets best, and reports all three so the choice is
// inspectable rather than opaque. Returns 'both' unchanged when per-eye
// data isn't present at all.
//
// `margin` is deliberately LARGE (a single eye must beat the blend by 20%
// relative, not just edge it out). Two asymmetric risks drove this, after a
// real hands-on session:
//   - Wrongly switching to one eye throws away half the available signal
//     and loses the independent-noise averaging the blend provides.
//   - Wrongly staying on 'both' costs only the modest gain a genuinely
//     better eye would have given.
// The first is clearly worse. And the measurement this decision rests on is
// noisy in practice: back-to-back calibrations in identical conditions were
// observed producing accuracy-test results 36 points apart, far exceeding
// the few-percent differences a small margin would act on. A tight margin
// would then flip the chosen eye essentially at random between sessions —
// itself a source of the inconsistency it's meant to fix. 20% only fires on
// a difference large enough to be real under that noise. Lower it only with
// evidence from a quieter measurement setup, not by intuition.
export function chooseEyeMode(calibPoints, ridgeLambda = 0.05, { margin = 0.20 } = {}) {
  const hasPerEye = calibPoints.some((p) => p.rxL != null && p.rxR != null);
  const errors = { both: looMeanError(calibPoints, ridgeLambda) };
  if (!hasPerEye) return { mode: 'both', errors, hasPerEye: false };
  errors.left = looMeanError(projectEyeMode(calibPoints, 'left'), ridgeLambda);
  errors.right = looMeanError(projectEyeMode(calibPoints, 'right'), ridgeLambda);
  let mode = 'both';
  const best = errors.left < errors.right ? 'left' : 'right';
  if (errors[best] < errors.both * (1 - margin)) mode = best;
  return { mode, errors, hasPerEye: true };
}

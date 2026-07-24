import { mean, stddev } from './mathUtils.js';
import { lstsqRidge } from './linearAlgebra.js';

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

// Fits gnorm/coefX/coefY from a set of 9(+)-point calibration samples, each
// shaped like { sx, sy, rx, ry, bH, bV } (sx/sy = target screen fraction).
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
  const coefX = lstsqRidge(zs.map(featX), col('sx'), ridgeLambda);
  const coefY = lstsqRidge(zs.map(featY), col('sy'), ridgeLambda);
  return { gnorm, coefX, coefY };
}

// Leave-one-out residuals: refits the model once per point with that point
// excluded, then measures how far the excluded point's own (rx,ry,bH,bV)
// predicts from where it was actually clicked (sx,sy). This is a genuine
// generalization check (unlike the fit's own training residual, which a
// 7-parameter model on ~9 points can nearly always drive to ~0 regardless of
// whether the fit is any good off-sample) — cheap here only because 9 points
// means 9 cheap refits, not because the method is approximate.
export function looResiduals(calibPoints, ridgeLambda = 0.05) {
  const out = [];
  for (let i = 0; i < calibPoints.length; i++) {
    const held = calibPoints[i];
    const rest = calibPoints.slice(0, i).concat(calibPoints.slice(i + 1));
    const { gnorm, coefX, coefY } = fitCalibration(rest, ridgeLambda);
    const px = applyX(held, coefX, gnorm);
    const py = applyY(held, coefY, gnorm);
    const dx = px - held.sx, dy = py - held.sy;
    out.push({ index: i, dx, dy, dist: Math.hypot(dx, dy) });
  }
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
// warrant a proactive recalibration prompt. Needs at least 4 points for LOO
// refits to be meaningful at all (below that, holding one out leaves too few
// points for the refit itself to mean anything) — real 9-point calibrations
// are always well above this floor; it only guards a pathological caller.
export function calibrationQuality(calibPoints, ridgeLambda = 0.05) {
  if (!calibPoints || calibPoints.length < 4) {
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

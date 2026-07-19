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

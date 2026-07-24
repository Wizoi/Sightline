import { describe, it, expect } from 'vitest';
import {
  fitCalibration, applyX, applyY, calibMismatch,
  looResiduals, gridSpacingThreshold, calibrationQuality,
} from './calibrationModel.js';

// The real 9-point grid used by runCalibration() in src/calibration.js.
function grid9() {
  const pts = [];
  for (const sy of [0.12, 0.5, 0.88]) for (const sx of [0.1, 0.5, 0.9]) pts.push({ sx, sy });
  return pts;
}

describe('fitCalibration + applyX/applyY', () => {
  it('recovers a near-identity mapping from synthetic 9-point data', () => {
    const grid = [];
    for (const sy of [0.12, 0.5, 0.88]) {
      for (const sx of [0.1, 0.5, 0.9]) grid.push({ sx, sy });
    }
    // rx/ry track sx/sy linearly; no blendshape signal.
    const calibPoints = grid.map(({ sx, sy }) => ({ sx, sy, rx: sx, ry: sy, bH: 0, bV: 0 }));
    const { gnorm, coefX, coefY } = fitCalibration(calibPoints);

    for (const p of calibPoints) {
      expect(applyX(p, coefX, gnorm)).toBeCloseTo(p.sx, 1);
      expect(applyY(p, coefY, gnorm)).toBeCloseTo(p.sy, 1);
    }
  });
});

describe('calibMismatch', () => {
  const base = { cam: 'cam-1', label: 'Webcam', vw: 1280, vh: 720, winW: 1000, winH: 800, dpr: 1 };

  it('reports no reasons when nothing changed', () => {
    expect(calibMismatch(base, { ...base })).toEqual([]);
  });

  it('flags a different camera', () => {
    expect(calibMismatch(base, { ...base, cam: 'cam-2' })).toContain('different camera');
  });

  it('flags a window resize beyond 5%', () => {
    const reasons = calibMismatch(base, { ...base, winW: 1200 });
    expect(reasons).toContain('window resized');
  });

  it('does not flag a small window resize under 5%', () => {
    const reasons = calibMismatch(base, { ...base, winW: 1020 });
    expect(reasons).not.toContain('window resized');
  });

  it('flags a display zoom (DPR) change', () => {
    expect(calibMismatch(base, { ...base, dpr: 1.5 })).toContain('display zoom changed');
  });

  it('can report multiple reasons at once', () => {
    const reasons = calibMismatch(base, { ...base, cam: 'cam-2', dpr: 2 });
    expect(reasons).toEqual(expect.arrayContaining(['different camera', 'display zoom changed']));
  });
});

describe('gridSpacingThreshold', () => {
  it('derives half the real 9-point grid spacing (min of the 0.4 x-gap and ~0.38 y-gap)', () => {
    const t = gridSpacingThreshold(grid9());
    expect(t).toBeCloseTo(0.19, 5); // min(0.4, 0.38) / 2
  });

  it('falls back to a conservative constant for a degenerate (non-grid) point set', () => {
    const pts = [{ sx: 0.5, sy: 0.5 }, { sx: 0.5, sy: 0.5 }, { sx: 0.5, sy: 0.5 }];
    expect(gridSpacingThreshold(pts)).toBe(0.15);
  });
});

describe('looResiduals + calibrationQuality', () => {
  it('reports near-zero LOO residuals for a clean, noise-free linear mapping', () => {
    const calibPoints = grid9().map((p) => ({ ...p, rx: p.sx, ry: p.sy, bH: 0, bV: 0 }));
    const residuals = looResiduals(calibPoints);
    expect(residuals).toHaveLength(9);
    for (const r of residuals) expect(r.dist).toBeLessThan(0.05);

    const quality = calibrationQuality(calibPoints);
    expect(quality.poor).toBe(false);
    expect(quality.poorIndices).toEqual([]);
    expect(quality.worst).toBeLessThan(quality.threshold);
  });

  it('flags a point whose gaze reading does not fit the pattern the other 8 points establish', () => {
    const calibPoints = grid9().map((p) => ({ ...p, rx: p.sx, ry: p.sy, bH: 0, bV: 0 }));
    // Corrupt one point's recorded gaze reading (as if the user glanced away
    // or a tracking glitch hit mid-capture) without changing its target.
    calibPoints[4] = { ...calibPoints[4], rx: calibPoints[4].rx + 0.4 };

    const quality = calibrationQuality(calibPoints);
    expect(quality.poor).toBe(true);
    expect(quality.poorIndices).toContain(4);
    expect(quality.worstIndex).toBe(4);
    expect(quality.worst).toBeGreaterThan(quality.threshold);
  });

  it('returns a non-poor, empty-residual result when there are too few points for LOO to mean anything', () => {
    const quality = calibrationQuality([{ sx: 0.1, sy: 0.1, rx: 0.1, ry: 0.1, bH: 0, bV: 0 }]);
    expect(quality.poor).toBe(false);
    expect(quality.residuals).toEqual([]);
  });
});

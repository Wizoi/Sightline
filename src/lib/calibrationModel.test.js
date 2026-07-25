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

// --- Many-samples-per-dot regime (item 1: feed every raw sample instead of --
// collapsing a dot's ~550ms capture to one median row) --------------------

// A small seeded PRNG (mulberry32) so these tests are fully deterministic —
// no reliance on Math.random(), no possibility of a flaky CI failure from an
// unlucky draw.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  // Box-Muller.
  const u1 = Math.max(1e-9, rng()), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Builds a many-sample-per-dot calibration set: for each of the 9 real grid
// dots, `perPoint` noisy rows sharing that dot's pointId — the shape
// runCalibration() now produces (one row per raw frame captured during the
// dot's hold, not one median-collapsed row).
function manySampleGrid(perPoint, noiseStd, seed) {
  const rng = mulberry32(seed);
  const rows = [];
  let pointId = 0;
  for (const sy of [0.12, 0.5, 0.88]) {
    for (const sx of [0.1, 0.5, 0.9]) {
      for (let i = 0; i < perPoint; i++) {
        rows.push({
          sx, sy, pointId,
          rx: sx + gaussian(rng) * noiseStd,
          ry: sy + gaussian(rng) * noiseStd,
          bH: 0, bV: 0,
        });
      }
      pointId++;
    }
  }
  return rows;
}

describe('fitCalibration on many samples per dot (pointId grouping)', () => {
  it('with exactly one row per point, is identical to the pre-existing behavior (ridge lambda unscaled)', () => {
    // rows/points === 1 -> effectiveLambda is a no-op; this just re-confirms
    // that adding `pointId` to already-singleton rows changes nothing.
    const oneEach = grid9().map((p, i) => ({ ...p, rx: p.sx, ry: p.sy, bH: 0, bV: 0, pointId: i }));
    const withIds = fitCalibration(oneEach);
    const withoutIds = fitCalibration(grid9().map((p) => ({ ...p, rx: p.sx, ry: p.sy, bH: 0, bV: 0 })));
    expect(withIds.coefX).toEqual(withoutIds.coefX);
    expect(withIds.coefY).toEqual(withoutIds.coefY);
  });

  it('recovers a near-identity mapping from many noisy samples per dot', () => {
    const rows = manySampleGrid(20, 0.02, 1);
    const { gnorm, coefX, coefY } = fitCalibration(rows);
    // Evaluate at the true (noiseless) grid locations, not the noisy training rows.
    for (const p of grid9()) {
      const clean = { ...p, rx: p.sx, ry: p.sy, bH: 0, bV: 0 };
      expect(applyX(clean, coefX, gnorm)).toBeCloseTo(p.sx, 1);
      expect(applyY(clean, coefY, gnorm)).toBeCloseTo(p.sy, 1);
    }
  });

  it('leave-one-POINT-out excludes an entire dot\'s rows per refit, not one row', () => {
    const rows = manySampleGrid(15, 0.01, 2);
    const residuals = looResiduals(rows);
    // One residual entry per distinct dot (9), not one per raw row (135).
    expect(residuals).toHaveLength(9);
  });

  it('flags a dot whose entire sample cluster is corrupted, even amid many samples', () => {
    const rows = manySampleGrid(15, 0.01, 3).map((r) => (
      r.pointId === 4 ? { ...r, rx: r.rx + 0.4 } : r
    ));
    const quality = calibrationQuality(rows);
    expect(quality.poor).toBe(true);
    expect(quality.poorIndices).toContain(4);
  });

  it('does not treat "too few raw rows" as the LOO floor once dots contribute many rows each (checks distinct dots, not row count)', () => {
    // Only 2 distinct dots, but 50 rows each -> still below the 4-dot floor.
    const rows = [
      ...Array.from({ length: 50 }, () => ({ sx: 0.1, sy: 0.1, rx: 0.1, ry: 0.1, bH: 0, bV: 0, pointId: 0 })),
      ...Array.from({ length: 50 }, () => ({ sx: 0.9, sy: 0.9, rx: 0.9, ry: 0.9, bH: 0, bV: 0, pointId: 1 })),
    ];
    const quality = calibrationQuality(rows);
    expect(quality.poor).toBe(false);
    expect(quality.residuals).toEqual([]);
  });
});

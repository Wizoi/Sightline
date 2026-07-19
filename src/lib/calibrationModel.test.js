import { describe, it, expect } from 'vitest';
import { fitCalibration, applyX, applyY, calibMismatch } from './calibrationModel.js';

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

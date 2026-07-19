import { describe, it, expect } from 'vitest';
import { solveLin, lstsqRidge } from './linearAlgebra.js';

describe('solveLin', () => {
  it('solves a simple 2x2 system', () => {
    // 2x + y = 5 ; x + 3y = 10  ->  x = 1, y = 3
    const [x, y] = solveLin([[2, 1], [1, 3]], [5, 10]);
    expect(x).toBeCloseTo(1, 8);
    expect(y).toBeCloseTo(3, 8);
  });

  it('solves an identity system', () => {
    const result = solveLin([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [7, 8, 9]);
    expect(result).toEqual([7, 8, 9]);
  });
});

describe('lstsqRidge', () => {
  it('recovers a known linear relationship with negligible regularization', () => {
    // y = 2 + 3*x1 - 1*x2, sampled exactly (no noise)
    const feats = [
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [1, 1, 1],
      [1, 2, 0],
    ];
    const ys = feats.map(([, x1, x2]) => 2 + 3 * x1 - 1 * x2);
    const coef = lstsqRidge(feats, ys, 1e-6);
    expect(coef[0]).toBeCloseTo(2, 3);
    expect(coef[1]).toBeCloseTo(3, 3);
    expect(coef[2]).toBeCloseTo(-1, 3);
  });

  it('shrinks coefficients toward zero as ridge lambda grows', () => {
    const feats = [[1, 1], [1, 2], [1, 3], [1, 4]];
    const ys = [2, 4, 6, 8]; // y = 2*x
    const light = lstsqRidge(feats, ys, 0.001);
    const heavy = lstsqRidge(feats, ys, 1000);
    expect(Math.abs(heavy[1])).toBeLessThan(Math.abs(light[1]));
  });
});

import { describe, it, expect } from 'vitest';
import { scoreOrientation, chooseRotation } from './pageRotation.js';

// A synthetic "page" with N horizontal staff-line rows spanning most of the
// width, at the given row indices.
function horizontalStaffInk(width, height, rowIndices, runFrac = 0.9) {
  const runLen = Math.round(width * runFrac);
  const rows = new Set(rowIndices);
  return (r, c) => rows.has(r) && c < runLen;
}

// A synthetic "page" with vertical strokes instead (what a page's staff lines
// look like when this rotation is wrong and they're actually running
// top-to-bottom) — never produces a long horizontal run.
function verticalStrokeInk(width, height, colIndices, runFrac = 0.9) {
  const runLen = Math.round(height * runFrac);
  const cols = new Set(colIndices);
  return (r, c) => cols.has(c) && r < runLen;
}

describe('scoreOrientation', () => {
  it('counts rows with a long horizontal ink run as staff-line-like', () => {
    const isInk = horizontalStaffInk(100, 50, [10, 11, 12, 13, 14]);
    expect(scoreOrientation(isInk, 100, 50)).toBe(5);
  });

  it('scores near zero for vertical strokes (wrong orientation)', () => {
    const isInk = verticalStrokeInk(100, 50, [10, 20, 30]);
    expect(scoreOrientation(isInk, 100, 50)).toBe(0);
  });

  it('scores zero for a blank page', () => {
    expect(scoreOrientation(() => false, 100, 50)).toBe(0);
  });
});

describe('chooseRotation', () => {
  const opts = { floor: 5, ratio: 3 };

  it('keeps the declared rotation when it already scores best', () => {
    const scores = { 0: 2, 90: 1, 180: 0, 270: 40 };
    expect(chooseRotation(scores, 270, opts)).toBe(270);
  });

  it('overrides to the convincingly-better rotation (Teutonia p.3-style case)', () => {
    // Declared 270 (wrong): staves render vertical, near-zero staff-line
    // signal. Actual upright orientation (0) scores like a real page of
    // horizontal staves.
    const scores = { 0: 30, 90: 1, 180: 2, 270: 0 };
    expect(chooseRotation(scores, 270, opts)).toBe(0);
  });

  it('does not override on a blank/cover page even if one rotation edges out the others', () => {
    // Nothing clears the floor anywhere -- a title-only page with no music.
    const scores = { 0: 1, 90: 0, 180: 2, 270: 0 };
    expect(chooseRotation(scores, 270, opts)).toBe(270);
  });

  it('does not override on a marginal difference (guards against flip-flopping)', () => {
    // Declared already reasonable; best is only slightly ahead, not a
    // convincing multiple -- ratio guard keeps the declared rotation.
    const scores = { 0: 12, 90: 1, 180: 1, 270: 10 };
    expect(chooseRotation(scores, 270, opts)).toBe(270);
  });

  it('does not override a uniformly-correct declared rotation (Fat Burger-style negative control)', () => {
    const scores = { 0: 0, 90: 1, 180: 0, 270: 35 };
    expect(chooseRotation(scores, 270, opts)).toBe(270);
  });

  it('breaks ties toward the smaller rotation value (prefers 0 over 180)', () => {
    const scores = { 0: 30, 90: 0, 180: 30, 270: 1 };
    expect(chooseRotation(scores, 270, opts)).toBe(0);
  });

  it('normalizes an out-of-range declared rotation', () => {
    const scores = { 0: 30, 90: 1, 180: 1, 270: 1 };
    expect(chooseRotation(scores, 360, opts)).toBe(0); // 360 normalizes to 0, already best
    // -90 normalizes to 270, whose score (1) is convincingly beaten by 0's (30).
    expect(chooseRotation(scores, -90, opts)).toBe(0);
  });
});

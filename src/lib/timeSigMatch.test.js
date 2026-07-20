import { describe, it, expect } from 'vitest';
import { gridSimilarity, matchDigit } from './timeSigMatch.js';

// Small block-letter-style synthetic grids, not meant to look like real
// digits -- just distinct enough shapes to test matching logic.
const SHAPE_X = [
  [1, 0, 1],
  [0, 1, 0],
  [1, 0, 1],
];
const SHAPE_O = [
  [1, 1, 1],
  [1, 0, 1],
  [1, 1, 1],
];
const SHAPE_X_NOISY = [ // SHAPE_X with one extra stray pixel
  [1, 0, 1],
  [0, 1, 0],
  [1, 1, 1],
];

describe('gridSimilarity', () => {
  it('is 1 for identical grids', () => {
    expect(gridSimilarity(SHAPE_X, SHAPE_X)).toBe(1);
  });

  it('is 0 for grids with no ink in common and some ink in each', () => {
    const a = [[1, 0], [0, 0]];
    const b = [[0, 1], [0, 0]];
    expect(gridSimilarity(a, b)).toBe(0);
  });

  it('is 0 for two all-empty grids (no union, defined as 0 not NaN)', () => {
    const empty = [[0, 0], [0, 0]];
    expect(gridSimilarity(empty, empty)).toBe(0);
  });

  it('is between 0 and 1 for a partial match', () => {
    const score = gridSimilarity(SHAPE_X, SHAPE_X_NOISY);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('throws on mismatched dimensions', () => {
    expect(() => gridSimilarity([[1]], [[1, 1]])).toThrow();
  });
});

describe('matchDigit', () => {
  it('picks the exact match over a dissimilar shape', () => {
    const result = matchDigit(SHAPE_X, { x: SHAPE_X, o: SHAPE_O });
    expect(result).toEqual({ digit: 'x', confidence: 1 });
  });

  it('picks the closest match for a noisy candidate', () => {
    const result = matchDigit(SHAPE_X_NOISY, { x: SHAPE_X, o: SHAPE_O });
    expect(result.digit).toBe('x');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(1);
  });

  it('returns null for an empty template set', () => {
    expect(matchDigit(SHAPE_X, {})).toBeNull();
  });
});

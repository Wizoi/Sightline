import { describe, it, expect } from 'vitest';
import { mean, median, stddev } from './mathUtils.js';

describe('mean', () => {
  it('averages a simple array', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  it('handles a single element', () => {
    expect(mean([7])).toBe(7);
  });
});

describe('median', () => {
  it('picks the middle of an odd-length array', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it('is unsorted-input safe', () => {
    expect(median([9, 1, 5, 3, 7])).toBe(5);
  });
  it('handles a single element', () => {
    expect(median([42])).toBe(42);
  });
});

describe('stddev', () => {
  it('is zero for a constant array', () => {
    expect(stddev([4, 4, 4])).toBe(0);
  });
  it('matches a hand-computed population stddev', () => {
    // mean 5, deviations [-2,-1,0,1,2] -> variance 2 -> stddev sqrt(2)
    expect(stddev([3, 4, 5, 6, 7])).toBeCloseTo(Math.sqrt(2), 10);
  });
  it('does not divide by zero for an empty array', () => {
    expect(Number.isFinite(stddev([]))).toBe(true);
  });
});

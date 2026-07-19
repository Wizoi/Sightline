import { describe, it, expect } from 'vitest';
import { clusterVals, kmeans2 } from './clustering.js';

describe('clusterVals', () => {
  it('keeps close values in one cluster', () => {
    expect(clusterVals([1, 2, 3], 2)).toEqual([[1, 2, 3]]);
  });
  it('splits on gaps larger than the cutoff', () => {
    expect(clusterVals([1, 2, 3, 20, 21, 22], 5)).toEqual([[1, 2, 3], [20, 21, 22]]);
  });
  it('handles a single value', () => {
    expect(clusterVals([10], 2)).toEqual([[10]]);
  });
  it('splits every value apart when the cutoff is zero and gaps exist', () => {
    expect(clusterVals([1, 3, 5], 1)).toEqual([[1], [3], [5]]);
  });
});

describe('kmeans2', () => {
  it('separates two well-separated clumps', () => {
    const [lo, hi] = kmeans2([1, 1.1, 0.9, 10, 10.2, 9.8]);
    expect(lo).toBeCloseTo(1, 1);
    expect(hi).toBeCloseTo(10, 1);
  });
  it('collapses to the same value when all inputs are equal', () => {
    expect(kmeans2([5, 5, 5])).toEqual([5, 5]);
  });
});

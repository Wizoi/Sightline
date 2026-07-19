import { describe, it, expect } from 'vitest';
import { pageSystems } from './systemDetection.js';

describe('pageSystems', () => {
  it('returns nothing/identity for fewer than 2 line rows', () => {
    expect(pageSystems([])).toEqual([]);
    expect(pageSystems([5])).toEqual([5]);
  });

  it('treats evenly-spaced single staves as separate systems (single-staff part)', () => {
    // Three solo staves (5 lines each), evenly spaced apart -> no bracing pattern
    // to detect, so each staff should stay its own system.
    const rows = [
      0, 2, 4, 6, 8,        // staff 1, center 4
      24, 26, 28, 30, 32,   // staff 2, center 28
      48, 50, 52, 54, 56,   // staff 3, center 52
    ];
    expect(pageSystems(rows)).toEqual([4, 28, 52]);
  });

  it('groups braced multi-staff systems consistently (full score)', () => {
    // Two systems, each with two braced staves close together, and a much
    // bigger gap between systems -> should merge each pair into one system.
    const rows = [
      0, 2, 4, 6, 8,          // system A, staff 1, center 4
      14, 16, 18, 20, 22,     // system A, staff 2, center 18
      54, 56, 58, 60, 62,     // system B, staff 1, center 58
      68, 70, 72, 74, 76,     // system B, staff 2, center 72
    ];
    expect(pageSystems(rows)).toEqual([11, 65]);
  });

  it('falls back to per-staff systems when grouping is inconsistent', () => {
    // Three staves where the gaps don't fall into a consistent bimodal
    // (bracing vs. system) pattern -> no safe grouping, one system per staff.
    const rows = [
      0, 2, 4, 6, 8,          // center 4
      20, 22, 24, 26, 28,     // center 24 (gap 20 from previous)
      35, 37, 39, 41, 43,     // center 39 (gap 15 from previous)
    ];
    const result = pageSystems(rows);
    expect(result).toEqual([4, 24, 39]);
  });
});

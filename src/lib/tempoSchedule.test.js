import { describe, it, expect } from 'vitest';
import { buildSchedule, systemIndexAtElapsed, progressWithinSystem, nearestSystemIndex } from './tempoSchedule.js';

// measures [2,3,1], 4/4 @ 120bpm (0.5s/beat) -> durations 4s, 6s, 2s -> starts 0,4,10 -> total 12
function sampleSchedule() {
  return buildSchedule({ measuresPerSystem: [2, 3, 1], beatsPerMeasure: 4, bpm: 120 });
}

describe('buildSchedule', () => {
  it('computes per-system start/duration/end and a total duration', () => {
    const s = sampleSchedule();
    expect(s.systems).toEqual([
      { index: 0, measures: 2, duration: 4, start: 0, end: 4 },
      { index: 1, measures: 3, duration: 6, start: 4, end: 10 },
      { index: 2, measures: 1, duration: 2, start: 10, end: 12 },
    ]);
    expect(s.totalDuration).toBe(12);
  });

  it('scales duration inversely with bpm', () => {
    const slow = buildSchedule({ measuresPerSystem: [1], beatsPerMeasure: 4, bpm: 60 });
    const fast = buildSchedule({ measuresPerSystem: [1], beatsPerMeasure: 4, bpm: 120 });
    expect(slow.systems[0].duration).toBeCloseTo(fast.systems[0].duration * 2, 8);
  });

  it('handles an empty schedule', () => {
    const s = buildSchedule({ measuresPerSystem: [], beatsPerMeasure: 4, bpm: 120 });
    expect(s.systems).toEqual([]);
    expect(s.totalDuration).toBe(0);
  });
});

describe('systemIndexAtElapsed', () => {
  const s = sampleSchedule();
  it('returns 0 at or before the start', () => {
    expect(systemIndexAtElapsed(s, 0)).toBe(0);
    expect(systemIndexAtElapsed(s, -1)).toBe(0);
  });
  it('finds the system whose [start, end) window contains t', () => {
    expect(systemIndexAtElapsed(s, 3.9)).toBe(0);
    expect(systemIndexAtElapsed(s, 4)).toBe(1);
    expect(systemIndexAtElapsed(s, 9.9)).toBe(1);
    expect(systemIndexAtElapsed(s, 10)).toBe(2);
  });
  it('clamps to the last system once elapsed exceeds the total duration', () => {
    expect(systemIndexAtElapsed(s, 999)).toBe(2);
  });
  it('returns -1 for an empty schedule', () => {
    expect(systemIndexAtElapsed(buildSchedule({ measuresPerSystem: [], beatsPerMeasure: 4, bpm: 120 }), 0)).toBe(-1);
  });
});

describe('progressWithinSystem', () => {
  const s = sampleSchedule();
  it('reports fractional progress through the current system', () => {
    expect(progressWithinSystem(s, 2)).toEqual({ index: 0, progress: 0.5 });
    expect(progressWithinSystem(s, 4)).toEqual({ index: 1, progress: 0 });
  });
  it('clamps progress to 1 once past the end (does not overshoot)', () => {
    expect(progressWithinSystem(s, 999)).toEqual({ index: 2, progress: 1 });
  });
  it('reports progress 1 (not NaN) for a zero-duration system', () => {
    const degenerate = { systems: [{ index: 0, start: 0, end: 0, duration: 0 }], totalDuration: 0 };
    expect(progressWithinSystem(degenerate, 0)).toEqual({ index: 0, progress: 1 });
  });
});

describe('nearestSystemIndex', () => {
  it('finds the closest system center to a scroll position', () => {
    const centers = [100, 300, 500];
    expect(nearestSystemIndex(centers, 250)).toBe(1);
    expect(nearestSystemIndex(centers, 0)).toBe(0);
    expect(nearestSystemIndex(centers, 500)).toBe(2);
  });
  it('returns 0 for an empty list', () => {
    expect(nearestSystemIndex([], 250)).toBe(0);
  });
});

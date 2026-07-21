import { describe, it, expect } from 'vitest';
import { buildSchedule, systemIndexAtElapsed, progressWithinSystem, nearestSystemIndex, beatTimestamps, nearestBeatTime, resolveBpmPerSystem } from './tempoSchedule.js';

// measures [2,3,1], 4/4 @ 120bpm (0.5s/beat) -> durations 4s, 6s, 2s -> starts 0,4,10 -> total 12
function sampleSchedule() {
  return buildSchedule({ measuresPerSystem: [2, 3, 1], beatsPerMeasure: 4, bpm: 120 });
}

describe('buildSchedule', () => {
  it('computes per-system start/duration/end and a total duration', () => {
    const s = sampleSchedule();
    expect(s.systems).toEqual([
      { index: 0, measures: 2, duration: 4, start: 0, end: 4, bpm: 120 },
      { index: 1, measures: 3, duration: 6, start: 4, end: 10, bpm: 120 },
      { index: 2, measures: 1, duration: 2, start: 10, end: 12, bpm: 120 },
    ]);
    expect(s.totalDuration).toBe(12);
  });

  it('gives each system its own tempo from bpmPerSystem, changing durations mid-piece', () => {
    // measures [4,4], 4/4; system 0 @ 60bpm (1s/beat -> 16s), system 1 @ 120bpm (0.5s/beat -> 8s)
    const s = buildSchedule({ measuresPerSystem: [4, 4], beatsPerMeasure: 4, bpm: 100, bpmPerSystem: [60, 120] });
    expect(s.systems[0]).toMatchObject({ duration: 16, start: 0, end: 16, bpm: 60 });
    expect(s.systems[1]).toMatchObject({ duration: 8, start: 16, end: 24, bpm: 120 });
    expect(s.totalDuration).toBe(24);
  });

  it('falls back to flat bpm for systems missing a bpmPerSystem entry', () => {
    const s = buildSchedule({ measuresPerSystem: [1, 1], beatsPerMeasure: 4, bpm: 60, bpmPerSystem: [120] });
    expect(s.systems[0].bpm).toBe(120); // has an entry
    expect(s.systems[1].bpm).toBe(60);  // missing -> flat bpm
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

describe('resolveBpmPerSystem', () => {
  it('carries each printed tempo mark forward until the next one', () => {
    // marks: ♩=86 at system 0, ♩=128 at system 1 -> [86, 128, 128, 128]
    expect(resolveBpmPerSystem(4, { 0: 86, 1: 128 }, 100)).toEqual([86, 128, 128, 128]);
  });
  it('uses the base bpm for systems before the first mark', () => {
    // first mark at system 2 -> systems 0,1 use base 100, then 140 onward
    expect(resolveBpmPerSystem(4, { 2: 140 }, 100)).toEqual([100, 100, 140, 140]);
  });
  it('returns the flat base bpm when there are no marks', () => {
    expect(resolveBpmPerSystem(3, {}, 100)).toEqual([100, 100, 100]);
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

describe('beatTimestamps', () => {
  it('produces one timestamp per beat, evenly spaced within each system', () => {
    const s = sampleSchedule(); // measures [2,3,1], 4/4 @ 120bpm -> 0.5s/beat throughout
    const beats = beatTimestamps(s, 4);
    expect(beats.length).toBe(2 * 4 + 3 * 4 + 1 * 4); // 24
    expect(beats[0]).toBe(0);
    expect(beats[1]).toBeCloseTo(0.5, 8);
    // first beat of system 1 (index 8) should land exactly on system 1's start (4)
    expect(beats[8]).toBeCloseTo(4, 8);
    // first beat of system 2 (index 20) should land exactly on system 2's start (10)
    expect(beats[20]).toBeCloseTo(10, 8);
  });

  it('skips systems with zero beats instead of producing garbage entries', () => {
    const s = buildSchedule({ measuresPerSystem: [0, 2], beatsPerMeasure: 4, bpm: 120 });
    const beats = beatTimestamps(s, 4);
    expect(beats.length).toBe(8);
  });

  it('returns an empty list for an empty schedule', () => {
    const s = buildSchedule({ measuresPerSystem: [], beatsPerMeasure: 4, bpm: 120 });
    expect(beatTimestamps(s, 4)).toEqual([]);
  });
});

describe('nearestBeatTime', () => {
  const beats = [0, 0.5, 1, 1.5, 2];
  it('finds the closest beat timestamp', () => {
    expect(nearestBeatTime(beats, 0.74)).toBe(0.5);
    expect(nearestBeatTime(beats, 0.76)).toBe(1);
    expect(nearestBeatTime(beats, -1)).toBe(0);
    expect(nearestBeatTime(beats, 10)).toBe(2);
  });
  it('returns null for an empty list', () => {
    expect(nearestBeatTime([], 1)).toBeNull();
  });
});

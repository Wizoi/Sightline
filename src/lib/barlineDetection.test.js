import { describe, it, expect } from 'vitest';
import { countBarlines, estimateMeasureCount } from './barlineDetection.js';

const BAND = 100; // bandHeight; default minFrac 0.95 -> need >= 95

function columns(len, peaks, peakHeight = 100, baseline = 5) {
  const a = new Array(len).fill(baseline);
  for (const c of peaks) a[c] = peakHeight;
  return a;
}

describe('countBarlines', () => {
  it('finds zero barlines when nothing spans the band', () => {
    expect(countBarlines(columns(50, []), BAND)).toBe(0);
  });

  it('counts clearly separated full-height strokes', () => {
    const cols = columns(50, [10, 25, 40]);
    expect(countBarlines(cols, BAND)).toBe(3);
  });

  it('merges adjacent columns (one thick/anti-aliased stroke) into a single barline', () => {
    const cols = columns(50, [10, 11]);
    expect(countBarlines(cols, BAND)).toBe(1);
  });

  it('does not merge columns further apart than mergeGap', () => {
    const cols = columns(50, [10, 13]); // gap of 3, default mergeGap is 2
    expect(countBarlines(cols, BAND)).toBe(2);
  });

  it('ignores runs that fall short of the height threshold', () => {
    const cols = columns(50, []);
    cols[20] = 80; // below the default 0.95 * 100 = 95 requirement
    expect(countBarlines(cols, BAND)).toBe(0);
  });

  it('respects a custom minFrac/mergeGap', () => {
    const cols = columns(50, []);
    cols[20] = 80;
    expect(countBarlines(cols, BAND, { minFrac: 0.75 })).toBe(1);

    const wide = columns(50, [10, 14]);
    expect(countBarlines(wide, BAND, { mergeGap: 5 })).toBe(1);
  });

  it('does not mistake dense note-stem/accent ink for barlines (regression)', () => {
    // Found on a real, densely-notated mixed-meter passage: note stems,
    // accents, and staccato dots can reach 80-91% of the band height --
    // tall, but a genuine barline reaches the *full* band, not just most
    // of it. The default 0.95 threshold (raised from 0.85) is specifically
    // there to keep these out while still catching real barlines.
    const cols = new Array(50).fill(5);
    [12, 18, 25, 33, 41].forEach((c) => { cols[c] = 88; }); // stems/accents, not barlines
    [10, 30, 45].forEach((c) => { cols[c] = 100; }); // genuine full-height barlines
    expect(countBarlines(cols, BAND)).toBe(3);
  });
});

describe('estimateMeasureCount', () => {
  it('falls back to 1 measure when no barlines are detected', () => {
    expect(estimateMeasureCount(columns(50, []), BAND)).toBe(1);
  });

  it('matches the barline count when barlines are found', () => {
    expect(estimateMeasureCount(columns(50, [10, 25, 40]), BAND)).toBe(3);
  });
});

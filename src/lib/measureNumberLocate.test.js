import { describe, it, expect } from 'vitest';
import { locateMeasureNumber } from './measureNumberLocate.js';

// isInk from a set of filled rectangles { r0, r1, c0, c1 } (inclusive).
function inkFrom(rects) {
  return (r, c) => rects.some((k) => r >= k.r0 && r <= k.r1 && c >= k.c0 && c <= k.c1);
}

describe('locateMeasureNumber', () => {
  // staff top at row 40, staff 20px tall, page 100px wide.
  const base = { systemTop: 40, staffHeight: 20, width: 100 };

  it('boxes the number and excludes a note to its right', () => {
    const isInk = inkFrom([
      { r0: 20, r1: 28, c0: 2, c1: 8 },    // number: above the staff, far left
      { r0: 36, r1: 46, c0: 12, c1: 18 },  // note: at staff level, further right
    ]);
    expect(locateMeasureNumber(isInk, base)).toEqual({ x0: 2, y0: 20, x1: 9, y1: 28 });
  });

  it('stops at the gap before a note directly below the number (same columns)', () => {
    const isInk = inkFrom([
      { r0: 20, r1: 28, c0: 2, c1: 8 },  // number
      { r0: 35, r1: 45, c0: 2, c1: 8 },  // note below, same columns, gap of rows between
    ]);
    expect(locateMeasureNumber(isInk, base).y1).toBe(28); // did not reach the note
  });

  it('captures a two-digit number as one box', () => {
    const isInk = inkFrom([
      { r0: 20, r1: 28, c0: 2, c1: 6 },    // first digit
      { r0: 20, r1: 28, c0: 8, c1: 12 },   // second digit, small gap
    ]);
    const box = locateMeasureNumber(isInk, base);
    expect(box.x0).toBe(2);
    expect(box.x1).toBe(13); // spans both digits
  });

  it('returns null when the band above the staff is empty', () => {
    expect(locateMeasureNumber(inkFrom([{ r0: 50, r1: 60, c0: 2, c1: 8 }]), base)).toBeNull();
  });
});

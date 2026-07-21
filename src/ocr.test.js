import { describe, it, expect } from 'vitest';
import { bboxToPoint } from './ocr.js';

describe('bboxToPoint', () => {
  // A page 600pt wide rendered onto a 2400px canvas -> pxPerPt = 4.
  const pxPerPt = 4, pageHeightPts = 800;

  it('maps a bbox center to PDF points, flipping the y axis', () => {
    // bbox center at canvas (200, 400) -> x = 50pt; y = 800 - 100 = 700pt.
    expect(bboxToPoint({ x0: 180, y0: 380, x1: 220, y1: 420 }, pxPerPt, pageHeightPts))
      .toEqual({ x: 50, y: 700 });
  });

  it('puts a mark near the page top at a high y (text-layer convention)', () => {
    // near the top of the canvas (small canvas-y) -> large PDF y (near page top).
    const p = bboxToPoint({ x0: 0, y0: 0, x1: 40, y1: 40 }, pxPerPt, pageHeightPts);
    expect(p.y).toBeCloseTo(800 - 5, 6); // center y=20px -> 5pt from top -> 795pt
  });

  it('puts a mark near the page bottom at a low y', () => {
    const p = bboxToPoint({ x0: 0, y0: 3160, x1: 40, y1: 3200 }, pxPerPt, pageHeightPts);
    expect(p.y).toBeCloseTo(800 - 795, 6); // center y=3180px -> 795pt from top -> 5pt
  });
});

import { describe, it, expect } from 'vitest';
import { regionAt, halfHeightFrom, pinchScale, EDGE_PX } from './bandGeometry.js';

// A band 200px tall sitting mid-screen, as getBoundingClientRect would give it.
const rect = (top, height) => ({ top, height, bottom: top + height });

describe('regionAt', () => {
  const r = rect(300, 200);

  it('reports the middle away from either edge', () => {
    expect(regionAt(400, r)).toBe('middle');
  });

  it('reports the edge you are actually on, not the nearest one', () => {
    expect(regionAt(302, r)).toBe('top');
    expect(regionAt(498, r)).toBe('bottom');
  });

  it('treats the edge zone as inclusive at its boundary', () => {
    expect(regionAt(300 + EDGE_PX, r)).toBe('top');
    expect(regionAt(300 + EDGE_PX + 1, r)).toBe('middle');
  });

  // The reading zone slider goes down to 4% of viewport height, which on a
  // short screen is a band thinner than two 16px edge zones. Without the
  // thin-band split those zones would overlap and whichever is tested first
  // would win everywhere, making one edge impossible to grab.
  it('splits a band too thin to have a middle into two reachable halves', () => {
    const thin = rect(300, 20);
    expect(regionAt(303, thin)).toBe('top');
    expect(regionAt(317, thin)).toBe('bottom');
    expect(regionAt(305, thin)).not.toBe(regionAt(315, thin));
  });
});

describe('halfHeightFrom', () => {
  it('measures from the band centre, since the band is centred on bandPos', () => {
    // Centre at 0.5*1000 = 500; dragging the bottom edge to 620 -> 120px half-height.
    expect(halfHeightFrom(620, 1000, 0.5)).toBeCloseTo(0.12, 6);
  });

  it('gives the same size for either edge at the same distance', () => {
    expect(halfHeightFrom(380, 1000, 0.5)).toBeCloseTo(halfHeightFrom(620, 1000, 0.5), 6);
  });

  it('mirrors rather than going negative when dragged past the centre', () => {
    expect(halfHeightFrom(400, 1000, 0.5)).toBeCloseTo(0.1, 6);
  });

  it('follows bandPos when the band is not centred on screen', () => {
    expect(halfHeightFrom(300, 1000, 0.2)).toBeCloseTo(0.1, 6);
  });
});

describe('pinchScale', () => {
  it('scales proportionally with finger spread', () => {
    expect(pinchScale(100, 150)).toBeCloseTo(1.5, 6);
    expect(pinchScale(100, 50)).toBeCloseTo(0.5, 6);
  });

  it('is a no-op while the spread is unchanged', () => {
    expect(pinchScale(100, 100)).toBe(1);
  });

  // Two fingers landing almost on top of each other give a divisor near zero,
  // which would turn any subsequent movement into an enormous ratio and snap
  // the band straight to its maximum.
  it('ignores a pinch that starts with the fingers together', () => {
    expect(pinchScale(3, 300)).toBe(1);
    expect(pinchScale(0, 300)).toBe(1);
  });
});

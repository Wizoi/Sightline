import { describe, it, expect } from 'vitest';
import {
  pursuitTarget, segmentIndexAt, buildPursuitCalibPoints, fitPursuitCalibration, estimateLag,
  DEFAULT_DURATION_SEC, DEFAULT_SEGMENTS, CX, CY, AX, AY,
} from './pursuitCalibration.js';
import { applyX, applyY, fitCalibration } from './calibrationModel.js';

// Deterministic PRNG (mulberry32) — no reliance on Math.random(), no flaky CI.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u1 = Math.max(1e-9, rng()), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

describe('pursuitTarget', () => {
  it('stays within the safe grid margins over the whole sweep', () => {
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * DEFAULT_DURATION_SEC;
      const { x, y } = pursuitTarget(t, DEFAULT_DURATION_SEC);
      expect(x).toBeGreaterThanOrEqual(CX - AX - 1e-9);
      expect(x).toBeLessThanOrEqual(CX + AX + 1e-9);
      expect(y).toBeGreaterThanOrEqual(CY - AY - 1e-9);
      expect(y).toBeLessThanOrEqual(CY + AY + 1e-9);
    }
  });

  it('clamps outside [0, durationSec] rather than extrapolating', () => {
    const atZero = pursuitTarget(0, DEFAULT_DURATION_SEC);
    expect(pursuitTarget(-5, DEFAULT_DURATION_SEC)).toEqual(atZero);
    const atEnd = pursuitTarget(DEFAULT_DURATION_SEC, DEFAULT_DURATION_SEC);
    expect(pursuitTarget(DEFAULT_DURATION_SEC + 5, DEFAULT_DURATION_SEC)).toEqual(atEnd);
  });
});

describe('segmentIndexAt', () => {
  it('divides the sweep into equal-width, in-range segment indices', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const t = (i / 1000) * DEFAULT_DURATION_SEC;
      const seg = segmentIndexAt(t, DEFAULT_DURATION_SEC, DEFAULT_SEGMENTS);
      expect(seg).toBeGreaterThanOrEqual(0);
      expect(seg).toBeLessThan(DEFAULT_SEGMENTS);
      seen.add(seg);
    }
    expect(seen.size).toBe(DEFAULT_SEGMENTS); // every segment gets covered
  });

  it('is monotonically non-decreasing over time (no segment "goes backward")', () => {
    let last = -1;
    for (let i = 0; i < 500; i++) {
      const t = (i / 500) * DEFAULT_DURATION_SEC;
      const seg = segmentIndexAt(t, DEFAULT_DURATION_SEC, DEFAULT_SEGMENTS);
      expect(seg).toBeGreaterThanOrEqual(last);
      last = seg;
    }
  });
});

// A simple, invertible "true" gaze-feature model used only to generate
// synthetic samples: rx/ry track sx/sy linearly (no blendshape signal),
// exactly like the existing fitCalibration synthetic test in
// calibrationModel.test.js. This isolates the lag-search behavior from the
// separate question of how well the quadratic ridge fit itself recovers a
// mapping (already covered by that other test).
function trueRxRy(sx, sy) { return { rx: 2 * (sx - 0.5), ry: 2 * (sy - 0.5) }; }

// Generates synthetic pursuit samples where the MEASURED gaze at capture
// time tSec reflects the target's position `trueLagSec` in the PAST — i.e.
// simulates a real smooth-pursuit lag — plus independent per-sample noise.
function simulatePursuit(trueLagSec, noiseStd, seed, { durationSec = DEFAULT_DURATION_SEC, hz = 30 } = {}) {
  const rng = mulberry32(seed);
  const samples = [];
  const dt = 1 / hz;
  for (let tSec = 0; tSec <= durationSec; tSec += dt) {
    const followedT = tSec - trueLagSec;
    if (followedT < 0) continue; // eye hasn't started tracking a target that doesn't exist yet
    const { x, y } = pursuitTarget(followedT, durationSec);
    const { rx, ry } = trueRxRy(x, y);
    samples.push({ tSec, rx: rx + gaussian(rng) * noiseStd, ry: ry + gaussian(rng) * noiseStd, bH: 0, bV: 0 });
  }
  return samples;
}

describe('buildPursuitCalibPoints', () => {
  it('drops samples whose lag-shifted target would fall outside the sweep', () => {
    const samples = [{ tSec: 0.02, rx: 0, ry: 0, bH: 0, bV: 0 }];
    // A 0.1s lag hypothesis on a sample captured at tSec=0.02 implies a
    // target at t=-0.08 -- outside the sweep, so it should be dropped.
    expect(buildPursuitCalibPoints(samples, DEFAULT_DURATION_SEC, 0.1)).toEqual([]);
  });

  it('tags each row with a pointId matching its (lag-shifted) time segment', () => {
    const samples = [{ tSec: 5, rx: 0, ry: 0, bH: 0, bV: 0 }];
    const rows = buildPursuitCalibPoints(samples, DEFAULT_DURATION_SEC, 0, DEFAULT_SEGMENTS);
    expect(rows).toHaveLength(1);
    expect(rows[0].pointId).toBe(segmentIndexAt(5, DEFAULT_DURATION_SEC, DEFAULT_SEGMENTS));
  });
});

describe('estimateLag — cross-correlation lag recovery', () => {
  it('recovers zero lag when there is none', () => {
    const samples = simulatePursuit(0, 0.02, 1);
    const est = estimateLag(samples);
    expect(est).not.toBeNull();
    expect(est.lagSec).toBeCloseTo(0, 5);
  });

  it('recovers a lag close to the true, nonzero smooth-pursuit lag from noisy samples', () => {
    const trueLag = 0.15;
    const samples = simulatePursuit(trueLag, 0.02, 2);
    const est = estimateLag(samples);
    expect(est).not.toBeNull();
    expect(est.lagSec).toBeCloseTo(trueLag, 5);
  });

  it('the correlation score peaks at the true lag, falling off on both sides (not a plateau/tie)', () => {
    const trueLag = 0.15;
    const samples = simulatePursuit(trueLag, 0.02, 2);
    const scoreAt = (lagSec) => estimateLag(samples, DEFAULT_DURATION_SEC, [lagSec]).score;
    const atTrueLag = scoreAt(0.15);
    expect(atTrueLag).toBeGreaterThan(scoreAt(0));
    expect(atTrueLag).toBeGreaterThan(scoreAt(0.3));
    expect(atTrueLag).toBeGreaterThan(scoreAt(0.1));
    expect(atTrueLag).toBeGreaterThan(scoreAt(0.2));
  });
});

describe('fitPursuitCalibration — end-to-end fit, and the naive-implementation trap this avoids', () => {
  it('recovers the correct lag and a usable fit with realistic noise and a real lag', () => {
    const samples = simulatePursuit(0.15, 0.02, 2);
    const result = fitPursuitCalibration(samples);
    expect(result).not.toBeNull();
    expect(result.lagSec).toBeCloseTo(0.15, 5);
    expect(result.coefX).toHaveLength(7);
    expect(result.coefY).toHaveLength(7);
  });

  // Documents a real, evidence-based limitation found while building this
  // (not desired behavior — a "regression pin" so it stays a known, visible
  // fact rather than silently-forgotten technical debt): reusing item 1's
  // leave-one-out philosophy unchanged for a CONTINUOUS trajectory (holding
  // out a whole time-segment, i.e. a contiguous arc of screen positions, not
  // a single repeated discrete dot) tends to flag even a fit that is
  // genuinely GOOD by an independent held-out-accuracy measure (see the
  // "measurably degrades... vs the correlation-estimated lag" test below,
  // which scores this exact kind of fit well) as "poor." This isn't a
  // threshold-tuning problem — it persisted across a wide range of segment
  // counts (3-10) when this was investigated. The likely cause: unlike the
  // 9-dot grid (where the 8 remaining points after holding one out still
  // surround it from every side), holding out one arc of a Lissajous
  // trajectory with only ~1-1.5 pattern repeats over 10s can remove the ONLY
  // near-visit to a particular screen region (e.g. a corner), turning the
  // "held-out" evaluation into extrapolation rather than interpolation. See
  // this module's top-of-file doc comment and the Gaze/Applied-Math persona
  // docs for the honest state of this: `pursuitQuality`/`looResiduals` are
  // kept as diagnostics for future research, but deliberately NOT wired to
  // any user-facing "recalibrate" gate the way the 9-dot flow's
  // calibrationQuality is, specifically because of this finding.
  it('[known limitation] LOO-based quality over-flags even a fit that independently scores well as "poor"', () => {
    const samples = simulatePursuit(0.15, 0.02, 2);
    const result = fitPursuitCalibration(samples);
    expect(result.quality.poor).toBe(true);
  });

  it('a wrong (naive, unlagged) assumption measurably degrades held-out accuracy vs. the correlation-estimated lag', () => {
    const trueLag = 0.2;
    const samples = simulatePursuit(trueLag, 0.02, 3);
    const searched = fitPursuitCalibration(samples);
    const naiveRows = buildPursuitCalibPoints(samples, DEFAULT_DURATION_SEC, 0);
    const naiveFit = fitCalibration(naiveRows);
    expect(searched).not.toBeNull();

    // Score both models against fresh, independently-sampled held-out points
    // along the TRUE trajectory -- the real question is "does this model map
    // a genuine future gaze reading back to the right screen position," not
    // just its own training residual.
    const rngEval = mulberry32(999);
    let sqSearched = 0, sqNaive = 0, n = 0;
    for (let i = 0; i < 60; i++) {
      const t = (i / 60) * DEFAULT_DURATION_SEC;
      const { x: sx, y: sy } = pursuitTarget(t, DEFAULT_DURATION_SEC);
      const { rx, ry } = trueRxRy(sx, sy);
      const sample = { rx: rx + gaussian(rngEval) * 0.02, ry: ry + gaussian(rngEval) * 0.02, bH: 0, bV: 0 };
      const dxS = applyX(sample, searched.coefX, searched.gnorm) - sx;
      const dyS = applyY(sample, searched.coefY, searched.gnorm) - sy;
      const dxN = applyX(sample, naiveFit.coefX, naiveFit.gnorm) - sx;
      const dyN = applyY(sample, naiveFit.coefY, naiveFit.gnorm) - sy;
      sqSearched += dxS * dxS + dyS * dyS;
      sqNaive += dxN * dxN + dyN * dyN;
      n++;
    }
    const rmsSearched = Math.sqrt(sqSearched / n), rmsNaive = Math.sqrt(sqNaive / n);
    expect(rmsSearched).toBeLessThan(rmsNaive);
  });

  it('returns null when there are too few usable samples to fit at all', () => {
    expect(fitPursuitCalibration([{ tSec: 0, rx: 0, ry: 0, bH: 0, bV: 0 }])).toBeNull();
  });
});

describe('pursuitTarget: center start + speed ramp (real-user findings, 2026-07-25)', () => {
  const D = DEFAULT_DURATION_SEC;

  it('starts the sweep at dead center, so it continues from where the stationary lead-in left the eye', () => {
    const p = pursuitTarget(0, D);
    expect(p.x).toBeCloseTo(CX, 6);
    expect(p.y).toBeCloseTo(CY, 6);
  });

  it('regression: does NOT teleport to the bottom of the safe band at t=0 (the pre-fix PHASE=PI/2 behavior jumped 0.38 of screen height, forcing a catch-up saccade exactly when sampling began)', () => {
    expect(Math.abs(pursuitTarget(0, D).y - CY)).toBeLessThan(0.01);
  });

  it('ramps speed up: the target moves slower early in the sweep than at full speed later', () => {
    const speedAt = (t) => {
      const a = pursuitTarget(t, D), b = pursuitTarget(t + 0.05, D);
      return Math.hypot(b.x - a.x, b.y - a.y) / 0.05;
    };
    expect(speedAt(0.2)).toBeLessThan(speedAt(1.5));
    expect(speedAt(1.5)).toBeLessThan(speedAt(6));
  });

  it('still completes a full sweep and covers the whole safe band despite the ramp eating trajectory time', () => {
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (let t = 0; t <= D; t += 0.01) {
      const q = pursuitTarget(t, D);
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    expect(minX).toBeCloseTo(CX - AX, 2);
    expect(maxX).toBeCloseTo(CX + AX, 2);
    expect(minY).toBeCloseTo(CY - AY, 2);
    expect(maxY).toBeCloseTo(CY + AY, 2);
  });
});

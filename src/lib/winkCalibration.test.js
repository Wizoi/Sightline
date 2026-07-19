import { describe, it, expect } from 'vitest';
import { deriveWinkThresholds, isUsableCalibration } from './winkCalibration.js';

describe('deriveWinkThresholds', () => {
  it('derives sensible thresholds from real-world-shaped data', () => {
    // Roughly matches an observed real session: rest ~0.10 both eyes,
    // left wink peaked 0.35 (other eye 0.21), right wink peaked 0.59 (other 0.32).
    const sample = {
      restLeft: 0.10, restRight: 0.10,
      leftPeakOwn: 0.35, leftPeakOther: 0.21,
      rightPeakOwn: 0.59, rightPeakOther: 0.32,
    };
    const { closedThreshold, gapThreshold } = deriveWinkThresholds(sample);
    expect(closedThreshold).toBeCloseTo(0.20, 5);
    expect(gapThreshold).toBeCloseTo(0.07, 5);
    // and the result should actually separate rest from both eyes' winks
    expect(closedThreshold).toBeGreaterThan(Math.max(sample.restLeft, sample.restRight));
    expect(closedThreshold).toBeLessThan(Math.min(sample.leftPeakOwn, sample.rightPeakOwn));
  });

  it('clamps closedThreshold to a sane floor for a very weak signal', () => {
    const sample = {
      restLeft: 0.05, restRight: 0.05,
      leftPeakOwn: 0.10, leftPeakOther: 0.02,
      rightPeakOwn: 0.10, rightPeakOther: 0.02,
    };
    const { closedThreshold } = deriveWinkThresholds(sample);
    expect(closedThreshold).toBeGreaterThanOrEqual(0.15); // MIN_CLOSED
  });

  it('clamps gapThreshold to a sane ceiling for a very clean, large-gap signal', () => {
    const sample = {
      restLeft: 0.05, restRight: 0.05,
      leftPeakOwn: 0.9, leftPeakOther: 0.05,
      rightPeakOwn: 0.9, rightPeakOther: 0.05,
    };
    const { gapThreshold } = deriveWinkThresholds(sample);
    expect(gapThreshold).toBeLessThanOrEqual(0.25); // MAX_GAP
  });

  it('is symmetric with respect to which eye is stronger', () => {
    const strongerLeft = deriveWinkThresholds({
      restLeft: 0.1, restRight: 0.1, leftPeakOwn: 0.6, leftPeakOther: 0.2, rightPeakOwn: 0.35, rightPeakOther: 0.15,
    });
    const strongerRight = deriveWinkThresholds({
      restLeft: 0.1, restRight: 0.1, leftPeakOwn: 0.35, leftPeakOther: 0.15, rightPeakOwn: 0.6, rightPeakOther: 0.2,
    });
    expect(strongerLeft.closedThreshold).toBeCloseTo(strongerRight.closedThreshold, 5);
    expect(strongerLeft.gapThreshold).toBeCloseTo(strongerRight.gapThreshold, 5);
  });
});

describe('isUsableCalibration', () => {
  it('accepts a clean, well-separated sample', () => {
    expect(isUsableCalibration({
      restLeft: 0.1, restRight: 0.1,
      leftPeakOwn: 0.35, leftPeakOther: 0.21,
      rightPeakOwn: 0.59, rightPeakOther: 0.32,
    })).toBe(true);
  });

  it('rejects a sample where a wink never really separated from the other eye', () => {
    expect(isUsableCalibration({
      restLeft: 0.1, restRight: 0.1,
      leftPeakOwn: 0.3, leftPeakOther: 0.28, // gap 0.02, too small
      rightPeakOwn: 0.6, rightPeakOther: 0.2,
    })).toBe(false);
  });

  it('rejects a sample where an eye barely rose at all (likely never winked)', () => {
    expect(isUsableCalibration({
      restLeft: 0.1, restRight: 0.1,
      leftPeakOwn: 0.12, leftPeakOther: 0.05, // peak too low, probably didn't wink
      rightPeakOwn: 0.6, rightPeakOther: 0.2,
    })).toBe(false);
  });
});

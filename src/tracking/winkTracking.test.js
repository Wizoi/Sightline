import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cfg, state } from '../appState.js';
import { onFrame, resetWinkTrackingState, id, needsCalibration } from './winkTracking.js';

const OPEN = 0.3, CLOSED = 0.02;

function makeLandmarks({ leftOpen = OPEN, rightOpen = OPEN } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y }; };
  set(33, 0.35, 0.5); set(133, 0.45, 0.5);           // left eye corners (width 0.1)
  set(159, 0.40, 0.5 - leftOpen / 2); set(145, 0.40, 0.5 + leftOpen / 2);
  set(263, 0.65, 0.5); set(362, 0.55, 0.5);           // right eye corners (width 0.1)
  set(386, 0.60, 0.5 - rightOpen / 2); set(374, 0.60, 0.5 + rightOpen / 2);
  return lm;
}

describe('winkTracking', () => {
  beforeEach(() => {
    resetWinkTrackingState();
    state.winkStrength = 0.5;
  });

  it('identifies itself and does not need calibration', () => {
    expect(id).toBe('wink');
    expect(needsCalibration).toBe(false);
  });

  it('returns null while both eyes stay open', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    expect(onFrame(makeLandmarks())).toBeNull();
    now.mockReturnValue(500);
    expect(onFrame(makeLandmarks())).toBeNull();
    now.mockRestore();
  });

  it('returns an "up" point once a left wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(makeLandmarks());                                   // establishes baselines
    now.mockReturnValue(10);
    expect(onFrame(makeLandmarks({ leftOpen: CLOSED }))).toBeNull();  // not held long enough yet
    now.mockReturnValue(300);
    const result = onFrame(makeLandmarks({ leftOpen: CLOSED }));
    now.mockRestore();

    expect(result).not.toBeNull();
    expect(result.ux).toBe(0.5);
    expect(result.uy).toBeLessThan(cfg.bandPos - cfg.deadZoneFrac);
  });

  it('returns a "down" point once a right wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(makeLandmarks());
    now.mockReturnValue(10);
    onFrame(makeLandmarks({ rightOpen: CLOSED }));
    now.mockReturnValue(300);
    const result = onFrame(makeLandmarks({ rightOpen: CLOSED }));
    now.mockRestore();

    expect(result).not.toBeNull();
    expect(result.uy).toBeGreaterThan(cfg.bandPos + cfg.deadZoneFrac);
  });

  it('ignores both eyes closing together (a blink, not a wink)', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(makeLandmarks());
    now.mockReturnValue(10);
    onFrame(makeLandmarks({ leftOpen: CLOSED, rightOpen: CLOSED }));
    now.mockReturnValue(500);
    const result = onFrame(makeLandmarks({ leftOpen: CLOSED, rightOpen: CLOSED }));
    now.mockRestore();

    expect(result).toBeNull();
  });

  it('pushes further past the dead-zone edge as wink strength increases', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(makeLandmarks());

    state.winkStrength = 0.05;
    now.mockReturnValue(10);
    onFrame(makeLandmarks({ leftOpen: CLOSED }));
    now.mockReturnValue(300);
    const gentle = onFrame(makeLandmarks({ leftOpen: CLOSED }));

    resetWinkTrackingState();
    now.mockReturnValue(1000);
    onFrame(makeLandmarks());
    state.winkStrength = 1;
    now.mockReturnValue(1010);
    onFrame(makeLandmarks({ leftOpen: CLOSED }));
    now.mockReturnValue(1300);
    const strong = onFrame(makeLandmarks({ leftOpen: CLOSED }));
    now.mockRestore();

    // both push "up" (uy below bandPos), but the stronger wink pushes further
    expect(strong.uy).toBeLessThan(gentle.uy);
  });
});

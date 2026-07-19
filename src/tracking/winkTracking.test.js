import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cfg, state } from '../appState.js';
import { onFrame, resetWinkTrackingState, id, needsCalibration } from './winkTracking.js';

const OPEN = 0.05, CLOSED = 0.9;

function makeRes({ leftBlink = OPEN, rightBlink = OPEN } = {}) {
  return {
    faceBlendshapes: [{
      categories: [
        { categoryName: 'eyeBlinkLeft', score: leftBlink },
        { categoryName: 'eyeBlinkRight', score: rightBlink },
      ],
    }],
  };
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
    expect(onFrame(null, makeRes())).toBeNull();
    now.mockReturnValue(500);
    expect(onFrame(null, makeRes())).toBeNull();
    now.mockRestore();
  });

  it('returns an "up" point once a left wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    expect(onFrame(null, makeRes({ leftBlink: CLOSED }))).toBeNull();  // not held long enough yet
    now.mockReturnValue(300);
    const result = onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockRestore();

    expect(result).not.toBeNull();
    expect(result.ux).toBe(0.5);
    expect(result.uy).toBeLessThan(cfg.bandPos - cfg.deadZoneFrac);
  });

  it('returns a "down" point once a right wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    onFrame(null, makeRes({ rightBlink: CLOSED }));
    now.mockReturnValue(300);
    const result = onFrame(null, makeRes({ rightBlink: CLOSED }));
    now.mockRestore();

    expect(result).not.toBeNull();
    expect(result.uy).toBeGreaterThan(cfg.bandPos + cfg.deadZoneFrac);
  });

  it('ignores both eyes closing together (a blink, not a wink)', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    onFrame(null, makeRes({ leftBlink: CLOSED, rightBlink: CLOSED }));
    now.mockReturnValue(500);
    const result = onFrame(null, makeRes({ leftBlink: CLOSED, rightBlink: CLOSED }));
    now.mockRestore();

    expect(result).toBeNull();
  });

  it('never lands exactly on the screen edge, even at max wink strength', () => {
    // Regression: followLogic.decide() treats gaze sitting exactly at y=0 or
    // y=H as "looking away" (strict > 0 / < H), not as a valid trigger. A
    // strong-enough wink push used to compute a uy of exactly 0 (or above 1,
    // clamped to 1 downstream) and silently fail to register at all.
    state.winkStrength = 1;
    const now = vi.spyOn(performance, 'now');

    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockReturnValue(300);
    const up = onFrame(null, makeRes({ leftBlink: CLOSED }));
    expect(up.uy).toBeGreaterThan(0);

    resetWinkTrackingState();
    now.mockReturnValue(1000);
    onFrame(null, makeRes());
    now.mockReturnValue(1010);
    onFrame(null, makeRes({ rightBlink: CLOSED }));
    now.mockReturnValue(1300);
    const down = onFrame(null, makeRes({ rightBlink: CLOSED }));
    expect(down.uy).toBeLessThan(1);

    now.mockRestore();
  });

  it('pushes further past the dead-zone edge as wink strength increases', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());

    state.winkStrength = 0.05;
    now.mockReturnValue(10);
    onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockReturnValue(300);
    const gentle = onFrame(null, makeRes({ leftBlink: CLOSED }));

    resetWinkTrackingState();
    now.mockReturnValue(1000);
    onFrame(null, makeRes());
    state.winkStrength = 1;
    now.mockReturnValue(1010);
    onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockReturnValue(1300);
    const strong = onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockRestore();

    // both push "up" (uy below bandPos), but the stronger wink pushes further
    expect(strong.uy).toBeLessThan(gentle.uy);
  });
});

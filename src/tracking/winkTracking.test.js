import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../appState.js';
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

  it('reports an "up" intent once a left wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    expect(onFrame(null, makeRes({ leftBlink: CLOSED }))).toBeNull();  // not held long enough yet
    now.mockReturnValue(300);
    const result = onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockRestore();

    expect(result).toEqual({ intent: 'up', strength: state.winkStrength });
  });

  it('reports a "down" intent once a right wink is held long enough', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    onFrame(null, makeRes({ rightBlink: CLOSED }));
    now.mockReturnValue(300);
    const result = onFrame(null, makeRes({ rightBlink: CLOSED }));
    now.mockRestore();

    expect(result).toEqual({ intent: 'down', strength: state.winkStrength });
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

  it('continues reporting the same intent every frame the wink stays held', () => {
    // followLogic.decide()'s `winkIntent` is timestamp-gated (see
    // followLogic.js), so it must be re-reported every frame the wink is
    // still held, not just once on the frame it commits.
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(0);
    onFrame(null, makeRes());
    now.mockReturnValue(10);
    onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockReturnValue(300);
    const first = onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockReturnValue(320);
    const second = onFrame(null, makeRes({ leftBlink: CLOSED }));
    now.mockRestore();

    expect(first).toEqual({ intent: 'up', strength: state.winkStrength });
    expect(second).toEqual({ intent: 'up', strength: state.winkStrength });
  });

  it('passes the current Wink strength dial straight through as the reported strength', () => {
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

    expect(gentle).toEqual({ intent: 'up', strength: 0.05 });
    expect(strong).toEqual({ intent: 'up', strength: 1 });
  });
});

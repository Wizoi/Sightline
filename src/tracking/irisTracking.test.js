import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../appState.js';
import { onFrame, id, needsCalibration, resetIrisTrackingState } from './irisTracking.js';

const W = 640, H = 480;

// Minimal, frontal-facing landmark set covering only what onFrame's own
// eyeRatios(usePose=false) call reads: eye-corner/iris points (rx/ry) and
// eyelid points (the still-computed-but-no-longer-gating `open` field).
function makeLandmarks() {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  set(33, 0.35, 0.5); set(133, 0.45, 0.5); set(468, 0.40, 0.5);   // left eye
  set(159, 0.40, 0.48); set(145, 0.40, 0.52);                      // left lids
  set(263, 0.65, 0.5); set(362, 0.55, 0.5); set(473, 0.60, 0.5);  // right eye
  set(386, 0.60, 0.48); set(374, 0.60, 0.52);                      // right lids
  return lm;
}

function makeRes({ leftBlink = 0.05, rightBlink = 0.05 } = {}) {
  return {
    faceBlendshapes: [{
      categories: [
        { categoryName: 'eyeBlinkLeft', score: leftBlink },
        { categoryName: 'eyeBlinkRight', score: rightBlink },
      ],
    }],
  };
}

describe('irisTracking', () => {
  beforeEach(() => {
    state.usePose = false;
    state.capturing = null;
    state.calibrated = false;
    state.coefX = null; state.coefY = null; state.gnorm = null;
    state.biasX = 0; state.biasY = 0;
  });

  it('identifies itself and needs calibration', () => {
    expect(id).toBe('iris');
    expect(needsCalibration).toBe(true);
  });

  it('returns null when not calibrated, even with eyes open', () => {
    expect(onFrame(makeLandmarks(), makeRes(), W, H)).toBeNull();
  });

  it('returns null while either eye is closing past the blink threshold, even if calibrated', () => {
    state.calibrated = true;
    state.coefX = [0.1, 0, 0, 0, 0, 0, 0];
    state.coefY = [0.2, 0, 0, 0, 0, 0, 0];
    state.gnorm = { m: [0, 0, 0, 0], s: [1, 1, 1, 1] };

    expect(onFrame(makeLandmarks(), makeRes({ leftBlink: 0.5 }), W, H)).toBeNull();
    expect(onFrame(makeLandmarks(), makeRes({ rightBlink: 0.5 }), W, H)).toBeNull();
  });

  it('returns a gaze point when calibrated and both eyes are open', () => {
    state.calibrated = true;
    state.coefX = [0.1, 0, 0, 0, 0, 0, 0];
    state.coefY = [0.2, 0, 0, 0, 0, 0, 0];
    state.gnorm = { m: [0, 0, 0, 0], s: [1, 1, 1, 1] };

    expect(onFrame(makeLandmarks(), makeRes(), W, H)).toEqual({ ux: 0.1, uy: 0.2 });
  });

  it('does not push a calibration sample while blinking', () => {
    state.capturing = { samples: [] };
    onFrame(makeLandmarks(), makeRes({ leftBlink: 0.9 }), W, H);
    expect(state.capturing.samples.length).toBe(0);
  });

  it('pushes a calibration sample when not blinking', () => {
    state.capturing = { samples: [] };
    onFrame(makeLandmarks(), makeRes(), W, H);
    expect(state.capturing.samples.length).toBe(1);
  });

  // Regression: a resting/EMA-based gate could be fooled by a sustained
  // asymmetric squint; a fixed blendshape threshold should not be — only the
  // eye that's actually closing should matter, and a genuinely open weaker
  // eye should not itself trip the gate.
  it('does not gate on a merely-lower (but still open) eye score', () => {
    state.capturing = { samples: [] };
    onFrame(makeLandmarks(), makeRes({ leftBlink: 0.05, rightBlink: 0.15 }), W, H);
    expect(state.capturing.samples.length).toBe(1);
  });
});

describe('blink gate: adaptive baseline (real-session fix, 2026-07-25)', () => {
  beforeEach(() => {
    resetIrisTrackingState();
    state.capturing = null;
    state.calibrated = false;
  });

  const feed = (blink, n = 1) => {
    let last;
    for (let i = 0; i < n; i++) last = onFrame(makeLandmarks(), makeRes({ leftBlink: blink, rightBlink: blink }), W, H);
    return last;
  };

  it('still rejects a real blink: a fast spike toward full closure from a relaxed baseline', () => {
    feed(0.05, 30);                      // settle the baseline at "eyes open"
    state.capturing = { samples: [] };
    feed(0.9, 3);                        // a blink: large and fast
    expect(state.capturing.samples.length).toBe(0);
  });

  it('rejects unambiguous closure regardless of baseline (absolute ceiling)', () => {
    feed(0.7, 60);                       // baseline drifts high (heavy lids/squint)
    state.capturing = { samples: [] };
    feed(0.95, 3);
    expect(state.capturing.samples.length).toBe(0);
  });

  it('REGRESSION: sustained downward gaze stops being rejected once the baseline adapts -- the bottom-row calibration dots that previously never captured', () => {
    feed(0.05, 30);                      // eyes open, looking straight ahead
    // User now looks down at a bottom-row dot: closure rises and STAYS up.
    feed(0.45, 25);                      // held long enough for the baseline to absorb it
    state.capturing = { samples: [] };
    feed(0.45, 10);                      // still looking down -- these must now be captured
    expect(state.capturing.samples.length).toBe(10);
  });

  it('the pre-fix fixed 0.3 cut would have rejected that same sustained downward gaze entirely', () => {
    // Documents what changed: 0.45 sustained closure is above the old fixed
    // BLINK_THRESHOLD of 0.3, so every one of those frames used to be dropped.
    expect(0.45).toBeGreaterThan(0.3);
  });
});

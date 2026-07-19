import { state } from '../appState.js';
import { eyeRatios, blendVec } from '../lib/gazeMath.js';
import { applyX, applyY } from '../lib/calibrationModel.js';

export const id = 'iris';
export const label = 'Iris tracking';
export const needsCalibration = true;

// Per frame: extract pose-invariant eye-direction features, blink-gate them
// (so blinks don't spike the gaze estimate or pollute calibration), feed a
// calibration sample if a calibration dot is being held, then map through the
// fitted calibration model. Returns unclamped screen-fraction coordinates, or
// null if there's nothing to report yet (blinking, or not calibrated).
export function onFrame(lm, res, procW, procH) {
  const r = eyeRatios(lm, state.usePose, procW, procH);
  const b = blendVec(res); r.bH = b.bH; r.bV = b.bV;

  if (state.openEMA == null) state.openEMA = r.open;
  const blinking = state.openEMA > 0 && r.open < 0.5 * state.openEMA;
  if (!blinking) state.openEMA += 0.03 * (r.open - state.openEMA);
  if (blinking) return null;

  if (state.capturing) state.capturing.samples.push(r);

  if (!(state.calibrated && state.coefX && state.coefY)) return null;

  return {
    ux: applyX(r, state.coefX, state.gnorm) + state.biasX,
    uy: applyY(r, state.coefY, state.gnorm) + state.biasY,
  };
}

import { state } from '../appState.js';
import { eyeRatios, blendVec, eyeBlinkScores } from '../lib/gazeMath.js';
import { applyX, applyY } from '../lib/calibrationModel.js';

export const id = 'iris';
export const label = 'Iris tracking';
export const needsCalibration = true;

// MediaPipe's per-eye blink blendshape score is a purpose-built,
// model-computed eye-closure signal (0 = open, 1 = fully closed) — see
// lib/gazeMath.eyeBlinkScores and lib/winkLogic.js's DEFAULT_CLOSED_THRESHOLD
// (0.3), which real deliberate winks were observed to clear against a resting
// baseline around ~0.1. This gate only needs to catch "eye(s) mid-closure, iris
// position untrustworthy" — not distinguish a wink from a blink the way
// winkTracking.js does — so a single fixed threshold on whichever eye is more
// closed is enough; no per-user calibration or running baseline needed, unlike
// the EMA-ratio heuristic this replaces (which chased a per-user resting
// openness that could itself drift under lighting/pose changes).
const BLINK_THRESHOLD = 0.3;

// Per frame: extract pose-invariant eye-direction features, blink-gate them
// (so blinks don't spike the gaze estimate or pollute calibration), feed a
// calibration sample if a calibration dot is being held, then map through the
// fitted calibration model. Returns unclamped screen-fraction coordinates, or
// null if there's nothing to report yet (blinking, or not calibrated).
export function onFrame(lm, res, procW, procH) {
  const r = eyeRatios(lm, state.usePose, procW, procH);
  const b = blendVec(res); r.bH = b.bH; r.bV = b.bV;

  const { left, right } = eyeBlinkScores(res);
  if (Math.max(left, right) > BLINK_THRESHOLD) return null;

  if (state.capturing) state.capturing.samples.push(r);

  if (!(state.calibrated && state.coefX && state.coefY)) return null;

  return {
    ux: applyX(r, state.coefX, state.gnorm) + state.biasX,
    uy: applyY(r, state.coefY, state.gnorm) + state.biasY,
  };
}

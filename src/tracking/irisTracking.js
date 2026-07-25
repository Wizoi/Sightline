import { state } from '../appState.js';
import { eyeRatios, blendVec, eyeBlinkScores, eyeConfidence } from '../lib/gazeMath.js';
import { applyX, applyY } from '../lib/calibrationModel.js';

export const id = 'iris';
export const label = 'Iris tracking';
export const needsCalibration = true;

// MediaPipe's per-eye blink blendshape score is a purpose-built,
// model-computed eye-closure signal (0 = open, 1 = fully closed) — see
// lib/gazeMath.eyeBlinkScores. This gate only needs to catch "eye(s)
// mid-closure, iris position untrustworthy," not distinguish a wink from a
// blink the way winkTracking.js does.
//
// A FIXED threshold on absolute closure was the first version of this gate
// (backlog A4). Real-session testing falsified it: the bottom-row
// calibration dots (y=0.88) repeatedly failed to capture at all, and the
// user could make them work instantly by deliberately opening their eyes
// wider — direct confirmation that what the gate was rejecting was normal
// LID POSITION, not a blink. Looking down lowers the upper eyelid as part
// of ordinary lid-eye coordination, so a sustained downward gaze pushes
// MediaPipe's eyeBlink score up with no blink occurring; a fixed cut then
// silently discards exactly the samples for the lowest targets, which is
// both a capture failure AND a systematic downward bias in whatever data
// does get through. Measured cost when this was live: 9-dot accuracy fell
// to 35-68% "lands on the right line" (from 80-86% before), with vertical
// the worst axis.
//
// The gate is now RELATIVE to a slowly-adapting baseline of the user's own
// recent closure score, plus an absolute ceiling for unambiguous closure:
//   - A real blink is a large, FAST transient (score spikes toward ~1.0 over
//     a few frames), so it clears the rise margin long before the slow
//     baseline can absorb it.
//   - Sustained downward gaze is a smaller, SLOW, held elevation, which the
//     baseline absorbs within a few hundred ms — after which samples flow
//     normally instead of being rejected for as long as the user looks down.
// This deliberately does NOT recreate the pre-A4 EMA-ratio heuristic, whose
// documented failure was chasing a per-user resting openness derived from
// raw eyelid GEOMETRY (which drifts with lighting/pose). The baseline here
// tracks the model's own normalized closure classifier, and is only used as
// a reference point for detecting a rise — never as the closure signal itself.
const BLINK_ABSOLUTE = 0.8;   // unambiguous closure, rejected regardless of baseline
const BLINK_RISE = 0.22;      // rise above the running baseline that counts as a blink
const BASELINE_ALPHA = 0.05;  // ~0.4s to absorb a sustained lid-position change at ~30fps

// Reasoned starting points calibrated against the observed failure, not
// tuned against a corpus of real blink traces (none exists) — same caveat
// this project already applies to gridSpacingThreshold and the pursuit lag
// candidates. Re-derive from real data if blinks start leaking through.
let closureBaseline = null;

// Clears the adaptive baseline — call when the tracking context changes
// enough that the old baseline is meaningless (tracking-type switch, camera
// restart), mirroring winkTracking.js's own resetWinkTrackingState().
export function resetIrisTrackingState() {
  closureBaseline = null;
}

// Per frame: extract pose-invariant eye-direction features, blink-gate them
// (so blinks don't spike the gaze estimate or pollute calibration), feed a
// calibration sample if a calibration dot is being held, then map through the
// fitted calibration model. Returns unclamped screen-fraction coordinates, or
// null if there's nothing to report yet (blinking, or not calibrated).
export function onFrame(lm, res, procW, procH) {
  const { left, right } = eyeBlinkScores(res);
  const closure = Math.max(left, right);
  if (closureBaseline == null) closureBaseline = closure;
  const isBlink = closure > BLINK_ABSOLUTE || (closure - closureBaseline) > BLINK_RISE;
  // Baseline updates on EVERY frame, including rejected ones. That's
  // deliberate: if it only learned from accepted frames, a sustained
  // downward gaze would be rejected on its first frame and then never get
  // the chance to teach the baseline that this is the user's new normal —
  // it would stay rejected for as long as they kept looking down, which is
  // precisely the bug this replaced. A brief blink barely moves it at this
  // alpha, so letting blink frames contribute costs nothing.
  closureBaseline += BASELINE_ALPHA * (closure - closureBaseline);
  if (isBlink) return null;

  // Per-eye confidence weighting (lib/gazeMath.js's eyeConfidence): reuses
  // the same blink scores already computed for the gate above, so this is a
  // pure signal-reuse, not an extra cost. Below the hard blink-gate
  // threshold both eyes are "open enough to trust" in the binary sense, but
  // one can still be more closed/occluded (glasses glare, a head turn) than
  // the other — down-weighting it in the average is strictly finer-grained
  // than the all-or-nothing gate above, and degrades to today's flat 50/50
  // average whenever both eyes score similarly (the common case).
  const weights = eyeConfidence(left, right);
  const r = eyeRatios(lm, state.usePose, procW, procH, weights);
  const b = blendVec(res, weights); r.bH = b.bH; r.bV = b.bV;

  // Capture happens BEFORE any eye-mode projection, deliberately. A
  // calibration sample must record the raw, UNPROJECTED blend (plus both
  // eyes' own values) so chooseEyeMode can afterwards compare all three
  // candidates fairly. Projecting first would bake the PREVIOUS session's
  // choice into the new data — a saved 'left' would make the 'both'
  // candidate secretly also left, and the comparison meaningless.
  //
  // `t` (capture time) rides along unused by the 9-dot flow (it only ever
  // reads rx/ry/bH/bV off each pushed sample) but is what lets the
  // smooth-pursuit flow (calibration.js's runPursuitCalibration) recover
  // *when* during its ~10s sweep each sample was captured, so it can pair
  // each one against the moving target's position at that instant.
  if (state.capturing) state.capturing.samples.push({ ...r, t: performance.now() });

  if (!(state.calibrated && state.coefX && state.coefY)) return null;

  // Apply the eye mode calibration measured as best for this user (see
  // lib/calibrationModel.js's chooseEyeMode) before mapping through the
  // model, so live frames are projected exactly the way the fit was. This
  // only affects the returned gaze point, never the captured sample above.
  const m = state.eyeMode;
  const rm = (m === 'left' && r.rxL != null) ? { ...r, rx: r.rxL, ry: r.ryL }
    : (m === 'right' && r.rxR != null) ? { ...r, rx: r.rxR, ry: r.ryR }
      : r;

  return {
    ux: applyX(rm, state.coefX, state.gnorm) + state.biasX,
    uy: applyY(rm, state.coefY, state.gnorm) + state.biasY,
  };
}

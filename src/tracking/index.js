import { state } from '../appState.js';
import * as irisTracking from './irisTracking.js';
import * as winkTracking from './winkTracking.js';

export const TRACKING_TYPES = [irisTracking, winkTracking];
const byId = Object.fromEntries(TRACKING_TYPES.map((t) => [t.id, t]));

export function getActiveTracking() {
  return byId[state.trackingType] || irisTracking;
}

export function setTrackingType(id) {
  if (byId[id]) state.trackingType = id;
}

// Whether "Follow eyes" can be enabled: camera + PDF are ready, and either
// the active tracking type doesn't need calibration at all (e.g. wink
// tracking), or it has been both calibrated AND verified.
//
// Requiring the accuracy check makes the setup an explicit sequence --
// camera, calibrate, verify -- instead of three independent buttons. Skipping
// the check was the easy path to a bad session: a poor fit behaves like the
// app is broken rather than like something needing 20 seconds of setup, and
// the user has no reason to suspect which. Wink tracking is unaffected, since
// it has nothing to calibrate or verify.
// Returns [ok, reason] — the reason names the specific missing prerequisite
// so the UI can tell the user which step they still owe, instead of leaving
// the most-gated button in the app as the one that explains itself least.
export function followGate() {
  if (!state.camReady) return [false, 'Start the camera first'];
  if (!state.pdfDoc) return [false, 'Load a PDF first'];
  if (!getActiveTracking().needsCalibration) return [true, ''];
  if (!state.calibrated) return [false, 'Calibrate first'];
  if (!state.verified) return [false, 'Run Verify first'];
  return [true, ''];
}

// Deliberately derived from followGate rather than re-stating its conditions:
// a second copy of this logic is exactly how a button ends up disabled while
// something else believes it should be live, with no way to see which is
// right.
export function canFollow() {
  return followGate()[0];
}

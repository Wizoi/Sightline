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
export function canFollow() {
  if (!state.camReady || !state.pdfDoc) return false;
  if (!getActiveTracking().needsCalibration) return true;
  return !!(state.calibrated && state.verified);
}

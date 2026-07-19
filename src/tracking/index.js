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
// the active tracking type has a completed calibration, or it doesn't need
// one at all (e.g. wink tracking).
export function canFollow() {
  return !!(state.camReady && state.pdfDoc && (state.calibrated || !getActiveTracking().needsCalibration));
}

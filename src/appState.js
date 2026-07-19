// Shared mutable runtime state used across the camera, calibration, follow
// controller, and settings modules — the explicit, namespaced version of what
// used to be a pile of module-scope `let`s in the original single-file app.

export const cfg = {
  deadZoneFrac: 0.18, bandPos: 0.5, rightZoneFrac: 0.62,
  maxSpeed: 360, smoothWin: 12, holdMs: 350, sheetMargin: 0.06, zoom: 1.0,
};

export const state = {
  pdfDoc: null,

  faceLandmarker: null,
  camReady: false,
  calibrated: false,

  following: false,
  showBand: true,
  showGaze: false,
  showSys: false,
  driftOn: false,
  snapOn: false,

  trackingType: 'iris',
  winkStrength: 0.5,

  capturing: null,
  calibPoints: [],
  coefX: null,
  coefY: null,
  gnorm: null,
  calibFp: null,

  biasX: 0,
  biasY: 0,

  facePresent: false,
  faceBox: { cx: 0.5, cy: 0.5, size: 0.3 },
  frameBrightness: 128,

  gazeUnclamped: null,
  openEMA: null,

  usePose: true,
  cameraZoom: 1,
  faceCenterVid: null,
  faceMiss: 0,
  reanchorCtr: 0,

  autoFrame: true,
  autoZoom: 1,

  videoTrack: null,
  hwZoom: false,
  zoomCap: null,

  rawGaze: null,

  systemCentersDoc: [],
};

// Switching pose/flat feature space invalidates any saved calibration.
export function calibModelId() {
  return (state.usePose ? 'pose' : 'flat') + '-blendquad-v3';
}

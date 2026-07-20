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

  trackingType: 'wink',
  winkStrength: 0.5,
  winkScores: { left: 0, right: 0 },   // live debug readout — see settings.js
  // null = not calibrated, fall back to lib/winkLogic.js's fixed defaults.
  winkClosedThreshold: null,
  winkGapThreshold: null,

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

  // Time-based "karaoke" auto-scroll — independent of camera/tracking state
  // above; see src/scoreAnalysis.js and src/autoScrollController.js.
  autoScroll: {
    analyzed: false,             // has "Analyze score" run for the current PDF?
    systemBands: [],             // [{ center, rowMin, rowMax }] per system, doc px — from scoreAnalysis
    measuresPerSystem: [],       // editable estimate, one entry per system
    beatsPerMeasure: 4,
    bpm: 100,
    tempoPct: 1,                 // live playback-speed multiplier (0.5-1.5), independent of bpm
    schedule: null,              // built from the above via lib/tempoSchedule.js when playback starts
    playing: false,
    scheduleElapsed: 0,          // accumulated schedule-time seconds elapsed — see autoScrollController.js

    // Live tempo correction ("onset-nudge") — experimental, opt-in mic-driven
    // trim on top of tempoPct. See src/liveTempo.js and lib/tempoCorrection.js.
    liveTempoEnabled: false,
    liveTempoStatus: 'off',      // 'off' | 'listening' | 'tracking' | 'no signal'
    tempoCorrection: { correction: 1, lastOnsetAt: null },
  },
};

// Switching pose/flat feature space invalidates any saved calibration.
export function calibModelId() {
  return (state.usePose ? 'pose' : 'flat') + '-blendquad-v3';
}

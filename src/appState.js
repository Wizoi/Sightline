// Shared mutable runtime state used across the camera, calibration, follow
// controller, and settings modules — the explicit, namespaced version of what
// used to be a pile of module-scope `let`s in the original single-file app.

export const cfg = {
  deadZoneFrac: 0.18, bandPos: 0.5, rightZoneFrac: 0.62,
  maxSpeed: 360, smoothWin: 12, holdMs: 350, sheetMargin: 0.06, zoom: 1.0,

  // Where the currently-playing system sits on screen during auto-scroll, as a
  // fraction of the viewport height (0 = top edge, 1 = bottom). Deliberately
  // lower than the eye-tracking band's `bandPos` (0.5): parking the reading
  // line ~60% down leaves ~1.5 lines of already-played context visible above
  // it, so when a new line scrolls into place the reader still sees where they
  // came from rather than the line jumping to the top edge. Separate from
  // `bandPos` because that one also drives the eye/wink reading band and
  // calibration target, which should stay centered.
  autoScrollBandPos: 0.6,
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
    systemBands: [],             // [{ page, fracCenter, fracMin, fracMax }] per system — page-relative, from scoreAnalysis; resolved to doc px at use time via systemGeometry.js so they survive resize/zoom/rotation
    measuresPerSystem: [],       // editable estimate, one entry per system
    // Per-page rotation OVERRIDE, keyed by 0-based page index, populated by
    // analyzeScore()'s orientation probe (see lib/pageRotation.js) only for
    // pages where the PDF's own declared page.rotate is convincingly wrong —
    // a real scanning/assembly artifact seen on real combined-score PDFs, not
    // a hypothetical. Value is an ABSOLUTE rotation (0/90/180/270) that
    // REPLACES page.rotate for that page (pdfjs's getViewport({ rotation })
    // overrides the declared rotation, it doesn't add to it). Empty = trust
    // every page's own declared rotation, same as before this existed.
    // Consulted by both scoreAnalysis.js (for the rest of that page's
    // analysis passes) and pdf.js's renderAll() (so the visible canvases
    // match what was analyzed). Reset on a new document load, same as
    // systemBands/measuresPerSystem above.
    pageRotationOverrides: {},
    // When an image-only PDF is read two ways (OCR per-number vs margin scan)
    // and they disagree, both whole-document count arrays are kept here so the
    // user can switch — { options: [{ label, measures }], active } | null. See
    // scoreAnalysis.js / autoScrollUI.js.
    measureReadings: null,
    beatsPerMeasure: 4,
    bpm: 100,                    // manual Tempo slider — also the fallback tempo for pieces with no printed ♩=N marks
    // Per-system tempo from printed metronome marks (♩=N), one entry per
    // system, carried forward from each mark; null when none were detected
    // (then playback is flat `bpm`). bpmBase is the reference the manual Tempo
    // slider scales against, so moving it speeds/slows the whole piece while
    // keeping the printed tempo *ratios* intact. See lib/tempoSchedule.js.
    bpmPerSystem: null,
    bpmBase: 100,

    // Parts/movements detected within a single PDF (e.g. a full score
    // followed by individual instrument parts) — see lib/scoreSections.js.
    // Each entry is a saved snapshot of the four fields above it; selecting
    // one (src/autoScrollUI.js) swaps its snapshot into them, so nothing
    // else (schedule building, the tempo HUD, settings persistence) needs
    // to know sections exist. Length <= 1 means nothing was detected — the
    // UI hides the picker entirely in that case, matching today's behavior.
    sections: [],
    activeSectionIndex: 0,       // which entry in `sections` is live, for UI highlighting only
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

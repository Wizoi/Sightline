import { cfg, state } from './appState.js';
import { $, calibEl, video, toast, setStatus, showRecalBanner, hideRecalBanner } from './ui.js';
import { median } from './lib/mathUtils.js';
import { fitCalibration, calibrationQuality, calibMismatch as calibMismatchPure } from './lib/calibrationModel.js';
import { pursuitTarget, fitPursuitCalibration, DEFAULT_DURATION_SEC as PURSUIT_DURATION_SEC } from './lib/pursuitCalibration.js';
import { canFollow } from './tracking/index.js';

// A ~550ms capture window at a typical webcam framerate (~30fps) yields
// roughly 15-20 samples per dot; an unusually high-framerate camera could
// produce many more. Cap (with even subsampling, not "first N") so the LOO
// refits in calibrationQuality() and every future fit stay cheap and no
// single dot's row count runs away, without discarding the spread of samples
// across the whole capture window a "first N" cap would.
const MAX_SAMPLES_PER_POINT = 60;
function subsampleEvenly(arr, k) {
  if (arr.length <= k) return arr;
  const out = [];
  for (let i = 0; i < k; i++) out.push(arr[Math.floor((i * arr.length) / k)]);
  return out;
}

export const calibMismatch = calibMismatchPure;

const CALIB_KEY = 'eyepagescroller.calibration';

export function calibModelId() {
  return (state.usePose ? 'pose' : 'flat') + '-blendquad-v3';
}

/* ---------------------------------------------------------------------- *
 *  Calibration — 9 points, one click each; fit ratio → screen mapping
 * ---------------------------------------------------------------------- */
export function runCalibration() {
  if (!state.camReady) return;
  calibEl.style.display = 'block';
  calibEl.querySelectorAll('.cdot').forEach((n) => n.remove());
  state.calibPoints = []; state.capturing = null; state.biasX = 0; state.biasY = 0;
  const pts = [];
  for (const gy of [0.12, 0.5, 0.88]) for (const gx of [0.1, 0.5, 0.9]) pts.push([gx, gy]);
  let remaining = pts.length;
  pts.forEach(([gx, gy], pointId) => {
    const d = document.createElement('div');
    d.className = 'cdot';
    d.style.left = (gx * 100) + 'vw'; d.style.top = (gy * 100) + 'vh';
    d.addEventListener('click', () => {
      if (d.classList.contains('done') || state.capturing) return;
      state.capturing = { samples: [] };
      d.classList.add('capturing');
      setTimeout(() => {
        const s = state.capturing ? state.capturing.samples : [];
        state.capturing = null; d.classList.remove('capturing');
        if (s.length) {
          // Feed every raw sample from this dot's capture window as its own
          // labeled row (sx/sy already known — it's whichever dot the user
          // just held their gaze on), instead of collapsing ~550ms of frames
          // down to a single median row. That used to throw away ~98% of
          // already-collected, already-labeled data: a 7-parameter ridge fit
          // on 9 rows becomes a fit on hundreds, for free (same data
          // collection, same UI, no extra time from the student) — and it
          // lets the leave-one-out check below (calibrationQuality) validate
          // against the model's actual training noise distribution rather
          // than 9 pre-denoised points. See lib/calibrationModel.js for how
          // pointId is used (grouped ridge-lambda scaling, leave-one-POINT,
          // not leave-one-sample, -out).
          for (const a of subsampleEvenly(s, MAX_SAMPLES_PER_POINT)) {
            state.calibPoints.push({ sx: gx, sy: gy, rx: a.rx, ry: a.ry, bH: a.bH || 0, bV: a.bV || 0, pointId });
          }
          d.classList.add('done'); d.style.pointerEvents = 'none';
          if (--remaining === 0) finishCalibration();
        }
      }, 550);
    });
    calibEl.appendChild(d);
  });
}

// Shared by both calibration flows (9-dot below, and smooth-pursuit further
// down): saves the fitted model, flips the app into "calibrated" state, and
// either shows the existing recal-banner (a genuinely-poor fit — the 9-dot
// flow's own free LOO sanity check) or a plain success toast.
function applyFittedModel(gnorm, coefX, coefY, { poor, poorReasons } = {}) {
  state.gnorm = gnorm; state.coefX = coefX; state.coefY = coefY;
  state.calibFp = currentFingerprint();
  saveCalibration();
  state.calibrated = true;
  $('calibBtn').textContent = '🎯 Recalibrate';
  $('testBtn').disabled = false;
  $('runBtn').disabled = !canFollow();
  if (poor) {
    showRecalBanner(poorReasons || ['calibration fit looks imprecise for one or more points']);
    setStatus('s-warn', 'calibrated & saved — fit looks imprecise, consider recalibrating');
    toast('Calibration saved (accuracy may be low)');
  } else {
    hideRecalBanner();
    setStatus('', 'calibrated & saved — check accuracy or follow');
    toast('Calibration saved');
  }
}

function finishCalibration() {
  const { gnorm, coefX, coefY } = fitCalibration(state.calibPoints);
  calibEl.style.display = 'none';

  // Free-with-9-points sanity check: leave-one-out residuals catch a poor
  // calibration (bad point placement, camera hiccup mid-session) directly,
  // rather than only reacting to a later camera/window fingerprint change
  // (calibMismatch, below).
  const quality = calibrationQuality(state.calibPoints);
  applyFittedModel(gnorm, coefX, coefY, { poor: quality.poor });
}

/* ---------------------------------------------------------------------- *
 *  Smooth-pursuit calibration (experimental) — an ALTERNATIVE to the 9-dot
 *  flow above, not a replacement: the user follows one continuously-moving
 *  target for ~10s instead of clicking 9 fixed points. See
 *  lib/pursuitCalibration.js for the trajectory/lag-correction math and its
 *  own honestly-documented limitations (in particular: this flow's own
 *  quality check is NOT wired to the recal banner — see the comment below).
 * ---------------------------------------------------------------------- */
let pursuiting = false;
// Lets a caller abandon an in-progress pursuit sweep cleanly (e.g. switching
// tracking type or head-pose mode mid-flow — settings.js already resets
// other calibration state in both of those handlers) instead of leaving the
// overlay stuck open and this module refusing every future click because
// `pursuiting` never got cleared.
export function cancelPursuitCalibration() {
  pursuiting = false;
  state.capturing = null;
  const overlay = $('pursuitCalib');
  if (overlay) overlay.style.display = 'none';
}
export function runPursuitCalibration() {
  if (!state.camReady || pursuiting) return;
  const overlay = $('pursuitCalib'), dot = $('pdot');
  if (!overlay || !dot) return;
  pursuiting = true;
  overlay.style.display = 'block';
  state.calibPoints = []; state.capturing = { samples: [] }; state.biasX = 0; state.biasY = 0;
  const t0 = performance.now();

  function step(now) {
    if (!pursuiting) return; // cancelled mid-flow (see cancelPursuitCalibration)
    const tSec = (now - t0) / 1000;
    if (tSec >= PURSUIT_DURATION_SEC) { finish(); return; }
    const { x, y } = pursuitTarget(tSec, PURSUIT_DURATION_SEC);
    dot.style.left = (x * 100) + 'vw';
    dot.style.top = (y * 100) + 'vh';
    requestAnimationFrame(step);
  }

  function finish() {
    const samples = state.capturing ? state.capturing.samples : [];
    state.capturing = null;
    overlay.style.display = 'none';
    pursuiting = false;
    // irisTracking.js stamps each pushed sample with capture time (`t`,
    // performance.now()) specifically so this flow can recover each sample's
    // position along the sweep — relative to this sweep's own t0, not
    // wall-clock time.
    const rel = samples
      .filter((s) => typeof s.t === 'number')
      .map((s) => ({ tSec: (s.t - t0) / 1000, rx: s.rx, ry: s.ry, bH: s.bH || 0, bV: s.bV || 0 }));
    const result = fitPursuitCalibration(rel, PURSUIT_DURATION_SEC);
    if (!result) {
      toast('Pursuit calibration failed — try again, or use the 9-point Calibrate instead');
      return;
    }
    state.calibPoints = result.calibPoints;
    // Deliberately always `poor: false` here — NOT wired to
    // result.quality.poor. See lib/pursuitCalibration.js's pursuitQuality
    // doc comment: its leave-one-out check was found, in this session's own
    // testing, to flag even a fit that scores well by an independent
    // held-out-accuracy measure as "poor" for a continuous trajectory
    // (structurally different from the 9-dot grid, not just an untuned
    // threshold) — surfacing that as a "recalibrate" prompt here would be a
    // false alarm on every use, worse than no check at all.
    applyFittedModel(result.gnorm, result.coefX, result.coefY, { poor: false });
  }

  requestAnimationFrame(step);
}

/* ---------------------------------------------------------------------- *
 *  Persistence + setup-change detection
 * ---------------------------------------------------------------------- */
export function currentFingerprint() {
  let cam = '', label = '', vw = 0, vh = 0;
  const track = (video.srcObject && video.srcObject.getVideoTracks) ? video.srcObject.getVideoTracks()[0] : null;
  if (track) {
    const s = track.getSettings ? track.getSettings() : {};
    cam = s.deviceId || ''; label = track.label || ''; vw = s.width || 0; vh = s.height || 0;
  }
  return { cam, label, vw, vh, winW: window.innerWidth, winH: window.innerHeight, dpr: window.devicePixelRatio || 1 };
}

export function saveCalibration() {
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify({
      model: calibModelId(), coefX: state.coefX, coefY: state.coefY, gnorm: state.gnorm, fp: state.calibFp, ts: Date.now(),
    }));
  } catch (e) { /* storage may be unavailable (private browsing, quota) — calibration just won't persist */ }
}
export function loadCalibration() {
  try { return JSON.parse(localStorage.getItem(CALIB_KEY) || 'null'); } catch (e) { return null; }
}

/* ---------------------------------------------------------------------- *
 *  Guided recenter: show a target at the band center, have the user look at
 *  it for ~1.4 s, then shift the mapping so their gaze there maps to center.
 * ---------------------------------------------------------------------- */
let recentering = false;
export function recenter() {
  if (!state.camReady || !state.calibrated) { toast('Calibrate first'); return; }
  if (recentering) return;
  recentering = true;
  const target = $('rcTarget');
  target.style.top = (cfg.bandPos * 100) + 'vh';
  target.style.display = 'block';
  const samples = []; const t0 = performance.now();
  function collect() {
    const now = performance.now();
    if (state.gazeUnclamped && now - state.gazeUnclamped.t < 200) samples.push({ x: state.gazeUnclamped.x, y: state.gazeUnclamped.y });
    if (now - t0 < 1400) { requestAnimationFrame(collect); return; }
    target.style.display = 'none';
    recentering = false;
    if (samples.length >= 3) {
      state.biasX += 0.5 - median(samples.map((s) => s.x));
      state.biasY += cfg.bandPos - median(samples.map((s) => s.y));
      toast('Recentered');
    } else { toast('Recenter failed — face not detected'); }
  }
  requestAnimationFrame(collect);
}

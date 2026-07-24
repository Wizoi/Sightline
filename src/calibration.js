import { cfg, state } from './appState.js';
import { $, calibEl, video, toast, setStatus, showRecalBanner, hideRecalBanner } from './ui.js';
import { median } from './lib/mathUtils.js';
import { fitCalibration, calibrationQuality, calibMismatch as calibMismatchPure } from './lib/calibrationModel.js';
import { canFollow } from './tracking/index.js';

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
  pts.forEach(([gx, gy]) => {
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
          state.calibPoints.push({
            sx: gx, sy: gy,
            rx: median(s.map((a) => a.rx)), ry: median(s.map((a) => a.ry)),
            bH: median(s.map((a) => a.bH || 0)), bV: median(s.map((a) => a.bV || 0)),
          });
          d.classList.add('done'); d.style.pointerEvents = 'none';
          if (--remaining === 0) finishCalibration();
        }
      }, 550);
    });
    calibEl.appendChild(d);
  });
}

function finishCalibration() {
  const { gnorm, coefX, coefY } = fitCalibration(state.calibPoints);
  state.gnorm = gnorm; state.coefX = coefX; state.coefY = coefY;
  state.calibFp = currentFingerprint();
  saveCalibration();
  calibEl.style.display = 'none';
  state.calibrated = true;
  $('calibBtn').textContent = '🎯 Recalibrate';
  $('testBtn').disabled = false;
  $('runBtn').disabled = !canFollow();

  // Free-with-9-points sanity check: leave-one-out residuals catch a poor
  // calibration (bad point placement, camera hiccup mid-session) directly,
  // rather than only reacting to a later camera/window fingerprint change
  // (calibMismatch, below). Reuses the existing recal-banner UI rather than
  // inventing a second "your calibration is bad" mechanism.
  const quality = calibrationQuality(state.calibPoints);
  if (quality.poor) {
    showRecalBanner(['calibration fit looks imprecise for one or more points']);
    setStatus('s-warn', 'calibrated & saved — fit looks imprecise, consider recalibrating');
    toast('Calibration saved (accuracy may be low)');
  } else {
    hideRecalBanner();
    setStatus('', 'calibrated & saved — check accuracy or follow');
    toast('Calibration saved');
  }
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

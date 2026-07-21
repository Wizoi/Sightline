import { cfg, state } from './appState.js';
import { $, gazeEl, toast, applyBand, setStatus } from './ui.js';
import { detectSystems, renderSysMarks } from './systemDetection.js';
import { renderAll } from './pdf.js';
import { repositionAutoScroll } from './autoScrollController.js';
import { setCameraZoom } from './camera.js';
import { TRACKING_TYPES, getActiveTracking, setTrackingType, canFollow } from './tracking/index.js';
import { resetWinkTrackingState } from './tracking/winkTracking.js';

const SETTINGS_KEY = 'eyepagescroller.settings';
const PRESETS_KEY = 'eyepagescroller.presets';

const sliders = {};
const DEFAULT_RAW = {};

function bind(id, key, fmt, transform) {
  const el = $(id), out = $(id + 'v');
  const apply = () => { const raw = parseFloat(el.value); cfg[key] = transform ? transform(raw) : raw; out.textContent = fmt(raw); };
  el.addEventListener('input', apply); apply();
  sliders[id] = { el, apply };
  DEFAULT_RAW[id] = parseFloat(el.value);
}

function collectRaw() {
  const o = {};
  for (const id in sliders) o[id] = parseFloat(sliders[id].el.value);
  return o;
}
function applyRaw(o, rerender) {
  for (const id in o) if (sliders[id] && Number.isFinite(o[id])) { sliders[id].el.value = o[id]; sliders[id].apply(); }
  applyBand();
  if (rerender && state.pdfDoc) renderAll();
}

// All on/off state (so "Save settings" captures everything, not just sliders).
function currentToggles() {
  return {
    drift: state.driftOn, snap: state.snapOn, pose: state.usePose, auto: state.autoFrame,
    band: state.showBand, sys: state.showSys, cz: parseFloat($('cz').value),
    tracking: state.trackingType, winkStrength: state.winkStrength,
    winkClosedThreshold: state.winkClosedThreshold, winkGapThreshold: state.winkGapThreshold,
    bpm: state.autoScroll.bpm, beatsPerMeasure: state.autoScroll.beatsPerMeasure, tempoPct: state.autoScroll.tempoPct,
  };
}
function applyToggles(t) {
  if (!t) return;
  if (Number.isFinite(t.cz)) $('cz').value = t.cz;
  state.driftOn = !!t.drift;
  $('driftBtn').classList.toggle('on', state.driftOn);
  $('driftBtn').textContent = '🎯 Drift: ' + (state.driftOn ? 'on' : 'off');
  state.showBand = !!t.band; applyBand(); $('showBand').textContent = state.showBand ? 'Hide band' : 'Show band';
  state.showSys = !!t.sys; renderSysMarks();
  if (typeof t.pose === 'boolean') {
    state.usePose = t.pose;
    $('poseToggle').classList.toggle('on', state.usePose);
    $('poseToggle').textContent = '🧭 Head-pose comp: ' + (state.usePose ? 'on' : 'off');
  }
  if (typeof t.auto === 'boolean') {
    state.autoFrame = t.auto;
    $('autoFrameToggle').classList.toggle('on', state.autoFrame);
    $('autoFrameToggle').textContent = '🔍 Auto-frame face: ' + (state.autoFrame ? 'on' : 'off');
    if (state.autoFrame) $('czv').textContent = 'auto'; else setCameraZoom(parseFloat($('cz').value) / 100);
  }
  state.snapOn = !!t.snap;
  $('snapBtn').classList.toggle('on', state.snapOn);
  if (state.snapOn && state.pdfDoc && !state.systemCentersDoc.length) detectSystems();
  $('snapBtn').textContent = '▦ Snap: ' + (state.snapOn ? 'on' + (state.systemCentersDoc.length ? ' (' + state.systemCentersDoc.length + ')' : '') : 'off');

  if (Number.isFinite(t.winkStrength)) { state.winkStrength = t.winkStrength; $('ws').value = Math.round(t.winkStrength * 100); $('wsv').textContent = Math.round(t.winkStrength * 100) + '%'; }
  state.winkClosedThreshold = Number.isFinite(t.winkClosedThreshold) ? t.winkClosedThreshold : null;
  state.winkGapThreshold = Number.isFinite(t.winkGapThreshold) ? t.winkGapThreshold : null;
  if (typeof t.tracking === 'string') { setTrackingType(t.tracking); $('trackingType').value = state.trackingType; applyTrackingTypeUI(); }

  if (Number.isFinite(t.bpm)) { state.autoScroll.bpm = t.bpm; $('bpmInput').value = t.bpm; $('bpmV').textContent = t.bpm + ' bpm'; }
  if (Number.isFinite(t.beatsPerMeasure)) { state.autoScroll.beatsPerMeasure = t.beatsPerMeasure; $('beatsPerMeasure').value = t.beatsPerMeasure; $('beatsPerMeasureV').textContent = String(t.beatsPerMeasure); }
  if (Number.isFinite(t.tempoPct)) { state.autoScroll.tempoPct = t.tempoPct; $('tempoPct').value = Math.round(t.tempoPct * 100); $('tempoPctV').textContent = Math.round(t.tempoPct * 100) + '%'; }
}

// Setup UI depends on whether the active Tracking Type needs a 9-point
// calibration flow at all (iris tracking does; wink tracking doesn't), and
// hides controls that provably do nothing under wink tracking:
//   - Recenter / Drift: both only ever adjust or consume biasX/biasY, which
//     winkTracking.js's synthesized point never reads or contributes to.
//   - "Turn the page when my eyes reach…" (rightZoneFrac): only consulted
//     inside decide()'s `inBand && smoothX > rightStart` branches, and a
//     wink's synthetic point is deliberately always *outside* the band
//     (that's what makes it trigger), so inBand is never true for it.
//   - "Ignore glances past the sides" (sheetMargin): only gates the
//     horizontal on-screen check against a fixed ux=0.5, which is always
//     comfortably inside any reachable margin value.
//   - Head-pose comp: only affects lib/gazeMath.eyeRatios, which wink
//     tracking (lib/gazeMath.eyeBlinkScores) never calls.
//   - Eye-tracking smoothing: smooths a continuously-varying gaze position;
//     wink's point is a fixed target the instant a wink commits.
function applyTrackingTypeUI() {
  const isWink = state.trackingType === 'wink';
  const needsCalib = getActiveTracking().needsCalibration;
  $('calibBtn').style.display = needsCalib ? '' : 'none';
  $('testBtn').style.display = needsCalib ? '' : 'none';
  $('winkStrengthRow').classList.toggle('hidden', !isWink);
  $('smoothnessRow').classList.toggle('hidden', isWink);
  $('recenterBtn').classList.toggle('hidden', isWink);
  $('driftBtn').classList.toggle('hidden', isWink);
  $('rightZoneRow').classList.toggle('hidden', isWink);
  $('sheetMarginRow').classList.toggle('hidden', isWink);
  $('poseToggle').classList.toggle('hidden', isWink);
  $('runBtn').disabled = !canFollow();
}

function saveSettings() { persistSettings(true); }
// Used after wink calibration completes, so the result survives a reload
// without requiring a separate trip to "Save settings" — mirrors how iris
// calibration is saved automatically the moment it finishes.
export function persistSettings(announce) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ s: collectRaw(), t: currentToggles() }));
    if (announce) toast('Settings saved');
  } catch (e) { if (announce) toast('Could not save (storage blocked)'); }
}
export function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!o) return false;
    if (o.s) { applyRaw(o.s, false); applyToggles(o.t); } else { applyRaw(o, false); }   // new + old formats
    return true;
  } catch (e) { /* nothing saved yet, or storage blocked — fall back to defaults */ }
  return false;
}
function resetDefaults() { applyRaw(DEFAULT_RAW, true); toast('Defaults loaded'); }

// per-piece presets ------------------------------------------------------
function loadPresets() { try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); } catch (e) { return {}; } }
function savePresets(p) { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(p)); } catch (e) { /* storage blocked — presets just won't persist */ } }
function refreshPresetList(select) {
  const p = loadPresets(), s = $('presetSel');
  s.innerHTML = '<option value="">— load preset —</option>';
  Object.keys(p).sort().forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; s.appendChild(o); });
  if (select) s.value = select;
}

export function initSettingsUI() {
  bind('dz', 'deadZoneFrac', (v) => v + '%', (v) => v / 100);
  bind('bp', 'bandPos', (v) => v + '%', (v) => v / 100);
  bind('sp', 'maxSpeed', (v) => v + ' px/s', (v) => v);
  bind('rt', 'rightZoneFrac', (v) => v + '%', (v) => v / 100);
  bind('sm', 'smoothWin', (v) => v, (v) => v);
  bind('hd', 'holdMs', (v) => v + ' ms', (v) => v);
  bind('mg', 'sheetMargin', (v) => v + '%', (v) => v / 100);
  bind('zm', 'zoom', (v) => v + '%', (v) => v / 100);
  ['dz', 'bp', 'rt'].forEach((id) => $(id).addEventListener('input', applyBand));
  $('zm').addEventListener('change', () => { if (state.pdfDoc) renderAll().then(repositionAutoScroll); });

  $('saveBtn').onclick = saveSettings;
  $('defBtn').onclick = resetDefaults;

  $('presetSave').onclick = () => {
    const n = $('presetName').value.trim();
    if (!n) { toast('Name the preset first'); return; }
    const p = loadPresets(); p[n] = { s: collectRaw(), t: currentToggles() }; savePresets(p);
    refreshPresetList(n); toast('Preset "' + n + '" saved');
  };
  $('presetSel').onchange = () => {
    const n = $('presetSel').value; if (!n) return;
    const p = loadPresets(), v = p[n]; if (!v) return;
    if (v.s) { applyRaw(v.s, true); applyToggles(v.t); } else { applyRaw(v, true); }
    $('presetName').value = n; toast('Loaded "' + n + '"');
  };
  $('presetDel').onclick = () => {
    const n = $('presetSel').value; if (!n) { toast('Pick a preset to delete'); return; }
    const p = loadPresets(); delete p[n]; savePresets(p); refreshPresetList(); toast('Deleted "' + n + '"');
  };
  refreshPresetList();

  $('showBand').onclick = () => {
    state.showBand = !state.showBand; applyBand();
    $('showBand').textContent = state.showBand ? 'Hide band' : 'Show band';
  };
  $('snapBtn').onclick = () => {
    state.snapOn = !state.snapOn;
    if (state.snapOn && state.pdfDoc && !state.systemCentersDoc.length) detectSystems();
    $('snapBtn').classList.toggle('on', state.snapOn);
    $('snapBtn').textContent = '▦ Snap: ' + (state.snapOn ? 'on (' + state.systemCentersDoc.length + ')' : 'off');
  };
  $('driftBtn').onclick = () => {
    state.driftOn = !state.driftOn;
    $('driftBtn').classList.toggle('on', state.driftOn);
    $('driftBtn').textContent = '🎯 Drift: ' + (state.driftOn ? 'on' : 'off');
  };
  $('showSys').onclick = () => { state.showSys = !state.showSys; renderSysMarks(); };

  $('webcamToggle').onclick = () => { const c = $('camview'); c.style.display = c.style.display === 'block' ? 'none' : 'block'; };
  $('dotToggle').onclick = () => { state.showGaze = !state.showGaze; gazeEl.style.display = state.showGaze ? 'block' : 'none'; };

  $('cz').addEventListener('input', () => { if (!state.autoFrame) setCameraZoom(parseFloat($('cz').value) / 100); });
  $('autoFrameToggle').onclick = () => {
    state.autoFrame = !state.autoFrame;
    $('autoFrameToggle').classList.toggle('on', state.autoFrame);
    $('autoFrameToggle').textContent = '🔍 Auto-frame face: ' + (state.autoFrame ? 'on' : 'off');
    if (state.autoFrame) $('czv').textContent = 'auto'; else setCameraZoom(parseFloat($('cz').value) / 100);
  };
  if (state.autoFrame) $('czv').textContent = 'auto'; else setCameraZoom(parseFloat($('cz').value) / 100);

  // Tracking Type — pluggable gaze source (iris/pose today, wink tracking as
  // a first alternative). Switching types invalidates any in-progress
  // calibration and resets the newly-active type's own detection state.
  TRACKING_TYPES.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.label;
    $('trackingType').appendChild(o);
  });
  $('trackingType').value = state.trackingType;
  applyTrackingTypeUI();
  $('trackingType').onchange = () => {
    setTrackingType($('trackingType').value);
    state.calibrated = false; state.coefX = state.coefY = null; state.gnorm = null;
    state.capturing = null;
    // If a calibration was left open mid-flow (started, then abandoned by
    // switching tracking type instead of finishing it), it never otherwise
    // gets hidden — it would just sit there, invisible only for as long as
    // some higher-z-index overlay happened to be covering it.
    $('calib').style.display = 'none';
    resetWinkTrackingState();
    $('calibBtn').textContent = '🎯 Calibrate';
    applyTrackingTypeUI();
    setStatus('s-warn', getActiveTracking().needsCalibration ? 'tracking type changed — recalibrate' : 'tracking type changed — ready to follow');
    toast('Switched to ' + getActiveTracking().label);
  };

  $('ws').addEventListener('input', () => {
    state.winkStrength = parseFloat($('ws').value) / 100;
    $('wsv').textContent = $('ws').value + '%';
  });
  $('wsv').textContent = $('ws').value + '%';

  // head-pose compensation toggle — switching feature space invalidates calibration
  $('poseToggle').onclick = () => {
    state.usePose = !state.usePose;
    $('poseToggle').classList.toggle('on', state.usePose);
    $('poseToggle').textContent = '🧭 Head-pose comp: ' + (state.usePose ? 'on' : 'off');
    state.calibrated = false; state.coefX = state.coefY = null; state.gnorm = null;
    $('runBtn').disabled = true; $('testBtn').disabled = true;
    $('calibBtn').textContent = '🎯 Calibrate';
    setStatus('s-warn', 'mode changed — recalibrate');
    toast('Recalibrate for ' + (state.usePose ? 'head-pose' : 'basic') + ' mode');
  };
}

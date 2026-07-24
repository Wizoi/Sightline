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

// ---------------------------------------------------------------------------
// Declarative settings registry (backlog F2 — see
// docs/reviews/2026-07-19-fable-review.md finding F2, and docs/PERSONAS.md
// persona 9). One table describes every persisted setting, slider or not, so
// save/load/presets/reset/reset-and-every-onclick-handler all iterate this
// same list instead of each hand-duplicating get/set/DOM-sync logic (the
// pre-refactor shape had that duplicated across bind(), currentToggles(),
// applyToggles(), and each control's own onclick handler).
//
// Each entry:
//   key      - the property name the value is saved under (in the `s` object
//              for kind:'slider', `t` for everything else). Chosen to exactly
//              match the pre-refactor persisted JSON keys so existing
//              localStorage data (both "Save settings" and per-piece
//              presets, saved before this refactor existed) keeps loading
//              unchanged -- this is the one thing this file must never
//              silently break, since it's a real user's own saved state.
//   kind     - 'slider' | 'toggle' | 'value' (also selects the s vs t bucket:
//              only 'slider' goes to `s`).
//   get()    - current value, used by collectRaw/currentToggles (save) and
//              to capture this entry's own default at registration time
//              (see `reg()`), which is what "Load defaults" restores.
//   set(v)   - restores `v` into the underlying cfg/state field *and* syncs
//              any dependent DOM (button text/class, formatted readout, a
//              disabled camera-zoom side effect, etc). This is the "quiet"
//              path: safe to call from load/preset-restore/reset because it
//              never fires a toast, a status-bar message, or invalidates
//              calibration -- exactly matching what applyToggles() (as
//              opposed to each setting's own onclick handler) did for these
//              fields before this refactor.
//   presence - (kind:'toggle'/'value' only) how a loaded `t` object decides
//              whether to apply this key at all. Reproduces each field's
//              original guard exactly, so an old save missing a field added
//              in a later app version leaves the current value alone
//              instead of clobbering it with a default:
//                'always'       - coerce unconditionally (missing => falsy).
//                                 drift/band/sys/snap have existed since the
//                                 `t` object's first shape.
//                'boolean'      - only if typeof === 'boolean' (pose/auto
//                                 were added later; old saves may lack them).
//                'string'       - only if typeof === 'string' (tracking).
//                'finite'       - only if Number.isFinite (cz/winkStrength/
//                                 bpm/beatsPerMeasure/tempoPct).
//                'finiteOrNull' - always applied, coercing to null when not
//                                 finite (winkClosedThreshold/
//                                 winkGapThreshold already forced a reset to
//                                 "uncalibrated" (null) when absent,
//                                 pre-refactor -- preserved as-is).
//   wire()   - (optional, called once from initSettingsUI) attaches the live
//              DOM listener for a control the user interacts with directly.
//              Calls set() for the shared part, then layers on any
//              interactive-only side effect (calibration invalidation,
//              a toast, resetWinkTrackingState()) that only makes sense when
//              the *user* changes the value, not when it's being restored
//              quietly from storage -- matching the pre-refactor asymmetry
//              between applyToggles() and each control's own onclick
//              handler for pose/tracking-type (both of which invalidate
//              calibration on a live change but not on a restore).
const registry = [];
function reg(entry) {
  entry.default = entry.get();
  registry.push(entry);
  return entry;
}
const sliderEntries = () => registry.filter((e) => e.kind === 'slider');
const toggleEntries = () => registry.filter((e) => e.kind !== 'slider');

function bind(id, key, fmt, transform) {
  const el = $(id), out = $(id + 'v');
  const apply = () => { const raw = parseFloat(el.value); cfg[key] = transform ? transform(raw) : raw; out.textContent = fmt(raw); };
  el.addEventListener('input', apply); apply();
  reg({
    key: id, kind: 'slider',
    get: () => parseFloat(el.value),
    set: (v) => { el.value = v; apply(); },
  });
}

function collectRaw() {
  const o = {};
  sliderEntries().forEach((e) => { o[e.key] = e.get(); });
  return o;
}
function applyRaw(o, rerender) {
  sliderEntries().forEach((e) => { if (o && Number.isFinite(o[e.key])) e.set(o[e.key]); });
  applyBand();
  if (rerender && state.pdfDoc) renderAll();
}

// All on/off + numeric/string state (so "Save settings" captures everything,
// not just sliders).
function currentToggles() {
  const o = {};
  toggleEntries().forEach((e) => { o[e.key] = e.get(); });
  return o;
}
function applyToggles(t) {
  if (!t) return;
  toggleEntries().forEach((e) => {
    switch (e.presence) {
      case 'always': e.set(!!t[e.key]); break;
      case 'finiteOrNull': e.set(Number.isFinite(t[e.key]) ? t[e.key] : null); break;
      case 'finite': if (Number.isFinite(t[e.key])) e.set(t[e.key]); break;
      case 'boolean': if (typeof t[e.key] === 'boolean') e.set(t[e.key]); break;
      case 'string': if (typeof t[e.key] === 'string') e.set(t[e.key]); break;
      default: break; // unreachable -- every non-slider entry declares a presence
    }
  });
}

// Setup UI depends on whether the active Tracking Type needs a 9-point
// calibration flow at all (iris tracking does; wink tracking doesn't), and
// hides controls that provably do nothing under wink tracking. Wink drives
// followLogic.decide() via its own explicit `winkIntent` channel (see
// followLogic.js / winkTracking.js), which is a direct up/down/strength
// signal, not a screen position — none of the gaze-point machinery below
// applies to it at all (not just "always trivially satisfied" the way it was
// under the old synthesized-point design):
//   - Recenter / Drift: both only ever adjust or consume biasX/biasY, which
//     the winkIntent branch never reads or writes.
//   - "Turn the page when my eyes reach…" (rightZoneFrac) / "Ignore glances
//     past the sides" (sheetMargin): both are gaze-point-only concepts (the
//     right-zone/line-end check, the on-sheet-x check) that the winkIntent
//     branch has no equivalent of — a wink is just "up" or "down".
//   - Head-pose comp: only affects lib/gazeMath.eyeRatios, which wink
//     tracking (lib/gazeMath.eyeBlinkScores) never calls.
//   - Eye-tracking smoothing: smooths a continuously-varying gaze position;
//     the winkIntent branch never runs decide()'s EMA smoothing step at all.
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
// Resets every registered setting (slider and non-slider alike) to the
// default captured from its element/state at registration time (before
// loadSettings() ever runs) -- so "Load defaults" now genuinely means
// everything, not just the sliders it covered pre-refactor. Uses the quiet
// set() path (like load/preset-restore), not each control's interactive
// onclick behavior, so this doesn't fire a flurry of calibration-reset
// toasts on top of the one "Defaults loaded" toast.
function resetDefaults() {
  registry.forEach((e) => e.set(e.default));
  applyBand();
  if (state.pdfDoc) renderAll();
  toast('Defaults loaded');
}

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

  // cz (camera zoom %) must be registered — and, below, restored — before
  // `auto` (auto-frame): auto's set() reads cz's current DOM value to decide
  // what to do with the real camera zoom, exactly like the pre-refactor
  // applyToggles() did (cz's field was always restored first).
  reg({
    key: 'cz', kind: 'value', presence: 'finite',
    get: () => parseFloat($('cz').value),
    set: (v) => { $('cz').value = v; },
  });
  $('cz').addEventListener('input', () => { if (!state.autoFrame) setCameraZoom(parseFloat($('cz').value) / 100); });

  const driftEntry = reg({
    key: 'drift', kind: 'toggle', presence: 'always',
    get: () => state.driftOn,
    set: (v) => {
      state.driftOn = !!v;
      $('driftBtn').classList.toggle('on', state.driftOn);
      $('driftBtn').textContent = '🎯 Drift: ' + (state.driftOn ? 'on' : 'off');
    },
  });
  $('driftBtn').onclick = () => driftEntry.set(!state.driftOn);

  const bandEntry = reg({
    key: 'band', kind: 'toggle', presence: 'always',
    get: () => state.showBand,
    set: (v) => {
      state.showBand = !!v; applyBand();
      $('showBand').textContent = state.showBand ? 'Hide band' : 'Show band';
    },
  });
  $('showBand').onclick = () => bandEntry.set(!state.showBand);

  const sysEntry = reg({
    key: 'sys', kind: 'toggle', presence: 'always',
    get: () => state.showSys,
    set: (v) => { state.showSys = !!v; renderSysMarks(); },
  });
  $('showSys').onclick = () => sysEntry.set(!state.showSys);

  const snapEntry = reg({
    key: 'snap', kind: 'toggle', presence: 'always',
    get: () => state.snapOn,
    set: (v) => {
      state.snapOn = !!v;
      if (state.snapOn && state.pdfDoc && !state.systemCentersDoc.length) detectSystems();
      $('snapBtn').classList.toggle('on', state.snapOn);
      $('snapBtn').textContent = '▦ Snap: ' + (state.snapOn ? 'on' + (state.systemCentersDoc.length ? ' (' + state.systemCentersDoc.length + ')' : '') : 'off');
    },
  });
  $('snapBtn').onclick = () => snapEntry.set(!state.snapOn);

  $('webcamToggle').onclick = () => { const c = $('camview'); c.style.display = c.style.display === 'block' ? 'none' : 'block'; };
  $('dotToggle').onclick = () => { state.showGaze = !state.showGaze; gazeEl.style.display = state.showGaze ? 'block' : 'none'; };

  const autoEntry = reg({
    key: 'auto', kind: 'toggle', presence: 'boolean',
    get: () => state.autoFrame,
    set: (v) => {
      state.autoFrame = !!v;
      $('autoFrameToggle').classList.toggle('on', state.autoFrame);
      $('autoFrameToggle').textContent = '🔍 Auto-frame face: ' + (state.autoFrame ? 'on' : 'off');
      if (state.autoFrame) $('czv').textContent = 'auto'; else setCameraZoom(parseFloat($('cz').value) / 100);
    },
  });
  $('autoFrameToggle').onclick = () => autoEntry.set(!state.autoFrame);
  autoEntry.set(state.autoFrame); // apply the czv/setCameraZoom side effect for the initial state

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
  const trackingEntry = reg({
    key: 'tracking', kind: 'value', presence: 'string',
    get: () => state.trackingType,
    set: (v) => { setTrackingType(v); $('trackingType').value = state.trackingType; applyTrackingTypeUI(); },
  });
  $('trackingType').onchange = () => {
    trackingEntry.set($('trackingType').value);
    state.calibrated = false; state.coefX = state.coefY = null; state.gnorm = null;
    state.capturing = null;
    // If a calibration was left open mid-flow (started, then abandoned by
    // switching tracking type instead of finishing it), it never otherwise
    // gets hidden — it would just sit there, invisible only for as long as
    // some higher-z-index overlay happened to be covering it.
    $('calib').style.display = 'none';
    resetWinkTrackingState();
    $('calibBtn').textContent = '🎯 Calibrate';
    setStatus('s-warn', getActiveTracking().needsCalibration ? 'tracking type changed — recalibrate' : 'tracking type changed — ready to follow');
    toast('Switched to ' + getActiveTracking().label);
  };

  const winkStrengthEntry = reg({
    key: 'winkStrength', kind: 'value', presence: 'finite',
    get: () => state.winkStrength,
    set: (v) => {
      state.winkStrength = v;
      $('ws').value = Math.round(v * 100);
      $('wsv').textContent = Math.round(v * 100) + '%';
    },
  });
  $('ws').addEventListener('input', () => { winkStrengthEntry.set(parseFloat($('ws').value) / 100); });
  $('wsv').textContent = $('ws').value + '%';

  // Calibrated wink open/closed thresholds — set only via winkCalibrate.js's
  // calibration flow (no direct slider), but still persisted/restored here
  // like every other setting.
  reg({
    key: 'winkClosedThreshold', kind: 'value', presence: 'finiteOrNull',
    get: () => state.winkClosedThreshold,
    set: (v) => { state.winkClosedThreshold = v; },
  });
  reg({
    key: 'winkGapThreshold', kind: 'value', presence: 'finiteOrNull',
    get: () => state.winkGapThreshold,
    set: (v) => { state.winkGapThreshold = v; },
  });

  // head-pose compensation toggle — switching feature space invalidates calibration
  const poseEntry = reg({
    key: 'pose', kind: 'toggle', presence: 'boolean',
    get: () => state.usePose,
    set: (v) => {
      state.usePose = !!v;
      $('poseToggle').classList.toggle('on', state.usePose);
      $('poseToggle').textContent = '🧭 Head-pose comp: ' + (state.usePose ? 'on' : 'off');
    },
  });
  $('poseToggle').onclick = () => {
    poseEntry.set(!state.usePose);
    state.calibrated = false; state.coefX = state.coefY = null; state.gnorm = null;
    $('runBtn').disabled = true; $('testBtn').disabled = true;
    $('calibBtn').textContent = '🎯 Calibrate';
    setStatus('s-warn', 'mode changed — recalibrate');
    toast('Recalibrate for ' + (state.usePose ? 'head-pose' : 'basic') + ' mode');
  };

  // bpm/beatsPerMeasure/tempoPct are the auto-scroll tempo controls — their
  // live sliders and interactive side effects (rebuildScheduleLive(),
  // per-section memory, the tempo HUD) live in autoScrollUI.js, out of this
  // module's scope. These entries exist only so save/load/presets/reset can
  // reach the same fields and DOM readouts settings.js has always restored
  // (quietly, without those extra live-only side effects, matching
  // pre-refactor applyToggles()).
  reg({
    key: 'bpm', kind: 'value', presence: 'finite',
    get: () => state.autoScroll.bpm,
    set: (v) => { state.autoScroll.bpm = v; $('bpmInput').value = v; $('bpmV').textContent = v + ' bpm'; },
  });
  reg({
    key: 'beatsPerMeasure', kind: 'value', presence: 'finite',
    get: () => state.autoScroll.beatsPerMeasure,
    set: (v) => { state.autoScroll.beatsPerMeasure = v; $('beatsPerMeasure').value = v; $('beatsPerMeasureV').textContent = String(v); },
  });
  reg({
    key: 'tempoPct', kind: 'value', presence: 'finite',
    get: () => state.autoScroll.tempoPct,
    set: (v) => { state.autoScroll.tempoPct = v; $('tempoPct').value = Math.round(v * 100); $('tempoPctV').textContent = Math.round(v * 100) + '%'; },
  });
}

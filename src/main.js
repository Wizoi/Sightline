import './style.css';
import { state } from './appState.js';
import { $, toast, setStatus, showRecalBanner, hideRecalBanner, applyBand } from './ui.js';
import { loadPdf, renderAll } from './pdf.js';
import { startCamera } from './camera.js';
import { runCalibration, recenter, currentFingerprint } from './calibration.js';
import { calibMismatch } from './lib/calibrationModel.js';
import { runAccuracyTest, beginAccuracySequence } from './accuracyTest.js';
import { runWinkCalibration, beginWinkCalibrationSequence } from './winkCalibrate.js';
import { startFollowLoop, setFollowing } from './followController.js';
import { initSettingsUI, loadSettings } from './settings.js';
import { initAutoScrollUI, pauseAutoScrollUI } from './autoScrollUI.js';
import { startAutoScrollLoop } from './autoScrollController.js';
import { initTabsUI } from './tabsUI.js';

initSettingsUI();
initAutoScrollUI();
initTabsUI();

/* ---------------------------------------------------------------------- *
 *  Primary controls
 * ---------------------------------------------------------------------- */
$('loadBtn').onclick = () => $('file').click();
$('file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => loadPdf(reader.result);
  reader.onerror = () => { setStatus('s-bad', 'could not read that file'); toast('Could not load PDF — try another file'); };
  reader.readAsArrayBuffer(f);
};
$('camBtn').onclick = startCamera;
$('calibBtn').onclick = runCalibration;
$('runBtn').onclick = () => {
  const turningOn = !state.following;
  // Eye/wink tracking and time-based Auto-scroll are alternatives, not
  // used together — both drive window.scrollTo() on their own rAF loop,
  // so running both at once would have them fight over scroll position.
  if (turningOn && state.autoScroll.playing) {
    pauseAutoScrollUI();
    toast('Auto-scroll paused — switched to Follow eyes');
  } else {
    toast(turningOn ? 'Following' : 'Paused');
  }
  setFollowing(turningOn);
};
$('recenterBtn').onclick = recenter;
$('testBtn').onclick = runAccuracyTest;
$('accStart').onclick = beginAccuracySequence;
$('accRecal').onclick = () => { $('accres').style.display = 'none'; runCalibration(); };
$('accClose').onclick = () => { $('accres').style.display = 'none'; };
$('winkCalibrateBtn').onclick = runWinkCalibration;
$('winkTestStart').onclick = beginWinkCalibrationSequence;
$('winkTestRetry').onclick = () => { $('winkTestRes').style.display = 'none'; runWinkCalibration(); };
$('winkTestClose').onclick = () => { $('winkTestRes').style.display = 'none'; };
$('recalNow').onclick = () => { hideRecalBanner(); runCalibration(); };
$('recalDismiss').onclick = hideRecalBanner;

// Foot pedal / mouse click anywhere on the score = pause toggle
// (clicks on the control panel and overlays are ignored).
document.addEventListener('mousedown', (e) => {
  if (e.target.closest && e.target.closest('#panel, #calib, #acctest, #accres, #winkTest, #winkTestRes, #recal')) return;
  if (!$('runBtn').disabled) $('runBtn').click();
});
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (state.calibrated) showRecalBanner(['camera list changed']);
  });
}

/* ---------------------------------------------------------------------- *
 *  Panel minimize
 * ---------------------------------------------------------------------- */
function toggleMin() {
  const min = $('panel').classList.toggle('min');
  document.documentElement.style.setProperty('--pane', min ? '46px' : '320px');
  $('minBtn').textContent = min ? '»' : '«';
  $('minBtn').title = (min ? 'Expand panel' : 'Collapse panel') + ' (M)';
  if (state.pdfDoc) renderAll();     // reflow the music to the new width
}
$('minBtn').onclick = toggleMin;

/* ---------------------------------------------------------------------- *
 *  Keyboard fallback
 * ---------------------------------------------------------------------- */
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (e.code === 'Space') { e.preventDefault(); $('runBtn').click(); }
  else if (e.code === 'ArrowDown') window.scrollBy(0, 60);
  else if (e.code === 'ArrowUp') window.scrollBy(0, -60);
  else if (e.key.toLowerCase() === 'c') runCalibration();
  else if (e.key.toLowerCase() === 'r') recenter();
  else if (e.key.toLowerCase() === 'b') { $('showBand').click(); }
  else if (e.key.toLowerCase() === 'm') toggleMin();
});

// Debounced so a drag-resize re-renders once after it settles, not on every
// intermediate event — renderAll() itself is also safe to call repeatedly
// (see its generation-counter guard), but there's no reason to re-render
// every PDF page several times a second while the window is mid-drag.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.pdfDoc) renderAll();
    if (state.calibrated && state.calibFp) {
      const reasons = calibMismatch(state.calibFp, currentFingerprint());
      if (reasons.length) showRecalBanner(reasons);
    }
  }, 400);
});

/* ---------------------------------------------------------------------- *
 *  Boot
 * ---------------------------------------------------------------------- */
const hadSaved = loadSettings();
applyBand();
$('showBand').textContent = state.showBand ? 'Hide band' : 'Show band';
setStatus('', hadSaved ? 'saved settings loaded' : 'idle');
startFollowLoop();
startAutoScrollLoop();

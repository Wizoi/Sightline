import { cfg, state } from './appState.js';
import { followGate } from './tracking/index.js';

export const $ = (id) => document.getElementById(id);

export const scoreEl = $('score'), bandEl = $('band'), emptyEl = $('empty');
export const statusDot = $('statusDot'), statusText = $('statusText');
export const zoneText = $('zoneText'), velText = $('velText');
export const calibEl = $('calib'), video = $('cam'), gazeEl = $('gaze'), sysMarksEl = $('sysMarks');

export function setStatus(cls, text) {
  statusDot.className = 'dot ' + cls;
  statusText.textContent = text;
}

export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1400);
}

// The reading band + "line-end" marker are eye/wink-tracking concepts —
// hidden whenever the Tempo tab is the active one (not just while
// auto-scroll happens to be playing — it was still showing while paused
// on that tab, which is exactly as irrelevant) or while auto-scroll is
// actively playing even if the user has switched back to the Eye/Wink tab
// to peek at something (tabs are a pure visibility toggle, not a stop —
// see tabsUI.js — so auto-scroll can still be running underneath).
export function applyBand() {
  const tempoTabActive = $('tabAutoScroll') && $('tabAutoScroll').classList.contains('active');
  bandEl.style.display = (state.showBand && !state.autoScroll.playing && !tempoTabActive) ? 'block' : 'none';
  bandEl.style.top = (cfg.bandPos * 100) + 'vh';
  bandEl.style.height = (cfg.deadZoneFrac * 2 * 100) + 'vh';
  $('rightMark').style.left = (cfg.rightZoneFrac * 100) + 'vw';
}

// Keeps the single Start/Pause auto-scroll button in sync with playback and
// analysis state. Lives here (not autoScrollUI.js) so autoScrollController.js
// and pdf.js can both call it -- autoScrollUI.js already imports FROM
// autoScrollController.js, so putting it there would create an import cycle.
// Called from: autoScrollController.js's startAutoScroll()/pauseAutoScroll()/
// stopAutoScroll()/tick() (reaching the end of a piece flips `playing`
// without going through a click handler), and pdf.js (a re-render
// invalidating a stale analysis mid-playback must NOT disable this button,
// since it's the only way to pause what's still actively playing).
export function syncAutoScrollButton() {
  const as = state.autoScroll;
  const btn = $('autoScrollStart');
  if (!btn) return;
  if (as.playing) {
    btn.disabled = false;
    btn.textContent = '⏸ Pause auto-scroll';
  } else {
    btn.disabled = !as.analyzed || !as.measuresPerSystem.length;
    btn.textContent = '▶ Start auto-scroll';
  }
}

export function showRecalBanner(reasons) {
  $('recalMsg').textContent = 'Setup changed (' + reasons.join(', ') + ') — recalibrate for best accuracy.';
  $('recal').style.display = 'flex';
}
export function hideRecalBanner() {
  $('recal').style.display = 'none';
}

// Single place that decides which controls are clickable right now.
// Previously each module flipped `disabled` on whichever buttons it happened
// to know about, which left several controls looking available while doing
// nothing when clicked (Recenter and wink calibration before the camera is
// on; Analyze score with no PDF loaded). A button that appears enabled and
// silently no-ops reads as a broken app rather than as a missing
// prerequisite, so the rule here is: if it can't work yet, it's visibly
// disabled, with a title saying what's missing.
//
// Lives in ui.js on purpose: nearly every module already imports from here,
// and this file imports almost nothing, so calling it from camera/pdf/
// calibration/accuracy/settings can't create an import cycle.
export function refreshControlStates() {
  const camReady = !!state.camReady;
  const hasPdf = !!state.pdfDoc;
  const calibrated = !!state.calibrated;

  const gate = (id, ok, why) => {
    const el = $(id);
    if (!el) return;
    el.disabled = !ok;
    if (ok) {
      // Restore whatever explanatory title the markup shipped with, rather
      // than clearing it outright -- several of these buttons have a real
      // description that should come back once they're usable again.
      const original = el.getAttribute('data-title') || '';
      if (original) el.title = original; else el.removeAttribute('title');
      el.removeAttribute('data-blocked');
    } else {
      // Stash the original title once, then replace it with the reason this
      // control isn't available yet -- a disabled button that says nothing
      // leaves the user guessing which prerequisite they're missing.
      if (!el.hasAttribute('data-title')) el.setAttribute('data-title', el.title || '');
      el.title = why;
      el.setAttribute('data-blocked', why);
    }
  };

  gate('calibBtn', camReady, 'Start the camera first');
  gate('calibFallbackBtn', camReady, 'Start the camera first');
  gate('winkCalibrateBtn', camReady, 'Start the camera first');
  gate('testBtn', camReady && calibrated, 'Calibrate first');
  gate('recenterBtn', camReady && calibrated, 'Calibrate first');
  gate('analyzeScoreBtn', hasPdf, 'Load a PDF first');
  gate('showSys', hasPdf, 'Load a PDF first');

  // "Follow eyes" has the longest prerequisite chain, so it gets a reason
  // naming the specific missing step rather than a generic one. It used to be
  // set by half a dozen callers as `disabled = !canFollow()` with no
  // explanation at all, which meant the most-gated button in the app was also
  // the one that explained itself least -- reported from real use as "after
  // verify, follow eyes is still not enabled" with no way to see why.
  const [followOk, followWhy] = followGate();
  gate('runBtn', followOk, followWhy);
}


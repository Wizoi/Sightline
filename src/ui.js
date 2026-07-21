import { cfg, state } from './appState.js';

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

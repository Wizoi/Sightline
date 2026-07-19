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

export function applyBand() {
  bandEl.style.display = state.showBand ? 'block' : 'none';
  bandEl.style.top = (cfg.bandPos * 100) + 'vh';
  bandEl.style.height = (cfg.deadZoneFrac * 2 * 100) + 'vh';
  $('rightMark').style.left = (cfg.rightZoneFrac * 100) + 'vw';
}

export function showRecalBanner(reasons) {
  $('recalMsg').textContent = 'Setup changed (' + reasons.join(', ') + ') — recalibrate for best accuracy.';
  $('recal').style.display = 'flex';
}
export function hideRecalBanner() {
  $('recal').style.display = 'none';
}

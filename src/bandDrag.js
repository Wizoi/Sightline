import { cfg } from './appState.js';
import { $, bandEl } from './ui.js';
import { regionAt, halfHeightFrom, pinchScale } from './lib/bandGeometry.js';

/* ---------------------------------------------------------------------- *
 *  Direct manipulation of the reading band
 *
 *  The band's three properties used to be adjustable only as sliders in the
 *  settings panel — "Reading zone size", "Where you read on screen", and
 *  "Turn the page when my eyes reach…". Every one of them is a spatial
 *  property of a thing already drawn on screen, so a slider is a poor
 *  control for it: the user has to look away from the band, move an
 *  abstract handle, look back, and repeat. Dragging the band itself is the
 *  same edit with the feedback loop closed.
 *
 *  Deliberately drives the EXISTING sliders (setting `.value` and
 *  dispatching `input`) rather than writing `cfg` directly. Those sliders
 *  remain in the DOM, hidden, as the app's store for these values: they are
 *  what settings.js's registry saves, restores, applies to `cfg`, and what
 *  per-piece presets capture. Writing cfg here instead would silently
 *  desync all of that, and any drag would be forgotten on reload.
 * ---------------------------------------------------------------------- */

// A press that never travels this far is a click, not a drag, and is passed
// through to the app's click-anywhere-to-pause behavior (see main.js). The
// band sits over the music, so swallowing taps there would quietly break
// pausing for anyone whose reading band covers where they'd tap.
const CLICK_SLOP_PX = 4;

function setSlider(id, value01) {
  const el = $(id);
  if (!el) return;
  const min = parseFloat(el.min), max = parseFloat(el.max);
  const v = Math.round(Math.min(max, Math.max(min, value01 * 100)));
  if (String(v) === el.value) return;
  el.value = String(v);
  // Goes through the normal input path so settings.js's own binding updates
  // cfg and re-renders the band, exactly as a slider drag would.
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function initBandDrag() {
  let drag = null;                       // { mode, pointerId, startX, startY, grabOffset, moved }
  const pointers = new Map();            // active pointers, for pinch
  let pinchStart = null;                 // { spreadPx, deadZoneFrac }

  const vh = () => window.innerHeight;
  const vw = () => window.innerWidth;

  function onDown(e) {
    if (bandEl.style.display === 'none') return;
    pointers.set(e.pointerId, e);

    // Two fingers on the band = pinch to resize, which supersedes any
    // single-pointer drag already in progress.
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { spreadPx: Math.abs(a.clientY - b.clientY), deadZoneFrac: cfg.deadZoneFrac };
      drag = null;
      return;
    }
    if (pointers.size > 2) return;

    const rect = bandEl.getBoundingClientRect();
    const onMark = e.target && e.target.id === 'rightMark';
    const mode = onMark ? 'right' : regionAt(e.clientY, rect);
    drag = {
      mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      // Moving keeps the grab point under the cursor instead of snapping the
      // band's center to it.
      grabOffset: e.clientY - (cfg.bandPos * vh()),
      moved: false,
    };
    // Capture keeps the drag alive when the pointer leaves the band, which
    // it does constantly — resizing means dragging an edge away from it.
    // Failure is survivable (window-level move/up handlers still fire), so
    // don't let it abort the drag.
    try { bandEl.setPointerCapture(e.pointerId); } catch { /* non-capturable pointer */ }
  }

  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);

    if (pinchStart && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const spread = Math.abs(a.clientY - b.clientY);
      setSlider('dz', pinchStart.deadZoneFrac * pinchScale(pinchStart.spreadPx, spread));
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (Math.abs(e.clientX - drag.startX) > CLICK_SLOP_PX
      || Math.abs(e.clientY - drag.startY) > CLICK_SLOP_PX) drag.moved = true;

    if (drag.mode === 'right') setSlider('rt', e.clientX / vw());
    else if (drag.mode === 'middle') setSlider('bp', (e.clientY - drag.grabOffset) / vh());
    else setSlider('dz', halfHeightFrom(e.clientY, vh(), cfg.bandPos));
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasClick = !drag.moved;
    drag = null;
    try { bandEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // A tap (no travel) falls through to pause/resume, preserving
    // click-anywhere-on-the-music behavior through the band.
    if (wasClick && !$('runBtn').disabled) $('runBtn').click();
  }

  // Cursor affordance: the band is only interactive while it's visible, and
  // which cursor depends on where you are within it.
  function onHover(e) {
    if (drag || bandEl.style.display === 'none') return;
    if (e.target && e.target.id === 'rightMark') { bandEl.style.cursor = 'ew-resize'; return; }
    const r = regionAt(e.clientY, bandEl.getBoundingClientRect());
    bandEl.style.cursor = r === 'middle' ? 'grab' : 'ns-resize';
  }

  bandEl.addEventListener('pointerdown', onDown);
  bandEl.addEventListener('pointermove', onHover);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

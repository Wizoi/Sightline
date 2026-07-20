import { cfg, state } from '../appState.js';
import { eyeBlinkScores } from '../lib/gazeMath.js';
import { createWinkState, decideWink } from '../lib/winkLogic.js';
import { deadZoneBounds } from '../lib/followLogic.js';

export const id = 'wink';
export const label = 'Wink tracking (left eye = up, right eye = down)';
export const needsCalibration = false;

// Long enough to filter a normal blink's brief eye-to-eye timing skew (they
// rarely close in perfect lockstep), short enough not to stack badly with
// followLogic.decide()'s own hold (cfg.holdMs, 350ms by default), which runs
// after this on every synthesized wink point.
const WINK_HOLD_MS = 120;

let winkState = createWinkState();
export function resetWinkTrackingState() { winkState = createWinkState(); }

// Per frame: read MediaPipe's per-eye blink scores, debounce them into a
// committed left/right wink (lib/winkLogic.js), then — if one just
// committed — synthesize a screen-fraction gaze point that sits past the
// reading band's dead-zone edge in that direction. It plugs straight into
// the same up/down trigger path real gaze uses (followLogic.decide()) — no
// changes needed there.
//
// The dead-zone edge must be computed with decide()'s own *capped* geometry
// (lib/followLogic.js's deadZoneBounds), not raw cfg.deadZoneFrac — decide()
// caps the dead zone per direction so a band positioned near the top of the
// screen can't make the "up" trigger unreachable, and a synthesized point
// that ignores that cap can land back inside the (now-larger, uncapped) dead
// zone it was meant to clear, silently never triggering. viewportH defaults
// to a representative laptop viewport height for callers (e.g. tests) that
// don't have a real window to measure.
export function onFrame(_lm, res, _procW, _procH, viewportH = 800) {
  const { left, right } = eyeBlinkScores(res);
  state.winkScores = { left, right };   // live debug readout, shown in Setup
  const now = performance.now();
  const result = decideWink(winkState, {
    left, right, now, holdMs: WINK_HOLD_MS,
    // Personal values from Calibrate wink sensitivity, when available —
    // undefined here falls back to lib/winkLogic.js's fixed defaults.
    closedThreshold: state.winkClosedThreshold ?? undefined,
    gapThreshold: state.winkGapThreshold ?? undefined,
  });
  winkState = result.state;
  if (!result.wink) return null;

  // Place the point at a fraction ("depth") of the way *through* the real
  // reachable trigger sliver, rather than a fixed reach past its edge — the
  // sliver's own size is capped by deadZoneBounds and can be as small as
  // ~8px (band near the top + a wide dead zone), so a fixed absolute reach
  // can overshoot straight past a tiny sliver and back out the other side.
  // depth 0..1 always lands strictly inside (never touches either edge, so
  // it can never register as "looking away" — see decide()'s onScreenY
  // check): strength 0 -> just inside the near edge (still has to clear
  // decide()'s own hold timer, like a real gentle glance); strength 1 ->
  // pushed deep into the zone, close to (but never at) the far edge.
  const depth = 0.15 + 0.8 * state.winkStrength;
  const { center, deadUp, deadDown } = deadZoneBounds(cfg, viewportH);
  const rawY = result.wink === 'left'
    ? (center - deadUp) * (1 - depth)                       // zone is (0, center-deadUp)
    : (center + deadDown) + depth * (viewportH - (center + deadDown)); // zone is (center+deadDown, H)
  return { ux: 0.5, uy: rawY / viewportH };
}

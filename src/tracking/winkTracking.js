import { cfg, state } from '../appState.js';
import { eyeBlinkScores } from '../lib/gazeMath.js';
import { createWinkState, decideWink } from '../lib/winkLogic.js';

export const id = 'wink';
export const label = 'Wink tracking (left eye = up, right eye = down)';
export const needsCalibration = false;

const WINK_HOLD_MS = 220;

let winkState = createWinkState();
export function resetWinkTrackingState() { winkState = createWinkState(); }

// Per frame: read MediaPipe's per-eye blink scores, debounce them into a
// committed left/right wink (lib/winkLogic.js), then — if one just
// committed — synthesize a screen-fraction gaze point that sits past the
// reading band's dead-zone edge in that direction. It plugs straight into
// the same up/down trigger path real gaze uses (followLogic.decide()) — no
// changes needed there.
export function onFrame(_lm, res) {
  const { left, right } = eyeBlinkScores(res);
  state.winkScores = { left, right };   // live debug readout, shown in Setup
  const now = performance.now();
  const result = decideWink(winkState, { left, right, now, holdMs: WINK_HOLD_MS });
  winkState = result.state;
  if (!result.wink) return null;

  // strength 0 -> just past the dead-zone edge (still has to clear decide()'s
  // own hold timer, like a real gentle glance); strength 1 -> a strong push.
  const reach = 0.02 + 0.4 * state.winkStrength;
  const uy = result.wink === 'left'
    ? cfg.bandPos - cfg.deadZoneFrac - reach
    : cfg.bandPos + cfg.deadZoneFrac + reach;
  return { ux: 0.5, uy };
}

import { state } from '../appState.js';
import { eyeBlinkScores } from '../lib/gazeMath.js';
import { createWinkState, decideWink } from '../lib/winkLogic.js';

export const id = 'wink';
export const label = 'Wink tracking (left eye = up, right eye = down)';
export const needsCalibration = false;

// Long enough to filter a normal blink's brief eye-to-eye timing skew (they
// rarely close in perfect lockstep), short enough not to stack badly with
// followLogic.decide()'s own hold (cfg.holdMs, 350ms by default), which runs
// after this on every committed wink frame.
const WINK_HOLD_MS = 120;

let winkState = createWinkState();
export function resetWinkTrackingState() { winkState = createWinkState(); }

// Per frame: read MediaPipe's per-eye blink scores, debounce them into a
// committed left/right wink (lib/winkLogic.js), then — while one is held —
// report a direct "scroll up"/"scroll down" intent for followLogic.decide()'s
// explicit `winkIntent` channel. This used to synthesize a fake on-screen
// gaze point positioned just past decide()'s dead-zone edge instead, which
// worked but was fragile: the synthesized point had to exactly track
// decide()'s own capped, per-direction dead-zone geometry (deadZoneBounds) to
// avoid landing back inside the zone it was meant to clear, and that broke
// once already (see PERSONAS.md section 5). A direct intent has no geometry
// to get out of sync with in the first place — wink tracking was never
// really "looking" anywhere, so it no longer pretends to.
export function onFrame(_lm, res) {
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

  // strength is a direct 0..1 dial (Wink strength slider) — decide() maps it
  // straight to scroll speed in smooth mode; snap mode ignores it (a snap
  // trigger is a boolean, not a magnitude).
  return { intent: result.wink === 'left' ? 'up' : 'down', strength: state.winkStrength };
}

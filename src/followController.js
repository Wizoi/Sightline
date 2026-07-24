import { cfg, state } from './appState.js';
import { $, setStatus, zoneText, velText } from './ui.js';
import { createFollowState, decide } from './lib/followLogic.js';
import { describeWinkStatus } from './lib/winkStatus.js';

let followState = createFollowState();
let lastFrame = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;
  if (!state.following) { velText.textContent = '0'; return; }

  const result = decide(followState, {
    now, dt, cfg, biasY: state.biasY,
    rawGaze: state.rawGaze,
    winkIntent: state.winkIntent,
    driftOn: state.driftOn, snapOn: state.snapOn, systemCentersDoc: state.systemCentersDoc,
    scrollY: window.scrollY,
    docMax: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    viewportW: window.innerWidth, viewportH: window.innerHeight,
  });

  followState = result.state;
  state.biasY = result.biasY;

  if (result.scroll) {
    if (result.scroll.type === 'by') window.scrollBy(0, result.scroll.amount);
    else window.scrollTo(0, result.scroll.y);
  }
  // decide() only knows about gaze zones/timing, not which Tracking Type
  // produced the point — translate its status into wink-phrased text when
  // that's the active type, rather than always showing gaze language.
  const status = state.trackingType === 'wink'
    ? describeWinkStatus(result.status, result.zoneText)
    : result.status;
  setStatus(status.cls, status.text);
  zoneText.textContent = result.zoneText;
  velText.textContent = result.velText;
}

export function clearSnapTarget() {
  followState = { ...followState, snapTarget: null };
}

export function startFollowLoop() {
  requestAnimationFrame(tick);
}

// Central place to flip state.following on/off, so every caller (the
// runBtn click, the foot-pedal/click-anywhere handler, the Space key, and
// autoScrollUI.js pausing this when auto-scroll starts) gets the same
// button-text/status/snap-target bookkeeping instead of duplicating it.
export function setFollowing(on) {
  state.following = on;
  $('runBtn').textContent = on ? '⏸ Following…' : '▶ Follow eyes';
  if (!on) { setStatus('', 'paused'); clearSnapTarget(); }
}

import { cfg, state } from './appState.js';
import { setStatus, zoneText, velText } from './ui.js';
import { createFollowState, decide } from './lib/followLogic.js';

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
  setStatus(result.status.cls, result.status.text);
  zoneText.textContent = result.zoneText;
  velText.textContent = result.velText;
}

export function clearSnapTarget() {
  followState = { ...followState, snapTarget: null };
}

export function startFollowLoop() {
  requestAnimationFrame(tick);
}

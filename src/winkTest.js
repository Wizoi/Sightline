import { state } from './appState.js';
import { $, toast } from './ui.js';
import { createWinkState, decideWink } from './lib/winkLogic.js';

// Per-eye self-test for wink detection: holds each eye's wink in turn,
// samples the live blink scores camera.js/winkTracking.js are already
// producing, and runs them through the *real* decideWink() logic (a fresh,
// isolated instance — doesn't touch the live wink-tracking state) so the
// result reflects exactly what would happen while actually using the app.
const PHASE_MS = 3000;   // how long to sample each eye's hold
const SETTLE_MS = 600;   // pause before sampling, so there's time to react
const TEST_HOLD_MS = 120; // matches winkTracking.js's WINK_HOLD_MS

export function runWinkTest() {
  if (!state.camReady) { toast('Start the camera first'); return; }
  $('winkTestMsg').textContent = '';
  $('winkTestIntro').style.display = 'block';
  $('winkTest').style.display = 'block';
}

export function beginWinkTestSequence() {
  $('winkTestIntro').style.display = 'none';
  const eyes = ['left', 'right'];
  const results = {};
  let idx = 0;

  function nextEye() {
    if (idx >= eyes.length) { finishWinkTest(results); return; }
    const eye = eyes[idx];
    $('winkTestMsg').textContent = `Get ready to wink your ${eye.toUpperCase()} eye…`;
    setTimeout(() => sampleEye(eye), SETTLE_MS);
  }

  function sampleEye(eye) {
    $('winkTestMsg').textContent = `Hold your ${eye.toUpperCase()} eye wink now…`;
    let testState = createWinkState();
    let detected = false;
    let peakOwn = 0, peakOther = 0, peakGap = -1;
    const t0 = performance.now();

    function collect() {
      const now = performance.now();
      const { left, right } = state.winkScores;
      const own = eye === 'left' ? left : right;
      const other = eye === 'left' ? right : left;
      if (own > peakOwn) peakOwn = own;
      if (other > peakOther) peakOther = other;
      const gap = own - other;
      if (gap > peakGap) peakGap = gap;

      const r = decideWink(testState, { left, right, now, holdMs: TEST_HOLD_MS });
      testState = r.state;
      if (r.wink === eye) detected = true;

      if (now - t0 < PHASE_MS) { requestAnimationFrame(collect); } else {
        results[eye] = { detected, peakOwn, peakOther, peakGap };
        idx++; nextEye();
      }
    }
    requestAnimationFrame(collect);
  }

  nextEye();
}

function finishWinkTest(results) {
  $('winkTest').style.display = 'none';
  const bothOk = results.left.detected && results.right.detected;
  $('winkTestGrade').textContent = bothOk ? 'Both eyes detected ✓' : 'Needs attention';
  $('winkTestGrade').style.color = bothOk ? 'var(--good)' : 'var(--warn)';

  const pct = (x) => Math.round(x * 100);
  const line = (label, r) => {
    const status = r.detected ? '<span style="color:var(--good)">✓ detected</span>' : '<span style="color:var(--bad)">✗ not detected</span>';
    return `<b>${label}</b>: ${status} — peak ${pct(r.peakOwn)}%, other eye peaked ${pct(r.peakOther)}%, best gap ${pct(r.peakGap)}%`;
  };
  $('winkTestNums').innerHTML = line('Left eye', results.left) + '<br>' + line('Right eye', results.right);

  const s = [];
  for (const eye of ['left', 'right']) {
    const r = results[eye];
    if (r.detected) continue;
    if (r.peakOwn < 0.3) {
      s.push(`${eye === 'left' ? 'Left' : 'Right'} eye never crossed the closed threshold (peaked at ${pct(r.peakOwn)}%, needs 30%+) — try closing it more firmly, or improve lighting/the camera's angle on that side.`);
    } else {
      s.push(`${eye === 'left' ? 'Left' : 'Right'} eye crossed the threshold, but the other eye rose too close to it at the same time (best gap only ${pct(r.peakGap)}%, needs 8%+) — try to keep the other eye more relaxed while winking.`);
    }
  }
  if (!s.length) s.push('Both eyes are reliably distinguishable — wink tracking should work well.');
  $('winkTestSug').innerHTML = s.map((x) => '<li>' + x + '</li>').join('');

  $('winkTestRes').style.display = 'flex';
}

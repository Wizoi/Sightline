import { state } from './appState.js';
import { $, toast } from './ui.js';
import { createWinkState, decideWink, DEFAULT_CLOSED_THRESHOLD, DEFAULT_GAP_THRESHOLD } from './lib/winkLogic.js';
import { deriveWinkThresholds, isUsableCalibration } from './lib/winkCalibration.js';
import { persistSettings } from './settings.js';

// Shared self-test / calibration flow for wink detection: holds each eye's
// wink in turn, samples the live blink scores camera.js/winkTracking.js are
// already producing, and (for the test) runs them through the *real*
// decideWink() logic in an isolated instance — doesn't touch the live
// wink-tracking state — so results reflect exactly what the app would do.
const PHASE_MS = 3000;    // how long to sample each eye's hold
const REST_MS = 1500;     // how long to sample the resting baseline
const SETTLE_MS = 600;    // pause before sampling, so there's time to react
const SAMPLE_HOLD_MS = 120; // matches winkTracking.js's WINK_HOLD_MS

let mode = 'test'; // 'test' | 'calibrate'

export function runWinkTest() {
  if (!state.camReady) { toast('Start the camera first'); return; }
  mode = 'test';
  $('winkTestMsg').textContent = '';
  $('winkTestIntroText').textContent =
    "Checks each eye independently against your current settings. When prompted, hold that eye's wink for the whole countdown — the other eye should stay relaxed and open. Takes about 8 seconds.";
  $('winkTestIntro').style.display = 'block';
  $('winkTest').style.display = 'block';
}

export function runWinkCalibration() {
  if (!state.camReady) { toast('Start the camera first'); return; }
  mode = 'calibrate';
  $('winkTestMsg').textContent = '';
  $('winkTestIntroText').textContent =
    'Measures your own eyes to set personal sensitivity, instead of one-size-fits-all defaults. First relax both eyes, then hold each wink in turn when prompted. Takes about 10 seconds.';
  $('winkTestIntro').style.display = 'block';
  $('winkTest').style.display = 'block';
}

// "Test again" on the results screen should re-run whichever flow produced
// those results, not always the plain test.
export function retryWinkFlow() {
  if (mode === 'calibrate') runWinkCalibration(); else runWinkTest();
}

export function resetWinkCalibration() {
  state.winkClosedThreshold = null;
  state.winkGapThreshold = null;
  persistSettings(false);
  toast('Wink sensitivity reset to defaults');
}

export function beginWinkTestSequence() {
  $('winkTestIntro').style.display = 'none';
  if (mode === 'calibrate') runCalibrationFlow();
  else runTestFlow();
}

async function runTestFlow() {
  const results = {};
  for (const eye of ['left', 'right']) {
    $('winkTestMsg').textContent = `Get ready to wink your ${eye.toUpperCase()} eye…`;
    await wait(SETTLE_MS);
    $('winkTestMsg').textContent = `Hold your ${eye.toUpperCase()} eye wink now…`;
    results[eye] = await sampleEyeHold(eye, { withDetection: true });
  }
  finishWinkTest(results);
}

async function runCalibrationFlow() {
  $('winkTestMsg').textContent = 'Relax — keep both eyes open normally…';
  await wait(SETTLE_MS);
  const { restLeft, restRight } = await sampleRest(REST_MS);

  const peaks = {};
  for (const eye of ['left', 'right']) {
    $('winkTestMsg').textContent = `Get ready to wink your ${eye.toUpperCase()} eye…`;
    await wait(SETTLE_MS);
    $('winkTestMsg').textContent = `Hold your ${eye.toUpperCase()} eye wink now…`;
    peaks[eye] = await sampleEyeHold(eye, { withDetection: false });
  }

  finishWinkCalibration({
    restLeft, restRight,
    leftPeakOwn: peaks.left.peakOwn, leftPeakOther: peaks.left.peakOther,
    rightPeakOwn: peaks.right.peakOwn, rightPeakOther: peaks.right.peakOther,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleRest(ms) {
  return new Promise((resolve) => {
    let sumLeft = 0, sumRight = 0, n = 0;
    const t0 = performance.now();
    function collect() {
      const { left, right } = state.winkScores;
      sumLeft += left; sumRight += right; n++;
      if (performance.now() - t0 < ms) requestAnimationFrame(collect);
      else resolve({ restLeft: n ? sumLeft / n : 0, restRight: n ? sumRight / n : 0 });
    }
    requestAnimationFrame(collect);
  });
}

function sampleEyeHold(eye, { withDetection }) {
  return new Promise((resolve) => {
    let testState = withDetection ? createWinkState() : null;
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

      if (withDetection) {
        const r = decideWink(testState, {
          left, right, now, holdMs: SAMPLE_HOLD_MS,
          closedThreshold: state.winkClosedThreshold ?? undefined,
          gapThreshold: state.winkGapThreshold ?? undefined,
        });
        testState = r.state;
        if (r.wink === eye) detected = true;
      }

      if (now - t0 < PHASE_MS) requestAnimationFrame(collect);
      else resolve({ detected, peakOwn, peakOther, peakGap });
    }
    requestAnimationFrame(collect);
  });
}

function finishWinkTest(results) {
  $('winkTest').style.display = 'none';
  const bothOk = results.left.detected && results.right.detected;
  $('winkTestGrade').textContent = bothOk ? 'Both eyes detected ✓' : 'Needs attention';
  $('winkTestGrade').style.color = bothOk ? 'var(--good)' : 'var(--warn)';

  const pct = (x) => Math.round(x * 100);
  const closed = pct(state.winkClosedThreshold ?? DEFAULT_CLOSED_THRESHOLD);
  const gap = pct(state.winkGapThreshold ?? DEFAULT_GAP_THRESHOLD);
  const line = (label, r) => {
    const status = r.detected ? '<span style="color:var(--good)">✓ detected</span>' : '<span style="color:var(--bad)">✗ not detected</span>';
    return `<b>${label}</b>: ${status} — peak ${pct(r.peakOwn)}%, other eye peaked ${pct(r.peakOther)}%, best gap ${pct(r.peakGap)}%`;
  };
  $('winkTestNums').innerHTML = line('Left eye', results.left) + '<br>' + line('Right eye', results.right)
    + `<br><span style="opacity:.8">Currently using: closed ≥ ${closed}%, gap ≥ ${gap}%${state.winkClosedThreshold != null ? ' (calibrated)' : ' (default)'}</span>`;

  const s = [];
  for (const eye of ['left', 'right']) {
    const r = results[eye];
    if (r.detected) continue;
    if (r.peakOwn < (state.winkClosedThreshold ?? DEFAULT_CLOSED_THRESHOLD)) {
      s.push(`${eye === 'left' ? 'Left' : 'Right'} eye never crossed the closed threshold (peaked at ${pct(r.peakOwn)}%, needs ${closed}%+) — try closing it more firmly, or improve lighting/the camera's angle on that side.`);
    } else {
      s.push(`${eye === 'left' ? 'Left' : 'Right'} eye crossed the threshold, but the other eye rose too close to it at the same time (best gap only ${pct(r.peakGap)}%, needs ${gap}%+) — try to keep the other eye more relaxed while winking.`);
    }
  }
  if (!s.length) s.push('Both eyes are reliably distinguishable — wink tracking should work well.');
  if (s.length && state.winkClosedThreshold == null) s.push('Try "Calibrate wink sensitivity" — it sets personal thresholds from your own eyes instead of the shared defaults.');
  $('winkTestSug').innerHTML = s.map((x) => '<li>' + x + '</li>').join('');

  $('winkTestRes').style.display = 'flex';
}

function finishWinkCalibration(sample) {
  $('winkTest').style.display = 'none';
  const pct = (x) => Math.round(x * 100);

  if (!isUsableCalibration(sample)) {
    $('winkTestGrade').textContent = "Couldn't calibrate reliably";
    $('winkTestGrade').style.color = 'var(--bad)';
    $('winkTestNums').innerHTML =
      `Left: peak ${pct(sample.leftPeakOwn)}% (other eye ${pct(sample.leftPeakOther)}%). ` +
      `Right: peak ${pct(sample.rightPeakOwn)}% (other eye ${pct(sample.rightPeakOther)}%).`;
    $('winkTestSug').innerHTML =
      '<li>One or both winks weren\'t clearly separated from the other eye — make sure you\'re holding a firm, single-eye wink for the whole countdown, then try again.</li>';
    $('winkTestRes').style.display = 'flex';
    return;
  }

  const { closedThreshold, gapThreshold } = deriveWinkThresholds(sample);
  state.winkClosedThreshold = closedThreshold;
  state.winkGapThreshold = gapThreshold;
  persistSettings(false);

  $('winkTestGrade').textContent = 'Calibrated ✓';
  $('winkTestGrade').style.color = 'var(--good)';
  $('winkTestNums').innerHTML =
    `Rest: left ${pct(sample.restLeft)}%, right ${pct(sample.restRight)}%.<br>` +
    `Left wink peak ${pct(sample.leftPeakOwn)}% (other eye ${pct(sample.leftPeakOther)}%). ` +
    `Right wink peak ${pct(sample.rightPeakOwn)}% (other eye ${pct(sample.rightPeakOther)}%).<br>` +
    `New thresholds: closed ≥ ${pct(closedThreshold)}%, gap ≥ ${pct(gapThreshold)}%.`;
  $('winkTestSug').innerHTML = '<li>Saved — wink tracking now uses these personal thresholds. Run "Test wink detection" to confirm.</li>';
  $('winkTestRes').style.display = 'flex';
  toast('Wink sensitivity calibrated');
}

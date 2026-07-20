import { state } from './appState.js';
import { $, toast } from './ui.js';
import { DEFAULT_CLOSED_THRESHOLD, DEFAULT_GAP_THRESHOLD } from './lib/winkLogic.js';
import { deriveWinkThresholds, isUsableCalibration } from './lib/winkCalibration.js';
import { persistSettings } from './settings.js';

// Wink sensitivity calibration: samples both eyes at rest, then each eye's
// wink held in turn, and derives personal detection thresholds from the
// actual peaks/gaps observed (lib/winkCalibration.js) instead of the fixed
// defaults everyone otherwise shares.
const PHASE_MS = 3000;    // how long to sample each eye's hold
const REST_MS = 1500;     // how long to sample the resting baseline
const SETTLE_MS = 600;    // pause before sampling, so there's time to react

export function runWinkCalibration() {
  if (!state.camReady) { toast('Start the camera first'); return; }
  $('winkTestMsg').textContent = '';
  const current = state.winkClosedThreshold != null
    ? `closed ≥ ${Math.round(state.winkClosedThreshold * 100)}%, gap ≥ ${Math.round(state.winkGapThreshold * 100)}% (calibrated)`
    : `closed ≥ ${Math.round(DEFAULT_CLOSED_THRESHOLD * 100)}%, gap ≥ ${Math.round(DEFAULT_GAP_THRESHOLD * 100)}% (default)`;
  $('winkTestIntroText').textContent =
    `Measures your own eyes to set personal sensitivity, instead of one-size-fits-all defaults. Currently using: ${current}. ` +
    'First relax both eyes, then hold each wink in turn when prompted. Takes about 10 seconds.';
  $('winkTestIntro').style.display = 'block';
  $('winkTest').style.display = 'block';
}

export function beginWinkCalibrationSequence() {
  $('winkTestIntro').style.display = 'none';
  runCalibrationFlow();
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
    peaks[eye] = await sampleEyeHold(eye);
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

function sampleEyeHold(eye) {
  return new Promise((resolve) => {
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

      if (now - t0 < PHASE_MS) requestAnimationFrame(collect);
      else resolve({ peakOwn, peakOther, peakGap });
    }
    requestAnimationFrame(collect);
  });
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
  $('winkTestSug').innerHTML = '<li>Saved — wink tracking now uses these personal thresholds.</li>';
  $('winkTestRes').style.display = 'flex';
  toast('Wink sensitivity calibrated');
}

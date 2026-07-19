import { state } from './appState.js';
import { $, toast } from './ui.js';
import { median } from './lib/mathUtils.js';

/* ---------------------------------------------------------------------- *
 *  Accuracy test — look at targets, measure error, suggest fixes
 * ---------------------------------------------------------------------- */
const TEST_PTS = [[0.5, 0.5], [0.5, 0.12], [0.5, 0.88], [0.1, 0.5], [0.9, 0.5], [0.15, 0.15], [0.85, 0.85]];

export function runAccuracyTest() {
  if (!state.calibrated) { toast('Calibrate first'); return; }
  if (state.following) $('runBtn').click();  // pause scrolling during the test
  $('accmsg').textContent = '';
  $('accdot').style.left = '50vw';           // dot waits in the center with instructions
  $('accdot').style.top = '50vh';
  $('accdot').style.display = 'block';
  $('accintro').style.display = 'block';
  $('acctest').style.display = 'block';
}

export function beginAccuracySequence() {
  $('accintro').style.display = 'none';
  const results = [], bright = []; let noFace = 0, frames = 0, idx = 0, vHit = 0, vTot = 0;
  const third = (f) => Math.min(2, Math.max(0, Math.floor(f * 3)));

  function nextPoint() {
    if (idx >= TEST_PTS.length) { finishTest(results, bright, noFace, frames, vHit, vTot); return; }
    const [gx, gy] = TEST_PTS[idx];
    $('accdot').style.left = (gx * 100) + 'vw';
    $('accdot').style.top = (gy * 100) + 'vh';
    $('accmsg').textContent = `Look at the dot and hold… (${idx + 1}/${TEST_PTS.length})`;
    const samples = []; const t0 = performance.now();
    function collect() {
      const now = performance.now();
      frames++;
      if (!state.facePresent) noFace++;
      bright.push(state.frameBrightness);
      if (state.gazeUnclamped && now - state.gazeUnclamped.t < 200) {
        samples.push({ x: state.gazeUnclamped.x, y: state.gazeUnclamped.y });
        vTot++; if (third(state.gazeUnclamped.y) === third(gy)) vHit++;   // landed in the correct vertical third?
      }
      if (now - t0 < 1300) { requestAnimationFrame(collect); } else {
        if (samples.length >= 3) {
          const mx = median(samples.map((s) => s.x)), my = median(samples.map((s) => s.y));
          results.push({ gx, gy, ex: Math.abs(mx - gx), ey: Math.abs(my - gy) });
        } else results.push({ gx, gy, ex: 1, ey: 1 });
        idx++; nextPoint();
      }
    }
    setTimeout(() => requestAnimationFrame(collect), 450);   // settle before sampling
  }
  nextPoint();
}

function finishTest(results, bright, noFace, frames, vHit, vTot) {
  $('acctest').style.display = 'none';
  const hErr = results.reduce((a, r) => a + r.ex, 0) / results.length;
  const vErr = results.reduce((a, r) => a + r.ey, 0) / results.length;
  const eucl = results.map((r) => Math.hypot(r.ex, r.ey));
  const overall = eucl.reduce((a, e) => a + e, 0) / eucl.length;
  const rms = Math.sqrt(eucl.reduce((a, e) => a + e * e, 0) / eucl.length);
  const sorted = [...eucl].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))];
  const thirdRate = vTot ? vHit / vTot : 0;
  const br = bright.length ? bright.reduce((a, b) => a + b, 0) / bright.length : 128;
  const noFaceRatio = frames ? noFace / frames : 0;

  let grade, gcolor;
  if (overall < 0.06) { grade = 'Excellent 🎯'; gcolor = 'var(--good)'; }
  else if (overall < 0.10) { grade = 'Good'; gcolor = 'var(--good)'; }
  else if (overall < 0.16) { grade = 'Fair'; gcolor = 'var(--warn)'; }
  else { grade = 'Poor'; gcolor = 'var(--bad)'; }

  const pct = (x) => Math.round(x * 100);
  const barPct = Math.min(100, pct(overall) * 3);
  $('accgrade').textContent = 'Accuracy: ' + grade;
  $('accgrade').style.color = gcolor;
  $('accnums').innerHTML =
    `Off by about <b>${pct(overall)}%</b> of the screen on average ` +
    `(sideways ${pct(hErr)}%, up/down ${pct(vErr)}%; worst-case ${pct(p90)}%, RMS ${pct(rms)}%).<br>` +
    `You'd land on the right line about <b>${pct(thirdRate)}%</b> of the time. Room brightness ${Math.round(br)}/255.` +
    `<div class="accbar"><span style="width:${barPct}%;background:${gcolor}"></span></div>`;

  const s = [];
  if (br < 70) s.push('The room looks dark — add a light facing your face (not behind you). Iris tracking needs even light on your eyes.');
  else if (br > 230) s.push('The image is very bright/washed out — reduce backlight or glare on your face.');
  if (state.faceBox.size < 0.18) s.push('Your face is small in frame — sit a bit closer to the camera.');
  else if (state.faceBox.size > 0.55) s.push('Your face fills the frame — move back slightly.');
  if (Math.abs(state.faceBox.cx - 0.5) > 0.18 || Math.abs(state.faceBox.cy - 0.5) > 0.2) s.push('Center yourself in the camera view, and put the camera roughly at eye level.');
  if (noFaceRatio > 0.2) s.push('Your face was frequently not detected — improve lighting or camera angle, and remove strong backlight.');
  if (vErr > 0.12 && vErr > hErr * 1.5) s.push('Up/down tracking is the weak spot (normal for webcams) — raise the camera toward eye level, use a taller reading band, and prefer Snap mode.');
  if (overall >= 0.10) s.push('Recalibrate slowly: click each dot once and keep your eyes locked on it until it turns green. Glasses glare and hair over the eyes hurt accuracy too.');
  if (!s.length) s.push('Looks solid — you should get reliable page turns. Leave Drift on and tap R to Recenter if it drifts.');

  $('accsug').innerHTML = s.map((x) => '<li>' + x + '</li>').join('');
  $('accres').style.display = 'flex';
}

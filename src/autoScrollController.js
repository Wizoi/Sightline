import { cfg, state } from './appState.js';
import { $, toast, setStatus } from './ui.js';
import { buildSchedule, progressWithinSystem, nearestSystemIndex } from './lib/tempoSchedule.js';

// Time-based "karaoke" auto-scroll playback loop — a requestAnimationFrame
// loop parallel to followController.js's tick(), but driven by elapsed
// schedule time instead of gaze/wink input, and fully independent of
// state.following/camera state.
let lastFrame = 0;

export function startAutoScroll() {
  const as = state.autoScroll;
  if (!as.analyzed || !as.measuresPerSystem.length) { toast('Run "Analyze score" first'); return false; }

  as.schedule = buildSchedule({
    measuresPerSystem: as.measuresPerSystem,
    beatsPerMeasure: as.beatsPerMeasure,
    bpm: as.bpm,
  });

  // Start from whichever system is nearest wherever the user has already
  // scrolled to — "scroll to the starting group, then hit go."
  const centers = as.systemBands.map((b) => b.center);
  const viewportCenterDoc = window.scrollY + window.innerHeight / 2;
  const startIdx = nearestSystemIndex(centers, viewportCenterDoc);
  as.scheduleElapsed = as.schedule.systems[startIdx] ? as.schedule.systems[startIdx].start : 0;
  as.playing = true;
  return true;
}

export function pauseAutoScroll() {
  state.autoScroll.playing = false;
}

export function stopAutoScroll() {
  state.autoScroll.playing = false;
  state.autoScroll.schedule = null;
  state.autoScroll.scheduleElapsed = 0;
  hideHighlight();
}

function hideHighlight() {
  const el = $('autoScrollHighlight');
  if (el) el.style.display = 'none';
}

// The BPM actually driving playback right now (base BPM x the live tempo%
// nudge) — surfaced in the HUD so it's an inspectable number, not a
// set-and-forget one. Exported so settings.js can also refresh it
// immediately on slider input, not just during playback.
export function currentTempoLabel() {
  const as = state.autoScroll;
  return Math.round(as.bpm * as.tempoPct) + ' bpm';
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;

  const as = state.autoScroll;
  if (!as.playing || !as.schedule) return;

  as.scheduleElapsed += dt * as.tempoPct;
  let reachedEnd = false;
  if (as.scheduleElapsed >= as.schedule.totalDuration) {
    as.scheduleElapsed = as.schedule.totalDuration;
    as.playing = false;
    reachedEnd = true;
  }

  const { index, progress } = progressWithinSystem(as.schedule, as.scheduleElapsed);
  if (index >= 0) {
    const bands = as.systemBands;
    const cur = bands[index];
    const next = bands[index + 1];
    const targetDocY = next ? cur.center + (next.center - cur.center) * progress : cur.center;
    const docMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const targetY = Math.min(docMax, Math.max(0, targetDocY - window.innerHeight * cfg.bandPos));
    window.scrollTo(0, targetY);

    const el = $('autoScrollHighlight');
    if (el) {
      el.style.display = 'block';
      el.style.top = cur.rowMin + 'px';
      el.style.height = Math.max(4, cur.rowMax - cur.rowMin) + 'px';
    }
    setStatus('s-good', `auto-scrolling — system ${index + 1}/${bands.length}`);
  }

  const tempoEl = $('tempoText');
  if (tempoEl) tempoEl.textContent = currentTempoLabel();

  if (reachedEnd) { setStatus('', 'auto-scroll: reached the end'); toast('Reached the end'); }
}

export function startAutoScrollLoop() {
  requestAnimationFrame(tick);
}

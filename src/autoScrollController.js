import { cfg, state } from './appState.js';
import { $, toast, setStatus, applyBand, syncAutoScrollButton } from './ui.js';
import { buildSchedule, progressWithinSystem, systemIndexAtElapsed } from './lib/tempoSchedule.js';
import { decayIfQuiet, correctionStatus } from './lib/tempoCorrection.js';
import { resolveBand, scoreCanvases } from './systemGeometry.js';

const LIVE_STATUS_LABEL = {
  off: '',
  listening: '🎤 listening…',
  tracking: '🎤 tracking tempo',
  'no signal': '🎤 no signal — check mic',
};

// Time-based "karaoke" auto-scroll playback loop — a requestAnimationFrame
// loop parallel to followController.js's tick(), but driven by elapsed
// schedule time instead of gaze/wink input, and fully independent of
// state.following/camera state.
let lastFrame = 0;

// The per-system tempo actually fed to the schedule: the detected ♩=N marks
// (bpmPerSystem) scaled by how far the manual Tempo slider has been moved from
// the piece's reference tempo (bpmBase), so the slider speeds/slows the whole
// piece while preserving the printed tempo *ratios*. null (→ flat `bpm`) when
// no marks were detected, exactly as before this feature.
function currentBpmPerSystem(as) {
  if (!as.bpmPerSystem) return null;
  const scale = as.bpmBase > 0 ? as.bpm / as.bpmBase : 1;
  return as.bpmPerSystem.map((b) => b * scale);
}

export function startAutoScroll() {
  const as = state.autoScroll;
  if (!as.analyzed || !as.measuresPerSystem.length) { toast('Run "Analyze score" first'); return false; }

  as.schedule = buildSchedule({
    measuresPerSystem: as.measuresPerSystem,
    beatsPerMeasure: as.beatsPerMeasure,
    bpm: as.bpm,
    bpmPerSystem: currentBpmPerSystem(as),
  });

  // Always start at the very first system (measure 1). tick() then scrolls the
  // page to it, so Start reliably begins at the top regardless of where the
  // user happened to scroll while reviewing the analysis.
  as.scheduleElapsed = 0;
  as.playing = true;
  applyBand();
  syncAutoScrollButton();
  return true;
}

// Rebuilds the schedule from the current beatsPerMeasure/bpm without
// resetting position -- called whenever either changes while a schedule
// already exists (playing or paused mid-way), so the sliders take effect
// immediately instead of silently freezing until the next Stop+Start.
// buildSchedule() bakes bpm/beatsPerMeasure in at build time and tick() only
// ever reads the already-built schedule, so without this, changing either
// slider mid-playback had no visible effect at all until restart -- found by
// a user testing a real multi-part score (2026-07-20). Preserves musical
// *position* (which system, how far through it), not elapsed seconds, since
// changing tempo/meter changes what a given second-count even means -- the
// same interpolation tick() already uses for scroll/highlight, so a rebuild
// mid-system doesn't jump the scroll position, just changes the pace/meter
// it continues at.
export function rebuildScheduleLive() {
  const as = state.autoScroll;
  if (!as.schedule) return; // nothing started yet -- startAutoScroll() will build fresh
  const { index, progress } = progressWithinSystem(as.schedule, as.scheduleElapsed);
  as.schedule = buildSchedule({
    measuresPerSystem: as.measuresPerSystem,
    beatsPerMeasure: as.beatsPerMeasure,
    bpm: as.bpm,
    bpmPerSystem: currentBpmPerSystem(as),
  });
  const s = index >= 0 ? as.schedule.systems[index] : null;
  as.scheduleElapsed = s ? s.start + progress * s.duration : 0;
}

export function pauseAutoScroll() {
  state.autoScroll.playing = false;
  applyBand();
  syncAutoScrollButton();
}

export function stopAutoScroll() {
  state.autoScroll.playing = false;
  state.autoScroll.schedule = null;
  state.autoScroll.scheduleElapsed = 0;
  hideHighlight();
  applyBand();
  syncAutoScrollButton();
}

function hideHighlight() {
  const el = $('autoScrollHighlight');
  if (el) el.style.display = 'none';
}

// The BPM actually driving playback right now (base BPM x the manual
// playback-speed slider x the live tempo correction, if enabled) —
// surfaced in the HUD so it's an inspectable number, not a set-and-forget
// one. Exported so settings.js can also refresh it immediately on slider
// input, not just during playback.
export function currentTempoLabel() {
  const as = state.autoScroll;
  const correction = as.liveTempoEnabled ? as.tempoCorrection.correction : 1;
  // With detected tempo changes, the HUD shows the tempo of the system playing
  // right now (each schedule system carries its own bpm), not the base slider
  // value — so the number tracks the ♩=86→♩=128 change as it happens. Falls
  // back to the slider value before playback starts or when no marks exist.
  let base = as.bpm;
  if (as.schedule) {
    const idx = systemIndexAtElapsed(as.schedule, as.scheduleElapsed);
    if (idx >= 0 && as.schedule.systems[idx]) base = as.schedule.systems[idx].bpm;
  }
  return Math.round(base * as.tempoPct * correction) + ' bpm';
}

// Resolves the current schedule position to a scroll target + highlight
// rectangle and applies both. Reads systemBands' page-relative fractions
// against the *live* canvas geometry every call (see systemGeometry.js), so a
// window resize, phone rotation, zoom change, or sidebar collapse is picked up
// automatically — the next tick (while playing) or an explicit
// repositionAutoScroll() (while paused) re-projects onto the new layout with
// no re-analysis. Returns the system index shown, or -1 if there's nothing to
// show yet (no schedule, or the page canvas isn't rendered).
function applyScrollPosition() {
  const as = state.autoScroll;
  if (!as.schedule) return -1;
  const { index, progress } = progressWithinSystem(as.schedule, as.scheduleElapsed);
  if (index < 0) return -1;

  const canvases = scoreCanvases();
  const cur = resolveBand(as.systemBands[index], canvases);
  if (!cur) return -1;
  const nextBand = as.systemBands[index + 1];
  const next = nextBand ? resolveBand(nextBand, canvases) : null;

  const targetDocY = next ? cur.center + (next.center - cur.center) * progress : cur.center;
  const docMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const targetY = Math.min(docMax, Math.max(0, targetDocY - window.innerHeight * cfg.autoScrollBandPos));
  window.scrollTo(0, targetY);

  const el = $('autoScrollHighlight');
  if (el) {
    el.style.display = 'block';
    el.style.top = cur.rowMin + 'px';
    el.style.height = Math.max(4, cur.rowMax - cur.rowMin) + 'px';
  }
  return index;
}

// Re-applies the current scroll target + highlight after a layout change
// (resize / rotation / zoom / sidebar collapse). While playing, tick()'s rAF
// loop already does this every frame; this is for the *paused* case, where the
// highlight would otherwise freeze at the old pixel position until playback
// resumes. No-op if nothing has been started. Called from pdf.js/main.js after
// a re-render settles.
export function repositionAutoScroll() {
  if (!state.autoScroll.schedule) return;
  applyScrollPosition();
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0;
  lastFrame = now;

  const as = state.autoScroll;

  const liveStatusEl = $('liveTempoStatus');
  if (liveStatusEl) liveStatusEl.textContent = as.liveTempoEnabled ? (LIVE_STATUS_LABEL[as.liveTempoStatus] || '') : '';

  if (!as.playing || !as.schedule) return;

  const liveCorrection = as.liveTempoEnabled ? as.tempoCorrection.correction : 1;
  as.scheduleElapsed += dt * as.tempoPct * liveCorrection;

  if (as.liveTempoEnabled) {
    const beatDuration = as.bpm > 0 ? 60 / as.bpm : 0;
    as.tempoCorrection = decayIfQuiet(as.tempoCorrection, as.scheduleElapsed, dt, { beatDuration });
    as.liveTempoStatus = correctionStatus(as.tempoCorrection, as.scheduleElapsed, { beatDuration });
  }

  let reachedEnd = false;
  if (as.scheduleElapsed >= as.schedule.totalDuration) {
    as.scheduleElapsed = as.schedule.totalDuration;
    as.playing = false;
    reachedEnd = true;
    syncAutoScrollButton();
  }

  const shownIndex = applyScrollPosition();
  if (shownIndex >= 0) {
    setStatus('s-good', `auto-scrolling — system ${shownIndex + 1}/${as.systemBands.length}`);
  }

  const tempoEl = $('tempoText');
  if (tempoEl) tempoEl.textContent = currentTempoLabel();

  if (reachedEnd) { setStatus('', 'auto-scroll: reached the end'); toast('Reached the end'); }
}

export function startAutoScrollLoop() {
  requestAnimationFrame(tick);
}

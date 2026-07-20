// DOM-facing wiring for the "onset-nudge" live tempo correction: mic input
// -> AudioWorklet onset detector (src/audio/onsetProcessor.js) -> the pure
// correction logic in lib/tempoCorrection.js. Everything here is plumbing;
// see tempoCorrection.js's header for the actual design rationale.
//
// Not covered by an automated test — it only does something inside a real
// AudioContext/getUserMedia, which Vitest doesn't provide, and this project
// has no Playwright/e2e harness (see docs/PERSONAS.md persona 8). Verified
// manually against a live mic instead. The pure logic it wires together
// (lib/tempoCorrection.js, lib/tempoSchedule.js) is unit tested.

import { state } from './appState.js';
import { toast } from './ui.js';
import { beatTimestamps, nearestBeatTime } from './lib/tempoSchedule.js';
import { applyOnset, createCorrectionState } from './lib/tempoCorrection.js';

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;

export async function startLiveTempo() {
  if (audioCtx) return; // already running
  const as = state.autoScroll;
  try {
    // Browsers apply echo cancellation, noise suppression, and auto-gain to
    // getUserMedia audio by default — all three work against onset
    // detection here: noise suppression is tuned to remove non-speech
    // transients (exactly the instrument attacks being listened for), and
    // auto-gain compresses the rising-energy jump the detector watches for.
    // The detector already does its own adaptive noise-floor tracking (see
    // public/audio/onsetProcessor.js), so raw, unprocessed input is what it
    // actually wants.
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    audioCtx = new AudioContext();
    // Lives in public/ (a real, stable-URL static file), not bundled from
    // src/ — see public/audio/onsetProcessor.js's header for why.
    await audioCtx.audioWorklet.addModule(import.meta.env.BASE_URL + 'audio/onsetProcessor.js');
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'onset-processor');
    workletNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'onset') handleOnset();
    };
    // Analysis only — never connected to audioCtx.destination, or the
    // performer would hear their own mic played back.
    sourceNode.connect(workletNode);
    as.liveTempoStatus = 'listening';
  } catch (err) {
    as.liveTempoEnabled = false;
    toast('Microphone access failed: ' + err.message);
    stopLiveTempo();
  }
}

export function stopLiveTempo() {
  const as = state.autoScroll;
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  as.liveTempoStatus = 'off';
  as.tempoCorrection = createCorrectionState();
}

// The onset message carries the worklet's own AudioContext-time timestamp,
// but by the time it reaches the main thread it's only ever a render-quantum
// or two old (a few ms) — far smaller than a beat duration at any playable
// tempo — so rather than maintaining a separate audio-clock-to-schedule-clock
// mapping, we just treat "now" in the schedule's own elapsed-time clock as
// the onset time. Simpler, and accurate enough for a bounded nudge.
function handleOnset() {
  const as = state.autoScroll;
  if (!as.liveTempoEnabled || !as.playing || !as.schedule) return;
  const beats = beatTimestamps(as.schedule, as.beatsPerMeasure);
  const expectedBeatTime = nearestBeatTime(beats, as.scheduleElapsed);
  if (expectedBeatTime == null) return;
  const beatDuration = as.bpm > 0 ? 60 / as.bpm : 0;
  as.tempoCorrection = applyOnset(as.tempoCorrection, {
    onsetTime: as.scheduleElapsed,
    expectedBeatTime,
    beatDuration,
  });
  as.liveTempoStatus = 'tracking';
}

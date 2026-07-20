// Live tempo "onset-nudge" correction — an experimental, opt-in layer on
// top of the fixed-BPM auto-scroll schedule (lib/tempoSchedule.js), not a
// replacement for it. Each detected note onset (from src/liveTempo.js's
// audio pipeline) is compared to when the schedule expected the nearest
// beat to land; the timing error nudges a small, bounded correction
// multiplier rather than recomputing tempo from scratch — much simpler and
// more robust than full beat tracking (see this feature's research notes),
// and it decays back to neutral whenever the performer stops playing, so a
// rest or a lost signal can never leave a stale correction applied.

const MIN_CORRECTION = 0.85, MAX_CORRECTION = 1.15;
// How strongly a single onset's timing error nudges the correction — small
// on purpose; this is a gentle trim toward the performer's actual timing,
// not a snap-to-tempo.
const GAIN = 0.15;
// An onset timed more than this fraction of a beat away from the nearest
// expected beat is more likely a mis-detection (matched to the wrong beat
// entirely) than real tempo drift — ignore it rather than let a bad match
// whipsaw the correction.
const IMPLAUSIBLE_BEAT_FRACTION = 0.5;

export function createCorrectionState() {
  return { correction: 1, lastOnsetAt: null };
}

// input: { onsetTime, expectedBeatTime, beatDuration } — all in the same
// elapsed-seconds timebase as the schedule (the caller translates from
// audio-context time). Returns the updated state.
export function applyOnset(state, { onsetTime, expectedBeatTime, beatDuration }) {
  const error = expectedBeatTime - onsetTime;     // + = onset was early (performer ahead), - = late
  const beatFrac = beatDuration > 0 ? error / beatDuration : 0;
  let correction = state.correction;
  if (Math.abs(beatFrac) <= IMPLAUSIBLE_BEAT_FRACTION) {
    // early -> speed the schedule up (correction > 1); late -> slow it down.
    correction = clamp(correction + beatFrac * GAIN, MIN_CORRECTION, MAX_CORRECTION);
  }
  return { correction, lastOnsetAt: onsetTime };
}

// Call every frame with dt = seconds since the last call and `now` in the
// schedule's elapsed-seconds timebase. Once it's been quiet (a rest, or the
// tracker lost the signal) for longer than `silenceBeats` beats, relaxes
// the correction back toward neutral (1.0) — a leaky integrator, the same
// pattern followLogic.js's drift correction uses.
export function decayIfQuiet(state, now, dt, { beatDuration, silenceBeats = 2, rate = 1.5 } = {}) {
  if (state.lastOnsetAt == null || beatDuration <= 0) return state;
  const quietFor = now - state.lastOnsetAt;
  if (quietFor < silenceBeats * beatDuration) return state;
  const correction = state.correction + (1 - state.correction) * Math.min(1, rate * dt);
  return { ...state, correction };
}

// Derives the UI-facing status ('listening' | 'tracking' | 'no signal') from
// the correction state — kept pure/testable rather than inlined into the
// controller's DOM-writing tick(). Callers handle 'off' themselves (this
// only runs while live tempo is enabled).
export function correctionStatus(state, now, { beatDuration, silenceBeats = 2 } = {}) {
  if (state.lastOnsetAt == null) return 'listening';
  if (beatDuration <= 0) return 'tracking';
  const quietFor = now - state.lastOnsetAt;
  return quietFor >= silenceBeats * beatDuration ? 'no signal' : 'tracking';
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

import { describe, it, expect } from 'vitest';
import { createCorrectionState, applyOnset, decayIfQuiet, correctionStatus } from './tempoCorrection.js';
import { buildSchedule, beatTimestamps, nearestBeatTime } from './tempoSchedule.js';

const beatDuration = 0.5; // matches 120bpm in tempoSchedule.test.js, for consistency

describe('applyOnset', () => {
  it('leaves the correction unchanged for a perfectly on-time onset', () => {
    const state = createCorrectionState();
    const r = applyOnset(state, { onsetTime: 2, expectedBeatTime: 2, beatDuration });
    expect(r.correction).toBe(1);
    expect(r.lastOnsetAt).toBe(2);
  });

  it('nudges the correction up when the onset arrives early (performer ahead)', () => {
    const state = createCorrectionState();
    // onset at 1.9, expected at 2.0 -> error +0.1 -> beatFrac 0.2
    const r = applyOnset(state, { onsetTime: 1.9, expectedBeatTime: 2.0, beatDuration });
    expect(r.correction).toBeCloseTo(1.03, 8);
  });

  it('nudges the correction down when the onset arrives late (performer behind)', () => {
    const state = createCorrectionState();
    const r = applyOnset(state, { onsetTime: 2.1, expectedBeatTime: 2.0, beatDuration });
    expect(r.correction).toBeCloseTo(0.97, 8);
  });

  it('ignores an implausibly-timed onset (likely matched to the wrong beat) rather than applying it', () => {
    const state = createCorrectionState();
    // error 0.4s against a 0.5s beat -> 0.8 of a beat off, over the 0.5 threshold
    const r = applyOnset(state, { onsetTime: 1.6, expectedBeatTime: 2.0, beatDuration });
    expect(r.correction).toBe(1); // unchanged
    expect(r.lastOnsetAt).toBe(1.6); // still recorded as "something was heard"
  });

  it('rejects a real nearest-beat match that lands near the ambiguous midpoint between two beats', () => {
    // Regression: tempoSchedule.js's nearestBeatTime() always returns the
    // *closest* grid point on a uniform beat grid, so the error it can ever
    // produce is bounded to at most half a beat — a threshold of 0.5 (the
    // old value) could therefore never reject anything reachable through the
    // real pipeline, even though applyOnset()'s own threshold check works
    // fine in isolation (see the hand-crafted "implausibly-timed" test
    // above). This test goes through the real nearestBeatTime() lookup,
    // like the live pipeline (src/liveTempo.js) does, to prove the gate
    // actually filters something end-to-end.
    const schedule = buildSchedule({ measuresPerSystem: [4], beatsPerMeasure: 4, bpm: 120 }); // secPerBeat = 0.5
    const beats = beatTimestamps(schedule, 4); // [0, 0.5, 1.0, 1.5, ...]
    const onsetTime = 0.24; // almost exactly between beat 0 (t=0) and beat 1 (t=0.5)
    const expectedBeatTime = nearestBeatTime(beats, onsetTime);
    expect(expectedBeatTime).toBe(0); // nearest is beat 0, distance 0.24 -> beatFrac 0.48

    const state = createCorrectionState();
    const r = applyOnset(state, { onsetTime, expectedBeatTime, beatDuration: 0.5 });
    expect(r.correction).toBe(1); // rejected as too ambiguous to trust, not nudged
  });

  it('clamps the correction at the configured bounds even with repeated large nudges', () => {
    let state = createCorrectionState();
    for (let i = 0; i < 50; i++) {
      // early by 0.15 = 0.3 of a beat: large enough to nudge every time, but
      // inside IMPLAUSIBLE_BEAT_FRACTION so it isn't rejected as ambiguous.
      state = applyOnset(state, { onsetTime: 1.85, expectedBeatTime: 2.0, beatDuration });
    }
    expect(state.correction).toBeLessThanOrEqual(1.15);
    expect(state.correction).toBeGreaterThan(1.1);
  });
});

describe('decayIfQuiet', () => {
  it('does nothing while onsets are still recent', () => {
    const state = { correction: 1.1, lastOnsetAt: 0 };
    const r = decayIfQuiet(state, 0.9, 0.1, { beatDuration, silenceBeats: 2 }); // threshold = 1.0s, only 0.9s quiet
    expect(r.correction).toBe(1.1);
  });

  it('relaxes the correction toward 1.0 once quiet for longer than silenceBeats', () => {
    const state = { correction: 1.1, lastOnsetAt: 0 };
    const r = decayIfQuiet(state, 1.5, 0.1, { beatDuration, silenceBeats: 2, rate: 1.5 });
    expect(r.correction).toBeCloseTo(1.085, 8);
    expect(r.correction).toBeLessThan(1.1);
    expect(r.correction).toBeGreaterThan(1);
  });

  it('eventually settles at exactly 1.0 given enough quiet time', () => {
    let state = { correction: 1.1, lastOnsetAt: 0 };
    for (let i = 0; i < 200; i++) {
      state = decayIfQuiet(state, 1.5 + i * 0.1, 0.1, { beatDuration, silenceBeats: 2 });
    }
    expect(state.correction).toBeCloseTo(1, 6);
  });

  it('is a no-op before any onset has ever been heard', () => {
    const state = createCorrectionState();
    const r = decayIfQuiet(state, 100, 0.1, { beatDuration });
    expect(r).toBe(state);
  });

  it('is a no-op when beatDuration is not positive (no schedule yet)', () => {
    const state = { correction: 1.1, lastOnsetAt: 0 };
    const r = decayIfQuiet(state, 100, 0.1, { beatDuration: 0 });
    expect(r).toBe(state);
  });
});

describe('correctionStatus', () => {
  it('reports listening before any onset has been heard', () => {
    expect(correctionStatus(createCorrectionState(), 5, { beatDuration })).toBe('listening');
  });

  it('reports tracking shortly after a recent onset', () => {
    const state = { correction: 1, lastOnsetAt: 5 };
    expect(correctionStatus(state, 5.2, { beatDuration })).toBe('tracking');
  });

  it('reports no signal once quiet for longer than silenceBeats', () => {
    const state = { correction: 1, lastOnsetAt: 5 };
    expect(correctionStatus(state, 5 + 3 * beatDuration, { beatDuration, silenceBeats: 2 })).toBe('no signal');
  });

  it('falls back to tracking when beatDuration is not positive', () => {
    const state = { correction: 1, lastOnsetAt: 5 };
    expect(correctionStatus(state, 999, { beatDuration: 0 })).toBe('tracking');
  });
});

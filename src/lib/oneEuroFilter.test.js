import { describe, it, expect } from 'vitest';
import { oneEuroStep } from './oneEuroFilter.js';

// Reference implementation of the OLD fixed-alpha EMA that oneEuroStep()
// replaces inside decide() — used here only so the tests can demonstrate the
// One Euro filter's claimed property *against the exact same synthetic
// input* the old smoothing would have seen, not just "it runs".
function emaRun(samples, smoothWin) {
  const alpha = 1 / Math.max(1, smoothWin);
  let smooth = null;
  const out = [];
  for (const v of samples) {
    smooth = smooth == null ? v : smooth + alpha * (v - smooth);
    out.push(smooth);
  }
  return out;
}

function oneEuroRun(samples, dt, minCutoff, beta) {
  let filterState = null;
  const out = [];
  for (const v of samples) {
    const step = oneEuroStep(filterState, v, dt, minCutoff, beta);
    filterState = step;
    out.push(step.value);
  }
  return out;
}

function variance(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}

// Deterministic pseudo-random generator (mulberry32) instead of Math.random()
// so the jitter test is reproducible — real per-frame gaze-estimation noise
// looks close to independent frame-to-frame noise (not a slow smooth
// wobble), which is also the harder case for a speed-adaptive filter: naive
// frame-to-frame "speed" of white noise is large even though the position
// itself barely moves.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same smoothWin -> minCutoff mapping decide() uses (ASSUMED_FPS=30), spelled
// out locally so this test file doesn't need to import followLogic.js's
// internals just to pick a realistic minCutoff for these scenarios.
const SMOOTH_WIN = 12;
const MIN_CUTOFF = 1 / (2 * Math.PI * (SMOOTH_WIN / 30));
// Matches followLogic.js's ONE_EURO_BETA — kept as a literal here (rather
// than imported) so this file tests the filter's general property with an
// independently-stated value, not a value that would silently track any
// future retuning of the production constant.
const BETA = 0.0008;
const DT = 1 / 30; // seconds, ~30fps webcam frame

describe('oneEuroStep', () => {
  it('passes the first sample through untouched regardless of filter state', () => {
    const step = oneEuroStep(null, 123.4, DT, MIN_CUTOFF, BETA);
    expect(step.value).toBe(123.4);
    expect(step.deriv).toBe(0);
  });

  it('ignores a degenerate (zero/negative) dt and passes the raw value through', () => {
    const prior = { value: 10, deriv: 5 };
    const step = oneEuroStep(prior, 999, 0, MIN_CUTOFF, BETA);
    expect(step.value).toBe(999);
    expect(step.deriv).toBe(0);
  });

  it('produces lower output variance than the old fixed-alpha EMA on identical small jitter around a steady position (reading one line)', () => {
    // +/-3px near-white noise around y=400 — the kind of small, largely
    // independent frame-to-frame jitter a real gaze estimator produces while
    // the eyes hold roughly steady on one line of text.
    const rnd = mulberry32(42);
    const N = 200;
    const samples = [];
    for (let i = 0; i < N; i++) samples.push(400 + (rnd() - 0.5) * 6);

    const emaOut = emaRun(samples, SMOOTH_WIN);
    const oneEuroOut = oneEuroRun(samples, DT, MIN_CUTOFF, BETA);

    // Drop the first few samples (both filters are still settling from the
    // null initial state) before comparing steady-state jitter suppression.
    const settle = 20;
    const emaVar = variance(emaOut.slice(settle));
    const oneEuroVar = variance(oneEuroOut.slice(settle));

    expect(oneEuroVar).toBeLessThan(emaVar);
  });

  it('converges to a sudden large jump (a saccade to the next system) faster than the old fixed-alpha EMA on identical input', () => {
    // Gaze holds at y=400 (reading a line), then jumps to y=700 and holds
    // there (looked down/across to the next system) — a step function, the
    // simplest stand-in for a saccade.
    const before = Array(30).fill(400);
    const after = Array(30).fill(700);
    const samples = [...before, ...after];

    const emaOut = emaRun(samples, SMOOTH_WIN);
    const oneEuroOut = oneEuroRun(samples, DT, MIN_CUTOFF, BETA);

    const jumpIndex = before.length; // first sample of the new position
    const target = 700, start = 400;
    const settledThreshold = start + 0.9 * (target - start); // 90% of the way there

    const framesToSettle = (out) => {
      for (let i = jumpIndex; i < out.length; i++) {
        if (out[i] >= settledThreshold) return i - jumpIndex;
      }
      return Infinity;
    };

    const emaFrames = framesToSettle(emaOut);
    const oneEuroFrames = framesToSettle(oneEuroOut);

    expect(oneEuroFrames).toBeLessThan(emaFrames);

    // Concretely: the EMA (alpha ~= 1/12) takes many frames to climb 90% of
    // the way there, while the One Euro filter's cutoff opens up within a
    // frame or two of the jump being detected and gets there much sooner.
    expect(emaFrames).toBeGreaterThan(10);
    expect(oneEuroFrames).toBeLessThan(6);
  });

  it('tracks a larger fraction of a big/fast jump in a single frame than of a small/slow one — the actual speed-adaptive mechanism, absent from a fixed-alpha EMA', () => {
    // A fixed-alpha EMA tracks exactly the same *fraction* of any jump in one
    // frame, no matter its size — that fraction is alpha, a constant. The One
    // Euro filter should not: a small jump (slow-looking motion) should barely
    // nudge the cutoff off of minCutoff, while a big jump in the same single
    // frame (necessarily a high estimated speed) should push the cutoff — and
    // so the tracked fraction — noticeably higher.
    const steady = { value: 400, deriv: 0 };

    const smallJump = 5;   // px in one frame — reading-line-scale jitter
    const bigJump = 300;   // px in one frame — saccade-scale motion

    const smallStep = oneEuroStep(steady, 400 + smallJump, DT, MIN_CUTOFF, BETA);
    const bigStep = oneEuroStep(steady, 400 + bigJump, DT, MIN_CUTOFF, BETA);

    const smallFraction = (smallStep.value - 400) / smallJump;
    const bigFraction = (bigStep.value - 400) / bigJump;

    const emaAlpha = 1 / SMOOTH_WIN; // the old EMA's constant fraction-per-frame

    expect(bigFraction).toBeGreaterThan(smallFraction);
    // The small/slow jump should look close to the old EMA's fixed rate...
    expect(smallFraction).toBeLessThan(emaAlpha * 3);
    // ...while the big/fast jump should clearly exceed it, unlike the EMA.
    expect(bigFraction).toBeGreaterThan(emaAlpha * 2);
  });
});

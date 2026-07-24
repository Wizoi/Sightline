// One Euro Filter (Casiez, Roussel & Vogel — CHI 2012): a low-pass filter
// whose cutoff frequency rises with the *speed* of the signal being filtered.
// A signal that's holding still gets a low cutoff (heavy smoothing, kills
// jitter); a signal that starts moving fast gets the cutoff opened up almost
// immediately (light smoothing, kills lag). A fixed-alpha EMA has to pick one
// fixed point on that trade-off for every signal speed — this is the
// dependency-free ~30-line algorithm that instead adapts per frame.
//
// Kept pure and DOM-free, matching the rest of this directory: a plain step
// function over an explicit filter state passed in and returned, not
// module-level mutable state. That means the caller can run two independent
// instances (e.g. one for x, one for y) without them sharing hidden state,
// and the whole thing is trivially unit-testable without a browser or camera
// — see decide() in followLogic.js for how the state is threaded frame to
// frame alongside its own state object.

// Cutoff (Hz) used to low-pass the *derivative* estimate itself, so a single
// noisy frame's raw speed reading can't punch the main cutoff wide open on
// its own. Fixed per the original paper; this only shapes how quickly a
// speed estimate is trusted, not the perceptible smooth/snappy trade-off a
// user would recognize, so it isn't exposed as a tunable.
const DERIV_CUTOFF_HZ = 1.0;

function smoothingFactor(cutoffHz, dt) {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoffHz));
  return 1 / (1 + tau / Math.max(1e-6, dt));
}

function lowPass(prev, value, alpha) {
  return prev + alpha * (value - prev);
}

// state: null (or the value has no prior sample) on the very first call,
// otherwise the { value, deriv } returned by the previous call for this same
// signal. Returns the new { value, deriv } pair — thread both fields, not
// just `value`, or the derivative low-pass resets to 0 every frame and the
// filter degenerates into a fixed-cutoff low-pass.
export function oneEuroStep(state, rawValue, dt, minCutoff, beta) {
  if (state == null || !(dt > 0)) {
    // First sample (or a degenerate/zero dt): nothing to derive a speed
    // from yet, so pass the raw value through untouched — identical to how
    // the old EMA initialized smoothX/smoothY straight from rawGaze.
    return { value: rawValue, deriv: 0 };
  }
  const rawDeriv = (rawValue - state.value) / dt;
  const deriv = lowPass(state.deriv, rawDeriv, smoothingFactor(DERIV_CUTOFF_HZ, dt));
  const cutoff = minCutoff + beta * Math.abs(deriv);
  const value = lowPass(state.value, rawValue, smoothingFactor(cutoff, dt));
  return { value, deriv };
}

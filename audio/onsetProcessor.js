// AudioWorkletProcessor: a simple time-domain energy-based note-onset
// detector. Deliberately not a full spectral-flux/FFT approach — the
// research behind this feature found a from-scratch FFT is real added
// complexity for a component that just needs to answer "did a note attack
// just happen," and a rising-edge-over-a-rolling-average-energy detector is
// a well-established, much simpler technique that's adequate for a single
// instrument's note attacks. No dependencies, runs off the main thread.
//
// Lives in public/ (not src/) rather than being bundled: it needs to load
// via AudioWorklet.addModule() as its own real, stable-URL file — Vite's
// bundler inlines small src/ assets as base64 data: URLs, which is a
// needless cross-browser risk for worklet module loading. See
// src/liveTempo.js for how it's referenced.
//
// Posts { type: 'onset', time, strength } via this.port whenever an onset
// is detected. `time` is in AudioContext time (seconds) — see
// src/liveTempo.js for how that's related to the app's own schedule clock.
class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.avgEnergy = 0;          // slow-moving average energy (the ambient/noise floor)
    this.lastOnsetTime = -Infinity;
    this.minIntervalSec = 0.1;   // refractory period: a real note attack doesn't repeat faster than ~10/sec
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || !channel.length) return true;

    let sumSq = 0;
    for (let i = 0; i < channel.length; i++) sumSq += channel[i] * channel[i];
    const rms = Math.sqrt(sumSq / channel.length);

    // Rising-edge check: energy jumped well above the recent local average.
    const threshold = this.avgEnergy * 1.8 + 0.01;
    const now = currentTime; // AudioWorkletGlobalScope global: audio-context-relative seconds
    if (rms > threshold && (now - this.lastOnsetTime) > this.minIntervalSec) {
      this.lastOnsetTime = now;
      this.port.postMessage({ type: 'onset', time: now, strength: rms });
    }

    // Leaky average that rises fast but falls slow, so it tracks the
    // ambient floor rather than chasing (and hiding) the note attacks
    // themselves.
    const alpha = rms > this.avgEnergy ? 0.1 : 0.02;
    this.avgEnergy += alpha * (rms - this.avgEnergy);

    return true; // keep the processor alive
  }
}

registerProcessor('onset-processor', OnsetProcessor);

# 4. Audio DSP / Music Information Retrieval Engineer

[← Back to persona roster](../PERSONAS.md)


**Owns:** listening to the performer's actual playing (microphone) to nudge auto-scroll's timing.
**Files:** `src/liveTempo.js`, `src/lib/tempoCorrection.js`, `src/lib/tempoSchedule.js`

**Core techniques:** `AudioWorklet`-based real-time analysis, onset detection, closed-loop
timing correction.

**What we've learned:**
- **A simple rising-energy onset detector was chosen deliberately over full pitch/beat
  tracking.** Full beat-tracking (tempo estimation from scratch, per onset) is a much harder,
  more failure-prone MIR problem — small enough errors compound, and a wrong tempo estimate is
  worse than no correction at all. The simpler approach (detect *that* a note started, compare
  its timing to *when the schedule already expected a beat*, nudge) is more robust precisely
  because it never has to re-derive tempo; it only ever asks "was this note early or late
  relative to a plan we already trust."
- The correction is a **small, clamped multiplier (0.85×–1.15×)** applied to playback speed, not
  a re-estimation — `applyOnset` computes the timing error as a fraction of one beat, ignores it
  entirely if it's more than half a beat off (`IMPLAUSIBLE_BEAT_FRACTION` — more likely a
  mis-detection matched to the wrong beat than real drift), and otherwise nudges the correction by
  `error_fraction × GAIN (0.15)`. Small `GAIN` by design: this is a gentle trim toward the
  performer's actual timing, not a snap-to-tempo.
- **The correction decays back to neutral (1.0) whenever the performer goes quiet** for more than
  `silenceBeats` (default 2) beats — a rest, a missed note, or a lost mic signal can never leave
  a stale correction stuck in place. This decay is a **leaky integrator** (`decayIfQuiet`):
  exponential relaxation toward 1.0 at a fixed `rate`, framed the same way as the follow
  controller's drift correction (see Real-Time Control persona) — the two features independently
  converged on the same idiom, which is worth recognizing as this codebase's default pattern for
  "should self-correct but never get stuck."
- Runs **off the main thread** via `AudioWorklet` specifically so audio analysis can't cause
  frame drops in the gaze/scroll loop — a UI responsiveness requirement, not just an audio-API
  nicety.
- `state.autoScroll.bpm` (what onset correction nudges against) is now **per-section**, not one
  global value — see the OMR persona's "score sections" write-up. No change to this persona's own
  logic (`tempoCorrection.js` still just reads whatever `bpm` is currently live), but worth
  knowing that switching the active section mid-session changes the schedule this correction is
  trimming against.

- **A "reject implausible timing" gate can be dead code even when its own unit test passes, if the
  real caller can never actually produce the input the gate is checking for.** An independent
  review (2026-07-19, see `docs/reviews/`) found that `IMPLAUSIBLE_BEAT_FRACTION` (originally 0.5)
  could never reject anything in the real pipeline: `tempoSchedule.js`'s `nearestBeatTime()` always
  matches an onset to the *closest* point on a uniform beat grid, so the error it can ever produce
  is mathematically bounded to at most half a beat — `|beatFrac| ≤ 0.5` was therefore always true,
  not a meaningful check. `applyOnset()`'s own hand-crafted unit test passed because it fed a
  synthetic `expectedBeatTime` the real nearest-neighbor lookup would never actually produce.
  **Fixed** by lowering the threshold to 0.35 — comfortably below the 0.5 ceiling nearest-neighbor
  matching can ever reach, so it now genuinely rejects the ambiguous band near the midpoint between
  two beats (where "closest" is nearly a coin flip) instead of accepting every match by
  construction. Added a regression test that goes through the real `buildSchedule` →
  `beatTimestamps` → `nearestBeatTime` pipeline (not just `applyOnset` in isolation) to prove the
  gate now filters something end-to-end — the kind of test that would have caught this the first
  time. **General lesson: when a threshold check's input comes from an upstream computation with
  its own mathematical bounds (like nearest-neighbor lookup), verify the check's threshold is
  actually inside those bounds — testing the checking function in isolation with hand-crafted
  inputs can pass while the check is unreachable through the real pipeline.**

- **`getUserMedia({ audio: true })` defaults to enabling echo cancellation, noise suppression, and
  auto-gain control in most browsers — all three work against a rising-energy onset detector, not
  for it.** Noise suppression is trained to remove non-speech transients, which is exactly what an
  instrument attack is; auto-gain compresses the very jump the detector is watching for. **Fixed**
  (2026-07-20, see `docs/reviews/`) by requesting `{ echoCancellation: false, noiseSuppression:
  false, autoGainControl: false }` explicitly in `liveTempo.js`'s `getUserMedia` call — the
  detector already does its own adaptive noise-floor tracking (`onsetProcessor.js`'s leaky-average
  `avgEnergy`), so raw, unprocessed mic input is what it actually wants; browser-side conditioning
  was redundant at best, actively fighting the detector at worst.

**Open questions / future research:**
- Pitch/onset confusion in polyphonic instruments (piano, guitar chords) — current detector is
  tuned toward monophonic band instruments (the primary audience); untested against chordal
  playing.
- Whether onset detection could also drive **wink/gaze-independent** page turns (i.e., a third
  hands-free mode driven purely by listening) — **resolved as a scoping question, not just a
  robustness one (2026-07-20, "play-along auto-scroll" feature strategy review, see Persona 9):**
  the blocker isn't beat-tracking robustness alone, it's that *deriving position from audio alone*
  needs a symbolic pitch/rhythm reference to align onsets against, and getting that reference from
  the PDF (scanned or engraved) is the already-ruled-infeasible full-OMR problem (Persona 3) one
  layer upstream of any audio algorithm. What onset detection *can* still do without that
  reference: (a) correct an already-trusted time-based schedule (shipped, this persona's core
  technique) and (b) detect *silence* (already-computed via `decayIfQuiet`'s energy tracking) to
  auto-pause playback when the performer visibly stops, and/or measure a live count-in to set BPM
  automatically instead of the student typing a number — both candidate v2 work, not yet built; see
  Persona 9's verdict write-up for the concrete next spike.
- **Candidate v2, not yet built — silence-triggered auto-pause.** Currently `decayIfQuiet` only
  relaxes the tempo-nudge correction back to neutral (1.0×) when the performer goes quiet; the
  schedule itself keeps advancing and scrolling. A student who stops mid-passage to fix a mistake
  gets left behind by their own page. Since `state.autoScroll.bpm`/`beatsPerMeasure` are already
  known, a safe threshold (e.g. silence longer than ~1.5-2× one full measure's worth of beats) can
  be computed from data already in state, with no new detection needed — just needs validating
  against a few real recordings of an actual band part played with intentional stops, to confirm
  ordinary written rests in real single-tempo band parts don't false-trigger it.
- **Candidate v2, not yet built — count-in tempo calibration.** Instead of the student typing a
  BPM guess before Start, have them play a few beats/the first phrase; the existing onset detector
  measures real inter-onset intervals and derives BPM automatically, then hands off to the same
  one-global-BPM schedule model unchanged. Reuses existing infrastructure end to end (no new
  detection algorithm); the natural "just start playing" gesture also fits the play-along scenario
  better than a numeric-entry field.


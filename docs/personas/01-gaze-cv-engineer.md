# 1. Gaze & Computer Vision Engineer

[← Back to persona roster](../PERSONAS.md)


**Owns:** turning a webcam frame into "where is this person looking."
**Files:** `src/tracking/irisTracking.js`, `src/tracking/winkTracking.js`, `src/lib/gazeMath.js`,
`src/camera.js`

**Core techniques:** MediaPipe Tasks `FaceLandmarker` (468-point face mesh + iris landmarks +
blendshapes), rigid-body head-pose estimation, wink/blink detection.

**What we've learned:**
- Raw iris position relative to the eye corners changes when the head moves — unusable as a
  standalone gaze signal for someone swaying/turning while they play. The fix (`headBasis` +
  `eyeGaze` in `gazeMath.js`) builds a **head-fixed orthonormal basis** from rigid landmarks
  (cheek points 234/454, forehead 10, chin 152: `right`, `down`, `fwd`), reconstructs an
  eyeball-center estimate ~0.6 eye-widths behind the corners along the face normal, and expresses
  the iris direction as **yaw/pitch in that head frame**. This makes the gaze feature
  pose-invariant, which is what lets calibration survive natural head movement.
- Blink/wink detection should use MediaPipe's **`eyeBlinkLeft`/`eyeBlinkRight` blendshape
  scores**, not raw eyelid-landmark distance — raw distance was tried first and was too noisy for
  a deliberate one-eyed wink to reliably clear a fixed threshold. The blendshape is a
  purpose-built, model-computed closure signal and is much more robust.
- A blink (both eyes closing together) must be distinguished from a wink (one eye) — checked via
  the *gap* between the two eyes' blink scores, not just an absolute threshold on one eye. See
  Applied Mathematician persona for how that gap threshold is personally calibrated.
- **Backlog item A4, closed (2026-07-23): `irisTracking.js`'s blink gate now uses the same
  `eyeBlinkLeft`/`eyeBlinkRight` blendshape scores winkTracking.js already relied on**, instead of
  the EMA-ratio heuristic (`state.openEMA` chasing a running-average eye-openness ratio,
  blinking when the current ratio dropped below half of it) that used to gate iris-mode gaze/
  calibration-sample capture. Confirmed first, rather than assumed, that blendshapes were already
  being requested from the model: `camera.js`'s `FaceLandmarker.createFromOptions` already passes
  `outputFaceBlendshapes: true` on both the GPU and CPU-fallback code paths (needed by
  winkTracking.js, which shipped first) — no new cost to enable, this was a pure signal-source
  swap in `irisTracking.js` alone. New gate: `Math.max(left, right) > 0.3` (reusing
  `winkLogic.js`'s `DEFAULT_CLOSED_THRESHOLD` reasoning — real deliberate winks clear ~0.3 against
  a ~0.1 resting baseline) returns null for that frame, same contract as before (still gates both
  the returned gaze point and calibration-sample capture). Deliberately *simpler* than
  winkTracking.js's gap-based left-vs-right logic: this gate only needs "is either eye
  mid-closure, i.e. is the iris position untrustworthy right now," not "which eye, wink or
  blink" — a single fixed threshold suffices, and (unlike the EMA it replaced) needs no running
  per-user baseline that could itself drift under lighting/pose changes. Removed the
  now-fully-unused `state.openEMA` field from `appState.js`. Verified via a new colocated
  `src/tracking/irisTracking.test.js` (7 tests: gate closed/open, blink vs. merely-lower-but-open
  eye, calibration-sample push/no-push) plus the full existing suite — all 292 tests pass (285 +
  7 new), no regressions.
- Auto-frame (crop + upscale around the detected face before running the landmark model) gives
  more effective pixels-per-eye when the user sits back from the laptop, and periodically widens
  back to the full frame to re-lock if tracking is lost. Manual zoom prefers the webcam's own
  hardware zoom (real optical detail) when the device exposes one, falling back to digital zoom.

- `calibModelId()` existed as two identical, independent definitions — `appState.js` and
  `calibration.js` — with only the latter actually imported anywhere. **Fixed** (2026-07-20, see
  `docs/reviews/`) by deleting the unused copy. Real drift risk for near-zero effort: a future
  model-version bump edited in only one copy would have invalidated saved calibrations
  inconsistently depending on which copy a given call site happened to import.

**Infrared (IR) gaze tracking — researched and declined (2026-07-20), full detail below rather than
just an open question, since this was a real two-thread research spike, not idle speculation:**
- **The web platform has no standardized way to access camera *spectrum* at all**, confirmed via a
  still-open, unresolved W3C spec issue (`w3c/mediacapture-extensions#14`, filed 2020 by a Microsoft
  Edge engineer requesting exactly this, still unanswered as of this research). The only workaround
  a W3C spec editor offered on the record was literally "look for ' IR ' in the label" — and that's
  not even reliable (a real Surface Laptop 3's IR sensor is labeled "AvStream Media Device," no
  "IR" anywhere in it).
- **Whether a laptop's IR sensor is even reachable via `getUserMedia()` is an OEM driver coin-flip,
  not a Sightline-controllable property.** Microsoft's own "Windows Hello Camera Driver Bring Up
  Guide" documents a `SkipCameraEnumeration` INF flag that exists specifically to **hide** the IR
  sensor from ordinary apps — non-exposure is the documented default intent; exposure (as seen on
  a real Surface Book/Surface Laptop 3) is OEM variance, not a supported integration point. Across
  a real school's mixed Lenovo/Dell/HP fleet, this would be inconsistent per-device, not a
  reliable capability to design a feature around.
- **Even where reachable, there's no way to control the IR illuminator LED from a web page** — the
  actual light-emitting hardware is gated behind a private kernel-streaming DDI
  (`KSPROPERTY_CAMERACONTROL_EXTENDED_FACEAUTH_MODE`) exclusive to the OS biometric subsystem, with
  no path from JavaScript to it at all (the closest web-platform analog, the Image Capture spec's
  `torch` constraint, only ever controls a phone's visible-light camera flash, and was never
  extended to IR).
- **The accuracy advantage of professional (Tobii-class) trackers is a hardware/geometry property,
  not a spectral-band one.** PCCR (pupil-center corneal-reflection) tracking needs a *controlled,
  known-position* IR LED to produce a trackable corneal glint at a geometrically predictable
  location — that's what gives ~0.3-0.6° accuracy. Bare IR-band *sensitivity* without a controlled,
  synchronized emitter (which is the most this app could ever realistically get, per the point
  above) would at best give a cleaner low-light image for an appearance-based method — the same
  class of technique this app already uses, not a jump to PCCR-class precision.
- **MediaPipe's FaceLandmarker (what this app already uses) is RGB-only, with no documented IR
  behavior, and the closest analogous evidence says it wouldn't degrade gracefully.** Two long-open
  MediaPipe GitHub issues ask this exact question with no maintainer answer; a sibling MediaPipe
  Task (Hands) that *was* tested on IR input was reported to fail badly (losing hand shape,
  frequent tracking failures) rather than gracefully — consistent with the broader RGB→IR
  domain-gap literature, which treats this as a nontrivial research problem, not a drop-in swap.
- **No IR-webcam-class dataset or model exists to build on, even for a custom approach.** Every
  genuinely IR-based gaze dataset found (OpenEDS/OpenSFEDS, automotive driver-monitoring systems)
  uses purpose-built, close-range, or dedicated-illuminator hardware — VR-headset-interior cameras
  a few centimeters from the eye, or dashboard rigs with six dedicated NIR LEDs — with no
  relationship to a webcam on a music stand. Building an IR version from scratch would mean
  collecting an entirely new dataset; there's no shortcut.
- **A custom *RGB* appearance-based model, by contrast, is realistic and already has a concrete
  reference implementation: WebEyeTrack** (arXiv:2508.19544, 2025, MIT-licensed,
  `github.com/RedForestAi/WebEyeTrack`, published as both a PyPI and npm package). A 0.16M-param
  (670KB) CNN running via TF.js, with **on-device few-shot personalization from as few as 9
  calibration samples** — numerically identical to this app's own 9-point calibration count.
  Reports 2-5cm/°-class point-of-gaze error, in the same range as this app's current MediaPipe-iris
  approach, and degrades more gracefully over a session than WebGazer.js (the other
  actively-referenced browser gaze library, RGB-only, "maintenance mode" but not dead).
- **Verdict: IR is not a fruitful direction for this app** — not because it's technically
  unbuildable in the abstract, but because every layer (web platform access, illuminator control,
  the underlying accuracy mechanism, dataset availability) independently comes back negative for
  the "ordinary school laptop webcam" scenario this app actually runs on. **If reconsidering,
  the specific condition that would change this verdict is a controllable, known-position IR
  illuminator becoming standard web-platform-accessible hardware** (not just an IR-sensitive
  sensor) — short of that, PCCR-class accuracy is architecturally out of reach regardless of
  software effort.
- **A real, falsifiable next step exists on the RGB side, if accuracy improvement is still wanted**
  (a separate, uncoupled question from the IR one above): spike integrating the `webeyetrack` npm
  package on a throwaway branch, A/B it against the current MediaPipe-iris + ridge-regression
  pipeline with 3-5 real users under the same 9-point calibration protocol, and measure whether its
  post-calibration *zone-classification* accuracy (does it land in the correct discrete page-turn
  trigger zone — the actual bar this app needs, not raw cm/degree error) meets or beats what's
  shipped today. Not yet done; genuinely open if pursued.
- **Methodological note:** no browser automation was available in this research session either
  (see QA persona), so this was pure literature/spec/issue-tracker research, not hands-on testing.
  A standalone diagnostic page (enumerate video input devices, flag IR/Hello-suggestive labels,
  live-preview each one, dump `getCapabilities()`) was built and handed to the user to actually
  check their own real hardware — genuine verification of the "is a sensor even exposed" question
  needs a real device, which no amount of further research alone can substitute for. **Result on
  the one real machine tested: exactly one camera device, no IR-suggestive label, and
  `getCapabilities()` reporting a `colorTemperature` range (2800-6500K) and full white-balance/
  saturation controls — conclusively an RGB sensor, not IR.** Consistent with the literature
  verdict above, not just a coincidence: no second device to even consider. (Getting a clean read
  took a couple of iterations — the diagnostic itself had two real bugs surfaced by that testing,
  both about `getUserMedia()` device-reopening edge cases rather than anything IR-specific: a
  close-then-immediately-reopen race with the OS driver, and `deviceId: {exact: ...}` failing on a
  `file://` origin even for a device ID `enumerateDevices()` had just returned. Fixed by switching
  to `deviceId: {ideal: ...}` and adding a retry-with-delay — the general lesson being that
  `file://` is a meaningfully less-tested origin for `getUserMedia()` device-selection edge cases
  than a real server origin, worth remembering for any future ad hoc browser-capability testing
  page, not just this one.)

**Per-eye confidence weighting, shipped (2026-07-24) — replaces the unconditional `(L+R)/2`
flat average in both gaze-angle and eye-look-blendshape combination.**
- **The gap this closes:** `gazeMath.js`'s `eyeRatios`/`blendVec` averaged the two eyes
  unconditionally. If one eye is compromised (glasses glare, a head turn partially occluding it,
  a partial closure not severe enough to trip the hard blink gate), its degraded reading pulled
  the combined gaze estimate exactly as hard as the good eye's — silent, ungraded degradation
  instead of favoring whichever eye is actually trustworthy right now.
- **What was built:** `eyeConfidence(left, right)` in `gazeMath.js` derives a per-eye weight from
  the SAME `eyeBlinkLeft`/`eyeBlinkRight` blendshape scores already computed for the hard blink
  gate (pure signal reuse, no extra per-frame cost): `weight = max(MIN_EYE_WEIGHT, 1 - blinkScore)`,
  floored (never fully zeroed) so a single bad confidence reading can't swing all the way to a
  pure single-eye estimate. `eyeRatios`/`blendVec` both take an optional `weights` parameter
  (default `{left:1, right:1}`, which is *exactly* the old flat average — every existing call
  site that doesn't pass weights is unaffected) and combine via a weighted mean instead of a
  plain one. `irisTracking.js`'s `onFrame` computes the blink scores once (as it already did for
  the gate), derives weights, and passes them to both.
- **Why blendshapes, not raw eyelid-landmark geometry, as the confidence signal — deliberately
  the opposite of what you might reach for first:** raw per-eye lid-gap ratio is anatomy-specific
  (a person's two eyes are rarely symmetric even at rest — see the wink-calibration work above and
  the Applied Math persona's per-user gap-threshold write-up), so a confidence weight built from
  raw geometry would *permanently* down-weight whichever eye is naturally narrower at rest, not
  just when something is actually wrong. The blink blendshape is a model-fit "how closed is this
  eye" score that already accounts for per-face anatomy far better than raw pixel geometry, so
  ordinary rest-state asymmetry (e.g. 0.08 vs 0.12) barely nudges the weights off 50/50, while a
  real problem (glare, occlusion, partial closure) drives one eye's score up much more than the
  other's — which is exactly when down-weighting it is wanted. Confirmed via unit tests
  (`gazeMath.test.js`) at both ends: near-equal scores stay within a ~48-52% band of 50/50; a
  clearly-elevated score (0.28 vs 0.05, still under the hard 0.3 blink gate) shifts weight to
  under 45/55.
- **Verified:** 10 new colocated unit tests in `gazeMath.test.js` covering `eyeConfidence` in
  isolation and the weighted `eyeRatios`/`blendVec` combination (default-weights identity, equal
  weights matching the flat average, down-weighting pulling the result toward the trusted eye, and
  pose-mode too) — plus the existing `irisTracking.test.js` suite (all still pass unchanged, since
  its synthetic landmark rig is eye-symmetric and both flows reduce to the same value there). Full
  suite green (351 tests total after this + the other two items in this round).
- **What's NOT verified, and can't be without a live session:** this is exactly the kind of change
  the task brief predicted can't be confirmed headlessly — no real glasses glare, real asymmetric
  partial closure, or real head-turn-occlusion was tested against a live camera. The math is
  provably conservative (degrades to today's exact behavior when both eyes score equally, per the
  unit tests), but whether it *measurably* helps in an actual glare/occlusion scenario is an open,
  real-user question for whoever next has a webcam and a pair of glasses on hand.

**Smooth-pursuit calibration, shipped as an experimental alternative alongside the 9-dot flow
(2026-07-24) — see `src/lib/pursuitCalibration.js`, jointly documented here and in the Applied
Math persona doc (the fitting/lag-estimation math is that persona's territory; the UI/capture
wiring below is this one's).**
- **What it is:** instead of clicking 9 fixed dots, the user follows one continuously-moving
  target (a Lissajous path, bounded to the same safe screen margins as the 9-dot grid) for ~10s.
  `calibration.js`'s new `runPursuitCalibration()` reuses the exact same `state.capturing`
  mechanism the 9-dot flow already used to collect raw per-frame samples — `irisTracking.js` now
  stamps each captured sample with `t: performance.now()` (harmless extra field for the 9-dot flow,
  which never reads it) specifically so the pursuit flow can recover *when* each sample was
  captured relative to the sweep's own start, which it needs to pair each sample against the
  target's position at that instant.
- **Wired as a genuine, real option, not a stub:** a new `👀 Pursuit calibration (experimental)`
  button (shown/hidden and enabled/disabled in lockstep with the existing `Calibrate` button — same
  `needsCalibration`/camera-ready gating in `settings.js`/`camera.js`), a dedicated `#pursuitCalib`
  overlay with a smoothly-moving `#pdot` target, and a `cancelPursuitCalibration()` escape hatch
  wired into both of the two places that already reset in-progress-calibration state on a mode
  switch (tracking-type change, head-pose toggle) — a mid-sweep switch away doesn't leave the
  overlay stuck open or the button permanently unresponsive.
- **On finish, the fitted model is saved and applied through the exact same `applyFittedModel()`
  helper the 9-dot flow now also uses** (extracted from `finishCalibration()` as part of this
  work) — same `state.coefX/coefY/gnorm`, same `saveCalibration()`/localStorage persistence, same
  `calibModelId()`. A pursuit-fitted calibration round-trips through reload exactly like a 9-dot
  one; nothing downstream (the accuracy test, `applyX`/`applyY`, recentering) needed to change.
- **Deliberately does NOT surface its own quality check as a "recalibrate" prompt** — see the
  Applied Math persona doc for why (`pursuitQuality`'s leave-one-out check was found, in this
  session's own testing, to flag even an independently-good fit as "poor" for a continuous
  trajectory). `applyFittedModel` is always called with `poor: false` from this flow. This was a
  deliberate choice to ship something honest rather than something that looks more finished than
  it is: a real, working alternative calibration flow with a known, documented, open validation gap,
  not a fake "all clear" signal.
- **What's genuinely verified (headlessly, via `pursuitCalibration.test.js`, 13 tests):** the
  trajectory stays within bounds; the cross-correlation lag estimator recovers a known synthetic
  lag exactly and its score cleanly peaks at the true lag (not a plateau); a fit built with the
  correlation-estimated lag scores measurably better on independently-sampled held-out points than
  a naive zero-lag assumption (concrete RMS numbers, not an assertion) — this is the core claim
  (smooth-pursuit lag correction matters, and a literature-standard correlation approach recovers
  it) and it's evidenced, not asserted.
- **What's explicitly NOT verified, and needs a real human at a real webcam before this should be
  considered anything more than an experiment:** the trajectory speed/duration/frequencies (10s,
  Lissajous 3:4) were chosen from general knowledge of comfortable smooth-pursuit speed ranges, not
  validated against a real user's actual eye-tracking comfort or the real MediaPipe iris signal's
  actual noise characteristics while genuinely moving (only additive Gaussian noise was simulated).
  Whether real users can comfortably follow this specific path for the full 10s, and whether the
  resulting calibration is actually as accurate in practice as the 9-dot flow, is completely open —
  this is presented to the user as "(experimental)" for exactly that reason, and should stay so
  until someone verifies it live.
- **Methodological note on how item 3 was researched:** no WebSearch/WebFetch tool was actually
  available in this session despite being expected to be (mirrors the IR spike's own methodological
  note above) — the trajectory-design and lag-correction reasoning here draws on general knowledge
  of the smooth-pursuit eye-movement literature (the "Pursuits" interaction technique — Vidal,
  Turner, Bulling & Gellersen — and the broader oculomotor-control latency/gain literature it
  draws on) rather than a live literature check performed in this session. Treat specific numeric
  claims about typical lag/speed ranges as reasonable-but-unverified-this-session, not
  freshly-confirmed citations.

**Open questions / future research:**
- Whether iris landmarks alone (without full FaceLandmarker) could reduce the ~13MB first-load
  fetch further — not investigated. The fetch is now same-origin (see Privacy/Architecture
  persona), so this would only help load time, not the CDN-blocking failure mode that motivated
  self-hosting in the first place.
- Robustness under glasses glare / low light beyond what "Check accuracy" already surfaces — the
  per-eye confidence weighting above is a real, tested step toward this, but still needs live
  verification against an actual glare/occlusion scenario (see above).
- Whether the WebEyeTrack spike above (RGB appearance-based CNN, not IR) is worth pursuing — see
  the falsifiable next step spelled out above.
- Smooth-pursuit calibration's own open items: (1) validate trajectory comfort/duration with real
  users, (2) design a validation metric for continuous-trajectory calibration that doesn't have the
  leave-one-segment-out over-flagging problem documented above and in the Applied Math persona doc,
  (3) A/B its real (not synthetic) post-calibration accuracy against the proven 9-dot flow via the
  app's own "Check accuracy" test with real users, before ever considering it for anything beyond
  "(experimental)".


**First real hands-on webcam session (2026-07-25) — three genuine defects found, and a hard lesson
about the measurement itself.** Everything before this was synthetic-only; a human at a real
webcam found things no unit test could.

- **A real bug shipped that same day, in backlog item A4's fixed blink threshold.** A4 switched
  iris tracking's blink gate to MediaPipe's `eyeBlink` blendshape with a fixed `> 0.3` cut. That
  cut cannot distinguish *eye closing* from *eye looking down* — both narrow the aperture. The
  bottom-row calibration dots (y=0.88) repeatedly failed to capture, and the user could make them
  work instantly by deliberately widening their eyes, which is direct causal confirmation. The
  gate was `return null`-ing before the calibration sample was pushed, so it silently discarded
  exactly the samples for the lowest targets — both a capture failure and a systematic downward
  bias in whatever survived. **Fixed** with a gate relative to a slowly-adapting baseline of the
  user's own recent closure (blinks are large *fast* transients that clear the rise margin; a held
  downward gaze is a smaller sustained elevation the baseline absorbs in ~0.4s), plus an absolute
  ceiling. The baseline deliberately updates on rejected frames too — otherwise a downward look is
  rejected on frame one and never gets to teach the baseline it's the new normal, which is the
  original bug. **Generalizable lesson: any fixed threshold on an eye-closure signal is really a
  threshold on eyelid aperture, and vertical gaze moves the eyelid. Prefer relative-to-baseline.**
- **The pursuit trajectory teleported.** After the stationary lead-in holds the dot at center, the
  sweep's own t=0 was at (0.5, 0.88) — the very bottom — so the dot jumped 0.38 of screen height
  the instant sampling began, guaranteeing a catch-up saccade exactly when it mattered. Fixed by
  setting PHASE=0 so the sweep starts where the lead-in left the eye. Found by a user saying "have
  the dot start moving from the center," then confirmed numerically.
- **Pursuit was moving far too fast** (~900px/s peak; smooth pursuit degrades into catch-up
  saccades well below that). Slowing it recovered ~8 points of measured accuracy on its own.
- **Ocular dominance is now measured, not assumed** — see the Applied Math persona for
  `chooseEyeMode`. Prompted by the user asking whether one eye might be stronger.

**The measurement lesson, which matters more than any of the above:** back-to-back 9-dot
calibrations under *identical* code and *identical* room brightness produced accuracy-test results
**36 points apart** (55% then 91% "lands on the right line"). The differences being chased all
session were 5-10 points. **The noise was ~4x the signal, which means most single-run A/B
comparisons made during that session were not measuring what they appeared to.** Two confounds were
also in play and under-weighted at the time: room brightness drifted from ~140-150 down to
~117-127 across the session, and the accuracy test was itself reporting "your face is small in
frame" (fewer pixels on the iris is upstream of every algorithm here). **Before trusting any future
gaze A/B: fix the setup first (light, distance), then take medians of 3-4 runs, never single runs.**
Real-world target settled at ~75-80% "lands on the right line" as good enough for this app, since
the reading band's height, the turn-delay, Snap mode's quantization, and the pedal/spacebar
fallback all absorb residual gaze error.

**Smooth pursuit promoted to the PRIMARY calibration (2026-07-25), with the 9-dot grid kept as a
labelled fallback.** Driven by real use: pursuit was reported as dramatically easier to complete,
and its accuracy became indistinguishable from the grid within the same session's (large)
measurement noise. Every entry point moved together — the Calibrate button, the accuracy result's
"Recalibrate", the recal banner, and the `C` hotkey. **The 9-dot flow was deliberately NOT deleted**:
it is the proven path, someone whose eyes don't pursue smoothly still needs it, and removing it
would strand saved calibrations with no recovery route. The element id `pursuitCalibBtn` was
renamed `calibFallbackBtn` in the same change — after the swap that id would have named the button
running the *9-dot* flow, exactly the kind of quietly-wrong name that misleads a later reader.

Three refinements landed the same day, each from a specific real-use observation, each with a
mechanism rather than a tuning guess behind it:
- **Dwell stops** (4 × 0.6s) partway through the sweep. During a *fixation* there is no
  smooth-pursuit lag to estimate at all, so those samples are 9-dot quality and anchor the fit at
  known positions, while the moving segments still give coverage a 9-point grid can't. They are
  also inherently lag-INSENSITIVE: shifting a sample's timestamp while the target is stationary
  barely changes where the target was, so they stay correctly labeled even when the lag estimate
  is off — which is the failure mode that made pursuit inconsistent run to run.
- **Easing into and out of each dwell.** Reported as "seems to be abrupt," and it was a data
  problem as much as a comfort one: pursuit carries momentum, so a target that stops dead is
  overshot and one that restarts at full speed is caught up to with a saccade — corrupting exactly
  the samples the dwells exist to make clean. Velocity now ramps linearly to zero and back;
  measured max frame-to-frame velocity step fell from 1.0 to 0.029.
- **Auto-set "Eye-tracking smoothing" from measured noise.** That slider never had a principled
  value — it shipped as something the user was expected to guess at. Calibration is precisely when
  this user's real per-frame jitter, on this camera in this light, is observable against a known
  target. Estimated from the first difference of the fit residual (differencing cancels both the
  target's motion and any slow bias), median-filtered so a blink can't dominate.
  **A wrong turn worth recording:** the noise→slider mapping first derived its target from
  `cfg.deadZoneFrac / 6` and returned minimum smoothing for every realistic input. The dead zone
  defaults to 0.18 — eighteen percent of the screen — so even a sixth of it is an enormous
  tolerance, and it is the wrong quantity regardless: the dead zone is what a *sustained* offset
  must not cross and says nothing about per-frame jitter. Caught by printing the mapping across
  realistic inputs rather than trusting the derivation. **Generalizable: when a formula is derived
  from an existing constant, print its output across the real input range before shipping it —
  a plausible-sounding derivation can still be anchored to the wrong quantity entirely.**

Implementation note for anyone extending the trajectory: display, fit, and lag estimator must all
agree on where the target was at a given instant. That is guaranteed by doing the elapsed →
sweep-time conversion **once** (`sweepTimeFromElapsed`), deliberately kept separate from
`pursuitTarget`, with everything downstream continuing to work in the sweep's own trajectory time.
Dwells and the speed ramp both live in that conversion, so neither can desynchronise the labels
from what was actually on screen.

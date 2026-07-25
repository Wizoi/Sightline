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

**Open questions / future research:**
- Whether iris landmarks alone (without full FaceLandmarker) could reduce the ~13MB first-load
  fetch further — not investigated. The fetch is now same-origin (see Privacy/Architecture
  persona), so this would only help load time, not the CDN-blocking failure mode that motivated
  self-hosting in the first place.
- Robustness under glasses glare / low light beyond what "Check accuracy" already surfaces.
- Whether the WebEyeTrack spike above (RGB appearance-based CNN, not IR) is worth pursuing — see
  the falsifiable next step spelled out above.


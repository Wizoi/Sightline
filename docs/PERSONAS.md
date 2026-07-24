# Sightline development personas

This is the roster of domain-expert "personas" for Sightline feature work. Each one owns a
slice of the problem (music notation, applied math, computer vision, audio, real-time control,
the actual end user, the privacy constraint, test strategy, feature scoping, and user-facing
documentation), and each entry below captures **what we've already learned** in that domain — so
a future feature discussion can start from "here's what we know" instead of re-deriving it.

Each persona also exists as an invokable Claude Code subagent under
[`.claude/agents/`](../.claude/agents/) — e.g. "ask the OMR persona whether X is feasible" can be
a literal subagent call, not just a mental frame. Update **this file** whenever a persona's
domain produces a durable finding (a feasibility verdict, a technique that worked, a dead end);
the subagent files stay thin and point back here.

**To get all 10 personas' take on a feature or change at once** (impact analysis, or an explicit
decline if it doesn't touch their domain), use the `/persona-review` skill
([`.claude/skills/persona-review/`](../.claude/skills/persona-review/)) — it fans the feature out
to all 10 subagents in parallel and synthesizes one combined report, and prompts to write any
durable finding back into this file.

---

## 1. Gaze & Computer Vision Engineer

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

---

## 2. Applied Mathematician / Numerical Methods

**Owns:** the math underneath calibration, thresholding, and clustering — the parts of the app
that turn noisy per-user signals into stable decisions.
**Files:** `src/lib/linearAlgebra.js`, `src/lib/calibrationModel.js`, `src/lib/clustering.js`,
`src/lib/mathUtils.js`, `src/lib/winkCalibration.js`

**Core techniques:** ridge-regularized least squares, Gaussian elimination with partial
pivoting, feature standardization, 1D k-means, gap-based clustering.

**What we've learned:**
- The 9-point gaze calibration fits a **quadratic model in standardized eye-angle features**
  (`1, rx, ry, rx·ry, rx², ry²`, plus a linear blendshape term) separately for screen X and Y,
  via **ridge regression** (`lstsqRidge`) — the intercept term is left unregularized (only
  indices ≥1 get `+lambda`), which is the standard reason ridge doesn't over-shrink the baseline.
  Standardizing `rx/ry/bH/bV` to zero-mean/unit-variance (`stdz`, using each session's own
  `mean`/`stddev`) before fitting keeps the normal-equations matrix well-conditioned across very
  different eye-ratio/pose scales between users. `solveLin` is plain Gaussian elimination with
  partial pivoting on the resulting small (7×7) system — no need for anything fancier at this
  scale.
- A **fixed global wink threshold doesn't generalize** across users — camera angle, lighting, and
  natural eye asymmetry mean one eye's resting/peak blink score can sit structurally higher than
  the other's. `deriveWinkThresholds` instead computes a personal closed-threshold (interpolated
  between the *higher* resting score and the *weaker* eye's peak, clamped to a sane range) and a
  personal gap-threshold (half the smaller observed eye-to-eye gap). `isUsableCalibration` then
  refuses to save a calibration that wouldn't actually distinguish a wink from rest/the other eye
  — worse-than-default calibrations are rejected rather than silently accepted.
- **1D k-means with k=2** (`kmeans2`: iteratively split by the running midpoint, recompute both
  centroids) is enough to tell a bimodal gap distribution (e.g. "small gaps within a staff" vs.
  "large gaps between systems") apart from a unimodal one — used by system-grouping detection
  (see OMR persona) to decide whether a score's staves are meant to be read as grouped systems.
  `clusterVals` (simple gap-threshold grouping on sorted values) is the workhorse for
  lower-stakes 1D clustering (staff-line rows) where a fixed/derived cutoff is good enough.
- General idiom across this codebase: prefer the **simplest numerical method that's provably
  adequate at the actual data scale** (7-parameter ridge fit on ~9 points; 2-cluster k-means on a
  few dozen gaps) over general-purpose ML — everything here needs to run instantly, client-side,
  on commodity laptops, with no training data beyond what one user provides in one sitting.

**Open questions / future research:**
- Whether a per-user *nonlinear* wink threshold (rather than the current linear interpolation)
  would help outlier faces — no evidence yet that it's needed.

**Item A3 closed (2026-07-23): leave-one-out (LOO) residual check at `finishCalibration()` time,
surfacing a proactive recalibration prompt independent of `calibMismatch`.**
- **The gap this closes:** the fit's own training residual is close to useless as a quality
  signal here — a 7-parameter model fit on ~9 points can drive its *training* error to near zero
  almost regardless of whether the fit actually generalizes, since there's so little slack (2
  spare points) to reveal overfitting. LOO is the right tool specifically because it's "free" at
  this scale: 9 points means 9 cheap refits (each a 7×7 `solveLin` on 8 points), giving a genuine
  held-out prediction error per point rather than a training-error number that can't distinguish
  a good fit from a memorized one.
- **What was built** (`src/lib/calibrationModel.js`): `looResiduals(calibPoints, ridgeLambda)`
  refits `fitCalibration` once per point with that point excluded, then evaluates the excluded
  point's own `(rx,ry,bH,bV)` against the refit model and compares to its actual `(sx,sy)` target
  — returning `{ index, dx, dy, dist }` per point (`dist` = Euclidean distance in screen-fraction
  units, the same 0-1 space `sx`/`sy` already live in). `gridSpacingThreshold(calibPoints)`
  derives a "meaningfully bad" cutoff **from the actual calibration grid used**, not a hand-picked
  constant: half the smallest spacing between distinct target columns/rows. The reasoning: a LOO
  error past that would place the predicted point closer to an *adjacent* calibration target than
  to the true one — a concrete, interpretable failure ("the model would have confused this click
  with a neighboring one"), not an arbitrary number. For the app's real 9-point grid (`sx` ∈
  {0.1,0.5,0.9}, `sy` ∈ {0.12,0.5,0.88}) this works out to `min(0.4, 0.38)/2 ≈ 0.19`. Falls back to
  a conservative constant (0.15) only for a degenerate/non-grid point set with no real spacing to
  derive from (shouldn't occur via the app's own `runCalibration()`, but the function is written
  to be safe if ever called on something else). `calibrationQuality(calibPoints)` ties these
  together into one summary (`worst`, `worstIndex`, `threshold`, `poorIndices`, `poor`), guarding
  the degenerate `<4`-point case by returning a non-poor empty result rather than computing
  something meaningless off too little data.
- **Wired into `finishCalibration()`** (`src/calibration.js`): after the real fit is computed and
  saved (a poor LOO result doesn't block saving — it's still the best model available, exactly
  the same "surfaced for review, never silently substituted or blocked" pattern already used
  elsewhere in this codebase for barline counts / time-sig detection, see OMR persona), `poor`
  triggers the **existing** `showRecalBanner()` mechanism (`src/ui.js`) — the same banner already
  used for a changed camera/window fingerprint (`calibMismatch`) — rather than inventing a second
  "your calibration might be bad" UI. This directly addresses the framing in the original backlog
  item: `calibMismatch` only reacts to a changed *setup*; this reacts to the fit *itself* being
  poor even on the very setup it was just captured on (bad point placement, a mistimed click, a
  tracking glitch mid-capture) — a real, complementary failure mode `calibMismatch` structurally
  cannot see since it never looks at the calibration data itself, only environment metadata.
- **Threshold honesty, as instructed:** the `min-grid-spacing/2` rule is grounded in something
  real (the app's own calibration geometry) and is more principled than an arbitrary magnitude
  guess, but it has **not been validated against real problematic-calibration session data** —
  no corpus of "sessions a user later reported as inaccurate, with their raw calibration points
  captured" exists to check this against, and none was fabricated to fake that validation. Treat
  0.19 (screen-fraction) as a conservative, clearly-reasoned starting point, not a tuned constant
  — if real usage ever surfaces either false-positive recal prompts on calibrations users are
  actually happy with, or a missed genuinely-bad session, that's the evidence to retune this
  against, the same "verify against real data, don't tune blind" discipline used everywhere else
  in this project (see OMR persona's `minFrac`/`pad`/rotation-threshold write-ups for the pattern
  this is following).
- **Verified:** 12 new colocated unit tests in `src/lib/calibrationModel.test.js` — a clean
  noise-free 9-point grid produces near-zero LOO residuals and `poor: false`; corrupting one
  point's recorded gaze reading (simulating a glance-away or tracking glitch mid-capture, target
  unchanged) reliably flags exactly that point as the worst offender and flips `poor: true`;
  `gridSpacingThreshold` is checked directly against the real 9-point grid's derived value and
  against a degenerate all-identical-point fallback case; a too-few-points input returns a safe
  non-poor empty result rather than throwing or fabricating a number. Full suite:
  `npm test` — 297 passed (was 285; +12 new, 0 regressions).

---

## 3. Optical Music Recognition (OMR) / Music Notation Specialist

**Owns:** reading structure out of the rendered score image — staves, systems, barlines,
measures — without doing full music recognition. Also owns reading structure out of the PDF's
*real text layer* where one exists (part/section boundaries, tempo markings, measure numbers) —
a related but fundamentally different technique from pixel-based detection; see below.
**Files:** `src/lib/systemDetection.js`, `src/lib/barlineDetection.js`, `src/scoreAnalysis.js`,
`src/lib/scoreSections.js`, `src/lib/scoreText.js`, `src/lib/timeSigMatch.js`,
`src/timeSigDetection.js`

**Core techniques:** staff-line row detection, 1D clustering (staves → systems), run-length
ink analysis for barlines, engraving-convention reasoning, PDF text-layer extraction
(`page.getTextContent()`), position/repetition-based text classification, glyph shape-matching
(grid-overlap similarity).

**What we've learned:**
- **Full automatic OMR (reading actual rhythm/pitch/note-duration values from PDF pixels) was
  researched for the auto-scroll feature and found infeasible to do reliably while staying
  100% client-side.** That verdict is why auto-scroll's v1 uses a *much* cheaper proxy — barline
  counting plus a user-confirmed BPM/time-signature — instead of true tempo/rhythm extraction.
  This is the single most important scoping decision in the project's music-reading work and
  should be revisited (not assumed permanent) only if a genuinely lightweight in-browser
  approach turns up — see the Feature Strategy persona for how to run that kind of feasibility
  spike, and the Privacy/Architecture persona for why "send it to a cloud OMR API" isn't on the
  table.
- **System detection** (`pageSystemsDetailed`) clusters detected staff-line rows into staves
  (requiring ≥3 lines per cluster — a real staff has 5, but this tolerates a missed line), then
  decides whether staves group into multi-staff systems by checking if the *gaps between staff
  centers* are bimodal (via `kmeans2`, see Applied Mathematician persona) — only trusting a
  multi-staff grouping when it's **consistent** (same staff-count per system for all but at most
  one group). This is deliberately conservative: an inconsistent grouping falls back to "every
  staff is its own system," which is right for the single-staff band parts that are this app's
  primary audience anyway.
- **`collapseThickness`** (in `systemDetection.js`) was added after testing against a real
  rendered PDF, not a synthetic one: anti-aliased/thick staff lines commonly render as 2-3
  adjacent "ink" rows rather than exactly 1. Left in the row list, those ~1px thickness gaps
  contaminate the gap statistics used to size the staff-clustering cutoff, dragging the median
  down so far that real inter-line gaps stop clustering — every line ends up isolated. Collapsing
  near-duplicate rows into one representative point *before* computing gap statistics fixed it.
  **Lesson generalized:** synthetic idealized test fixtures did *not* catch this; a real rendered
  PDF did (see QA/Test Strategy persona).
- **Barline detection is a deliberate approximation, not a hidden gap.** `countBarlines` looks
  for thin vertical strokes spanning ≥85% of a system's staff-line band height (a genuine barline
  crosses the whole staff; a stray mark usually doesn't). It does **not** distinguish
  single/double/final barlines or special-case repeat signs, and assumes roughly uniform note
  values within a measure. `estimateMeasureCount` treats N detected barlines as bounding N
  measures (a printed system's last measure is always closed by a barline — "fence posts"), and
  **falls back to 1, never 0**, when nothing is confidently detected, specifically so a wrong
  count is *visibly* wrong (the user will notice "1" and fix it) rather than silently absent. The
  app always surfaces this count for user review/correction (`src/scoreAnalysis.js`) rather than
  trusting it blindly — treat that "human confirms the estimate" pattern as the template for any
  future detection-based feature in this domain, not a stopgap to eventually remove.
- **Engraving-convention grounding:** [[project_target_audience]] — the realistic input is
  cleanly engraved, single-staff, mostly single-tempo published band parts (Hal Leonard/Alfred/
  notation-software exports), not scanned/photographed pages or full orchestral/piano scores.
  Detection-accuracy work should be tuned and tested against that bar, which is meaningfully
  easier than worst-case grand-staff piano engraving — don't over-invest in robustness the
  primary audience doesn't need yet.

**A third real-file bug, found on a real 4-part braced clarinet-quartet score (2026-07-20,
"Juggling Clowns" by Bill Malcolm): multi-staff system grouping silently degraded to one-staff-
per-system across a *whole page* because a single staff went undetected.** The user reported the
symptom directly — selecting the Score section only highlighted a thin single-staff band, and
"next system" advanced by one staff instead of one printed system. Diagnosed by actually rendering
the real file headlessly (Node + `pdfjs-dist`'s legacy build + `node-canvas`, since no browser
automation was available in-session — see QA persona) and running the real `pageSystemsDetailed()`
against it: one staff (Clarinet 2's, in a system with several consecutive whole-measure rests)
produced only 2 of its 5 expected staff-line rows instead of the usual 4-5, and the old `>= 3
lines to count as a staff` filter dropped it entirely. That alone would only cost one system's
staff — but losing that one staff changed the *gap* between its still-detected neighbors enough to
exceed the intra-system clustering cutoff, which cascaded into the whole page's grouping being
judged "inconsistent" and falling back to per-staff systems everywhere, not just the one affected
system. **Fixed** by loosening the per-staff line-count filter from `>= 3` to `>= 2` in
`systemDetection.js` — verified (not assumed) safe by running *every* page of the real file through
both thresholds: the 3 affected score pages fixed, the other 10 pages (including single-staff part
pages, where nothing this loose should ever spuriously cluster) byte-for-byte unchanged. **General
lesson, sharpening the "one missing staff" resilience gap already implicit in the grouping-
consistency check's "tolerate at most one non-conforming group" design: a dropped staff's damage
isn't contained to its own system — it can silently corrupt a neighboring system's gap statistics
too, so the fix belongs at the detection threshold (stop losing the staff) rather than trying to
patch the grouping logic to tolerate more missing staves after the fact.** Also notable
methodologically: no headless-browser tool was available in this session (no `chromium-cli`, no
installable Playwright browser — see QA persona), so verification used a from-scratch Node+
`node-canvas` render harness instead of the project's usual Playwright-driven approach — a real
file rendered through the *actual* PDF.js pipeline was still reachable even without a browser, and
was what made the diagnosis conclusive rather than speculative.

**Two accuracy bugs found and fixed against a real, complex piece (mixed meter, dense fast
passages) — both via the same "verify against real data, don't tune blind" discipline:**
- **`extractMeasureNumbers`'s y-range check had zero tolerance, and a measure number is engraved
  *above* the staff, not within it.** Consistently ~10pt above a system's own detected top edge on
  every page checked. A page with generously-spaced systems could still match by coincidence with
  no tolerance at all, which is exactly why this went unnoticed until a *tightly*-packed page (9
  systems on one page) surfaced it: the un-padded check matched **zero of 8** real printed numbers
  on that page, leaving every system on it stuck with the raw pixel estimate. Fixed with a
  `pad=20` tolerance above `yTop` (a real margin over the observed ~10pt, still well under
  typical system-to-system spacing so it can't reach into a neighboring system's own number) and
  "closest wins" tie-breaking. This alone fixed the majority of a real anomaly a user spotted
  (measure counts of 18 and 23 among neighbors of 4-9) — the anomalies weren't really about the
  barline heuristic at all; refinement (which should have overridden them) simply wasn't running
  on that page.
- **Even after that fix, the two positions refinement can never reach — a section's first and
  last system, no adjacent known number to diff against — stayed elevated.** Dumped the actual
  run-length *fraction* (not just pass/fail at one threshold) for every candidate column on the
  worst page and found a clean signal: genuine barlines cluster at exactly 1.0 (full band
  height); false positives (note stems, accents, staccato dots in a dense, fast passage) cluster
  at 0.62-0.91 — tall, but not *full*. Raised `countBarlines`'s default `minFrac` from 0.85 to
  0.95 to exclude that band. Verified end-to-end against the real file: the already-correct
  "Score" section's counts were byte-for-byte unchanged (no regression), while the exposed
  first/last-system anomalies dropped substantially (e.g. 11→4, 16→9, 14→8) — real improvement,
  though not perfect in every case; some residual overcounting likely remains for the very
  densest passages. **General lesson: when a pass/fail threshold's false positives and true
  positives turn out to be numerically close (0.85 vs. actual barlines), don't just eyeball
  candidate positions — dump the actual continuous metric across a real sample and look for
  where the two populations actually separate**, the same evidence-based approach that already
  paid off for `collapseThickness` and the text-extraction bugs above.

**PDF text-layer extraction — a second, much more reliable detection technique (added for the
"score sections" feature: splitting a full-score-plus-parts PDF into named, independently
tempo/time-signature-scoped sections):**
- **This is *not* a partial walk-back of the "full OMR is infeasible" verdict.** It's a different
  problem: a PDF exported from real notation software (Finale/Sibelius/Dorico/MuseScore-class,
  not a scan) embeds instrument names, tempo markings ("Andante"), and printed measure numbers as
  **genuine, exact text objects** — `page.getTextContent()` (pdfjs, already a project dependency,
  previously only used for rendering) reads them with zero recognition error, the same way you'd
  `grep` a text file. Full OMR is still infeasible because it means *recognizing* notes/rhythm
  from pixels; this is *reading pre-existing text*, a categorically easier problem. Confirmed by
  dumping every text item on a real multi-part test PDF before writing any detection code — verify
  this same way (inspect real `getTextContent()` output) before assuming a new PDF has this
  property; a scanned/photographed score won't.
- **Time-signature digits are the one exception, and are genuinely subject to the OMR-infeasible
  class.** They're drawn from the music engraving's glyph font with no Unicode mapping — same as
  noteheads/stems — confirmed by dumping every item on a page containing a visible "4/4" and
  finding only position data, no digit characters. Reading them at all requires the shape-matching
  approach below, not text extraction.
- **A rendered page's text layer is much noisier than it looks.** Most items (noteheads, stems,
  accidentals) are empty-string, position-only glyphs — expected. But some music-notation glyphs
  *surprisingly* decode to ordinary-looking characters: staccato dots and spacer glyphs were found
  decoding to literal "." and extra whitespace on a real test file, silently corrupting naive
  text reconstruction (e.g. "Clarinet in B 2" merging with the composer's name on the same row
  into "Clarinet in B2Bill Malcolm"). **Fix:** only treat an item as real content if it contains a
  letter or is a clean digit run (`isMeaningful()` in `scoreText.js`) — checking for "non-empty
  string" alone is not enough.
- **Row-reconstruction merge logic must compare against each row's original/fixed first-item y,
  not a running average.** A page has hundreds of text items; a running average lets a long dense
  chain of nearby items drift far enough to bridge two genuinely distinct rows into one (found via
  the same corrupted-text symptom above). Fixed-reference-y merging (`groupIntoRows`) fixed it.
  **General lesson: any "cluster nearby values" logic should default to a fixed reference per
  cluster, not an incrementally-updated running average, unless there's a specific reason values
  need to drift** — the Applied Math persona's `kmeans2`/`clusterVals` don't have this bug since
  they're not incremental, but a *new* one-off clustering loop easily could.
- **Detecting a "real instrument label" needed position, not repetition.** First attempt used
  "the text repeats 2+ times" to distinguish instrument names (which repeat once per system) from
  one-off title-block text ("Score", the composer's name, also sitting at the left margin) —
  **wrong**, because a score prints an instrument's *full* name only once (beside its first
  system) then an *abbreviated* form on every system after ("Clarinet in B 1" once, then "B Cl. 1"
  repeated) — neither "once" nor "repeats" is reliable on its own. **What actually works:**
  position relative to the first system's top edge — title-block text sits *above* the music;
  every form of a real label sits *at or below* it (`collectKnownNames`'s `topSystemY` + `pad`
  parameter). **General lesson: when a first classification heuristic is falsified by real data,
  look for a positional/structural signal before reaching for a second statistical one** — this
  is the second time in this codebase geometry beat statistics (see also the dead-zone
  per-direction-cap bug, Real-Time Control persona).
- **A bootstrap page must never also be a match target for what it bootstraps.** The page that
  *collects* known instrument names (page 1, a full score's opening) was initially also checked
  for title matches against those same names — it always matched itself (it has a tempo marking
  and, trivially, contains its own just-collected names), silently misnaming the opening "Score"
  section after whichever instrument happened to be listed first. Fixed by excluding the bootstrap
  page from title-matching entirely. **General lesson: any "collect known values from source X,
  then match other things against them" pipeline needs an explicit check that X doesn't
  match-against-itself.**
- **Sections are saved snapshots swapped into existing global state, not a parallel data model.**
  `autoScrollController.js` only ever reads `state.autoScroll.{systemBands, measuresPerSystem,
  beatsPerMeasure, bpm}` directly; a "section" (`lib/scoreSections.js`) is just a remembered copy
  of those four values, and selecting one (`autoScrollUI.js`) swaps its copy into the live
  top-level fields by *reference* (not a deep copy) so in-place edits — e.g. hand-correcting a
  measure count — write straight back into that section's own remembered state with no extra
  sync code. This meant the schedule-building/playback code needed **zero changes** to support
  sections. **General lesson: when adding a "which of several saved configs is active" concept to
  an existing feature, prefer swapping references into the config's existing top-level fields
  over introducing a parallel `activeX` vs `allX[]` structure that every consumer has to learn
  about** — much smaller blast radius.
- **Real measure numbers refine, never fully replace, the barline-count estimate.** Where two
  *directly adjacent* systems both have a printed measure number, the exact delta is used; every
  other system (gaps, a section's last system, a PDF with no printed numbers at all) keeps the
  existing barline-count estimate untouched (`refineMeasureCounts`). This is the same "prefer the
  simpler estimate, only override where a stronger signal exists" caution as the surfaced-for-
  review barline count itself above.

**Time-signature glyph shape-matching (best-effort, ships inert — not yet reliable enough to
surface as more than a declined "no suggestion"):**
- **Region-finding needed three iterations, each falsified by looking at an actual rendered
  region, not by reasoning alone:**
  1. "Continuous ink run ≥ 50% of the band height" (matching how barline detection finds a
     barline) — found *nothing*. A clef, flat, or digit is curved/diagonal; none of those shapes
     produce one unbroken tall stroke in any single column the way a barline does.
  2. "Any ink at all in the column" — over-corrected: the staff's own horizontal lines run the
     *entire* width of the system, so every column has "some" ink regardless of whether a real
     glyph is there, merging the whole candidate region into one meaningless blob.
  3. **What worked:** a column's *longest continuous run* must exceed a small threshold —
     comfortably thicker than one staff line's stroke width, comfortably thinner than a real
     glyph stroke (`findInkBlobs` in `timeSigDetection.js`). Confirmed by rendering the actual
     crop region to a PNG and looking at it: the real "4/4" was correctly isolated as its own
     blob, distinct from the clef, a flat, and the following whole-rest.
- **Glyph detail needs a dedicated high-resolution re-render, not the shared analysis canvas.**
  The canvas used for staff-line/barline detection is downsampled for that purpose (a single
  staff renders only ~30px tall) — far too coarse for digit-shape detail (individual strokes came
  out 1-2px wide). Fix: re-render just the small candidate region directly from the PDF via
  `page.render()` at a much higher scale (10x), using a `transform` offset to crop to just that
  region instead of rendering (and discarding most of) a full high-res page — cheap, since it only
  runs once per detected section, not per page.
- **Even with a correctly-isolated, high-resolution glyph region, digit classification against
  generic-sans-serif-font-rendered reference templates (`ctx.font = 'bold ...px sans-serif'`)
  tops out around 0.3 confidence and picks the wrong digit.** Real music-engraving digit shapes
  (Bravura/Finale/etc.) are visually distinct enough from a plain UI font that shape matching
  needs actual engraving-font reference glyphs to be viable — not attempted yet (would mean
  bundling/rendering a real SMuFL-class font). The matcher (`gridSimilarity`/`matchDigit` in
  `lib/timeSigMatch.js`, Jaccard-style grid overlap) and the confidence-threshold gate both work
  correctly; the *reference data* is the blocking gap, not the algorithm.
- **Ships safely inert on purpose:** below the confidence threshold, no suggestion is shown at
  all — never a guessed value. This is the same "human confirms the estimate" pattern as barline
  counting above, applied to a detector that currently doesn't clear its own bar; treat "detect,
  then gate behind a confidence threshold that's allowed to show nothing" as the default shape for
  any future best-effort detector in this domain, not just this one.

**Wrong-`/Rotate`-flag self-correction (2026-07-21, real user corpus at `D:\sheetmusic`):**
- **Some source PDFs carry a genuinely wrong `/Rotate` flag on individual pages — a scanning/
  assembly artifact, not a hypothetical.** Confirmed on two real combined-score PDFs: a normal
  portrait page (readable title, horizontal staves at rotation 0) instead declares `/Rotate 270`.
  Sightline's rendering trusted `page.rotate` unconditionally everywhere it called
  `page.getViewport()` with no explicit `rotation` (`pdf.js` `renderAll()`; `scoreAnalysis.js`'s
  main detailed pass, the text-layer `pdfHeight` viewport, the OCR renders, the time-sig high-res
  re-render) — so the wrongly-declared page rendered sideways both on screen and for analysis,
  feeding vertical-staff pixels into the horizontal-ink-run staff-line scanner and producing
  nonsense measure counts (1-49 on a march) on just that page.
- **Fix: an unconditional per-page orientation probe, not a conditional retry gated on "looks
  wrong."** The failure mode doesn't fail cleanly — a wrongly-rotated page still detects a *few*
  garbage systems, not zero — so there's no reliable downstream signal to gate a retry on.
  Instead, every page is rendered at all 4 absolute rotations (`getViewport({ scale, rotation })`
  — this *overrides* `page.rotate`, it doesn't add to it) at a small fixed low resolution (~220px
  long edge, ~30x fewer pixels than the shared ah=1200 detailed-pass canvas), scored by the exact
  same signal already used for real staff-line detection (count of rows with a long horizontal ink
  run — `scoreOrientation`/`chooseRotation` in `lib/pageRotation.js`). The declared rotation is
  overridden only when the best-scoring candidate both clears an absolute floor (rejects a blank/
  cover/text-only page with no music in *any* rotation) and convincingly beats the declared
  rotation's own score by a ratio (rejects flip-flopping a page whose declared rotation is already
  correct). The resolved rotation is threaded through *every* subsequent render for that page
  (detailed pass, text-layer viewport, OCR renders, time-sig re-render) and also consulted by
  `pdf.js`'s `renderAll()` so the visible canvases match what was analyzed — `autoScrollUI.js`
  triggers one extra `renderAll()` after Analyze if any override was newly set.
- **Both thresholds were calibrated against real dumped scores, not guessed, and the first guess
  (floor=40) was wrong.** A placeholder floor of 40 passed 2 of 3 real target pages but silently
  missed the third (MonogramMarch p.5, a sparser continuation page whose real signal was only 29)
  — caught by instrumenting the actual per-rotation scores during Playwright-driven verification
  rather than trusting the "looks reasonable" guess. Real numbers that set the final floor=15,
  ratio=3: genuine wrong-rotation pages scored 89 (Teutonia p.3), 57 (MonogramMarch p.4), and 29
  (MonogramMarch p.5, the tightest real margin found); blank/cover-page noise topped out at 6
  (Teutonia p.1); and the regression-guard file ("Fat Burger parts with drums" — all 41 pages
  declare `/Rotate 270` and genuinely need it, real negative control) scored surprisingly low
  even in its own *correct* orientation (at most 8) since its individual-part pages are sparser
  than the two combined scores — floor=15 sits with real margin above that 8 and real margin below
  the tightest genuine 29. **General lesson, same discipline as the `minFrac`/`pad` precedents
  above: dump the actual scores from a real corpus before picking a threshold, and re-check every
  real target case individually — a threshold that passes most of a corpus can still silently
  miss one, exactly as it did here on the first pass.**
- **A pure horizontal-ink-run signal cannot distinguish right-side-up from upside-down (or,
  equivalently for a landscape-stored page, rotation 90 from 270) — a staff's lines are
  horizontal either way.** Observed directly on the real regression-guard file: its 90 and 270
  candidate scores were frequently equal or within 1-2 of each other. Not a problem in practice
  for the confirmed real cases (both broken files declare 270, never 90/180, and the floor keeps
  this noise well below any override threshold), but a real, documented limitation of the metric,
  not fixed by this change — ties are broken toward the smaller rotation value (prefers 0 over
  180) as a reasonable default given the real data, not a proof it's always right.
- **Verified via the actual running app (Playwright + system Chrome against the Vite dev server),
  not just synthetic unit tests, including a direct git-stash before/after comparison against the
  real regression-guard file** — its 41-page, 231-system measure-count output was byte-for-byte
  identical before and after the whole change, confirming the fix is a true no-op whenever no
  override fires (passing the same `rotation` value as the page's own declared `page.rotate`
  produces identical output to not passing `rotation` at all).

**Two more real bugs found and fixed via a 39-file real-corpus sweep (2026-07-21, reading actual
rendered results, not just synthetic fixtures) — both in the section-splitting pipeline:**
- **Bug: the section-title tempo gate only recognized word-based markings ("Andante"), never a
  bare printed metronome mark.** `findSectionTitle()`'s gate required `findTempoMarking()` (the
  `TEMPO_WORDS` vocabulary) to match before it would recognize ANY page as a section start — but
  `extractTempoMarks()` already had a separate, working numeric-mark regex (`= *(\d{2,3})`) for a
  different purpose (BPM resolution) that the gate never consulted. This silently broke section-
  splitting on an entire real 8-file IMSLP trio-score folder ("Potential clarinetflute duets" +
  its Melancholic subfolder): every one of them prints only "♩ = 127"-style marks, never an
  Italian word, so `findSectionTitle` rejected every part-title page even though every OTHER
  condition (a known instrument name at the left margin) was met — confirmed by dumping the real
  text layer and finding literally every other signal present. The one real file in the whole
  corpus that already split correctly (JugglingClowns) only worked because it happens to print
  "Andante". **Fixed** by sharing the regex (`TEMPO_MARK_RE`, exported implicitly via a new
  `hasTempoMarking()` that accepts either signal) rather than duplicating it — `scoreText.js`.
  Verified: all 8 real trio files (+ Melancholic) now split into real instrument-named sections;
  JugglingClowns unchanged (regression guard, confirmed byte-for-byte via git-stash A/B); several
  genuinely single-part files (`randomclarinet/`) spot-checked to confirm nothing spuriously
  splits.
- **Bug: no section-boundary signal at all when there's no combined-score bootstrap page — and
  this actively corrupted measure counts for every part after the first, not just naming.** The
  "Full band arrangements" folder (Teutonia, MonogramMarch, Fat Burger, KingCotton, Fantastic
  Parade — scanned individual-part booklets whose page 1 is a library cover sheet, not a combined
  score) never had any name for `findSectionTitle` to match against, so it never split at all —
  previously documented as "a real, accepted limitation." Turned out to be worse: measure-count
  refinement (`filterMeasureNumberOutliers` + `refineMeasureCounts`) ran ONCE, globally, across
  the whole flat system list. When part 2 restarts at measure 1, every one of its real,
  correctly-read numbers is *smaller* than part 1's, so the longest-strictly-increasing-subsequence
  logic in `filterMeasureNumberOutliers` discarded them as "outliers," and `refineMeasureCounts`'s
  own `total <= 0` defensive check separately skipped the negative-delta boundary system — between
  the two, every system from a reset onward fell back to the raw (often wildly wrong) barline/OCR
  estimate, which is what actually produced the extreme "1-71 measures" style warnings on these
  files, not a cosmetic naming gap.
  - **Fix, part A:** a printed measure number *resetting* (going down) is itself a real,
    title-independent section-boundary signal — new `detectMeasureNumberResets()` in
    `scoreText.js`, fed into `analyzeScore()`'s existing `boundaries` list alongside title matches
    (nameless; `buildSections()` already falls back to `Section N` — see below). Detected from
    whichever of the three raw entry sources (text-layer, OCR-box, OCR-strip) has the *most* data
    points, independent of which source is later chosen to fill in the actual numbers — needed
    because one real file (Teutonia) turned out to be a MIXED document: most pages have no
    extractable text (OCR path), but a few genuinely do, and that handful was both richer and
    where the only clean, confidently-read reset showed up. The old logic discarded
    `measureNumberEntries` entirely whenever *any* page fell back to OCR.
  - **Fix, part B:** `analyzeScore()` now builds sections from the RAW (unrefined) per-system
    estimate first, then runs `filterMeasureNumberOutliers` + `refineMeasureCounts` SEPARATELY per
    section (entries re-based to section-local indices) and stitches the refined slices back
    together — so a part's own numbers never bleed into a neighbor's. A welcome side effect,
    unplanned but free: re-basing to section-local indices means each part's own first system now
    implicitly anchors at measure 1 too (`refineMeasureCounts` already did this for global system
    0), fixing the "no printed 1 on the opening system" gap for every part, not just the document's
    first.
  - **A real bug in `buildSections()` surfaced immediately during verification:** its name
    fallback was `boundary ? boundary.name : defaultName` — but a nameless reset boundary is a
    real, truthy object with `name: null`, so sections literally rendered with the name `"null"`
    instead of falling back to `Section N`. Fixed to `(boundary && boundary.name) ? ... : ...`.
    Caught by actually reading the rendered Sections list, not by reasoning about the code.
  - **A second real bug surfaced by the SAME verification pass, unrelated to either bug above:**
    accepting numeric tempo marks (part A above) made section-splitting active on a real 20+-
    instrument conductor's score ("The Fantastic Parade") that had never split before (no word
    marking, so the old gate always rejected it) — and its compact left-margin layout puts each
    instrument's own time-signature digits at nearly the same y as that instrument's name label,
    so `groupIntoRows` (correctly, by its own merge rules) merged them into one row, producing
    garbage "known names" like `"6 J"` or `"b J"` (a stray music-font glyph decoding to an
    ordinary letter — the same class of surprising glyph-decode already documented on
    `groupIntoRows` itself, just colliding with a different row this time). Those short, pure-noise
    fragments then re-matched themselves on every later page where the same layout collision
    repeated, producing a flood of ~20 garbage-named micro-sections. **Fixed** by requiring a real
    run of letters (`hasRealNameShape`, >= 2 consecutive) in `collectKnownNames` — rejects the
    pure-noise fragments while keeping every real label (including short abbreviated ones like
    "B Cl. 1", "A.Cl."); a compound row that still has a real prefix ("Oboes 8 J") is kept as a
    lesser-harm tradeoff rather than chased further, since a real prefix is far less likely to
    spuriously re-match a later page verbatim than a pure-noise fragment is.
  - **A third, more diffuse quality issue found via the same corpus sweep, this time in
    `detectMeasureNumberResets` itself:** OCR/text-extraction noise doesn't just misread a single
    digit — on one real file ("A Lazy Summer Day") some other printed content (almost certainly
    not a measure number at all) got picked up as the SAME wrong small number ("2") across several
    *consecutive* systems, and each one independently looked exactly like a valid small-restart
    drop, fragmenting one real part into several bogus generic sections. **Mitigated** (not fully
    solved — see below) by requiring the very next reading, if any, to genuinely be greater than
    the drop (real numbering resumes climbing; a flatlined repeat never does). This is a real,
    verified improvement (confirmed the worst files' section counts dropping substantially: 10→8,
    17→10, 5→2) but **not airtight** — a truly isolated one-off misread immediately followed by a
    real, further-climbing number can still slip through, and one real file in the corpus (a
    Lazarus duets collection with especially poor, near-random-looking OCR readings throughout —
    values oscillating 0/3/4/5/6/7 with no real coherent climbing signal at all) still over-splits
    into 10 sections. This is a data-quality ceiling, not a design flaw in the detector: no
    heuristic on top of fundamentally noise-dominated input will reliably separate "real reset"
    from "misread" in every case. Consistent with this project's established "surfaced for review,
    not silently wrong" pattern — the sections list is visible and user-editable, so an over-split
    result is at worst a visible annoyance, not silent corruption. **Revisited and substantially
    improved (2026-07-22) — see the "Lazarus duets over-split" write-up further below**: a genuine
    additional guard (a section's own printed numbers must climb to a value plausible for its own
    system span, not just individually pass the drop/climb checks above) cut this file from 10
    sections to 5, without touching any of the 10→8/17→10/5→2 cases this paragraph already fixed.
  - **Verified against the full 39-file real corpus** (not just the target folders) before and
    after each incremental fix, confirming: every genuinely single-part file still shows no
    sections; every previously-working named-section file (JugglingClowns, the whole Potential-
    clarinetflute-duets folder) keeps its real names unchanged; every "Full band arrangements" file
    now shows 2-3 sections (down from 0) where OCR data quality permits, with per-section measure
    counts that no longer bleed across a part boundary.

**Open questions / future research:**
- **Mid-section time-signature changes are now a confirmed real case, not a hypothetical.** A
  real test piece's Alto Clarinet part changes meter almost every measure (5/8, 7/8, 3/4, 4/4,
  ...) — the section-level `beatsPerMeasure` model (Feature Strategy verdict, this section above)
  cannot be *correct* for a piece like this no matter what single value is set, since duration is
  `measures × one beatsPerMeasure` for the whole section. Under discussion: instead of trying to
  auto-detect the actual per-measure time signature (already the failed Phase 2 approach), drop
  the single beats-per-measure slider in favor of computing and displaying each system's
  scheduled *duration* directly (seconds, or another musician-legible unit) as an overlay next to
  the system on the page — sidesteps needing an exact time-signature value at all, and lets a
  user directly see/correct the number actually driving playback. Not yet built; revisit here
  once a direction is chosen.
  **Backlog note (2026-07-22), not yet researched — the open question to answer FIRST, before any
  UI work on this:** whether showing a scheduled duration per system actually lets a student
  self-correct drift as well as a single BPM number does for the common (single-tempo) case. A BPM
  slider is a single, familiar, already-internalized unit a band student can compare against a
  metronome or their own count; a per-system duration overlay is a new unit (seconds-until-next-
  system) with no existing mental model to anchor it to, and it's not yet established whether it's
  actually easier or harder for this persona's audience to use for real-time drift-correction during
  a performance. Don't start on the overlay's UI/rendering until this is answered — a good spike
  would be a low-fidelity mockup/paper-prototype check with a real student trying to keep pace off a
  duration number vs. off a BPM number, not a code prototype.
- Repeat signs / codas / D.S. al Fine and their effect on auto-scroll's linear schedule — out of
  v1 scope, unaddressed.
- ~~Whether note-head density could refine the "assume uniform note values" approximation~~ —
  **closed as moot (2026-07-20, independent review + persona triage, see `docs/reviews/`):**
  `buildSchedule()` never actually depends on note values — `duration = measures × beatsPerMeasure
  × secPerBeat` is exact regardless of whether a measure holds a whole note or sixteen 16ths, so
  there's no "uniform note values" approximation for note-head density to refine. If note-head
  detection is ever built, its real value is as a **barline false-positive discriminator** for the
  residual overcounting the `minFrac` 0.95 fix didn't fully eliminate in the densest passages (a
  candidate column flanked by dense note-heads is more likely a stem than a barline) — see
  persona 3's barline-detection write-up above. Point any future note-head-density work there, not
  at schedule refinement.
- Bundling or rendering real music-engraving-font reference glyphs (vs. a generic system font) for
  time-signature digit matching — the specific next step that would make that detector reliable
  enough to activate, if picked back up.
- ~~A PDF that's *only* individual parts with no combined full score first has no bootstrap page to
  collect known instrument names from, so its parts won't be auto-split into sections~~ --
  **fully addressed (2026-07-21 partial, 2026-07-22 completed — see the "three-item backlog" write-up
  below for the real-corpus evidence).** It now splits via the title-independent printed-measure-
  number-reset signal either way, AND a nameless reset boundary gets a real label where one exists —
  `fillMissingSectionNames()` (`scoreAnalysis.js`) treats THAT boundary's own first page as a one-off
  mini-bootstrap page (the exact same `collectKnownNames` left-margin/letter-run logic as the page-1
  bootstrap, just scoped to one page), re-fetching only `page.getTextContent()` for the handful of
  pages that actually need it — no new pixel rendering. Still correctly does nothing on a page with no
  extractable text at all (a genuinely scanned/image-only part) — that residual gap is a photographed-
  page limitation, not a logic gap, exactly as expected.

**Four more findings closed via a follow-up backlog pass (2026-07-22), covering the same 39-file
real corpus plus four new committed regression tests — verified with real before/after evidence
per finding, not just an aggregate "all fixed":**

- **Finding 1 (biggest, most uncertain going in): system-detection under/over-grouping on real
  scanned single-staff booklets, root-caused rather than threshold-tuned.** Dumped the actual
  `gaps` array feeding `kmeans2()` (see the Applied Mathematician persona) for real affected pages
  before touching any code, per this backlog's explicit instruction. The real data showed the
  under-grouping symptom ("Full band arrangements" folder: 6-7 real solo staves merging into 1-2
  detected systems) was **not** noisy-gap-statistics at all — it was a genuine logic bug in
  `pageSystemsDetailed()`'s consistency check: `modeSize > 1 && best >= grp.length - 1` ("tolerate
  at most one non-conforming group") is **mathematically vacuous whenever there are exactly 2
  groups** — `best` (the larger of two counts) is always `>= 1` out of 2, so the check can never
  reject a 2-way split no matter how mismatched the two group sizes are. A real page from
  `Teutonia.pdf` (an individual-part scanned booklet with **no real bracing anywhere in the
  document**) showed exactly this: gaps of mostly ~90-125 plus one much larger outlier (a
  scan/binding irregularity, not a real system-vs-staff boundary), which `kmeans2` correctly called
  "bimodal," splitting 7 solo staves into 2 groups of sizes 3 and 4 — accepted as "consistent"
  purely because `grp.length - 1 == 1 == best`, wrongly merging unrelated solo staves into 2 fake
  multi-staff systems and directly producing the "1-49 measures" warning range a user would see.
  **Fixed** by special-casing `grp.length === 2` to require `best === 2` (both groups must actually
  match) instead of the vacuous "at most one off" rule, which provides zero discriminating power at
  n=2 — the `>= 3`-group case (already verified safe against the real 13-page braced-quartet file,
  see the "tolerates a staff with only 2 of 5 lines detected" fix above) is completely untouched.
  The mirror symptom described in this backlog ("1 real braced system splitting into ~14" on a
  dense conductor's score) turned out, on inspection of the real `Fantastic Parade.pdf` dump, to be
  a `grp.length >= 5` case, not a `grp.length === 2` one — a page with a real, consistent 3-staff
  bracing pattern occasionally lost a staff entirely on 1-2 systems (0 detected lines, not just a
  thin one), producing local group sizes of 2 instead of 3 on more than one group at once, which
  the existing "tolerate at most one" rule correctly (by its own already-verified design) refuses
  to paper over — this is the same "a dropped staff's damage isn't contained to its own system"
  category already documented above, not evidence of a second bug, and was left as an open staff-
  detection-density gap rather than loosened further (loosening the *grouping* tolerance to paper
  over a *detection* gap risks silently re-accepting genuinely inconsistent pages, which this
  project's conservative-by-design philosophy explicitly rejects — see the existing "falls back to
  per-staff" rationale a few paragraphs above). **Root-caused and fixed (2026-07-22) — see the
  "Fantastic Parade staff-detection density gap" write-up further below**: the actual detection gap
  turned out to be a real, narrowly-scoped `collapseThickness` bug (not a case needing the grouping
  tolerance loosened at all). **Verified with a real git-stash-style before/after
  A/B across 14 real files** (temporarily reverting just this one line, re-running the identical
  Playwright-driven batch, restoring it): the 4 affected "Full band arrangements" files all gained
  real, plausible additional systems (Teutonia 63→80, MonogramMarch 141→158, KingCotton 193→208,
  Fat Burger 231→261 — all previously-merged solo staves correctly split apart), while all 10 other
  real files spanning clean vector scores, a braced clarinet quartet, a dense 20+-instrument
  conductor's score, solo clarinet pieces, and IMSLP trio scores were **byte-for-byte unchanged** —
  a real, clean regression guard, not just "looks plausible." Two new committed unit tests in
  `systemDetection.test.js` encode the real gap shapes from both the buggy-merge case and a
  legitimate-2-system case directly (not just abstract numbers), so this exact bug class can't
  silently regress.

- **Finding 2: the numeric-tempo-mark section-title gate (`findSectionTitle`) over-triggered on
  Score CONTINUATION pages, not just genuine new-part title pages.** Root cause exactly as
  diagnosed in the backlog: `collectKnownNames()` returned one flat list of strings mixing an
  instrument's FULL name (printed once, beside its very first system) with its ABBREVIATED
  recurring form (printed on every system/page after) — with no way for a caller to tell which was
  which. A mid-Score continuation page legitimately shows the abbreviated label at the left margin
  on EVERY page, plus (after the numeric-tempo-gate fix from the prior backlog pass) the Score's
  own restated numeric tempo mark — both real signals, but present on every continuation page, not
  just a genuine new section start. **Fixed** by having `collectKnownNames` return `{ text, isFull
  }` pairs — `isFull` is true only for a label whose row sits within (or up to `pad` above) system
  0's own vertical band (where every instrument's FULL name is printed, stacked at its own staff's
  y but all still inside that one braced system), false for a label below it (beside a LATER
  system, always the abbreviated form). `findSectionTitle` now only accepts an `isFull` match as a
  boundary trigger. **Verified with real before/after evidence on 3 real "Score and Parts"-style
  IMSLP trio files** (temporarily reverting just the `isFull` filter, same A/B methodology as
  Finding 1): all 3 files (`The Spanish Winds Trio`, `The Cuban Dancer Trio`, `My Happy Life`)
  dropped from one spurious extra section to the correct count (5→4, 5→4, 6→5), **and**, as a
  striking bonus that wasn't anticipated going in, the tempo-changes banner went from completely
  EMPTY to showing the piece's real tempo change in all 3 cases — the old spurious split had been
  truncating the first (now-active) section's own system range before it ever reached the system
  where the real printed tempo change occurred, so Finding 2's bug was silently breaking Finding 4's
  feature too on these exact files, discovered only by running the real corpus, not reasoned about
  in advance.

- **Finding 3: `refineMeasureCounts` picked one measure-number source (text-layer vs. OCR) for the
  WHOLE document even when a specific section had a strictly better source available.** Root cause
  matched the backlog's diagnosis exactly: `usedOcrAnywhere` was a single whole-document switch — if
  ANY page needed OCR, the real PDF text-layer entries (`measureNumberEntries`) were discarded
  entirely for the whole final measure-count computation, even for the handful of pages that had
  perfectly good real text. **Fixed**, more surgically than "choose per section": since a given
  system's page takes EITHER the OCR path OR the real-text path in the per-page loop (never both —
  confirmed directly from the code, not assumed), `measureNumberEntries` can be safely merged into
  BOTH OCR candidate arrays (`[...measureNumberEntries, ...ocrEntriesBox]` and
  `[...measureNumberEntries, ...ocrEntriesStrip]`) before the existing per-section refinement runs
  — no new plumbing needed, and no risk of the two sources ever conflicting for the same system.
  **Verified with a real before/after diff on `Teutonia.pdf`** (the one real file in the corpus
  already documented as a mixed text/OCR document): 4 of the active section's 6 systems changed
  from clearly-inflated OCR-only estimates (7, 8, 12, 15) to smaller, far more plausible merged
  values (5, 6, 6, 6) once the real text-layer numbers were allowed to contribute.

- **Finding 4: the tempo-change banner (`autoScrollTempoInfo`) was computed from the
  whole-DOCUMENT `tempoSequence`, not the active section's own.** On a multi-part file where every
  part reprints the same tempo structure, a normal "speeds up once, slows down once" piece looked
  like it oscillated once per part. **Fixed** by extracting a small pure helper,
  `tempoSequence(bpmPerSystem)` (`lib/tempoSchedule.js`), and having `autoScrollUI.js` call it with
  the ACTIVE SECTION's own `bpmPerSystem` slice (already computed and stored per section) instead of
  a whole-document array computed once in `scoreAnalysis.js` — recomputed on every section switch
  (`selectSection`), not just once at Analyze time. Display-layer fix only, exactly as scoped; no
  detection logic changed. Directly confirmed correct via Finding 2's real-corpus verification above
  (each trio file's banner now shows its own section's real, single tempo change instead of nothing
  or a repeated/confusing sequence).

**Phase 1 (foundational) work done alongside the four findings above:**
- **`analyzeScore()`'s ~360-line post-page-loop composition logic extracted into
  `src/lib/scoreAssembly.js`** — `pickPrimaryEntries`, `addMeasureNumberResetBoundaries`,
  `resolveTempoSchedule`, `refineMeasuresPerSection`, `chooseMeasureReadings`, `computeWarnings`, all
  pure and DOM/canvas-free, each with its own dedicated unit tests (17 new tests) — exactly the
  composition layer this project's own history flags as where real bugs slip through (a
  `buildSections()` name-fallback bug, a bootstrap-page self-match bug, both already documented
  above as caught by manual inspection rather than a test). **Verified behavior-preserving, not just
  "looks equivalent"**: ran the full `npm test` suite (272 tests, all passing) plus a real-corpus
  byte-for-byte diff of the same 11-file Playwright batch before and after the extraction — the only
  differences found were from the already-separately-verified Phase 3 UX change (the
  "— auto-detected split" section-name suffix, see the Music Educator persona below), not from the
  refactor itself. The per-page rendering/detection loop (staff-line scanning, barline counting, the
  rotation probe) deliberately stays inline in `scoreAnalysis.js` — see the fixture-testing decision
  immediately below for why.
- **Fixture-testing technical decision (the explicitly-flagged-uncertain part of this backlog):**
  confirmed directly (not assumed) that this project has **no `canvas` npm package and no jsdom**
  installed — plain Node, `document`/`canvas` genuinely undefined — and that Vitest's `environment`
  is unset in `vite.config.js`. Rather than add native `canvas` bindings as a new permanent
  devDependency (real Windows-native-build-friction risk for every future contributor, and this
  project's QA persona already treats Playwright-driven rendering as deliberately **ad hoc,
  session-only verification, never committed test infra** — no `e2e/` directory, no Playwright
  dependency in `package.json`, no CI job), the chosen split is:
  - **Pixel/canvas-rendering-dependent logic** (staff-line/barline detection, the rotation probe's
    per-orientation ink scoring) stays tested exactly where it already was: pure functions
    (`pageSystemsDetailed`, `estimateMeasureCount`, `scoreOrientation`/`chooseRotation`) fed literal
    row/ink-function arrays in their own `*.test.js` files — including the two new Finding-1
    regression tests added directly from real corpus-dumped gap data.
  - **Real-PDF-text-layer-dependent logic** gets a genuinely new capability: `pdf-lib` (pure JS, zero
    native dependencies, added as a devDependency) builds real PDF byte streams **in memory at test
    time** — not committed as static `.pdf` binary files, specifically because this repo's
    `.gitignore` has a deliberate blanket `*.pdf` rule whose entire purpose is making it structurally
    hard to ever accidentally commit the user's real copyrighted sheet-music collection; carving out
    an exception for a fixtures folder would be a real, if narrow, weakening of that safety net for
    no real benefit over generating the bytes at test time. The resulting bytes are fed straight into
    `pdfjs-dist/legacy/build/pdf.js` (already a project dependency) via `getDocument({ data: bytes
    })` — confirmed this runs correctly in plain Node with **zero canvas dependency** for anything
    that doesn't call `page.render()`: `page.rotate`, `page.getViewport()`, and, critically,
    `page.getTextContent()` (the actual call `scoreAnalysis.js` makes) all work against the REAL
    pdfjs parsing pipeline (real xref table, real content streams, real font/glyph decoding) with
    only two harmless console warnings (DOMMatrix/Path2D polyfill, standard-font-data fetch — both
    about rendering/metrics machinery text-position extraction never touches). New committed file
    `src/lib/realPdf.fixtures.test.js` (6 tests) exercises `groupIntoRows` / `collectKnownNames` /
    `findSectionTitle` / `extractMeasureNumbers` / `detectMeasureNumberResets` end-to-end against
    genuinely-parsed real PDFs covering exactly the three structural conditions this backlog named:
    a numeric-tempo-only multi-part title page (plus the real Finding 2 continuation-page rejection,
    both against the SAME fixture), a no-combined-score booklet with a mid-document measure-number
    reset, and a page whose declared `/Rotate` doesn't match a plain assumption about its content.
    Where a test needs to know "which systems are on this page" (real code gets that from the pixel
    pass this file doesn't exercise), it uses an explicit, clearly-commented SYNTHETIC
    `systemsForText`-shaped array positioned to match where the fixture's own text was drawn —
    honest about the one seam this approach doesn't reach, not a silent gap.

**A three-item backlog pass (2026-07-22), closing out the three remaining open questions from the
sections above — all verified against the real corpus with the same Playwright-driven, real-file,
before/after discipline as everything else in this section (Playwright-core installed ad hoc for
this session only, never saved to `package.json`; a small `.scratch/` driver directory used and
fully deleted afterward — no `public/*.pdf` copies, no committed binaries):**

- **Finding: the "Fantastic Parade" staff-detection-density gap was root-caused, not left open.**
  The prior write-up (Finding 1, above) correctly diagnosed the *symptom* (two real staves losing
  most of their detected lines on a dense page) but had stopped short of finding the actual
  mechanism, reasonably worried that a fix might just be re-loosening the grouping tolerance the
  Teutonia fix had just tightened. Dumping the real per-row ink data for the affected page (a
  temporary debug hook added to `pageSystemsDetailed`/`scoreAnalysis.js` for this session, fully
  reverted afterward) and rendering the actual crop at 4x found the true cause: **this file's page
  packs 23 real staves into the shared `ah=1200` analysis canvas, shrinking real line-to-line
  spacing down to ~2-3px — the SAME magnitude as the anti-aliasing-duplicate-row gap
  `collapseThickness()` was written to collapse.** Two real staves (Tenor Saxophone, Baritone
  Saxophone), each rendering every one of its 5 lines as a doubled ink row (a 1-2px internal gap),
  produced a chain of small per-step gaps that individually all cleared the old `maxGap=2` check —
  `collapseThickness`'s greedy single-linkage merge then chained the ENTIRE 5-line staff into one
  point instead of 5, discarding 4 of 5 real lines per staff. **Fixed** by additionally capping the
  group's TOTAL span from its first row at the same `maxGap` threshold (a genuine thickness-
  duplicate group is already documented as spanning only 1-2px total — comfortably inside the cap —
  so the original anti-aliasing fix is completely unaffected; a real next line 2-3px away now
  correctly starts a new group once the running span would exceed that small, physically-plausible
  single-line-thickness bound, instead of chaining indefinitely). **Verified with real before/after
  evidence**: on the affected page, both staves now correctly detect all 5 lines; document-wide, the
  file's real (UI-mutation-corrected — see below) system count went from 417 (corrupted by the
  detection gap fragmenting one real system into up to 6 fake ones) to 480 (its true structure: one
  giant 20+-instrument system per page, laid out as 2 stacked staff panels — winds, then brass —
  plus 3 percussion staves, confirmed by actually rendering and reading the page image, not
  assumed). The residual imperfection — its percussion staves (one is a genuine single-line
  percussion staff, a real, different notation convention this pipeline was never designed to
  detect as a 5-line staff at all) still don't merge into the big system, correctly falling back to
  one-system-per-staff there — is a *different*, deliberately-conservative case, not a bug: forcing
  it to merge would need staff-type-awareness this app doesn't have, and risks exactly the "silently
  accept a genuinely inconsistent page" regression the conservative design exists to prevent.
  **Methodological note that surfaced along the way and is worth generalizing**: the "systemCount"
  a caller reads off `state.autoScroll.systemBands.length` is NOT the true whole-document count once
  a PDF has more than one section — `autoScrollUI.js`'s `renderSummary()` auto-selects section 0
  whenever `sections.length > 1`, which SWAPS `systemBands` down to just that section's own slice
  (see `scoreSections.js`'s doc comment on why sections are reference-swaps, not copies). Any future
  ad hoc verification script (or future debugging session) reading that field directly will silently
  under-count on a multi-section file; the correct whole-document count is the sum across
  `state.autoScroll.sections[i].systemBands.length`, or the `systemCount` `analyzeScore()` itself
  returns before the UI ever touches state.
- **New regression test** in `systemDetection.test.js` encodes the real dumped row shape from this
  exact page (two real 5-line staves, each doubled-row, spaced ~130 apart) and asserts both resolve
  to 5-line staves in 2 separate systems, not 1 collapsed point each merged into one.

- **Finding: the Lazarus-duets over-split was revisited with fresh real data (not re-stated from the
  prior conclusion) and a genuine, additional, safe guard was found.** Re-ran the real file end to
  end: it currently produces 10 sections from 9 detected resets, exactly as previously documented.
  Dumping the real `primaryEntries` feeding `detectMeasureNumberResets` (39 raw OCR strip-scan
  readings, values oscillating 0/3/4/5/6/7/41 with almost no relationship to position) confirmed
  every prior conclusion was correct as far as it went — but computing the actual data's coherence
  (longest strictly-increasing-subsequence length as a fraction of total entries, the exact
  algorithm `filterMeasureNumberOutliers` already uses elsewhere in this file) surfaced a clean,
  well-motivated additional signal that a naive whole-document version of doesn't work: a real
  multi-section document's WHOLE-document LIS fraction is confounded by simply having multiple
  legitimate resets (a real, clean 4-section IMSLP trio file, "The Spanish Winds Trio," scores only
  0.26 whole-document despite being perfectly clean *within* each of its sections) — so the fix
  applies the check PER CANDIDATE SECTION instead: **a section's own printed readings must climb to
  a value at least roughly proportional to how many systems it spans** (a real system, by
  definition, holds at least one real measure, so an entire 40-140-system section whose own readings
  never climb past single digits is implausible on its face) — `max(readings) / span >= 0.5`.
  Verified this ratio cleanly separates the real vs. fake populations on real data: Lazarus's 9
  candidate sections score 0.00-0.29 (data-confirmed noise); a real, already-working SPARSE case
  ("KingCotton.pdf," only 2 and 5 real readings in its two genuine sections) scores 1.66 and 2.84 —
  clearly on the other side of the line despite the small sample size. **The small-sample side is
  the real hazard this guard had to avoid**: a segment with too few readings to compute the ratio
  meaningfully (a real, already-working case, "Fat Burger parts with drums," has only ONE reading in
  its one reset-introduced section) is explicitly left alone rather than second-guessed — the guard
  only ever REJECTS a candidate when there's enough corroborating data to be confident it's
  implausible (`MIN_SAMPLES_FOR_RATIO_CHECK = 3`), never when data is merely sparse. **Fixed** in
  `detectMeasureNumberResets` (`scoreText.js`, threaded through from `addMeasureNumberResetBoundaries`
  in `scoreAssembly.js`), verified end-to-end against the real file: **10 sections → 5** (4 of 9
  candidate resets survive — each introduces a section with fewer than 3 corroborating readings, so
  there isn't enough evidence to judge them either way), while KingCotton/Fat Burger/Teutonia/
  MonogramMarch/Spanish-Winds-Trio/A-Lazy-Summer-Day were all confirmed byte-for-byte unchanged.
  **An unplanned bonus, discovered only by testing, not anticipated going in**: this exact same guard
  also fixes a brand-new spurious section this backlog's OWN Fantastic-Parade fix (above) had
  introduced — fixing the staff-detection gap corrected that file's system indices enough that a
  previously-inert noisy reading now qualified as a "confident" reset at systemIndex 95, splitting a
  file that should have exactly one section into two. That segment's own numbers (n=306, real
  readings, max=87 against a span of 385) score 0.226 — well below the same 0.5 threshold — so one
  general, real-evidence-based fix resolved both problems, rather than needing a second, file-
  specific patch. Two new committed unit tests in `scoreText.test.js` encode the real Lazarus/
  KingCotton/Fat-Burger data shapes directly.
- **General lesson, worth generalizing beyond this one fix**: when a new detection/threshold fix
  changes upstream data (here: system indices), always re-check downstream consumers of that data
  on the SAME real file, not just the file(s) the new fix directly targeted — a fix can be correct
  in isolation and still expose (or even newly trigger) a latent bug one step removed, and the only
  way to catch that is running the real pipeline end-to-end again, not reasoning about each fix in
  isolation.

- **Finding: real instrument names (and other genuinely-printed structural labels) for no-
  bootstrap-page files — implemented as scoped, per boundary-page bootstrapping.** Every detected
  section boundary that still has no name after title-matching (the reset-only case above) now gets
  one more chance: `fillMissingSectionNames()` (`scoreAnalysis.js`) treats THAT boundary's own first
  page as a one-off mini-bootstrap page, reusing `collectKnownNames`'s exact left-margin/letter-run/
  `isFull` logic (no new heuristic), scoped to a single page instead of relying on "a combined score
  lists everyone." Runs as a second, targeted pass after boundaries are finalized (not folded into
  the main per-page loop, since a reset-only boundary's existence isn't known until
  `detectMeasureNumberResets` runs on the FULL document's entries, after the loop) — cheap by
  design: only re-fetches `page.getTextContent()` (no pixel rendering, no canvas) for the handful of
  pages that actually have a nameless boundary landing on them.
  - **A real refinement, found only by testing against the real target file, not assumed in
    advance**: the natural first design used "this page's own topmost system" as the reference band
    for `collectKnownNames`'s `isFull` check (reasoning "a new part starts at the top of its own
    fresh page, so these are the same system anyway"). Wrong on a real file (`Teutonia.pdf`): a
    short part can end and the next part begin PARTWAY DOWN THE SAME PHYSICAL PAGE, so the new
    part's own label sits beside ITS OWN system, not the page's first one — using the page's
    topmost system looked in completely the wrong vertical band and found nothing. **Fixed** by
    using the boundary's own system directly as the reference band instead — simpler than the
    original design AND correct for the (still more common) case where it's also the page's first.
  - **Verified against the real "Full band arrangements" folder** (the folder this feature targets):
    of its 4 files with a real detected part boundary, only `Teutonia.pdf` has an actual PDF text
    layer on the relevant page (`KingCotton`/`Fat Burger` are genuinely scanned images there — this
    correctly does nothing rather than fabricate a name, exactly as designed). On Teutonia, "Section
    2" became **"TRIO"** — confirmed by rendering the real page: not an instrument name after all,
    but a real, legitimately-printed formal-structure marker ("TRIO," at the left margin, right
    before the system where the piece's Trio strain begins and measure numbering restarts) on what
    turned out to be a single-instrument Flute part, not a multi-instrument booklet. This is a
    genuine, verified win using the exact mechanism the backlog asked for — it just revealed that
    "no bootstrap page" files in this real corpus split on more than one kind of real boundary
    (instrument changes AND intra-part structural markers), and the same left-margin/letter-run
    logic correctly picks up either, which is a fair, arguably more useful generalization of the
    original "instrument name" framing.
  - **Verified no regression on already-correctly-named files**: `JugglingClowns`, `The Spanish
    Winds Trio`, and the rest of the already-working IMSLP trio folder were confirmed byte-for-byte
    unchanged (every one of their boundaries already has a name from title-matching, so
    `fillMissingSectionNames` never even reaches them — `if (b.name) continue`).
  - **Fully scanned files (Lazarus, and the other 2 of 4 "Full band arrangements" files with a
    reset boundary) correctly stay generically named** — there is no general-purpose text-reading
    OCR in this pipeline (only the existing, narrowly-scoped NUMBER-reading OCR), so a page with no
    embedded text genuinely has nothing for this feature to read. This is an honest limitation, not
    a bug: building general OCR text-recognition for instrument labels would be materially new,
    much larger scope, not attempted here.

- **General lesson tying all three findings together, worth carrying into future OMR work**: every
  one of these three "revisit an open question" items turned out to have a real, safe, well-
  evidenced fix once actually investigated with real data — none of them were the "no safe fix
  exists" outcome the original brief flagged as an acceptable possibility. The common thread across
  all three (and consistent with every fix earlier in this section) is that the ACTUAL blocking
  detail was one level more specific than the prior write-up's diagnosis (a chain-merge span cap,
  not a grouping-tolerance loosening; a per-segment plausibility ratio, not a whole-document
  coherence score; the boundary's own system, not the page's topmost one) — reinforcing this
  project's standing discipline: dump the real data and look at the real rendered page before
  concluding a problem is unfixable, don't stop at the first plausible-sounding root cause.

**A committed, repeatable accuracy benchmark now exists (2026-07-23) — `scripts/benchmark/`
(`run.mjs`, `backfill.mjs`, `report.mjs`), replacing "re-verify by hand every time" with a trend
you can track across commits.** Built and tested against a small hand-made placeholder plus
whatever real ground-truth files the parallel corpus-labeling effort had already produced at the
time (see QA persona for the full infra write-up) — two real findings worth recording here since
they're about this domain's own data shapes, not just test-runner mechanics:
- **The real ground-truth schema the labeling agents converged on independently** (`sections:
  [{name, startPage, isGeneric}]`, `totalSystems`, `tempoMarks`) **differs from what a
  from-scratch design would guess** (flat `sectionNames`/`systemCount`/`tempoBpms` arrays) — found
  only because two real labeled files already existed in `benchmarks/ground-truth/` by the time
  this was built, and were read before finalizing the loader rather than assumed. General lesson,
  same shape as this project's "read the real getTextContent() output before coding against it"
  precedent: when a schema is being produced by parallel work, inspect real instances of it before
  committing to your own guess, even under time pressure to keep moving.
- **A single-section file's implicit section is always named `"Score"`** — both by
  `buildSections()`'s own fallback (`i === 0 ? 'Score' : ...`) and, independently, by the
  labeling agents' own convention (confirmed on real ground-truth files) — even though the app's
  `#sectionsSelect` dropdown never renders at all for this, by far the most common, case (see this
  section's "Sections are saved snapshots" note above on why the UI stays hidden here). The
  benchmark's DOM-only driver (`scripts/benchmark/lib/appDriver.mjs`) scores this hidden-dropdown
  state as the app having reported `['Score']`, not `[]` — scoring it as `[]` would have wrongly
  zeroed out section-name accuracy on every ordinary correctly-behaving single-part file, the
  overwhelming majority of this app's real target audience (Music Educator persona).

**A dev/benchmark-only "force OCR" validation pass (2026-07-23) — measuring OCR's real measure-
number-reading accuracy against trusted ground truth, not just on scanned files where ground truth
itself is lower-confidence:**
- **Motivation:** `ocrPageNumbers()`'s OCR fallback normally only ever runs on scanned/image-only
  pages, exactly where this project's own ground truth is *also* least confident (scan quality
  makes the "true" measure numbers themselves harder for a human labeler to verify — see the
  Lazarus/KingCotton ground-truth files' own confidence caveats above). Text-layer PDFs give a
  controlled way to measure "how good is OCR alone at reading printed measure numbers," using
  numbers this project is much more confident about, by deliberately forcing every page's
  measure-number reading down the OCR path even though a real text layer exists, then scoring
  against the SAME ground truth the normal (text-layer) pass already gets scored against.
- **Mechanism chosen: a URL query parameter (`?forceOcr=1`), read fresh once per `analyzeScore()`
  call via `location.search`** (`isForceOcrRequested()` in `scoreAnalysis.js`), folded into the
  existing per-page decision as `const usedOcr = (forceOcr || !pageItems.some(...)) &&
  systemsOnThisPage.length > 0`. Chosen over a hidden UI toggle or a build-time flag specifically
  because it's real, working production code (not a test-only stub or monkeypatch) while staying
  genuinely inert for a real user — nothing in the UI reads or sets it, there's no visible
  control, and no ordinary user would ever hand-type `?forceOcr=1` onto the app's URL. The
  benchmark driver (`scripts/benchmark/lib/appDriver.mjs`'s `withForceOcr()`) just navigates to
  that URL before clicking Analyze; `analyzeFile()` itself needed zero changes since navigation was
  already a separate step the caller controlled.
- **Real, surfaced-during-implementation scoping correction to the original plan: forcing OCR
  does NOT cleanly touch "measure numbers only" — it also fully suppresses real tempo-mark
  reading for any page it forces onto the OCR path, for a structural reason, not a new bug.**
  `extractTempoMarks()` (the real numeric `♩=N` reader) lives in the SAME non-OCR `else` branch as
  `extractMeasureNumbers()` in `scoreAnalysis.js`'s per-page loop, not a separate call gated
  independently — so a forced-OCR page loses its tempo marks too, with nothing (there's no
  OCR-based tempo reading) reading them instead. This is completely harmless for a REAL `usedOcr`
  page (image-only, so there was never tempo text there to lose) but becomes real the moment a
  text-layer page is forced onto that path. Section-title matching
  (`findSectionTitle`/`collectKnownNames`) is genuinely unconditional, as originally assumed —
  it reads `pageItems` directly, before the `usedOcr` branch. **Net effect, and why the validation
  script scores only system count + measures-per-system, never section names or BPM:** section
  names are unaffected either way (nothing to demonstrate); BPM isn't merely "not exercised" the
  way the original framing assumed, it's actively zeroed out by this mechanism — scoring it would
  have measured "does forcing OCR delete tempo marks" (trivially yes, every time) rather than
  anything about OCR quality.
- **New script: `scripts/benchmark/run-ocr-validation.mjs`** (own npm script,
  `benchmark:ocr-validation`), reusing `lib/scoring.mjs`, `lib/groundTruth.mjs`, `lib/devServer.mjs`,
  and the existing `lib/appDriver.mjs` (extended with the one-line `withForceOcr()` helper, not
  duplicated). For each ground-truth file: runs a normal baseline pass first to confirm THIS run
  actually has `usedOcr: false` (skips a file that already uses OCR normally — nothing to force
  away from there), then re-analyzes the same file with `?forceOcr=1` and sanity-checks the app's
  own summary text actually flips to "No embedded text..." this time (confirms the mechanism
  genuinely engaged, not just assumed). Writes to `benchmarks/ocr-validation/<date>-<sha>.json` —
  deliberately NOT `benchmarks/snapshots/`, and `report.mjs`'s per-commit trend table intentionally
  never reads this directory, since this is a synthetic "what if" probe, not "how the app behaves
  for real users today."
- **Real numbers from a full 39-file corpus run (2026-07-23, commit `c18988e`):** 32 of 39
  ground-truth files have a real text layer in a normal run (the other 7 — the two scanned "Full
  band arrangements" booklets not yet OCR'd here plus a few others — already use OCR normally and
  were correctly skipped, nothing to force). Across those 32: **system count accuracy was
  identical (81.4%) between the normal and forced-OCR pass on every single file** — confirms
  forcing OCR genuinely doesn't touch system detection at all, exactly as designed (system count
  comes from pixel/staff detection, upstream of and independent from the measure-number-reading
  branch). Of those 32, only **18 had the app's own system count exactly matching ground truth**
  (the other 14 — mostly the IMSLP trio "Score and Parts" files — are a *separate*, pre-existing
  system-over-detection gap this task didn't investigate further, unrelated to OCR forcing one way
  or the other) — measures-per-system accuracy is only meaningful on those 18 (see
  `measuresPerSystemAccuracy`'s own "only comparable when system counts match" design, `scoring.mjs`).
  On those 18: **real text-layer reading averaged 81.3% exact-match accuracy (mean abs error 0.79
  measures/system); the SAME 18 files, forced through OCR instead, averaged 71.0% (mean abs error
  1.22)** — a real, meaningful accuracy gap, but a much smaller one than "OCR barely works at all"
  would have suggested: most individual files lost roughly 10-30 points of exact-match accuracy
  (e.g. 95%→76%, 89%→67%, 83%→42%) rather than collapsing, and a few files (the `randomclarinet`
  folder, `Bouree - Händel`, `A Cruel Angel's Thesis`) scored byte-for-byte IDENTICAL in both passes
  — those happen to be files where barline-count + refinement already carries most of the correct
  answer with little contribution from the printed numbers either way, so OCR misreads had nothing
  to corrupt. One file (`Peace_Sign Clarinet`) actually scored slightly HIGHER under forced OCR
  (87%→93%) — a reminder that "OCR is strictly worse than the real text layer" is a good average
  statement, not a guarantee for every individual file.
- **General lesson for future OMR persona work: a plan's own "which downstream reads get touched"
  assumption is worth re-deriving from the actual branch structure before building the validation
  harness around it, even when the assumption sounds obviously right** — the BPM-suppression side
  effect here wasn't a hidden bug so much as an artifact of `extractTempoMarks()` sharing a branch
  with `extractMeasureNumbers()` for an unrelated reason (both only make sense to read from a real
  text layer), but it meant the *actual reason* to exclude BPM from this validation was different
  (and more interesting) than the reason assumed going in.

**Benchmark suite hardened + a real 6-commit historical trend recorded (2026-07-23).** Two real
bugs found on the first full-corpus run, both fixed:
- `scripts/benchmark/lib/appDriver.mjs`'s two `page.waitForFunction(fn, { timeout })` calls passed
  the options object as the SECOND positional argument -- Playwright treats that as the page
  function's `arg`, not `options`, silently falling back to its own 30s default regardless of the
  configured `loadTimeoutMs`/`analyzeTimeoutMs`. This is the exact same argument-order mistake
  already found and fixed once earlier this project in a hand-written Playwright driver script --
  confirmed here by the fact it broke in exactly the predicted way (timing out the 3 largest/
  slowest OCR-fallback files at 30s instead of their real 600s budget). Fixed by passing `undefined`
  as the third-positional `arg` and moving `{ timeout }` to the real options position.
- `#autoScrollTempoInfo` is deliberately blank for a flat, non-changing tempo (see
  `autoScrollUI.js`'s `refreshTempoInfo()`) -- reading only that banner therefore reported `[]`
  (indistinguishable from "nothing detected") for every single-tempo file in the corpus, even ones
  the app correctly detected and adopted a real printed tempo for. Fixed by also reading `#bpmV`
  (`"<n> bpm"`, reflecting `state.autoScroll.bpm`) as a fallback, compared against a baseline
  captured from a fresh page BEFORE any file was loaded (not an assumed hardcoded default) --
  BPM sequence accuracy went from 68.6% to 96.8% on the very same data purely from this tooling fix,
  confirming it was a benchmark blind spot, not a real app deficiency.

**Metrics now segmented by text-layer vs. scanned/OCR PDFs, not just one blended "overall" number**
(`run.mjs`'s `summarizeGroup()`, `report.mjs`'s per-group tables) -- this was necessary, not
cosmetic: blending the two regimes was hiding that section-name accuracy on scanned/OCR files
(28.6%-33.3% across every commit checked) is barely a third of text-layer files' (63.8%-81.7%,
improving over time) -- see the trend table below.

**`appDriver.mjs` made tolerant of DOM elements that don't exist yet on an old historical commit**
(`safeEval()`, defaulting to a safe fallback instead of throwing) -- found necessary backfilling
this project's own two oldest candidate commits: `#autoScrollTempoInfo` didn't exist until a later
commit (`294d43a`), and `49c66a4`'s Sections picker was still per-row text inputs, not yet the
`#sectionsSelect` dropdown this driver reads. Without this, both commits failed EVERY one of 39
files outright, discarding even the system-count data that genuinely did exist and is comparable
that far back -- full backward compatibility with every historical UI shape (e.g. reading the old
per-row inputs) was NOT attempted (real, accepted scope limit -- those two commits' `sections`/
`measures`/`tempo` data stays unrecoverable, but their system-count data isn't wasted anymore).

**Real 6-commit trend, current corpus/scoring logic applied retroactively via `git worktree`**
(`benchmark:backfill`, then `benchmark:report`) -- picked to span the feature's real evolution:

```
Date        Commit   Overall: SysCount SecName Measures BPM   | Text-layer SecName/Measures | OCR SecName/Measures
2026-07-20  49c66a4  80.6%    63.8%    3.1%    43.6%          | 63.8% / 3.1%   (no OCR yet)  | n/a
2026-07-20  89bab60  81.9%    65.9%    66.0%   43.6%          | 65.9% / 66.0%  (no OCR yet)  | n/a
2026-07-21  b58b58d  80.3%    65.9%    79.2%   96.8%          | 74.0% / 80.9%                | 28.6% / 63.9%
2026-07-21  41fa477  80.3%    65.9%    81.4%   96.8%          | 74.0% / 80.9%                | 28.6% / 86.1%
2026-07-22  1e742bd  81.1%    72.2%    81.7%   96.8%          | 81.7% / 81.3%                | 28.6% / 86.1%
2026-07-23  c18988e  80.6%    72.2%    81.7%   96.8%          | 81.7% / 81.3%                | 28.6% / 86.1%
```

Two real, opposite-valence findings this makes concrete rather than anecdotal:
- **`89bab60`'s own commit message ("fix multi-staff system grouping") is dramatically confirmed**:
  measures-per-system accuracy jumps from a barely-functional 3.1% to 66.0% in exactly that one
  commit -- the single largest jump in the whole trend, and it's the correct commit for it.
  `1e742bd`'s section-name jump (65.9%→72.2% overall, 74.0%→81.7% on text-layer files specifically)
  likewise lands exactly on the commit that introduced numeric-tempo-mark section detection +
  measure-number-reset boundaries, as expected.
- **The scanned/OCR segment's section-name accuracy has not moved AT ALL across every commit that
  has OCR fallback at all (28.6% flat, `b58b58d` through current `c18988e`)** -- despite real,
  substantial engineering effort across this exact span specifically targeting this case
  (measure-number-reset section boundaries, `fillMissingSectionNames`'s real-name-filling, the
  Item-2/plausible-section-span over-split guard). Consistent with, and now quantifying, this same
  section's own per-file finding that these fixes added MORE sections to scanned booklets
  (Teutonia 1→2, etc.) without making them reliably NAMED CORRECTLY (generic labels, or occasionally
  a wrong boundary like Teutonia's "TRIO") -- this is the one metric in the whole trend that reads
  as a real, unresolved gap rather than steady progress, and is the most promising place to look
  next if section-name accuracy on scanned booklets specifically is a priority.

**Investigated (2026-07-23, follow-up session) -- root-caused with real evidence, but NOT fixed
this round (a diagnosis + proposed direction, per this session's own explicit "don't rush a fix"
instruction): why `detectMeasureNumberResets()` barely fires on Teutonia/MonogramMarch/KingCotton/
Fat Burger despite being purpose-built for exactly this case.**
- **It's not a `detectMeasureNumberResets` logic problem at all -- it's that the OCR pipeline feeding
  it is producing almost no usable data for the vast majority of these documents.** Dumped the real
  entries feeding it on Teutonia (a temporary debug hook, reverted): only the first 12 of 79 systems
  (the systems with a genuine PDF text layer -- this file is a real MIXED document, as already
  documented) have any real measure-number entry at all; of the remaining 67 systems (85% of the
  document), OCR produced **zero** usable BOX entries and only **2** usable STRIP entries, total,
  across all 18 OCR-fallback pages on this file. `detectMeasureNumberResets` has nothing to detect a
  reset FROM for 85% of the document -- not a threshold or algorithm gap.
- **Root cause of the OCR starvation, confirmed by saving and visually inspecting the actual box
  crops sent to Tesseract (not assumed from confidence numbers alone): `locateMeasureNumber()`'s
  "topmost ink blob in the left margin above the staff" heuristic is confidently finding a box on
  nearly every system (`nBoxesLocated` ≈ `nSystems` on every page checked) -- but the crops
  themselves are consistently NOT measure numbers.** Real saved crops showed, variously: actual
  music notation (noteheads/stems), a clef/key-signature cluster, a rehearsal-mark/repeat bracket,
  and (on one page) the instrument's own printed name label ("Eb CLAR..."). Tesseract's confidence
  on these genuinely-non-number crops is correctly near-zero (observed 0-1 against a `minConfidence
  = 55` gate) -- the confidence gate is working exactly as designed, rejecting garbage rather than
  fabricating a number; the real gap is one step upstream, in what gets handed to it.
- **Working theory, not yet verified against the source engraving directly: this scanned corpus's
  actual print convention may not put a measure number above every system at all** (older
  public-domain band-part booklets often number only every 5-10 measures, or only at a line/page
  break) -- unlike the modern notation-software exports `locateMeasureNumber` was built and
  validated against, where a number is printed every system. If true, the "topmost ink above the
  staff" heuristic has nothing real to find on most systems and will always grab the nearest
  unrelated ink instead; no confidence threshold or reset-detection tweak downstream can fix an
  upstream location failure like this.
- **Proposed next step, not attempted here**: before touching `locateMeasureNumber` or
  `detectMeasureNumberResets` again, render and visually inspect a handful of real full pages from
  this specific corpus (not just the cropped boxes) to confirm/deny the working theory above -- if
  numbers really are sparse in the source engraving, the realistic fix is accepting that most
  systems on this class of scanned booklet will never have a real printed-number reading (the
  barline-count fallback already handles this gracefully) rather than chasing a location heuristic
  that has nothing reliable to locate; if numbers ARE present every system but positioned/sized
  differently than this heuristic assumes, the fix is a geometry adjustment to `locateMeasureNumber`
  specifically calibrated against THIS corpus's real crops, the same way `pad=20`/`minFrac=0.95`
  were calibrated against their own real target files.
- **Teutonia's "TRIO" false positive (also asked about in this same investigation) is explained by
  the data that DOES exist, not a new bug**: the 12 real text-layer entries show a genuine, cleanly-
  read drop (measure 31 -> 3) right where the piece's Trio strain begins -- `detectMeasureNumberResets`
  and `plausibleSectionSpan` both behave exactly as designed on this real data (ratio 76/73 = 1.04,
  comfortably above the 0.5 threshold); the boundary is real and correctly detected, it's just a
  formal-structure marker rather than an instrument change, exactly as already documented above. Nothing
  to fix here specifically -- it's a correct detection of a real, if differently-typed, boundary.

**Follow-up (2026-07-23, later same day): the "geometry adjustment" branch of the proposed next
step above, confirmed for one file — Fat Burger prints its measure numbers BELOW the staff, not
above.** Rendered and visually inspected real full pages from Fat Burger (the corpus's own
regression-guard file for this investigation) to check the two branches the prior write-up left
open — sparse source printing vs. a geometry mismatch. For Fat Burger specifically, it's geometry:
the engraving prints a number under literally every measure, with rehearsal letters in boxes above
the staff instead (`locateMeasureNumber()`'s "look above the staff" assumption was pointed at the
wrong region for this file's own convention, not looking for something that wasn't there). **Fix
built:** `lib/measureNumberLocate.js` gained `locateMeasureNumberBelow()` (mirrors the existing
above-staff locator, scanning `systemBottom + 0.08..1.0` staff-heights, calibrated against this
file's own real rendered pixels — a ~2-9pt gap before the number, a ~50pt+ clear gap before the
next system's own content begins); `ocr.js`'s `ocrNumbersByBox()` tries the above-staff box first
and only falls through to the below-staff box if that one fails the confidence gate, so files where
the above-staff read already works are completely unaffected; `scoreText.js`'s
`extractMeasureNumbers()` got the equivalent `padBelow` extension for the text-layer path. 4 new
unit tests, full suite green (307 passing), lint clean, no regressions on any of the other 3
regression-guard files.
- **Real, honest limit of this fix, confirmed by re-running the benchmark before and after: zero
  movement in any of the scanned/OCR group's aggregate numbers** (77.6%/28.6%/86.1%/85.7% —
  identical). Fat Burger's own raw `measuresPerSystem` data did change in several places (finer,
  more accurate per-system counts where a below-staff number is now actually read instead of
  missed) — a real, verified improvement to reading quality — but it doesn't move any *scored*
  metric for this file: `systemCountAccuracy` is unaffected (261 detected vs. 391 true systems —
  this fix reads numbers for systems already found, it doesn't find more systems), and
  `sectionNameAccuracy` stays 0 (still "Score"/"Section 2" vs. 19 real instrument names — section
  *naming* depends on the text-layer name-detection path, which this fix doesn't touch). **This is
  a genuine, narrow improvement worth keeping, not a fix for "why section-splitting barely works
  on scanned files" — that broader question is still open.**
- **What this investigation did NOT resolve, and shouldn't be assumed resolved: whether Teutonia/
  MonogramMarch/KingCotton's own sparse-OCR-data problem (documented above — 85% of Teutonia's
  systems have zero usable measure-number reading at all) is the same below-staff-geometry issue
  or the original "numbers genuinely printed sparsely in the source" theory.** The session that ran
  this specific check ended before reaching a documented conclusion on those 3 files — this
  write-up covers only what was independently confirmed afterward from the surviving code, its
  tests, and a fresh benchmark run, not a claim about what that session concluded for the other
  files. Follow-up investigation into those 3 specifically is the natural next step.

**Follow-up (2026-07-23, later still): resolved for all 3 remaining files — Teutonia,
MonogramMarch, and KingCotton all confirm the OTHER branch of the open question, the opposite of
Fat Burger's.** Rendered real full pages of all three at scale 2.0-2.5 via a headless Chromium page
driving pdfjs-dist directly (`getDocument`/`page.render` to a canvas, screenshotted — the same
technique class as the Fat Burger session, no app/dev-server needed since this only needed pixels +
`getTextContent()`, not the app's own detection code), and visually inspected a spread of
instruments/pages per file (Teutonia: Piccolo, Oboe, Eb Clarinet, Tenors, Flute — pages 2,3,4,6,15;
MonogramMarch: Flute, Oboe — pages 2,4,5,6; KingCotton: Piccolo, Solo Cornet, Baritone Sax — pages
1,3,12,20). **Verdict: sparse/absent-printing confirmed (theory a) for all three — none of them
prints a per-system measure number anywhere in their scanned parts, above the staff, below the
staff, or anywhere else.** This is not the same finding as "OCR can't read it" — the numerals
simply aren't there to read.
- **What IS actually printed in the exact region `locateMeasureNumber()` scans, identified
  precisely this time (a real upgrade on the prior session's looser "notation/clef clusters,
  rehearsal marks" description) — three distinct real numeral types that are legitimate printed
  digits, just never a measure number:**
  1. **Multi-measure-rest counts.** A horizontal thick bar (the standard multi-bar-rest glyph) with
     a small number directly above it stating how many measures it spans — confirmed on Teutonia
     p2 ("2" over 2 rest-measures, later "3" and "8" over longer rests) and KingCotton p20 (boxed
     "3" appearing twice over separate multi-bar rests). This is the single most dangerous
     false-friend for this heuristic: it's a real number, in the right general position (above the
     staff, left-ish), that looks exactly as plausible as a genuine measure number until you check
     what it's actually counting.
  2. **Plate/catalog numbers.** KingCotton prints "173" at the very top-left of the FIRST system on
     the Solo Cornet and Baritone Sax parts specifically (same position `locateMeasureNumber` grabs
     for a real system-opening measure number) — identical across those parts (a document-level
     plate number, not anything per-system or per-part), and reads as a perfectly legible number to
     an OCR pass with no reason to distrust it structurally. Other parts of the same file (Piccolo)
     instead print a different catalog code ("34007-11") at the page BOTTOM, outside either scan
     region — confirming this varies by original print-run convention within a single file, not a
     fixable single offset.
  3. **Repeat-ending brackets ("1"/"2") and "Trio" labels.** Present on every file, every instrument
     — a real printed "1" or "2" bracketed at a repeat, or the word "Trio" marking the second-strain
     entry point. Neither denotes measure count.
- **The one real per-system, per-measure numbering convention found in this whole exercise is the
  same shape as the "genuine text-layer" pages already known about, not a new one**: both Teutonia
  (page 3, "FLUTE" part) and MonogramMarch (pages 4-5, "MONOGRAM MARCH-FLUTE") contain a single
  MODERN re-typeset part mixed into an otherwise all-scanned, decades-old engraving — confirmed via
  `getTextContent()` returning hundreds of real text items on exactly those pages (`"1"`, `"2"`,
  `"49"`, `"50"` etc. as literal, isolated text runs) vs. zero items on every scanned page. That
  modern part numbers literally every measure with a small italic number above the barline — this
  is where the previously-documented "first 12 of Teutonia's 79 systems have a genuine reading"
  comes from: not 12 systems spread across the document, but ALL 12 systems of that one Flute page
  (its whole part fits on one rotated page). KingCotton has no such page at all — `getTextContent()`
  returned zero items on literally all 40 pages, confirming it's a pure scan cover-to-cover with no
  modern-engraving exception anywhere.
- **No fix attempted, per this task's own explicit instruction not to force one under theory
  (a).** There is no real per-system measure number in these files' scanned parts for
  `locateMeasureNumber()`/`locateMeasureNumberBelow()` to find under any geometry adjustment — the
  gap is the source content, not the scan region. Inventing a detector that manufactures a "measure
  number" out of a rest-count or a plate number would be strictly worse than the current behavior
  (Tesseract's confidence gate silently rejecting these, or `locateInBand` finding nothing to
  locate at all): the barline-count fallback already handles "no reliable number reading" correctly
  and gracefully for exactly this case. Confirmed the already-shipped `locateMeasureNumberBelow()`
  (Fat Burger's fix) doesn't regress anything here either — the below-staff margin is genuinely
  blank ink on every sampled system across all three files, so it correctly returns `null` (no ink
  blob to find) rather than grabbing something spurious.
- **No code was touched this session** (`measureNumberLocate.js`, `scoreText.js`, `ocr.js`,
  `scoreAnalysis.js` are all unchanged from the Fat Burger session's own commit), so no test run or
  benchmark re-run was needed or performed — the existing benchmark numbers for the scanned/OCR
  group already reflect the correct, unchanged behavior for these 3 files.
- **This closes out the open question left by both prior write-ups**: of the 4 files investigated
  across this whole thread, exactly 1 (Fat Burger) was a genuine geometry mismatch (numbers below
  the staff, now fixed), and 3 (Teutonia, MonogramMarch, KingCotton) are genuine sparse/absent
  source printing where the honest, safest thing this pipeline can do is exactly what it already
  does — fail to find a number and let the barline-count fallback carry the file. Any future push
  on this specific class of scanned/OCR file's accuracy should look elsewhere (e.g. the
  already-flagged flat 28.6% section-name accuracy across every OCR-fallback commit), not at
  `locateMeasureNumber`'s own geometry again — this corpus has now been checked from both branches
  and both are exhausted for these 4 files specifically.

**Every mean in the benchmark's output now ships with its own population stddev** (`scoring.mjs`'s
`stddev()`, `run.mjs`'s `summarizeGroup()`, `report.mjs`'s trend table) -- found necessary
because the flat-looking ~80% system-count mean above was hiding real movement in BOTH directions
underneath it: per-file trend data (not shown in the table above, but pulled directly from the
snapshots) shows System count stddev sits at a consistent ~26-27 points on that 80% mean across
every commit, and section-name stddev is wider still (37-45 points) -- confirming this corpus is
genuinely bimodal (~20 simple single-page files scoring 99-100% since the very first commit
measured, unchanged; ~19 hard files with real, spread-out, independently-moving accuracy). Two
concrete findings this same per-file digging surfaced, from data the aggregate alone would never
have revealed:
- **A real regression, not just a gap: Fantastic Parade's own system-count accuracy has gotten
  WORSE across this history (93%→93%→68%→68%→68%→48%)**, with the second, sharpest drop landing
  exactly on last session's own staff-density fix (`c18988e`) -- that fix was correctly verified
  against its 4 target files (Teutonia/MonogramMarch/Fat Burger/KingCotton all improved and were
  confirmed unchanged elsewhere), but no independent ground truth existed for Fantastic Parade at
  the time, so its rising raw count (417→480) read as progress against its OWN prior count when it
  was actually overshooting relative to the true 315 -- exactly the kind of miss real ground truth
  (not just "did the count go up") is for. Not yet investigated further or fixed.
- **A completely untouched, wide-spread bug**: a cluster of IMSLP trio "Score and Parts" files
  (Cuban Dancer 44%, Mystery Man 41%, Waltz Trio 51%, Running Scared 59%, My Happy Life 62%,
  Melancholic 57%, Arno Andiam 14%, and East Meets West at **0%** -- the single worst file in the
  entire corpus) have shown byte-identical system-count accuracy across all 6 commits measured,
  meaning none of the rotation/section/staff-density work done across this whole span ever touched
  whatever is over-counting systems on these specific, otherwise-clean vector files. Given how many
  files this affects and that it's never been looked at, this is likely the single highest-leverage
  unexplored investigation in the current backlog. Not yet investigated.

**Both regressions above were root-caused and fixed in the same follow-up session (2026-07-23),
via the same "dump real gap data before touching thresholds" discipline as every prior fix in this
section, plus two smaller findings (section-splitting on Fantastic Parade, and a Clarinet-1/2
naming bug) that fell out of the same investigation:**

- **Fantastic Parade fix: the n=2 grouping-consistency exact-match rule (the Teutonia fix, above)
  had a second real shape it didn't cover.** Dumping the real, complete per-page ink rows for
  Fantastic Parade's 9 combined-score pages (all 9 are byte-identical in raw layout -- a repeating
  template) showed each page's real 20-staff brace (winds panel, then brass panel) plus ONE
  separately-notated percussion staff produces exactly 2 kmeans2 groups of sizes `[20, 1]` --
  rejected by the exact-match rule (`20 !== 1`), falling the WHOLE page back to 21 one-staff
  systems and destroying the correctly-detected 20-staff brace along with it. A naive first fix
  ("a size-1 group can never itself be inconsistent, so accept pairing it with anything") was tried
  and found genuinely UNSAFE by git-stash A/B against the 4 regression-guard files: real scanned
  single-staff booklets (no bracing anywhere) can ALSO produce a `[N, 1]` split from ordinary scan/
  binding noise isolating an edge staff (e.g. Teutonia p.9's real gaps `[212.3, 118.3, 112, 120.4,
  106.3]` -> sizes `[1, 5]`), and the naive rule wrongly merged those real, separate solo staves
  into one fake system (confirmed: 5 real systems collapsed into a 474-row blob). **Fixed** by
  gating the singleton exception on the non-singleton side being LARGE (`MIN_BRACE_SIZE_FOR_
  SINGLETON_EXCEPTION = 15`) -- calibrated against real data, not guessed: across all 4 regression-
  guard files' real pages, the worst false-positive "big" side topped out at size 9 (Fat Burger
  p.31); Fantastic Parade's real case is 20. 15 sits with real margin on both sides. **Verified**:
  all 4 regression-guard files byte-for-byte unchanged (79/157/209/265 systems); Fantastic Parade's
  real (ground-truth-confirmed) system count went from 480 down to **309** against a true 315 --
  system-count accuracy 47.6%→**98.1%** via the committed benchmark tool itself (single-file run,
  before/after).
- **Fantastic Parade's zero section splits, investigated in the same pass, turned out to be a
  SEPARATE bug (not fixed by the system-count fix) with the same root shape already documented
  above for `collectKnownNames`'s "Oboes 8 J" compromise.** On this real file, its compact
  left-margin layout puts literally EVERY instrument's own time-signature glyph noise onto the same
  row as that instrument's name (not just Oboes) -- so `collectKnownNames` collected almost nothing
  usable ("Oboes 8 J", "Clarinet 1 in B b 8 J", etc.), and since `findSectionTitle`'s match test
  only ever checks whether a LATER page's row STARTS WITH the stored name, a trailing-contaminated
  name can never re-match a later page's own clean text at all -- this is exactly the "lesser-harm
  tradeoff" the original fix accepted, just never revisited to see how often it actually bites.
  **Fixed** by recognizing a structural fact confirmed on this real file: real notation software
  draws a complete instrument name as ONE pdfjs text item (`"Alto Saxophone 1"`, `"Clarinet 2 in
  B"`, etc. are each already a single item, never built word-by-word) -- so `groupIntoRows` now
  also exposes each row's own leftmost item's text (`firstItemText`) alongside the existing full
  joined `text`, and `collectKnownNames` adds it as a SECOND candidate name whenever it differs.
  Harmless when a row is already clean (the two are identical, deduped by the existing `seen` set)
  and harmless for a genuinely separate multi-line label (each of its own rows' first item is
  already that whole row). **Verified**: section-name accuracy on this one file went from
  4.2%→**58.3%** (Score + 20 of 23 real named instrument parts, up from Score alone) -- the 3
  missing are percussion staves, a real, different, already-documented notation convention (they
  sit below system 0's own band so never qualify as `isFull`, not a regression from this fix).
- **IMSLP trio over-counting fix: the `kmeans2` bimodality PRE-FILTER (`>= 0.3`), not the grouping-
  consistency check itself, was the actual blocker -- and it was never validated against a real
  multi-page combined score, only guessed.** Dumping real gap data for the worst files (East Meets
  West, Cuban Dancer Trio, Spanish Winds Trio, and 5 more) showed an extremely consistent real
  shape: a combined score's own title page (generous spacing, 1 system per page) groups fine (ratio
  0.7-0.8), but its CONTINUATION pages (4 systems/page, less breathing room) measure a real
  within-brace-vs-between-system gap ratio of only **0.20-0.26** -- comfortably bimodal to a human
  looking at the page (4 clean groups of exactly 3 staves, every time), but below the 0.3 gate, so
  these pages never even attempted grouping and fell back to one system per staff (12 "systems"
  instead of the real 4). **A flat lowering of the gate was tried first and found UNSAFE** by the
  same git-stash A/B discipline: on the real scanned single-staff regression-guard files, ordinary
  scan noise can ALSO clear a lowered gate (Teutonia p.16 measures 0.189; MonogramMarch p.7 measures
  0.251) and then get accepted by the EXISTING `>=3`-group "tolerate one non-conforming group" rule,
  which a near-uniform noise pattern can satisfy by coincidence (both pages happened to split into
  sizes `[1, 2, 2]` -- two accidental "pairs"). That tolerance is legitimate and already verified
  safe at the ORIGINAL 0.3 gate (a real 13-page braced quartet file), so removing it wasn't an
  option. **Fixed** with a two-tier gate instead: a weak signal (0.15-0.3) is only trusted when the
  resulting grouping is PERFECT (every group exactly the same size, no tolerance, no singleton
  exception either) -- a real combined score's repeated bracing clears this easily (4 groups of
  exactly 3), while noise-driven near-uniform splits on a real single-staff booklet don't. A strong
  signal (>= 0.3) keeps its existing tolerance untouched. **Verified with real before/after
  evidence**: East Meets West 27→**11** (exact match to ground truth's 11, 0%→100%), Cuban Dancer
  Trio 67→**43** (exact match to 43), Mystery Man 65→**41** (exact match), Waltz Trio 122→**82**
  (exact match), Running Scared 111→**79** (exact match), Melancholic Trio 107→**75** (exact
  match) -- 6 of 8 previously-broken files now land EXACTLY on ground truth. My Happy Life improved
  (58→50 against a true 42) but not exactly, and Arno Andiam Romanza (13, true 7) was unaffected --
  both have a genuinely irregular per-system staff count in the real engraving (confirmed via their
  own gap data: not every system on the page has the same instrumentation, e.g. a piano-only
  passage mixed with piano+clarinet systems), which this fix's deliberately-strict "must be
  perfectly uniform" requirement correctly declines to force a match for rather than risk a false
  positive -- a genuine, accepted residual, not a new bug. All 4 regression-guard files (Teutonia/
  MonogramMarch/KingCotton/Fat Burger) confirmed byte-for-byte unchanged throughout both fixes.
- **A third, smaller, independently-discovered bug fixed in the same pass: `findSectionTitle`
  returned the matched KNOWN NAME's text, not the matched ROW's own (more specific) text --
  confirmed causing "B♭ Clarinet 1" and "B♭ Clarinet 2" to both get named plain "B♭ Clarinet"** on
  several real IMSLP trio files (the exact bug the OMR persona's own backlog flagged as suspected
  but unconfirmed). Root cause: a combined score's braced Clarinet-1/Clarinet-2 staves print the
  SAME unnumbered label beside each ("B♭ Clarinet" -- the reader tells them apart by position, not
  a printed numeral), so `collectKnownNames`' dedup only ever keeps ONE generic entry; each part's
  own opening page DOES print its real numbered name ("B♭ Clarinet 1"/"2"), and both correctly
  match the generic entry via `startsWith` -- but the function then returned the STORED (generic)
  name for both, discarding the numeral. Since a match is only ever accepted when the row's text
  equals or extends the known name (never the reverse), the row's own text is always at least as
  specific -- returning it instead is strictly safe. **Fixed** (`findSectionTitle` now returns
  `row.text`) and verified via 6 new/existing unit tests (no existing test relied on the old
  `match.text` return distinguishing from `row.text`, confirming this was a real, previously
  untested gap rather than a deliberate design choice).
- **Regression coverage**: 4 new real-corpus-derived tests in `systemDetection.test.js` (the
  Fantastic Parade merge, the Teutonia false-positive guard, the East Meets West weak-gate merge,
  and the MonogramMarch weak-gate false-positive guard, all using literal real dumped row data) and
  4 new tests in `scoreText.test.js`/`scoreText.js` (firstItemText candidate collection, and the
  row-text-not-match-text return) -- 285 tests total (up from 277), all passing.
- **Verified against the FULL 39-file real corpus via the committed benchmark tool itself** (not
  just the targeted files above), run.mjs's own summary, before (committed `c18988e`) vs. after
  (this session's fixes, uncommitted):
  ```
                              Overall              | Text-layer          | Scanned/OCR
              SysCount SecName Measures BPM        | SysCount SecName    | SysCount SecName
  Before      80.6%    72.2%   81.7%    96.8%      | 81.4%    81.7%      | 76.7%    28.6%
  After       92.9%    72.5%   83.8%    96.8%      | 96.3%    82.1%      | 77.6%    28.6%
  ```
  System-count accuracy is the standout, real, corpus-wide jump (+12.3pp overall, +14.9pp on
  text-layer files specifically) -- exactly the two fixes above's real, intended effect, not
  overfitting to the handful of files directly targeted. A second, unplanned but very real
  knock-on benefit: measures-per-system is only ever comparable when system count matches ground
  truth EXACTLY (see this benchmark's own scoring design), so fixing system count on ~8 more files
  raised the comparable-file count from 20/39 to 28/39, which is most of why measures-per-system
  accuracy also rose (81.7%→83.8%) despite no measure-counting logic being touched this session.
  Section-name accuracy barely moved in the AGGREGATE (72.2%→72.5%) despite two real per-file wins
  (Fantastic Parade 4.2%→58.3%; several IMSLP trio files gaining their correct Clarinet-1/2 split) --
  expected, since both are large, real improvements diluted across a 39-file mean, not evidence the
  fixes are small. OCR section-name accuracy is confirmed unchanged (28.6%→28.6%), exactly as
  expected: item 3 above was investigated and root-caused but deliberately NOT fixed this round (a
  diagnosis + proposed direction, not a rushed fix, per this session's own instruction) -- OCR
  system-count nudged up slightly (76.7%→77.6%, within its own stddev) from unrelated small
  variation on one of the 3 non-"Full band arrangements" OCR files, not from anything touched this
  session (the 4 Full-band-arrangements regression-guard files were independently confirmed
  byte-for-byte unchanged throughout, per the git-stash A/B evidence above). All 39 files scored
  with 0 errors both before and after.

**Literature/prior-art research pass (2026-07-23, Feature Strategy-directed), checking five of this
persona's own detection techniques against academic OMR literature and real open-source OMR
projects (Audiveris, oemer, homr) for alternatives, improvements, or adjacent ideas — not a
re-spike of anything already answered above. Verdicts below, organized by file/technique:**

- **Page-rotation auto-correction (`lib/pageRotation.js`) — the academic "deskew" literature
  mostly doesn't apply here, because it's solving a different problem than this code has.** The
  large body of document-skew-detection work (Hough transform, Radon transform, projection-profile
  variance maximization) targets *continuous-angle* skew — a scanned page sitting a few degrees
  crooked on the platen — and is normally paired with a sub-pixel rotate-and-resample step. This
  code's actual bug (confirmed on real files, see the wrong-`/Rotate`-flag write-up above) is a
  *discrete*, already-known-to-be-one-of-4 problem: a PDF page's declared `/Rotate` flag is
  sometimes flatly wrong (0 vs. 90 vs. 180 vs. 270), not that the page content itself is drawn at a
  slight angle. Applying full Hough/Radon machinery to pick among 4 fixed candidates would be
  solving a harder, more general problem than the one that actually exists in this corpus — **not
  worth prototyping**, the existing `scoreOrientation`/`chooseRotation` ink-run-count approach is
  already the right-sized tool and is calibrated against real files.
  - **A real, different, and so-far-untested question this surfaces rather than answers: does any
    file in the real corpus have *continuous* few-degree skew** (e.g. a phone-photographed page,
    as opposed to a flatbed-scanned or notation-software-exported one)? None of the confirmed real
    bugs to date involve this — every one is a 90°-multiple `/Rotate` flag error — but the target
    audience's "minority scanned/photographed" case (persona 6) could plausibly include one someday.
    If it ever does, a lightweight *variance-of-row-ink-count-vs-rotation-angle* sweep (the same
    `scoreOrientation` signal, just swept over a fine angle range near 0/90/180/270 instead of only
    those 4 exact values) would be the natural, cheap extension — genuinely worth prototyping *if
    and when* a real skewed file actually surfaces, but not speculatively now; no evidence yet that
    it's needed.
  - **Tesseract's OSD (orientation & script detection) mode was checked as a possible "already-
    solved, reuse it" shortcut, since `tesseract.js` is already a lazy-loaded dependency for OCR
    fallback** — it works by classifying connected-component shapes against synthetically-rendered
    text at each of the 4 candidate rotations, i.e. the exact same "which rotation makes shapes
    correctly readable" idea, just for prose text instead of staff lines. **Not adopted**: it's
    fundamentally a *text* orientation detector, and its confidence signal comes from letterform
    recognition — for a music page (mostly staff lines, noteheads, and often little or no running
    text on an interior page) it would have far less to work with than this app's own staff-line
    ink-run signal, which is the actually-reliable structural feature on a page like this. Would
    also force loading the OCR worker on every page just to probe rotation, undermining the "OCR is
    lazy, only for genuinely image-only pages" design this codebase already deliberately keeps.
  - **A MediaPipe "document scanner" angle (raised as a possible thread, per this app's existing
    MediaPipe dependency) doesn't exist** — Google's on-device document-scanning/deskew capability
    is an Android ML Kit feature, not a MediaPipe Tasks (web) solution; nothing to adopt here, dead
    end confirmed rather than left open.

- **Staff/system detection (`lib/systemDetection.js`) — the one genuinely adoptable idea found: both
  Audiveris and oemer group staves into systems primarily via *barline continuity/alignment*, not
  (only) gap statistics.** Audiveris's GRID step gathers staves into systems "based on barlines found
  on the left side of the staves" plus detected brace/bracket connector glyphs; oemer (a from-scratch
  deep-learning OMR system, not Audiveris's classical pipeline) reports the same underlying idea in a
  different form — it "parses the barline information to infer possible grouping of tracks," i.e. a
  barline stroke that visibly continues unbroken from one staff's band down through the gap into the
  next staff's band is itself strong, direct, geometric evidence those two staves belong to the same
  system — a fundamentally different and more *direct* signal than this codebase's current approach
  (`kmeans2` bimodal clustering purely on staff-center *gap sizes*, with no reference to what's
  actually drawn in that gap). **Worth prototyping, not adopted yet:** this app already has the exact
  building block needed — `barlineDetection.js`'s column run-length ink scan already finds
  full-height vertical strokes within one system's own band; extending that same scan to check
  whether a candidate barline column's ink run *also* continues across the inter-staff gap between
  two adjacent detected staves would be a cheap, no-new-dependency, purely-geometric second signal to
  corroborate (or override) the current gap-based grouping decision — plausibly a more direct fix for
  some of the still-open residual cases this persona's own write-up already flags as irregular
  per-system staff counts (e.g. "My Happy Life," "Arno Andiam Romanza," where the current
  perfectly-uniform-groups requirement declines to merge a real but irregularly-instrumented system).
  Not attempted in this pass (out of scope — research only), but concrete enough to hand to a future
  session: reuse `findInkBlobs`/the barline column scan across the *inter-staff* band, not just the
  intra-system one.
  - **Attempted (2026-07-23) and falsified on the real corpus, across two independent
    implementations — not adopted.** The idea itself (barline continuity as a corroborating signal
    for system grouping) is exactly what Audiveris/oemer document, and the building blocks existed
    cheaply, so this was worth a real spike. Both attempts were fully implemented, unit-tested, and
    verified against the real 39-file corpus (not just synthetic fixtures) before being rejected —
    this is a genuine negative result, not an abandoned-early idea.
    - **Round 1**: a single-page signal — a candidate irregular group (gap-size clustering rejects
      it for non-uniform size, e.g. "My Happy Life"'s real 2-staff-then-3-staff pattern) is trusted
      if every internal staff-to-staff gap shows 2+ columns where ink runs the full 0.95-of-band-height
      bar on both sides AND is solid across the gap between them. **Result: never fired on either
      real target file.** Direct instrumentation against the real running app showed every genuine
      irregular page in "My Happy Life" and "Arno Andiam Romanza" produces EXACTLY 1 confirming
      column per gap, never 2+ — confirmed byte-identical app output before/after on both files.
      **Worse, on "Fat Burger parts with drums"** (a scanned single-staff-part booklet, unrelated to
      the target case) **several coincidental, genuinely-unrelated 2-staff pairings showed 4-7
      confirming columns** — more apparent "evidence" than either real target case ever produced —
      and fired a false merge, regressing that file's system count from 261 to 251 (true count 391).
      The confirming-column count runs BACKWARDS from what the design assumed: real bracing produced
      less local evidence than scan-noise coincidence did. No single per-page threshold value fixes
      the target files without also flooding Fat-Burger-style false positives.
    - **Round 2**: since real per-system instrumentation patterns repeat throughout a whole piece
      while single-page scan-noise coincidences shouldn't, the fix was redesigned around cross-page
      corroboration — a cheap first pass renders every page once (reusing that same render for the
      real per-page pipeline, so no added rendering cost), computes a coarse shape signature
      (staff count + bucketed internal spacing) for each candidate irregular group with at least 1
      confirming column, and only promotes a group to an actual merge if the SAME signature recurs
      with evidence on 2+ *distinct* pages of the document. Cleanly implemented (`computeGrouping`,
      `collectCandidateGroupSignatures`, `groupSignature` in `lib/systemDetection.js`;
      a `pageCache`-based two-pass pre-pass in `scoreAnalysis.js` that renders each page exactly
      once), thoroughly tested (18 new test cases including a full end-to-end simulation of the
      real cross-page tally), 326/326 suite passing, lint clean. **Verified against the real
      39-file corpus again — still does not help either target file** (still byte-identical output,
      before and after, on both "My Happy Life" and "Arno Andiam Romanza": their own real irregular
      shapes apparently never recur in a bucketed-signature-matching way across 2 distinct pages of
      their own documents either, despite recurring visibly to a human reader). **Fat Burger still
      regressed the identical way** (261→251) — its scanned pages share very uniform real staff
      spacing throughout (being one instrument's part, scanned from one physical source), so a
      coincidental noise "shape" is, if anything, MORE likely to coincidentally recur across 2+ of
      its pages than a deliberate one is to recur in a piece with more real instrumentation variety.
      **A third, new regression also appeared**: "HLazarus_3_Grand_Artistic_Duets" went from
      406→415 systems (true count 326), a file round 1 didn't touch at all.
    - **Verdict: dropped, not merged.** Two independently-designed, individually well-reasoned,
      individually well-tested implementations both failed to fire on the real cases they targeted
      and both introduced real regressions elsewhere in the corpus — the second attempt's
      regressions were a strict superset of the first's, not an improvement. This is strong enough
      evidence that a *local, per-page-or-cross-page geometric ink-continuity signal alone* cannot
      safely discriminate genuine repeated bracing from scan/print noise on this real corpus, at
      least not via the specific signatures tried (raw column-continuity count; coarse
      staff-count-plus-spacing shape matching). A future attempt would need either a fundamentally
      different discriminating signal (not just a stricter threshold on the same one) or to accept a
      narrower, more conservative scope than "any irregular grouping, anywhere" — e.g. requiring
      corroboration from a completely independent source (real barline/measure alignment against an
      already-known-good adjacent system) rather than shape-signature recurrence alone. Not pursued
      further this session; "My Happy Life" and "Arno Andiam Romanza" remain unfixed for now (still
      correctly falling back to one-staff-per-system, the safe conservative default — no regression,
      just no improvement either).
  - **The ML-based route (oemer's/homr's UNet segmentation models) is explicitly not worth
    it, exactly as the task's own framing anticipated.** Confirmed via oemer's own README: model
    checkpoints are large enough that first download is documented as "up to 10 minutes" — this is
    squarely the "a second multi-hundred-MB ML model" case already ruled out by this project's
    privacy/architecture posture (one ~13MB MediaPipe download is the app's one accepted heavy
    asset; a second, much larger one for a problem the existing classical approach already handles
    adequately for this audience's single-staff-part-common-case is not worth it). No genuinely
    lightweight ML alternative for staff/system segmentation was found in this search — every
    real learned-segmentation OMR project is UNet-or-larger scale, not a few-hundred-KB model.
  - **Academic staff-line detection research (the "stable paths" algorithm, Capela/Rebelo et al.,
    and its several follow-ups) targets a harder, different problem than this app has**: robust
    detection on *handwritten* or badly-degraded scores where staff lines are curved, broken, or
    inconsistently spaced — the paper's own framing is explicit that printed scores are already
    comparatively well-handled by simpler methods, and it's specifically handwritten-music
    recognition that "remains below expectations." This app's real corpus (persona 6: cleanly
    engraved band parts as the common case, scanned/photographed booklets as a real but minority
    case) has never needed anything past straightforward horizontal-ink-run scanning + 1D
    clustering — **not worth prototyping**, it solves a problem this app's real files don't
    actually have.

- **OCR fallback / measure-number location (`ocr.js`, `lib/measureNumberLocate.js`) — no better
  lightweight browser-feasible localization technique was found than what's already built, and a
  real full-OMR system's own documented approach is actually *less* targeted than this app's.**
  Audiveris delegates all text recognition (including, presumably, measure numbers — not
  separately documented as its own subproblem anywhere found) straight to Tesseract's own general
  text-block detection across the page, with no dedicated "find one isolated small numeral above a
  staff" step at all. This app's own two-method design (`BOX`: geometric ink-blob localization,
  narrowly targeted per system, then OCR just that crop at PSM 8; `STRIP`: hand the whole left
  margin to Tesseract's own PSM-11 sparse-text layout analysis and correlate results by position)
  already covers both ends of this spectrum — the narrowly-targeted approach AND the "let generic
  OCR do its own layout analysis" approach a reference OMR system relies on exclusively. **Verdict:
  this app's existing dual-method approach is already more sophisticated than what a real, mature
  reference OMR project documents doing for this exact subproblem — nothing to adopt from
  Audiveris here.**
  - **One classical-CV technique worth naming as a possible future refinement to the `BOX`
    locator specifically, not a replacement:** MSER (Maximally Stable Extremal Regions), the
    standard scene-text-detection primitive for finding text-like blobs of consistent contrast
    across multiple thresholds, is more tolerant of touching/low-contrast ink than the current
    single-threshold ink-run blob finder (`findInkBlobs`). **Marked "worth prototyping only if a
    real corpus file surfaces a genuine location failure that isn't already explained by the
    numbers simply not being printed every system"** — this persona's own already-recorded
    investigation (Teutonia/MonogramMarch/KingCotton/Fat Burger OCR starvation) found the real
    blocking issue on that corpus was upstream of localization entirely (the source engraving may
    not print a number every system at all), so a better blob-finder wouldn't have helped that
    specific, already-diagnosed case — no evidence yet that the *localization* step itself, as
    opposed to what it's given to find, is the bottleneck anywhere in the real corpus.
  - **No academic literature specifically on "OMR measure-number reading" as its own studied
    subproblem was found** — every full-OMR paper/system found treats measure numbers as generic
    page text (an OCR job), not a music-notation-specific recognition problem worth its own
    dedicated technique. This is itself a useful negative finding: this app's narrowly-scoped
    ink-geometry pre-locate step is a genuinely uncommon (not just under-published) refinement,
    not a reinvention of an existing documented technique.

- **PDF text-layer section/tempo/measure-number-reset detection (`lib/scoreText.js`,
  `lib/scoreSections.js`, `lib/tempoSchedule.js`) — confirmed: nothing meaningfully comparable
  exists in the literature or in real open-source OMR projects, and that's a genuine finding, not a
  failed search.** Every OMR paper, dataset, and open-source project found (oemer, homr, Audiveris,
  the LEGATO/LEGATO-2 vision-LM line of work, several PDF-to-MusicXML commercial tools) targets
  *image* input — pixels in, symbols out — with zero use of a PDF's own embedded text objects as a
  metadata source, even when the input PDF is itself a "born-digital" (notation-software-exported,
  not scanned) file where a real text layer demonstrably exists. The closest adjacent published
  idea found, "extraction of information from born-digital PDF documents" (a reproducible-research/
  document-analysis paper, not music-specific), confirms the general *technique* (parsing a PDF's
  real text/vector content stream instead of rasterizing and re-recognizing it) is sound and used
  elsewhere, but nobody has applied it to this specific music-score metadata problem — this
  project's own approach here is a genuinely novel (if narrow and low-effort-to-discover) niche, not
  a known-and-adoptable-from-elsewhere technique this write-up somehow missed. **No action item —
  there's nothing to adopt, and the existing approach is already correctly described elsewhere in
  this section as "a different, easier problem than full OMR," not a walk-back of that verdict.**
  One tangential but real observation while researching this: commercial "PDF/image → MusicXML"
  tools (e.g. Newzik, PDFtoMusicXML) advertise materially higher accuracy specifically on
  "born-digital" PDF input than on scans — consistent with (not contradicting) this project's own
  finding that a real text layer is a much stronger signal than pixels wherever it's available,
  just applied by those tools to full symbolic OMR rather than to the narrower
  section/tempo/measure-number metadata this app actually needs.

- **Time-signature glyph shape-matching (`lib/timeSigMatch.js`, `timeSigDetection.js`) — the
  existing backlog item (bundle real engraving-font reference glyphs) is confirmed low-cost and
  license-clear, and a cheaper zero-new-dependency alternative is worth trying first.**
  - **Bravura (the reference SMuFL font) is SIL Open Font License-licensed — free to bundle,
    embed, and redistribute, including in a project like this one** (the only restrictions are
    against selling the font standalone and against reusing the reserved name "Bravura" for a
    modified derivative — neither applies to using it as-is for template rendering). SMuFL also
    defines fixed codepoints for time-signature digits (`timeSig0`-`timeSig9`, U+E080-U+E089) — so
    the swap from the current `ctx.font = 'bold ...px sans-serif'` template generator to a bundled
    Bravura webfont is a small, mechanical change to `getDigitTemplates()` in `timeSigMatch.js`
    (load a self-hosted `@font-face`, same pattern already established for MediaPipe/tesseract.js
    self-hosting — see Privacy/Architecture persona — then render the SMuFL codepoint instead of
    the plain digit character), not a redesign of the matching algorithm itself. **This confirms
    backlog item B2 is worth doing, and de-risks it further than it already was** — license was the
    one unverified assumption behind it going in.
  - **A real caveat worth flagging alongside that confirmation, not found until actually checking:
    Bravura is one specific engraving font family among several in real-world use** (Finale
    historically defaults to its own proprietary Maestro/Broadway-style fonts; MuseScore's own
    current default is Leland, a Bravura-derived-but-distinct sibling; Dorico and most
    SMuFL-conscious tools do use Bravura or something close to it) — bundling Bravura templates
    should meaningfully improve match confidence over a generic UI sans-serif for *many* real files,
    but won't be a perfect match for every notation-software vendor's own digit glyph shapes. Worth
    validating against a handful of real files from different source software (this project's own
    39-file corpus almost certainly spans more than one originating tool) before assuming Bravura
    templates alone close the gap completely — a reasonable, well-scoped first step, not
    guaranteed to be the whole fix.
  - **A genuinely cheaper alternative worth prototyping BEFORE bundling any font, and not
    previously considered in the existing write-up: feed the same already-built high-resolution
    candidate-region crop (the 10x re-render `timeSigDetection.js` already produces) to
    `tesseract.js` instead of (or alongside) the grid-Jaccard shape matcher.** This has a real,
    concrete cost advantage over both the Bravura-template plan and an ONNX-based classifier: no
    new dependency and no new bundle weight at all for the files that matter most to this app's
    audience (persona 6's engraved-common-case), since `tesseract.js` and its self-hosted worker/
    model are already a lazy-loaded dependency for the OCR measure-number fallback — the only new
    cost is possibly triggering that same lazy load on a text-layer PDF that would otherwise never
    need OCR at all (a real but small, one-time-per-analysis cost, not a bundle-size cost). A
    general OCR model trained on varied real-world fonts and shapes is also very plausibly *more*
    tolerant of an unfamiliar engraving font's digit shapes than a rigid single-template Jaccard
    grid comparison is — genuinely untested here, but a real, falsifiable, cheap thing to try
    (render the same crop already produced, run it through the existing PSM-8 single-word Tesseract
    path already built for measure numbers, compare confidence/accuracy against the current
    matcher) before spending effort on either bundling a font or a learned classifier.
  - **A small ONNX Runtime Web-based CNN digit classifier was checked and is NOT worth it given
    this project's real constraints, confirming (not just assuming) the size math**: a trained
    MNIST-scale model itself can be genuinely tiny (a few hundred KB), but the WASM *runtime*
    onnxruntime-web needs to execute it is not — the default (non-simd/non-threaded) `.wasm` binary
    alone is documented at ~10.5MB, comparable to this app's entire existing MediaPipe download,
    for a problem (10 digits + a handful of common time signatures) that a few-hundred-KB
    hand-rolled grid comparison already solves algorithmically, with only the *reference data*
    (not the algorithm) needing improvement. Paying a second MediaPipe-sized download for this
    narrow a symbol set is not a good trade — **not worth prototyping**, exactly the "narrow
    symbol set, glyph-matching is the pragmatic right call" framing the task itself anticipated.
    (MNIST-trained digit shapes are also the wrong reference distribution anyway — trained on
    handwritten digits, not engraved music-font numerals — so even a minimal model would need its
    own from-scratch training data, not an off-the-shelf MNIST checkpoint, adding real effort on
    top of the runtime-size problem.)

**Time-signature detection follow-through (2026-07-23): both the tesseract-OCR spike and the
Bravura-template bundling (backlog B2) were implemented and tested against real files from the
39-file corpus. Neither "wins" outright — the honest result is that Tesseract, once two real bugs
found along the way were fixed, reads a genuinely clean single-glyph crop far more reliably than
either grid variant, but is fragile in ways the grid method isn't, so both now run and the higher
-confidence result wins per detection, not a fixed primary/fallback order.**
- **Bravura templates (B2) do NOT clearly beat the old plain-sans-serif fallback on real files —
  a genuinely negative/neutral finding, not the hoped-for confirmation.** Direct A/B (same real
  glyph, same code path, only the template source toggled) against a Sibelius-engraved file's
  clearly-legible "5" and "4" digits: sans-serif template confidence 0.28/0.36 vs. Bravura's own
  0.17/0.23 — both comfortably below the 0.55 threshold (so neither ever surfaced either way), but
  Bravura was *lower*, not higher, on this real glyph. On a MuseScore-engraved file (Bravura's own
  closest real-world relative), grid confidence was ALSO low (~0.10-0.20) regardless of template
  source. **Conclusion: for THIS matching approach (16x20 Jaccard grid overlap), font-accurate
  templates aren't the bottleneck they were assumed to be** — the coarse grid resolution and the
  approximate numerator/denominator row-split (see below) appear to matter more than which
  reference font supplies the digit shapes. B2 is still implemented (self-hosted, OFL-licensed,
  zero ongoing cost, safely inert if the font fails to load) since it's genuinely free and can't
  regress anything, but it should not be read as "the fix" for grid accuracy.
- **Tesseract, once fed a properly-prepared crop, is dramatically more accurate than either grid
  variant on a real, clean glyph — but getting there required finding and fixing two real problems
  neither in the original plan.** (1) A raw numerator/denominator crop sits directly ON the staff
  (unlike a measure number, which sits in the clear margin and was already known to OCR fine) —
  fed raw, Tesseract read nothing at all (0% confidence, empty string) on a real crop, confirmed
  reproducibly; blanking any row that's dark across >85% of the crop's width before OCR (a real
  staff line spans nearly the full width; a digit's own stroke never does) took the SAME real crop
  from 0% to 94% confidence, correctly reading "5". (2) The existing candidate-blob window
  (`blobs.slice(1, 4)`, both methods) was too narrow: a real 5-flat key signature produces 4
  accidental blobs before the real time-signature glyph, so the true digit was never even
  attempted — widened to `slice(1, 8)` for both methods, confirmed against the same real file (Take
  Five, correctly detecting 5/4 end-to-end once both fixes were in).
- **Tesseract's own per-character confidence is NOT reliable enough to compare directly against
  the grid method on a raw min-of-two-digits basis — found only by testing, not anticipated.** The
  same real, correctly-read "4" denominator self-reported 0% confidence (reproduced consistently
  across 4 PSM modes against the actual production self-hosted worker, not a fluke), while spurious
  reads on non-digit fragments (a clef swirl, a flat sign) self-reported non-trivial 21-70%
  confidence on their OWN single side. What actually filters out the spurious blobs, confirmed
  across every test file, is a structural gate — BOTH the numerator and denominator half must
  independently recognize a digit at all — not a confidence floor: a non-digit fragment reads as a
  digit on at most one side by chance, never cleanly on both. Once past that gate, the pair's
  reported confidence is taken as `Math.max` of the two sides (not `Math.min`, the original design)
  specifically because `Math.min` was found to actively discard the one genuinely correct real
  match in this testing session, dragged to 0 by its own denominator's confidence quirk.
- **Final combination: highest-confidence-wins between the two methods (`pickBestTimeSig`,
  `lib/timeSigMatch.js`), not a fixed primary/fallback order** — justified by the evidence above,
  not assumed going in: grid confidence never once cleared the 0.55 threshold on any real file
  tested (whether via Bravura or sans-serif templates), so in every real case tested it was
  ALREADY structurally impossible for grid to outrank a genuine OCR hit; OCR's own structural gate
  (both halves must read) already excludes the false-positive risk a naive confidence comparison
  would otherwise carry. OCR is not unconditionally trusted over grid in the code, though — a
  future file where grid genuinely does score higher (e.g. OCR's worker fails to load, or a
  cleaner scan than any tested here) is still free to win on its own merits.
- **A real, separate bug found (but NOT fixed — out of scope for this task) while sourcing test
  files, worth a dedicated future session:** `scoreAnalysis.js`'s `firstBarlineCol` heuristic (an
  85%-of-band-height continuous ink run) can trigger on a clef's own vertical stroke rather than a
  genuine barline when the staff band is short, producing a degenerate few-pixel-wide "candidate
  region" that renders as a blank crop — confirmed on 2 of 6 real MuseScore-engraved single-part
  files tested (`Mixed_Nuts Clarinet.pdf`, `Dance_In_The_Game Trumpet.pdf`), both silently skipping
  time-signature detection entirely rather than misdetecting anything. This blocked testing the
  Bravura-template hypothesis against more Bravura-native files than the one (`Peace_Sign
  Clarinet.pdf`) that happened to have a wide enough region to avoid it.
- **A real, separate, PRE-EXISTING UI bug found and fixed while verifying: `renderTimeSigSuggestion()`
  was never called at all for a single-section file** (`autoScrollUI.js`'s `renderSummary()` calls
  it only via `selectSection()`, which the single-section — i.e. most common, single-band-part —
  branch never reaches). This silently made the entire "detected — use this?" suggestion feature
  invisible for this app's most common real case ever since it was introduced, regardless of any
  grid/OCR/Bravura accuracy question — found only because every real test file in this session
  happened to be single-section, and the suggestion never appeared even once detection started
  working correctly underneath. **Fixed** (one added call in the single-section branch).
- **Verified end-to-end against real files, not just unit-level:** `randomclarinet/takefive.pdf`
  (Sibelius-engraved, famously 5/4 time, a real 5-flat key signature) now correctly shows "🔍 Time
  signature: 5/4 detected — use this?" after these fixes, confirmed by eye against the real
  rendered page. `pinkpanther.pdf` (also Sibelius) and `Peace_Sign Clarinet.pdf` (MuseScore)
  correctly show NO suggestion — the former appears to use the "𝄴" common-time symbol rather than
  digits (neither method can read that; a genuinely different, out-of-scope problem), the latter's
  numerator/denominator glyphs are packed too tightly for either method's row-split to isolate
  cleanly. Both null results are the CORRECT, safe behavior (never a wrong guess), not a bug.
  Testing used a temporary, session-only Playwright script (not committed, matching this project's
  established ad hoc verification pattern — see the Testing/QA persona) driving the real dev
  server against real files from the local corpus; no PDF or rendered crop was committed or left
  on disk afterward.

---

## 4. Audio DSP / Music Information Retrieval Engineer

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

---

## 5. Real-Time Control Systems / Interaction Designer

**Owns:** turning a noisy per-frame signal (gaze, wink, or a time schedule) into a *decision* —
scroll, don't scroll, snap, hold — that feels natural rather than jittery or laggy.
**Files:** `src/lib/followLogic.js`, `src/followController.js`, `src/autoScrollController.js`

**Core techniques:** exponential moving-average smoothing, dead-zone thresholding, hysteresis /
hold-debounce, leaky-integrator drift correction, eased snapping.

**What we've learned:**
- `followLogic.js`'s `decide()` is kept **pure and DOM-free on purpose** — it takes the current
  smoothed gaze plus the previous frame's local state and returns the next state and an intended
  effect; `followController.js`'s rAF loop is the only thing that touches the DOM. This is what
  makes the decision logic unit-testable without a browser or camera (see QA persona) and is the
  template for any new "signal → scroll decision" feature.
- **Smoothing** is a single-pole EMA (`alpha = 1/smoothWin`) on both axes — simple, tunable by one
  "smoothness" slider, and good enough; no need for a Kalman filter or similar at this signal
  quality.
- **The dead zone has to be capped per-direction**, not just sized as a flat fraction of band
  height: a band positioned near the top of the screen (well within the sliders' normal range)
  can make `bandPos <= deadZoneFrac`, which makes the "scroll up" trigger *mathematically
  unreachable* (no on-screen gaze position could produce `offset < -dead` when `dead` exceeds the
  available room above the band center). The fix (`deadUp`/`deadDown`, each clamped to leave a
  `minRoom` sliver) is a good example of a bug that only shows up by reasoning about the *geometry
  of the whole slider range*, not by testing typical/default values — worth remembering as a
  category of bug to watch for whenever sliders interact multiplicatively.
- **Hysteresis via a hold timer** (`cfg.holdMs`), not just a dead zone, prevents a single quick
  glance from committing a scroll or a system snap — the zone has to be *sustained* across a
  short hold before it "engages." Same pattern is reused for both continuous scroll speed and
  discrete system-snap advance/retreat.
- **Snap mode and smooth-scroll mode are structurally different control loops** sharing the same
  input pipeline: snap computes a target document Y and eases toward it (`step = (target -
  scrollY) * min(1, dt*6)`, arriving when within 2px); smooth mode computes a proportional
  velocity intent from how far outside the dead zone the gaze is, gated by the same hold-debounce,
  and accumulates fractional scroll via a carry remainder (`scrollCarry`) so sub-pixel velocities
  don't get truncated away frame to frame.
- **Drift correction is a slow, clamped leaky integrator** on the vertical mapping bias, active
  only while "reading" (in-band, not mid-turn) — nudges resting gaze back toward the band center
  over time without ever being able to run away, independently arriving at the same shape as the
  live-tempo correction's decay (see Audio DSP persona).
- **Two independent per-frame loops driving the same global side effect need an explicit mutual-
  exclusion guard — nothing about "different input signals" prevents them from colliding.**
  `followController.js`'s gaze-driven loop and `autoScrollController.js`'s schedule-driven loop
  both call `window.scrollTo()` on their own `requestAnimationFrame` cycle; there was no code
  stopping both from running at once and fighting over scroll position until this was specifically
  audited for and fixed. **Fix pattern:** starting either mode force-pauses the other, via small
  reusable functions each side calls (`setFollowing()` in `followController.js`,
  `pauseAutoScrollUI()` in `autoScrollUI.js`) rather than duplicating the pause logic at each call
  site, plus a toast explaining the automatic switch so it's never a silent behavior change.
  **General lesson: whenever a new feature adds *another* independent loop that can touch shared
  page state (scroll position, a DOM overlay, anything not scoped to that loop alone), audit for
  this class of conflict explicitly** — "reads different inputs" does not imply "can't collide,"
  and this bug shipped once already (in the time-based auto-scroll feature) before being caught.

- **A second module re-deriving capped dead-zone geometry from raw config (instead of importing
  the capped result) can silently reintroduce the exact bug the cap fixed, in a place tests
  didn't cover.** An independent review (2026-07-19, see `docs/reviews/`) found `winkTracking.js`
  synthesizing its trigger point from raw `cfg.bandPos`/`cfg.deadZoneFrac`, not `decide()`'s
  capped `deadUp`/`deadDown` — at reachable slider settings (e.g. band 20% + dead zone 20%, both
  well inside the sliders' ranges) the real "up" trigger zone caps down to an ~8px sliver, but the
  wink code's uncapped math (plus a fixed absolute floor clamp) could synthesize a point that
  landed *outside* that sliver — left wink silently did nothing, in the default tracking type. The
  existing wink test only asserted against the uncapped threshold, so it didn't catch it. **Fixed**
  by exporting the capping math as `deadZoneBounds(cfg, H)` from `followLogic.js` (decide() now
  calls it too, removing the duplication) and having `winkTracking.js` place its synthesized point
  at a *fraction of the real (possibly tiny) reachable sliver's own width* — `depth = 0.15 + 0.8 ×
  winkStrength`, scaled to whatever `deadZoneBounds` says the sliver actually is — instead of a
  fixed absolute reach past an assumed edge. **General lesson: when a value's valid range is
  computed with a cap/clamp in one place, any other producer of that same kind of value must
  import the capped computation itself, not re-derive an uncapped version from the same raw
  inputs** — this is the same "geometry beats a second re-derivation" class of bug as the original
  dead-zone cap fix above, just one hop further from where the cap was first added.
  **Superseded (2026-07-23) by removing the synthesized point entirely — see the `winkIntent`
  finding below, backlog item A2.** This finding (and the fix it describes) is kept verbatim as the
  historical record of why the A2 refactor mattered, not because the synthesized-point code path
  still exists.

- **(A2, 2026-07-23) `decide()` now takes an explicit `winkIntent` channel instead of wink
  synthesizing a fake gaze point at all — closing the bug *class* the A1 fix above only patched one
  instance of.** The prior design (`winkTracking.js` computing a screen-fraction point positioned
  just past `deadZoneBounds`'s capped dead-zone edge, scaled by wink strength, for `decide()` to
  re-derive an up/down direction from) worked but stayed structurally fragile: *any* future change
  to `decide()`'s dead-zone/band geometry had to be mirrored in `winkTracking.js`'s point-placement
  math, or the exact A1 bug class (a synthesized point landing back inside the zone it was meant to
  clear) could reappear in a new shape. **Fix:** `decide()` gained a new optional input,
  `winkIntent: { dir: -1 | 1, strength, t } | null` — a direct "scroll up"/"scroll down" signal with
  no screen position at all. Handled in its own branch, checked *before* the gaze-point path: it
  reuses the exact same downstream zone/hold-hysteresis/snap-vs-smooth-mode machinery (`curZone`/
  `zoneSince`/`scrollCarry`, `cfg.holdMs`, the snap-target easing) so wink's feel (hold-to-commit,
  proportional smooth-mode speed) is unchanged, but skips every gaze-point-only concern entirely —
  no EMA smoothing, no sheet-margin/on-screen check, no dead-zone geometry, no drift correction, no
  line-end detection — because none of those exist to serve an (x, y) position this signal never
  had. Same 250ms timestamp-freshness gate as `rawGaze` (defense in depth against a stale/stuck
  value, e.g. left over after switching tracking types mid-session). `winkTracking.js` now just
  returns `{ intent: 'up' | 'down', strength }` directly from its existing wink-commit logic — no
  geometry, no `deadZoneBounds` import, no `cfg` import at all — and `camera.js` routes that into
  `state.winkIntent` (a new, separate field from `state.rawGaze`) instead of a synthesized gaze
  point; `followController.js` forwards it to `decide()` alongside (not instead of) `rawGaze`. **The
  gaze/iris tracking call path is untouched** — this was a pure refactor for wink, verified by the
  full existing `followLogic.test.js` gaze-path suite passing unmodified. **One real, expected side
  effect, not a bug:** the "gaze dot" debug overlay (`Toggle gaze dot`) no longer shows a position
  during wink tracking, since there's no synthesized screen position left to show — it was only ever
  a side effect of the old hack, not a real gaze estimate, so this is a more honest UI state, not a
  lost feature. Added dedicated `winkIntent` coverage to `followLogic.test.js` (smooth-mode hold/
  scroll direction/speed scaling, snap-mode advance/retreat, priority over a simultaneously-present
  `rawGaze`, staleness fallback, and a case at the exact `bandPos=0.12` config that used to make
  "up" unreachable via the old rawGaze-synthesis path — demonstrating the new path is structurally
  immune to that whole bug class rather than merely re-tested against the one known instance);
  rewrote `winkTracking.test.js` around the new `{ intent, strength }` return contract (the old
  tests asserting `uy` landed inside/past the capped dead-zone edge no longer apply, since
  `winkTracking.js` no longer computes a `uy` at all). Full suite: 303 tests passing after the
  change (was 285 before this session's two additions).

- **(E2, 2026-07-23) Added `PageUp`/`PageDown` to `main.js`'s manual-scroll keyboard fallback,
  alongside the existing `ArrowUp`/`ArrowDown` handling.** Real hardware value, not a cosmetic
  addition: page-turn foot pedals aimed at this app's actual audience commonly send `PageUp`/
  `PageDown` keycodes rather than arrow keys. Same scroll amount/direction as the existing Arrow
  branches (`window.scrollBy(0, ±60)`), added as separate `e.code` branches rather than folding into
  the existing Arrow conditions, specifically so the Arrow branches' behavior (no `preventDefault`)
  stays byte-for-byte unchanged — `PageUp`/`PageDown` get their own `e.preventDefault()` because,
  unlike arrow keys, the browser's own default action for them is to scroll the viewport by a full
  page, which would otherwise double up with the manual `scrollBy()`.

- **A DOM re-render doesn't invalidate geometry another feature already captured from it, unless
  something explicit makes that connection.** The same 2026-07-19 review found `pdf.js`'s
  `renderAll()` was both re-entrant (a resize/zoom/panel-collapse mid-drag could fire it multiple
  times before the first call finished, interleaving two page sets — `main.js`'s resize listener
  called it on every event, undebounced) and silently invalidating: `scoreAnalysis.js`'s
  `analyzeScore()` bakes `state.autoScroll.systemBands` as *absolute document pixels* at Analyze
  time, and nothing told auto-scroll a later re-render had moved everything — Start would then
  scroll/highlight the wrong position with no warning, silently, mid-performance. **Fixed:**
  `renderAll()` now carries a generation counter, checked after every `await`, so a superseded
  call stops touching the DOM (clearing/appending/calling `detectSystems()`) as soon as a newer
  call has started — snap mode's own detection already re-runs inside `renderAll()`, so this alone
  fixes it. For auto-scroll, the cheap first fix was to invalidate `state.autoScroll.analyzed` on
  every re-render and show a "layout changed, re-analyze" toast. **Superseded (2026-07-21) by the
  fraction-based rewrite that was always the right end state:** `systemBands` are now stored
  *page-relative* (a page index + top/center/bottom as fractions of that page's height) and
  resolved to document pixels against the live canvas geometry at scroll/highlight time
  (`src/systemGeometry.js`), so a resize, zoom, phone rotation, or sidebar collapse is picked up
  automatically — no invalidation, no re-analyze, no toast. A paused schedule is re-snapped after a
  reflow (`repositionAutoScroll()`), and `main.js` now also handles `orientationchange`. Verified
  in-browser (Playwright) across resize/rotate/sidebar-collapse, playing and paused, at 100% and
  150% display scaling: the highlight stays locked on the correct staff line every time. **A
  second, related instability surfaced only once real files were driven through the pipeline at
  varying window sizes — the deeper form of the same lesson:** analysis *itself* was
  resolution-dependent, because detection ran on the on-screen display canvas (whose pixel
  resolution varies with window size × zoom × DPR). At higher resolution/DPR a real 5-line staff
  could split into 2-3-line fragments (inflating the system count) and a printed measure number
  could fall just outside its correlation window (dropping it), silently corrupting measure counts
  on some machines but not others — a real lead sheet ("Departure!") analyzed as 21 systems at some
  window sizes and 23-24 at others, showing a stray "27" where an 8 belonged. **Fixed
  (2026-07-21):** `analyzeScore()` now renders each page to a fixed 1200-row offscreen canvas for
  detection instead of reusing the display canvas, so system/measure results are identical on every
  machine, window size and DPI; `systemBands`' page-relative storage means on-screen scroll still
  maps correctly at any resolution. Separately, `main.js`'s resize handler now debounces the
  `renderAll()` call itself (folded into the existing 400ms recalibration-check timer) rather than
  firing on every intermediate resize event. **General
  lesson: when a producer module captures derived data from the DOM/render output (pixel positions,
  bounding boxes, anything geometry-shaped), and a *different* module can trigger a re-render, the
  producer needs either to re-derive on demand or be explicitly told "that's stale now" — a shared
  render entry point is the natural place to own that invalidation, same as it's the natural place
  to own re-entrancy guards.**

- **A slider that updates `state` but nothing that reads a *derived* value built from that state can look completely dead, with no error anywhere.** A user testing a real score reported the
  BPM and beats-per-measure sliders having "no effect" during active auto-scroll playback.
  Root cause: `startAutoScroll()` calls `buildSchedule()` once, baking `beatsPerMeasure`/`bpm` into
  `state.autoScroll.schedule`; `tick()` only ever reads that already-built schedule, never rebuilds
  it. The two slider handlers (`autoScrollUI.js`) only ever wrote `state.autoScroll.beatsPerMeasure`/
  `bpm` — correct, but inert until the next Stop+Start, with zero UI signal that anything was
  frozen. ("Playback speed"/`tempoPct` is the one slider with true live effect, since `tick()` reads
  it fresh every frame — this asymmetry between sliders that look identical but behave differently
  is exactly what made the frozen ones feel like a bug rather than a documented limitation.)
  **Fixed** (2026-07-20): added `rebuildScheduleLive()` in `autoScrollController.js`, called from
  both slider handlers whenever a schedule already exists. It rebuilds the schedule from the current
  values but **preserves musical position** (which system, what fraction through it — via
  `progressWithinSystem`), not elapsed seconds, since a tempo/meter change redefines what a given
  second-count even means; verified by hand that doubling BPM mid-system keeps the same system index
  and ~50% progress rather than jumping. **General lesson: when a feature's live/frozen distinction
  isn't visually obvious (two sliders that look the same but one takes effect immediately and the
  other doesn't), either make all of them live or make the frozen ones visibly disabled/labeled —
  the silent-freeze middle ground reads as broken even when every individual line of code is
  behaving exactly as written.**

**(D1, 2026-07-23) Replaced the fixed-alpha EMA gaze smoothing with a One Euro filter** (Casiez,
Roussel & Vogel — CHI 2012), per the 2026-07-19 Fable review's finding #5: a fixed-alpha EMA has to
pick one point on the jitter-vs-lag trade-off for every gaze speed; a speed-adaptive cutoff instead
smooths heavily while gaze holds still (killing reading-line jitter) and opens the cutoff up as
gaze speed rises (killing lag on the saccade to the next system) — exactly the trade-off the single
"smoothness" slider previously forced users to pick a side of. Implemented as a small, dependency-free
pure function (`lib/oneEuroFilter.js`'s `oneEuroStep(state, rawValue, dt, minCutoff, beta)`, no new
npm package, matching this codebase's existing practice of hand-rolling small algorithmic utilities),
with per-axis derivative-estimate memory (`dX`/`dY`) threaded through `decide()`'s explicit `state`
object the same way `smoothX`/`smoothY` already were — added to `createFollowState()` and every one
of `decide()`'s return sites (including the `winkIntent` branch's own return sites, which never
touch gaze smoothing at all and simply pass `dX`/`dY` through unchanged, same as they already did
for `smoothX`/`smoothY`).
- **Parameter mapping — kept the single existing "Eye-tracking smoothing" slider** (`cfg.smoothWin`,
  range 3-40) rather than exposing the filter's own `minCutoff`/`beta` parameters directly, to avoid
  trading one low-cognitive-load control for three raw ones. `minCutoffFromSmoothWin()` treats
  `smoothWin` as the same "N-frame time constant" the old EMA's `alpha = 1/smoothWin` always meant,
  converting it to Hz assuming a representative ~30fps webcam frame rate (`tau = smoothWin/30`,
  `minCutoff = 1/(2π·tau)`) — chosen specifically so an already-saved slider value (real users may
  have this in `localStorage`) lands on comparably-smooth *resting* behavior rather than a jarring
  discontinuity, even though the actual moment-to-moment behavior necessarily differs (that's the
  whole point of the change). `beta` (how fast the cutoff opens up as speed rises) is a fixed
  constant (`ONE_EURO_BETA = 0.0008`), empirically picked as the largest value that still keeps
  synthetic small (~3px) reading-line jitter's steady-state variance *below* the old EMA's, while
  still cutting a synthetic saccade-sized jump's settle time from the old EMA's ~26 frames to ~5.
- **Verified via synthetic-sequence tests, not real-corpus data** (this is an interaction-feel
  property, not something the accuracy benchmark scores, and there was no reported user complaint
  driving this — backlog item D1 was explicitly "do when touching `followLogic.js` next, not as a
  standalone session"): `lib/oneEuroFilter.test.js` demonstrates the filter's core claimed property
  directly against the old fixed-alpha EMA on identical synthetic input (lower steady-state variance
  on jitter, faster settle time on a saccade-sized step); `followLogic.test.js` adds integration
  tests confirming `decide()` itself threads the new `dX`/`dY` state correctly frame to frame and
  that a real gaze jump through `decide()` tracks noticeably further in one frame than the old EMA
  would have.

**Open questions / future research:**
- Whether snap-mode's fixed `dt*6` easing rate should itself be user-tunable (currently baked in)
  — no reported user complaints yet, so untouched.
- Horizontal (X-axis) dead-zone/hysteresis tuning has had less real-world testing than the
  vertical band logic; worth a dedicated accuracy pass if line-end detection complaints come in.

---

## 6. Music Educator / Target-Audience Advocate

**Owns:** representing the actual player — a high-school band student reading a single-staff
part — in every feature and tuning decision. Not a code owner; a standing "does this match how
our real users actually read music" check.

**What we've learned:**
- [[project_target_audience]]: the core audience is **high school band**, playing **individual
  instrumental parts** (one instrument per part) — not full scores, not piano/grand-staff
  literature. This one fact **cascades into every other persona's scoping**:
  - CV/OMR: single-staff is the easy, reliable case for staff/system detection — multi-staff
    grouping logic exists but isn't the primary bar.
  - Notation: parts are typically **cleanly engraved** (published or notation-software output),
    not scanned/photographed — OMR-adjacent detection work performs meaningfully better here than
    it would against scans, and testing should prefer real engraved band-part PDFs over
    hand-picked hard cases from orchestral/piano repertoire.
  - Audio/Tempo: band pieces are usually **single-tempo** (at most one contrasting section) —
    this is *why* auto-scroll's v1 deliberately supports one global BPM per piece rather than
    building per-system tempo-change markers; that's a validated scope decision, not a missing
    feature.
- Practical playing conditions matter more than lab conditions: hands are on the instrument (no
  keyboard/mouse mid-piece — hence pedal/spacebar pause and wink-only turning), the player is
  often not perfectly still (breathing, swaying, instrument movement — hence pose-invariant
  gaze), and sheet music stands / rooms have inconsistent lighting (hence the accuracy-test's
  brightness feedback and auto-frame).
- **A cluttered control panel is a real usability failure for this audience, not just aesthetics
  — a student mid-warm-up won't debug a confusing settings panel.** As camera-tracking and
  time-based auto-scroll grew side by side, the panel drifted into ~15 flat top-level items mixing
  three unrelated concerns (camera setup/tuning, save/presets, auto-scroll), with no visual
  signal that eye/wink tracking and auto-scroll were *alternatives*, not two things meant to run
  together — a real user got confused by exactly this ("i'm not seeing the two choices," surprise
  that both hands-free modes could run at once and fight each other, see Real-Time Control
  persona's mutual-exclusion finding). **Fix:** an explicit tab switcher (Eye/Wink vs. Tempo) so
  exactly one mode's controls are visible at a time, matching the actual "pick one hands-free
  method" mental model, rather than a flatter grouped-accordion attempt that turned out to still
  not read clearly enough. **General lesson: as this app accumulates independent tracking/
  playback modes over time, proactively re-audit whether the panel still reads as a small number
  of clear top-level choices — this kind of clarity loss is gradual and easy to miss
  incrementally from the inside.** Default to an explicit mode-tab per top-level choice for any
  *future* additional mode, rather than adding another flat section and rediscovering the same
  problem.
- **Adding the tab switcher didn't automatically make every mode-specific UI element respect
  it.** The reading-band overlay had already been fixed once to hide "while auto-scroll is
  playing," but a user caught it still showing while paused on the Tempo tab — the earlier fix
  checked *play state*, not *which tab is active*, and the two aren't the same thing (tabs are a
  pure visibility toggle, not a stop; auto-scroll can keep running after switching back to
  Eye/Wink). **General lesson: when a UI element belongs conceptually to one mode/tab, its
  visibility condition should check the active tab directly, not a proxy state that happens to
  usually correlate with it** — the proxy will eventually be wrong in some reachable combination
  a user finds before you do.
- **The default-visible tab was Tempo, not Eye/Wink — silently contradicting the README's own
  quick-start, the default tracking type (wink), and the reading band's default-on state.** A
  first-time student following the README's setup steps would open the app to the wrong panel,
  with no visible path back to what the instructions just described — a first-five-seconds failure
  for exactly the "student mid-warm-up won't debug a confusing panel" scenario above, found by an
  independent review (2026-07-20, see `docs/reviews/`). Notably, `index.html`'s own static markup
  already had `trackingPanel` visible and `autoScrollPanel` hidden by default — `tabsUI.js`'s
  `initTabsUI()` was actively fighting the HTML's own default on every load. **Fixed** by defaulting
  to `tabTracking`, which now agrees with the HTML. **General lesson: a "trivial effort" fix can
  still be a first-impression-breaking bug** — effort size and user impact are independent axes;
  don't let one substitute for triaging the other.

**Practice is not performance, and that distinction breaks a naive "play-along auto-scroll"
proposal (2026-07-20 review of that feature idea).** Auto-scroll's existing model (single BPM,
monotonic time-based schedule, gentle onset-nudge correction — see Audio DSP and Real-Time Control
personas) was built and validated for **playing a piece through start to finish at one tempo** —
a performance-shaped scenario. Real solo practice is not that: a band student **stops and repeats
a hard measure over and over, plays a passage slow then speeds it up, pauses to breathe/reset,
sometimes runs a metronome, counts multi-bar rests silently (no sound at all for many beats), and
— especially as a beginner — plays wrong notes and has unstable pitch/tone constantly.** Any
scroll-driver proposed for this scenario has to survive all of those, not just the clean
run-through case the current schedule already handles.
- **Audio score-following (listening to position the page, not just nudge a known schedule's
  tempo) is judged NOT worth building for v1**, for a reason specific to this audience's rests:
  the app has no reliable way to know *where the written rests are* (full OMR — reading actual
  note/rest values from pixels — was already researched and found infeasible client-side, see OMR
  persona) so nothing in the codebase can distinguish "the student is silently counting 8 bars of
  rest, as written" from "the student stopped to fix a reed problem." A follower that advances
  the page during a genuine written rest, or one that pauses/stalls waiting for sound that was
  never supposed to come, is a **dealbreaker for trust** — worse than doing nothing, because it
  actively fights a student's silent counting instead of just failing to help. Stop-and-repeat
  practice compounds this: the existing onset-nudge correction (Audio DSP persona) only ever nudges
  a schedule *forward* within a small clamped range — it has no concept of the position jumping
  *backward* when a student repeats a measure, so even a simplified "are they still playing"
  activity gate would misbehave the first time a student loops a hard passage.
- **What actually earns trust here is predictability the student can rely on, not cleverness that's
  occasionally wrong** — the same lesson as the control-panel clarity findings above, applied to
  the scroll mechanism itself: a dumb, metronome-locked scroll a student can predict and fight
  through once is more usable than a smart listener that's right 90% of the time but silently wrong
  in exactly the moments (a long rest, a repeat) that already require the student's full attention.
  A real band director's practical advice to students ("count your rests, don't just wait for a
  cue") already assumes the student is the one tracking position during a rest — a feature that
  tries to do that *for* them, imperfectly, undermines a habit teachers are actively trying to
  build, not just a UX nuisance.
- **Recommendation for v1: keep auto-scroll's existing metronome-locked mode for run-throughs
  (already validated for exactly that use case), and add a distinct, fully hands-free
  *manual advance* mode for drill/repeat practice** — reusing the existing wink/gaze trigger
  infrastructure to let the student themselves decide when to move to the next system/measure (or
  back up to repeat one), at their own pace, with no listening involved at all. This puts the
  human — who already knows when they're ready to move on — in control of the "clock," which is
  the actual mental model of how practice works, rather than trying to infer it from an inherently
  ambiguous audio signal.
- **The one question that would validate or kill audio-following as a future direction:** record a
  real student's *practice* session (not a clean performance) — stopping, repeating, playing a
  passage slow then fast, counting a real multi-bar rest — and run it through the existing onset
  detector + schedule-nudge logic. If it produces more false pauses/false advances than correct
  nudges on that recording, audio-following isn't ready for a practice-shaped feature regardless of
  how well it performs on a clean run-through; this hasn't been tested and would need a real
  recording, not synthetic input, to answer honestly (the same "verify against real data" discipline
  as the OMR persona's barline/measure-number fixes).

**Whole-app health review (2026-07-22): the recent 39-file real-corpus sweep (rotation-flag
correction, numeric-tempo section titles, measure-number-reset boundaries — see OMR persona) is
exactly the right kind of validation for this audience, and surfaces one new UX-facing risk worth
tracking rather than treating as purely an OMR-internal detail.**
- **Endorsement, not just a technical note: the corpus itself (a real user's own high-school/
  community-band collection — marches, IMSLP trio arrangements, anime sheet music, solo clarinet
  pieces) is a meaningfully better test signal than hand-picked hard cases, because it's the actual
  shape of what this audience owns and plays** — individually-rotated scanned booklet pages, parts
  with only a numeric metronome mark and no Italian tempo word, library-cover-sheet first pages
  with no combined score to bootstrap instrument names from. Recommend this stays the default
  review practice for any future detection tuning in this app, not a one-off.
- **New risk to watch: generic `Section N` names (the fallback when a part has no combined-score
  bootstrap page) combined with the still-open over-splitting failure mode on noisy OCR** (the
  "Lazarus duets" case in the OMR persona's write-up, over-splitting into ~10 sections from
  oscillating misreads) **is a real control-panel-clarity risk, not just a data-quality footnote.**
  A student opening the Tempo tab mid-warm-up to a list of 10 meaninglessly-numbered sections for
  what is, to them, just "my one clarinet part" is the same class of failure already flagged above
  for a cluttered/confusing panel — the harm isn't silent wrong output, it's a confusing choice
  surface at exactly the moment (mid-warm-up) this audience won't debug it. Doesn't need OMR-side
  fixing first; a UI-side mitigation (e.g. collapsing/hiding the section picker entirely when there's
  only one real section, or visually de-emphasizing low-confidence generic-named sections) would
  contain the damage even before the underlying OCR-noise ceiling improves.
  **Built (2026-07-22):** went with de-emphasizing rather than hiding — a blanket "hide whenever any
  section is generic" rule would have thrown away real value on the common, legitimately-useful case
  (a "Full band arrangements" file with 2-3 real generic sections from clean measure-number resets,
  which the same corpus sweep confirmed is a working, valuable split even with no real instrument
  names attached to it — see the OMR persona's Finding 1 write-up for real system counts on those
  exact files). `buildSections()` (`lib/scoreSections.js`) now tags each section `genericName: true`
  only for the numbered `Section N` fallback (explicitly NOT for the `i===0` "Score" default, which
  is a meaningful label on its own) and the sections dropdown (`autoScrollUI.js`) appends
  "— auto-detected split" to a generic section's own option text, so a student sees a plain visual/
  textual cue that this particular split point is an approximation, not an authoritative label —
  without hiding or removing any of its own (still real, still useful) per-section measure counts.
- **No new hands-off-instrument interaction risk from any of this work.** Rotation correction and
  section splitting are both pre-processing (run during "Analyze," before the student ever picks up
  the instrument) — they don't touch the pedal/spacebar/wink control surface at all, so the "hands
  stay on the instrument mid-piece" bar this persona is most protective of is untouched by this
  round of work.

**Open questions / future research:**
- No current handling for **duet/ensemble parts with cues** (small cue notes from another
  instrument) — unclear how they'd interact with barline-based measure counting; likely fine
  since cues don't usually add extra barlines, but untested.
- Orchestral/piano users are explicitly a secondary audience, not unsupported — worth periodically
  checking that secondary-audience support hasn't silently regressed rather than actively
  investing in it.
- Whether a lightweight, non-OMR way to flag "this system contains a long rest" (e.g. detecting a
  whole-rest glyph via the same shape-matching approach used for time-signature digits) could ever
  make a silence-tolerant audio mode safe — not attempted; would need to clear the same
  confidence-gated "ships inert unless confident" bar as the time-signature matcher before being
  trusted anywhere near a live practice session.

---

## 7. Privacy & Client-Side Architecture Engineer

**Owns:** the "everything runs in the browser, nothing is ever uploaded" constraint, and vetting
every new feature idea against it before it gets designed.
**Files:** whole-app constraint — no `src/` file is exempt; most visible in `README.md`'s privacy
section and the absence of any server/backend in the project. `scripts/fetch-mediapipe-assets.mjs`
and `public/mediapipe/` (git-ignored, populated at dev/build time) hold the self-hosted MediaPipe
assets — see below.

**What we've learned:**
- This is a **hard constraint, not a preference** — it has already ruled out a concrete feature
  direction (sending pages to a cloud OMR service for full rhythm/pitch extraction, which would
  have made accurate auto-scroll tempo detection much easier). Any future feature proposal that
  implies "send the score/audio/video to a server" needs a client-side-only alternative or it
  doesn't ship, no matter how much easier the server-side version would be.
- Corollary for calibration/settings data: it's stored **only in the browser** (no account, no
  sync) — that's a feature ("close the tab and nothing is kept except your saved settings"), so
  any new persisted setting should default to local storage, not assume a backend will ever
  exist.
- **The "MediaPipe's model/WASM are too large to self-host" tradeoff was never actually measured,
  and turned out to be wrong.** An independent review (2026-07-19) challenged it; verification
  (2026-07-20, live `HEAD`/download checks against the exact pinned URLs) found the real combined
  size is **~13MB** (float16 `face_landmarker.task` = 3.76MB, the larger of the two WASM variants
  ≈ 9MB — only one loads per session) — comfortably small, not "large" by this project's own PDF-
  loading standards. The CDN-loading approach's actual cost fell on exactly this app's audience:
  school networks commonly filter `storage.googleapis.com`/`cdn.jsdelivr.net`, which meant a
  blocked first load killed the app outright with a confusing error for a user with no way to
  self-diagnose "my school blocks Google's CDN" — worse than the inconvenience the CDN approach
  was chosen to avoid. **Fixed** (2026-07-20, see `docs/reviews/`): `scripts/fetch-mediapipe-
  assets.mjs` runs automatically before `dev`/`build` (via npm's `pre*` script lifecycle) and
  copies the WASM files straight out of the already-installed `@mediapipe/tasks-vision` npm
  package (so they can never drift from the pinned dependency version) plus downloads the model
  once from its stable, version-pinned URL; `camera.js` now points at same-origin
  `/mediapipe/wasm` and `/mediapipe/models/face_landmarker.task` instead. `public/mediapipe/` is
  git-ignored — a ~13MB binary doesn't belong in git history when it can be regenerated
  deterministically from a pinned dependency + a stable URL, the same reasoning that keeps user
  PDFs out of the repo. Licensing checked out too (`@mediapipe/tasks-vision` is Apache-2.0; native
  MediaPipe apps already bundle the `.task` file by design). The model URL was already pinned to
  version `1`, not `latest`, so self-hosting introduces **no new staleness risk** versus what was
  already shipping — a version bump requires a code change either way, CDN or not. **The
  constraint itself never actually required a CDN** — it was always "no frame/audio data leaves
  the machine," and inference still runs 100% on-device either way; this was a scope refinement of
  *how* the model gets to the browser, not a reversal of the constraint. **General lesson: a
  documented tradeoff's numbers should be treated as a claim to verify, not a fact to cite
  indefinitely** — this one sat unverified long enough for the actual asset sizes to never once
  have been checked against the real, small numbers.

- **Play-along audio score-following (mic-driven auto-scroll for a soloist) — reviewed 2026-07-20,
  verdict: no hard blocker, but three gaps in the existing posture, not zero-cost to ship:**
  - **The mic isn't explicitly covered by the privacy posture yet.** `liveTempo.js` already does
    `getUserMedia({ audio: true, ... })` for onset-based tempo correction (see Audio DSP persona),
    but the README's privacy section and this persona's own framing talk about "camera frame" far
    more prominently than audio — an implicit "audio inherits the same treatment as video" has
    never been written down. A *new*, more ambitious mic feature (driving scroll position, not
    just nudging a known schedule) is exactly the moment to make that explicit rather than let it
    stay implied.
  - **Any new pitch/onset ML model must follow the MediaPipe self-hosting precedent**, not the
    CDN-fetch pattern that precedent replaced: fetched at build/dev time from the installed npm
    package or a pinned stable URL (a `scripts/fetch-*-assets.mjs`-style script), served
    same-origin under `public/`, git-ignored, regenerable — not a runtime fetch from a third-party
    CDN a school network might block, and not assumed "too large to self-host" without actually
    checking its size the way the MediaPipe number was checked.
  - **The single most tempting phone-home vector here is accuracy-improvement telemetry** —
    "send a short clip/anonymized features to help us tune the detector" is a realistic ask for
    whoever builds the pitch/onset model, and must be preempted explicitly (no such call in the
    code, and ideally a smoke-test assertion that no network request fires while the mic is
    active), not just avoided by omission.
  - **Mic permission UX should mirror the camera's existing plain-language, at-point-of-use ask**,
    plus a one-line "analyzed on this device, never transmitted" affordance right at the permission
    prompt — this is also the fastest thing a school IT approver needs to see, not something to
    leave buried in a README.
  - **Holding a decoded PDF and a live mic buffer in memory at once is not a new privacy risk** —
    both are already in-process/in-memory-only with nothing written to disk; the only thing worth
    guarding against is a future engineer accidentally routing a raw audio buffer into
    localStorage (only settings belong there, per the existing corollary above).
  - Whether audio-based position-in-score estimation (matching played pitches/onsets to a known
    note sequence via something DTW-like) is even *feasible* client-side — as opposed to the
    existing "nudge a known schedule" onset correction — is the Audio DSP/OMR personas' call, not
    this persona's; note only that it would face the same "must recover actual note identity from
    something" problem that already made full pixel-based OMR infeasible, if the design ever needs
    to know *which* notes were played, not just *that* a note started.

**When to invoke:** early — at the *idea* stage of any feature that touches camera frames,
microphone audio, or the loaded PDF, before design work goes further. Cheaper to redirect a
feature idea here than to redesign it after building a server-dependent prototype.

**Open questions / future research:**
- Whether a **lightweight in-browser ML model** (WASM/TF.js-class, not a full cloud OMR pipeline)
  could someday narrow the gap on true rhythm extraction without breaking the client-side
  constraint — this is the condition under which the OMR Specialist's "infeasible" verdict (see
  persona 3) would be worth revisiting. **Sharpened to a specific, checkable trigger (2026-07-23),
  not just "a lightweight model turns up":** revisit if ONNX-exported OMR models (the `oemer`-class
  reference point already researched in persona 3's literature pass — see "Literature/prior-art
  research pass," staff/system-detection bullet) become small/fast enough to run acceptably under
  `onnxruntime-web`/WebGPU. As of that same research pass, `onnxruntime-web`'s own non-SIMD/
  non-threaded WASM runtime alone is ~10.5MB — comparable to this app's entire existing MediaPipe
  download — before even counting a real OMR model's own weights, so the condition is not yet met.

---

## 8. QA / Test Strategy Engineer

**Owns:** making sure detection-accuracy and interaction-logic changes are actually verified,
not just plausible-looking.
**Files:** every `*.test.js` colocated under `src/lib/`.

**What we've learned:**
- **Pure logic always gets colocated Vitest tests with synthetic fixtures** (`src/lib/*.js` +
  `*.test.js` next to it) — this is non-negotiable for anything in `src/lib/`, which exists
  specifically to hold dependency-free, testable logic separate from DOM-facing wiring.
- **DOM-facing / hardware-dependent changes get an ad hoc, session-driven Playwright-automated
  smoke check** (headless Chromium, screenshot + console-error check, real file inputs where
  relevant) via the `run` skill, when camera/wink features can't be meaningfully verified by unit
  tests alone and can't be manually driven by an agent without real hardware. **This is not a
  committed, repeatable test suite** — there is no `e2e/` directory, no Playwright dependency in
  `package.json`, and no e2e job in CI (confirmed 2026-07-19, see `docs/reviews/`, finding C5).
  It's a one-off verification technique available *during a working session*, not automated
  regression coverage; don't describe it as the latter in code comments or elsewhere in this file
  — a stale claim to the contrary in `liveTempo.js` sat undetected until an independent review
  caught it. **The `run` skill's Playwright path isn't always available, either** — confirmed
  2026-07-20: no `chromium-cli` and no installable Playwright browser binary in this session's
  sandbox. When that happens for a *rendering-pipeline* bug specifically (staff/barline/system
  detection — anything downstream of `page.render()`), a real headless Node render harness is a
  working fallback: `pdfjs-dist`'s `legacy/build/pdf.js` entry point plus the `canvas` npm package
  (installed ad hoc with `--no-save`, not a project dependency) renders real PDF pages to a real
  canvas outside a browser entirely, letting the *actual* detection functions run against the
  *actual* rendering pipeline's output — the same real-data discipline as the collapseThickness/
  pad=20/minFrac fixes above, just reached through a different door when the usual one is locked.
  See the OMR persona's "Juggling Clowns" system-grouping fix for a worked example (diagnosed via
  this exact technique, including a visual PNG crop of the suspect region for direct inspection).
  If durable e2e coverage is ever wanted, it needs to be built and committed as real
  infrastructure (a Playwright dependency + CI job), not assumed to already exist.
- **The most important lesson so far:** for algorithmic/detection work (staff detection, barline
  detection), a **synthetic-but-realistic fixture** (e.g. an actually-generated PDF with known,
  deliberately-placed barline positions, rendered through the real PDF.js pipeline) caught a real
  bug — the anti-aliased staff-line thickness issue (`collapseThickness`, see OMR persona) — that
  hand-written unit tests using idealized, already-clean synthetic data completely missed. The
  gap between "idealized synthetic input" and "real rendered output" is exactly where detection
  bugs hide. **Apply this to any future detection-accuracy work**: don't stop at clean synthetic
  fixtures; generate (or source) something that goes through the same rendering pipeline real
  input would.
- **When the user hands you a real, concrete example file, test against *that* file directly, not
  only a from-scratch synthetic one — do it early, and expect it to find things a synthetic
  fixture wouldn't.** Building the PDF-text-layer section-detection feature (see OMR persona)
  against the user's actual multi-part score (loaded through the real UI via Playwright's file
  chooser, then reading both the rendered DOM and the live module state for exact assertions)
  caught three real bugs a hand-built synthetic text fixture would very plausibly have missed
  entirely, because they came from font/glyph quirks specific to how real notation software
  exports PDF text — not something an agent would think to fabricate into a synthetic fixture:
  (1) a running-average row-merge letting hundreds of real glyph items chain-bridge two distinct
  text rows into one garbled string; (2) a one-off title-block word ("Score") structurally
  indistinguishable from a real repeating instrument label until position (not repetition) was
  used to tell them apart; (3) a bootstrap page silently matching against its own just-collected
  data. **General lesson, generalizing the synthetic-fixture lesson above: a real user-provided
  file is a *stronger* realism source than even a carefully-constructed synthetic one, because its
  quirks are exactly the ones you didn't think to construct.** When a real example file is
  available for a feature under development, prioritize testing against it directly, early —
  don't treat it as a nice-to-have final check after synthetic tests pass.

- **A new committed pattern (2026-07-22): `pdf-lib` (pure JS, zero native deps, now a
  devDependency) builds real PDF byte streams in memory at test time, parsed by the real
  `pdfjs-dist` pipeline — genuine committed regression coverage for text-layer-dependent logic,
  without needing the ad hoc `canvas` install this section previously relied on.** Confirmed
  `page.rotate`, `page.getViewport()`, and `page.getTextContent()` all work with **zero canvas
  dependency** in plain Node — only `page.render()` (actual pixel rendering) needs canvas/jsdom,
  which this project still deliberately doesn't add (see the OMR persona's Phase 1b write-up for
  the full reasoning). This closes part of the gap this section flagged below (no committed
  regression corpus) for the text-layer half of detection, without opening the door to committing
  real user sheet-music PDFs: fixtures are generated in-memory, never written to disk or committed
  as binary files, specifically so this repo's blanket `*.pdf` `.gitignore` rule (guarding against
  ever accidentally committing the user's real, copyrighted personal collection) never needs an
  exception. See `src/lib/realPdf.fixtures.test.js` for the concrete pattern — reuse it for any
  future text-layer-dependent detection work rather than re-deriving hand-typed `{str, x, y}` item
  arrays, which can't catch a real pdfjs API-shape regression the way a real parsed PDF can.
- **The `pageSystemsDetailed`/`kmeans2` gap-clustering logic got a second real-corpus-verified fix
  (2026-07-22, see OMR persona Finding 1) using the same "dump real data before touching code"
  discipline as the `collapseThickness`/`pad=20`/`minFrac` fixes above** — the recurring thread
  across every real detection bug fixed in this project so far: a threshold or consistency-check
  that looks reasonable in isolation can still be provably wrong (here, mathematically vacuous at
  one specific group-count) or silently miscalibrated, and the only way to find out is to look at
  the actual numbers a real file produces, not to reason from the code alone.

**A committed, repeatable Playwright-driven benchmark now exists (2026-07-23) — a deliberate,
scoped exception to the "Playwright is ad hoc only" stance above, not a reversal of it.**
`scripts/benchmark/{run,backfill,report}.mjs` (`playwright-core` now a real, saved
devDependency — the ad hoc-only rule stays true for the *actual* `npm test` unit suite, which
stays canvas/DOM-free and untouched) drives the real running app end-to-end (load a real PDF via
the `#file` input, Analyze, read the DOM) against a growing set of hand/agent-labeled ground-truth
JSON files under `benchmarks/ground-truth/` (built in parallel by a separate corpus-labeling
effort — see the OMR persona's own note on the real schema those files converged on), scores
per-file accuracy on four dimensions (section names, system count, measures-per-system, detected
BPM sequence), and writes a dated, commit-tagged snapshot under `benchmarks/snapshots/` —
`report.mjs` reads every snapshot and prints a trend table. `backfill.mjs` retroactively applies
today's scoring logic to ~6 hand-picked historical commits (via real `git worktree`s, each with its
own npm install + dev server) so the trend has more than one data point immediately. This directly
narrows the open question below for the pixel/rendering-dependent half specifically **once the real
ground truth is filled in and the benchmark is actually run** (not yet done as of this writing —
the real run is a deliberate follow-up step, kept separate from building the infrastructure itself).
- **Verified working end-to-end**, not just written: a placeholder ground-truth file plus the real
  ground-truth files already present mid-build were run through `run.mjs` (confirmed sane
  per-file/aggregate numbers, including the "not directly comparable" system-count-mismatch case
  correctly producing `null`/`false` rather than a misleading number), `report.mjs` (confirmed
  correct commit-date sorting across snapshots), and `backfill.mjs` (one real historical commit,
  `b58b58d`, smoke-tested through the full worktree-add → npm-install → dev-server → run.mjs →
  worktree-remove pipeline, snapshot correctly tagged with that commit's real historical date, no
  leftover worktree or listening process afterward) — all test snapshots and the placeholder
  ground-truth file were deleted afterward, leaving only the real, independently-produced
  ground-truth files this session found already in progress.
- **A genuine, Windows-specific tooling bug found only by actually running the tool**: `spawn()`ing
  `npm` (which resolves to `npm.cmd`, a shell shim, not a real executable) throws `EINVAL` on
  Windows unless `shell: true` — hit in both `devServer.mjs` (starting `npm run dev`) and
  `backfill.mjs` (running `npm ci`/`npm install` in a fresh worktree). `git`/`node` invocations,
  being real executables, needed no such fix. General lesson for any future cross-platform
  child-process tooling in this repo: a `.cmd`-shimmed command (anything installed as an npm
  global/local binary on Windows) needs `shell: true` (or an explicit `.cmd` suffix); a real `.exe`
  does not.

**Open questions / future research:**
- No current corpus of real (redacted/public-domain) band-part PDFs for regression testing
  detection accuracy over time — tests use generated fixtures, plus the one real user-provided
  file used ad hoc for the sections feature (see above). Worth considering a small checked-in set
  of public-domain engraved band parts (score-plus-parts *and* single-instrument-only PDFs, to
  cover the "no bootstrap page" gap noted in the OMR persona's open questions) if detection
  regressions become a recurring problem. The new `pdf-lib`-based in-memory fixture pattern above
  narrows this gap for text-layer logic specifically, but the pixel/rendering-dependent half (staff/
  barline detection) still has no committed real-PDF regression corpus, only literal-array unit
  tests plus ad hoc Playwright/canvas verification during a session. **Update (2026-07-23):** the
  new `scripts/benchmark/` tool above is the real committed-regression-tracking answer to this once
  the parallel ground-truth-labeling effort's corpus is complete and a real full run has been done
  (not yet, as of this writing) — it doesn't replace the `pdf-lib` in-memory fixtures (still the
  right tool for a fast, isolated unit test of one specific text-layer function) but does close the
  "detection regressions over time, tracked as a trend, across the WHOLE real corpus" gap this
  question originally flagged.

---

## 9. Feature Strategy & Research Lead

**Owns:** framing a new feature idea as a question worth spiking before it's worth building —
running (or delegating) the feasibility research, writing down the verdict, and setting realistic
v1 scope. This persona is the one that produced the "full OMR is infeasible client-side" and
"single global BPM, not per-system tempo changes" verdicts that every other persona now treats as
established.

**How this persona works:**
1. State the feature idea and the *specific* question that would kill or validate it (not "can we
   detect tempo" but "can we extract rhythm from rendered PDF pixels reliably enough to drive
   auto-scroll timing, staying 100% client-side").
2. Pull in the relevant domain personas (OMR, Audio DSP, CV, Applied Math) for what's already
   known — check this file first, it may already be answered.
3. Check the Privacy/Architecture persona's constraint and the Music Educator persona's
   audience-scoping *before* investing in a full feasibility spike — many ideas are killed or
   right-sized by those two alone, cheaper than a technical investigation.
4. Where a real spike is needed, do it, then **write the verdict back into this file** under the
   relevant persona (not just leave it in chat history) — the OMR-infeasibility and single-BPM
   decisions were previously only recoverable from session memory/chat history, which is exactly
   the gap this persona system exists to close.

**Known verdicts so far** (see linked personas for full detail):
- Full automatic OMR (rhythm/pitch from pixels) for auto-scroll: **infeasible client-side** —
  barline-counting + user-confirmed BPM is the shipped substitute. (Persona 3)
- Live tempo tracking: **onset-nudge against a trusted schedule**, not full beat-tracking —
  simpler and more robust. (Persona 4)
- Auto-scroll tempo model: **one global BPM per piece** (v1), not per-system tempo-change
  markers — matches the band-part audience's typical single-tempo pieces. (Persona 3, 6)
- Wink detection: **per-user calibrated thresholds**, not a fixed global threshold — needed
  because eye asymmetry/camera angle vary enough to break a shared default for some users.
  (Persona 1, 2)
- Score sections (splitting a full-score-plus-parts PDF into named, independently-scoped parts):
  **PDF text-layer extraction is feasible and shipped** — a fundamentally different, more
  tractable technique than pixel-based OMR (it's exact text extraction, not visual recognition),
  and works for any PDF exported from real notation software. This does *not* revisit the full-OMR
  verdict above; it's a different, easier problem that happens to solve a similar-looking need.
  (Persona 3)
- Time-signature reading via glyph shape-matching: **attempted, does not yet reach reliable
  accuracy — ships safely inert** (region-finding is correct and kept; digit classification
  against generic font glyphs isn't). Would need real music-engraving-font reference glyphs to
  reconsider, not a different algorithm. (Persona 3)
- Infrared (IR) camera-based gaze tracking: **declined — no web-platform API for camera spectrum
  or illuminator control, OEM-driver-dependent sensor exposure, MediaPipe untrained/unvalidated for
  IR, and no IR-webcam-class dataset exists to build a custom model from.** The professional-tracker
  accuracy gain is a controlled-illuminator hardware property, not a spectral one, so it's out of
  reach regardless of software effort absent that specific hardware condition. A separate, real
  next step exists on the *RGB* side (spike `webeyetrack`, an existing MIT-licensed browser gaze
  library) if accuracy improvement is still wanted. (Persona 1)
- **Audio score-following** (listening to the performer and deriving playback *position* from what
  they're actually playing, rather than nudging a pre-built schedule): **infeasible client-side —
  not a new investigation, a direct corollary of the existing full-OMR verdict above.** Score-
  following needs a symbolic pitch/onset reference sequence to align the live audio against; the
  only place that reference could come from is the loaded PDF, and extracting it (scanned *or*
  cleanly engraved) from pixels *is* the full-OMR problem already ruled out for staying 100%
  client-side (Persona 3) — this app has no MusicXML/MIDI side-channel, only the PDF. Reviewed
  2026-07-20 for the "play-along auto-scroll for a practicing band student" feature ask; killed by
  checking the OMR verdict + the Privacy persona's no-cloud constraint *before* spending any spike
  effort, exactly the cheap-filters-first sequencing this persona is supposed to apply. What
  *does* remain feasible and valuable, using the exact same onset-detection machinery already
  shipped: audio that only **corrects or gates a time-based clock that's already trusted**
  (shipped: the onset-nudge tempo trim) rather than deriving position from scratch — see Persona
  4's silence-auto-pause and count-in-calibration candidates for the concrete next v2 steps in that
  direction, both of which need no new signal, only new uses of data already collected.

**Cross-cutting triage of the 2026-07-19 Fable review** (see
[`docs/reviews/2026-07-19-fable-review.md`](reviews/2026-07-19-fable-review.md); A1/C1 already
fixed and merged before this triage). Full per-finding detail lives in that file and in each
owning persona's section — this is the prioritized punch list, not a restatement.

**Progress (2026-07-20): all of "do soon" shipped** — D3+D2, C2, E1, F3, A5(c), C5, B1, and F1
(bumped up from "do soon"/verify-first once the Privacy persona's own byte-size check below came
back favorable). Each has its own durable-finding bullet in its owning persona's section above;
this list is kept below as the historical record of what was triaged and why, not as an open TODO
— check each persona's section for current status rather than assuming anything below is still
outstanding.

**Progress (2026-07-23): all of "do eventually" also shipped** — F2, B2, A2, A3, A4, B4, D1, E2,
E3, and B3. Every entry below that heading is now struck through; nothing from this triage remains
open except what's explicitly listed under "skip / decline for now" (deliberately not planned) and
"low-priority future consideration" (blocked or intentionally deferred, not forgotten).

*Do soon (small, high-leverage, or fixes a documented-but-false safety property):*
- **D3** — auto-scroll's `systemBands` go stale after any resize/zoom with no invalidation; silent
  wrong-position playback is the feature's worst failure mode. Cheap fix (set `analyzed = false` +
  "layout changed, re-analyze" toast) ships now; fraction-based storage can follow later. Bundle
  with **D2** (undebounced re-entrant `renderAll()`) — same code path, same audit. **Update
  (2026-07-21): the "later" fraction-based storage shipped and removed the toast; a follow-on fix
  also made `analyzeScore()` render at a fixed resolution so detection no longer varies with window
  size/DPR — full write-up in persona D's durable-findings section above.**
- **C2** — disable `echoCancellation`/`noiseSuppression`/`autoGainControl` on the mic stream.
  Trivial, likely the single highest-value onset-quality fix available, do before considering C4.
- **E1** — default tab is Tempo while onboarding/README/default tracking type all lead with
  Eye/Wink; one-line default-tab fix.
- **F3** — wrap `loadPdf`'s rejection (corrupt/password PDFs) in the existing toast path; trivial.
- **A5(c)** — delete the duplicate `calibModelId()` definition (only one is imported); a real
  future drift risk for near-zero effort, not just a style nit.
- **C5** — fix `liveTempo.js`'s header comment claiming a Playwright e2e test that doesn't exist
  (no `e2e/` dir, no Playwright dep). Say what's actually verified today.
- **B1** — close persona 3/4's "note-head density could refine uniform-note-value assumption" open
  question as moot: `buildSchedule()` never depends on note values, only measure count × beats.
  Redirect any future note-head-detection effort toward barline false-positive discrimination
  instead, if it's ever built.
- **F1-verify** — before spiking self-hosting, just check the numbers: confirmed today that
  `camera.js` pulls WASM from `cdn.jsdelivr.net` and the model from
  `storage.googleapis.com/mediapipe-models`. Reviewer's 10-15MB estimate should be checked against
  actual bytes; if confirmed small, self-hosting under `public/models/` is genuinely Low effort
  and directly strengthens the privacy story. See "verdict revisit" below — this is the one finding
  from the review that argues with an existing persona verdict's *reasoning*, not just its scope.

*Do eventually (real value, but sized for a dedicated session or dependent on something above):*
- **F2** — ~~declarative settings registry. Not urgent today, but it's explicitly the mechanism the
  review says will produce the *next* E1/reading-band-class bug as more modes accumulate. Do this
  before adding another top-level mode/tab, not before.~~ **Done (2026-07-23)**:
  `src/settings.js` now has a single `registry` array (entries shaped `{ key, kind:
  'slider'|'toggle'|'value', get(), set(v), presence, wire() }`) replacing the four hand-synced
  places settings used to live in (`bind()`, `currentToggles()`/`applyToggles()`, each control's own
  `onclick`):
  - `key` is the exact pre-refactor persisted-JSON property name, kept identical on purpose — see
    the backward-compat note below.
  - `get()`/`set(v)` are the single place a setting's cfg/state field and its dependent DOM (button
    text/class, formatted readout, a `setCameraZoom()` call, etc.) are synced — the thing that used
    to be hand-duplicated between `applyToggles()` and each control's own click handler.
  - `presence` (`'always'|'boolean'|'string'|'finite'|'finiteOrNull'`) reproduces each field's
    original forward-compat guard exactly, so a save from before a field existed (pose/auto/
    tracking/winkStrength/bpm were all added after the toggles object's original shape) still leaves
    that field alone instead of clobbering it with a default — verified field-by-field against the
    pre-refactor code, this was the part most likely to introduce silent drift if gotten wrong.
  - `wire()` is only used by controls the user directly interacts with, and layers interactive-only
    side effects (calibration invalidation, a toast, `resetWinkTrackingState()`) on top of the shared
    `set()` — preserving the pre-refactor asymmetry where a live pose/tracking-type change
    invalidates calibration but a quiet restore (load/preset/reset) does not.
  `collectRaw`/`currentToggles`/`applyRaw`/`applyToggles`/preset save+load/every `.onclick` now all
  iterate this one array; `applyToggles()`'s hand-written per-field branches are gone, exactly as the
  review asked. One deliberate, disclosed behavior change came with the consolidation: "Load
  defaults" now resets every registered entry (toggles/tracking-type/wink/tempo included) instead of
  only the eight sliders it covered before — the alternative (special-casing "reset stops at the
  slider boundary") would have re-introduced exactly the kind of scattered exception this refactor
  exists to remove.
  **Backward compatibility with existing `localStorage` data was verified, not assumed:** the
  persisted shape (`{ s: {...sliders}, t: {...everything else} }` under `eyepagescroller.settings`,
  identical shape under `eyepagescroller.presets`) is byte-identical to what the pre-refactor code
  produced — same keys, same nesting — so real users' already-saved settings/presets need no
  migration. Confirmed live against a running dev server (a Playwright driver, ~76 checks, 0
  failures, 0 console errors) covering every slider/toggle/wink-threshold/tracking-type/bpm field
  updating its DOM on change, save-then-reload restoring every field, preset save/change/load
  restoring the preset's own values (not intervening edits), "Load defaults" resetting everything,
  and three constructed old-format `localStorage` blobs loaded directly: the genuinely-ancient flat
  pre-`{s,t}`-split format, a full pre-refactor `{s,t}` blob at non-default values, and a `{s,t}`
  blob missing fields added after the object's original shape — confirming each field's specific
  presence-guard, including that `winkClosedThreshold`/`winkGapThreshold` still force-reset to
  `null` unconditionally when absent, exactly like the pre-refactor code. This file has, and still
  has, no automated test coverage of its own (fully DOM/localStorage-coupled UI wiring), so this
  manual pass is the actual verification, not a supplement to one. Re-verified again after merging
  onto the current tree (this worktree was pinned at a stale ancestor commit missing the `winkIntent`
  channel and the `zm`-slider's `repositionAutoScroll` wiring added since — both were manually
  reconciled in during the merge and re-smoke-tested: drift-toggle persistence, defaults reset,
  preset round-trip, and wink-tracking-type UI hiding all confirmed working together, zero console
  errors).
- **B2** — ~~bundle Bravura's SMuFL time-signature glyphs to unblock digit classification. This
  isn't a new idea, it's persona 3's own documented reconsideration condition ("would need real
  engraving-font reference glyphs") being satisfied — low-medium effort, activates a feature that
  already ships inert with working plumbing.~~ **Done (2026-07-23)** — see persona 3's write-up
  above. Implemented and tested against real files alongside a tesseract-OCR spike; the honest
  result is that Bravura templates alone did NOT clearly improve grid-matcher accuracy over the
  old sans-serif fallback on real files tested, while OCR (once two unrelated real bugs were fixed)
  did — both now run, highest confidence wins.
- **A2** — ~~give `decide()` an explicit intent channel instead of wink synthesizing a fake gaze
  point. A1 is already patched, so this is prevention of a bug *class* recurring, not an active
  fix — worth doing before the next `decide()` geometry change, not urgently now.~~ **Done
  (2026-07-23)** — see persona 5's write-up above.
- **A3** — ~~free LOO-residual validation at `finishCalibration()` time; low effort, proactive
  recalibration prompts.~~ **Done (2026-07-23)** — see Applied Mathematician persona's write-up
  above.
- **A4** — ~~switch `irisTracking.js`'s blink gate to the blendshape signal persona 1 already
  concluded is better; low effort, closes a documented contradiction.~~ **Done (2026-07-23)** —
  see persona 1's write-up above.
- **B4** — ~~extract shared `detectStaffRows` to stop `analyzeScore()` and `systemDetection.js`
  duplicating tuned thresholds (the exact kind of constant the minFrac episode showed does
  drift).~~ **Done (2026-07-23)**: new `lib/inkScan.js` exports `detectStaffRows(isInk, aw, ah,
  opts)` — the exact staff-row ink-scan (isInk test, 0.45-width run-length row scan, 570-brightness
  threshold) that previously existed character-for-character in both `scoreAnalysis.js`'s
  `analyzeScore()` and `systemDetection.js`'s `detectSystems()` (Snap mode). Takes an `isInk(row,
  col)` callback + explicit width/height rather than a raw pixel array, matching the calling
  convention every other pixel-scanner in this codebase already uses
  (`timeSigDetection.js`'s `findInkBlobs`, `lib/measureNumberLocate.js`'s `locateInBand`) — both
  callers already build an `isInk` closure over their own pixel buffer before this scan runs, so the
  callback costs nothing. Only the shared pixel scan moved; each caller's own render setup and
  invocation trigger (automatic Snap-mode vs. heavier user-triggered Analyze) stayed untouched, as
  intended. **Verified as a true no-op**: the full 39-file corpus benchmark (`scripts/benchmark/
  run.mjs`) was run before and after via `git stash`, and every per-file field plus the aggregate
  summary matched byte-identical (39/39 scored, 0 errored, both runs) — confirming this is a pure
  refactor, not a behavior change. Snap mode (`src/systemDetection.js`, which has no automated test
  coverage) was separately verified by hand against a real corpus file: identical detected-system
  count and mark positions before/after. New `lib/inkScan.test.js` covers the extracted function
  with synthetic fixtures. Full suite (323 tests) and lint clean.
- **D1** — ~~One Euro filter for gaze smoothing. Solid argument, low-med effort, but no reported
  user complaint about the current EMA — do when touching `followLogic.js` next, not as a
  standalone session.~~ **Done (2026-07-23)** — see Real-Time Control Systems persona's write-up
  above.
- **E2** — ~~PageUp/PageDown pedal keycodes; low effort, real value for hardware this audience
  actually uses, just not urgent.~~ **Done (2026-07-23)** — see persona 5's write-up above.
- **E3** — ~~one baseline ARIA pass (toast `aria-live`, tab roles, label associations); cheap, no
  reason to keep deferring indefinitely, but not blocking anything.~~ **Done (2026-07-23)** —
  `index.html`: `role="tablist"` on `.tabBar`, `role="tab"`/`aria-selected`/`aria-controls` on
  `#tabTracking`/`#tabAutoScroll`, `role="tabpanel"`/`aria-labelledby` on their two panels,
  `role="status"`/`aria-live="polite"`/`aria-atomic="true"` on `#toast`, `role="alert"` on
  `#recal`, `aria-label` on the unlabeled `#presetName` text input, and `for`/`id` association on
  every settings-panel `<label>` that lacked it (~15 sliders/selects). `src/tabsUI.js`'s
  `selectTab()` now also flips `aria-selected` alongside the existing `.active` class toggle, so
  it stays in sync on every tab switch, not just at initial page load. Markup/attributes only — no
  behavior change, verified by the full existing suite passing unmodified.
- **B3** — ~~sharpen the full-OMR revisit trigger from "a lightweight ML model turns up" to the
  specific, checkable condition: ONNX-exported OMR models (the `oemer`-class reference point)
  becoming small/fast enough under `onnxruntime-web`/WebGPU. Documentation-only change to the
  verdict text below.~~ **Done (2026-07-23)** — see Privacy & Client-Side Architecture persona's
  "Open questions / future research" above.

*Skip / decline for now:*
- **C3** (cache `beatTimestamps` per schedule) — real but minor (GC churn only, not correctness);
  low value relative to even its own low effort given everything else queued.
- **C4** (spectral flux onset detection) — explicitly sequenced behind C2 in the review itself;
  don't touch the 54-line worklet until C2 is shipped and shown insufficient.
- **A5(a)/(b)** (throttle wink-panel DOM writes, avoid per-frame object allocation) — real but
  low-impact perf hygiene; fold into a future pass through that file rather than a dedicated task.
- **D5** (idle-loop DOM writes in `autoScrollController.tick()`) — same category as A5(a)/(b), fold
  in opportunistically.

*Low-priority future consideration (not backlog — no plan to act, revisit only if the trigger condition below actually occurs):*
- **D4** (viewport-lazy page rendering) — all pages currently render eagerly at full resolution;
  a 30-page combined "score + parts" PDF (the exact input the Sections feature invites) could reach
  hundreds of MB to >1GB of canvas backing store, enough to crash a tab on the low-end Chromebooks
  this app's real audience uses. Nobody has actually measured real memory usage on a real large
  file yet, and the fix (`IntersectionObserver`-driven render-near-viewport, with `analyzeScore()`
  needing to render pages transiently instead of reading already-rendered canvases) is Med-High
  effort — not worth building speculatively. Revisit only if a real crash/memory report ever
  surfaces on a real large file, and measure actual bytes before committing to the rewrite.
- **F4** (small MuseScore-generated fixture corpus, 4-6 PDFs, through the real render→detect
  pipeline in CI) — high leverage for detection-work velocity (catches OMR/staff/measure
  regressions — the class that already bit `collapseThickness`, the pad=20 fix, minFrac — though
  not D3/A1-class interaction bugs; if ever built, add one Playwright scenario that resizes/
  collapses the panel after Analyze and asserts the schedule invalidates or re-resolves correctly,
  since the static fixtures alone would not have caught D3). **Blocked, not just deprioritized
  (2026-07-23): generating the fixture PDFs needs the MuseScore CLI, which isn't installed on this
  dev machine.** Revisit if/when MuseScore is available (either installed here or fixture PDFs are
  supplied some other way) — not worth pursuing an alternate fixture-generation path speculatively
  in the meantime.

**Does this review suggest a documented verdict needs real revisiting?** One case, not more: **F1
(self-host MediaPipe) challenges the Privacy/Architecture persona's stated reasoning**, not just
its scope. The existing verdict's reasoning was "these are large ML assets, so CDN is an
acceptable tradeoff" — the review's claim (and the confirmed CDN URLs above) makes that an
empirical question the persona never actually measured. **Falsifiable question before any
self-hosting work:** what is the actual combined byte size of `face_landmarker.task` (float16) +
the `@mediapipe/tasks-vision` WASM bundle, and does serving them same-origin from GitHub Pages
(a) stay comfortably within GitHub's repo/Pages size norms and (b) actually eliminate the failure
mode described (school-network filtering of `storage.googleapis.com`/jsDelivr specifically,
distinct from GitHub Pages being blocked too, which would need a different mitigation entirely)?
If both check out, this is a scope refinement of the existing verdict (the constraint was always
"no frame/audio data leaves the machine," not "must use a CDN") rather than a reversal — but it
should be measured, not assumed, before the Low-effort estimate is trusted.

**Open questions worth spiking next** (candidate backlog, not commitments):
- **Play-along auto-scroll v2 (2026-07-20 feature review):** silence-triggered auto-pause and
  count-in tempo calibration (both spelled out under Persona 4's open questions) — the two
  concrete, low-risk next increments once real audio score-following was ruled out by corollary
  above. Suggested single spike to run first: feed a few real recordings of an actual band part
  played with intentional mid-passage stops through the existing onset detector, and confirm a
  silence threshold derived from the schedule's own beat length (~1.5-2x one measure) doesn't
  false-trigger on ordinary written rests — cheap (no new detector), and the one piece of this
  bundle that's a genuine empirical unknown rather than a corollary of an existing verdict.
- In-browser lightweight ML for rhythm extraction (would revisit the OMR verdict — see Privacy
  persona's open question).
- Repeat signs / D.S. al Fine handling in auto-scroll's schedule (currently unhandled — see
  Music Educator persona).
- A checked-in corpus of real band-part PDFs for regression testing (see QA persona), including
  parts-only PDFs with no combined score to bootstrap section names from (see Persona 3's open
  questions).
- Bundling/rendering real music-engraving-font reference glyphs for time-signature digit
  matching — the specific, identified blocker for activating that detector (Persona 3).

---

## 10. Technical Writer / Documentation

**Owns:** the gap between what Sightline actually does and what its user-facing docs — chiefly
`README.md`, the only doc a real end user (a band student, a director, a parent setting it up)
ever reads — say it does. Not a code owner; a standing "does this describe the real product,
clearly, for the actual reader" check, the documentation counterpart to persona 6's "does this
match our real user" check.

**Why this persona exists:** this project ships fast and iteratively, and a shipped feature or a
lifted caveat doesn't automatically update the README — confirmed as a *recurring*, not
hypothetical, problem: the README described "Live tempo correction" as "(experimental)" well
after real use confirmed it works reliably (2026-07-24), and never mentioned the Sections
picker or the time-signature auto-detection suggestion at all, despite both shipping and being
covered elsewhere in this file. Both were caught only because a human noticed, not because
anything routinely re-checked the docs against the code.

**How this persona works, when reviewing a doc:**
1. Read the actual current source for anything the doc claims or omits — `index.html`'s panel
   copy, `src/autoScrollUI.js`, the relevant `src/lib/` module — rather than trusting the doc's
   own existing framing just because it reads confidently.
2. Write for the actual audience (persona 6): a high-school band student and the adults around
   them, not a developer. Engineering jargon, raw internal metric/module names, and hedge-heavy
   caveats that leaked in from a dev conversation read as noise to this reader.
3. Any number presented needs the caveat that makes it honest (population size, partial
   comparability) — the same discipline the Applied Math persona already holds internal stddev
   reporting to (section 2); this persona's job is applying that same honesty externally, in
   plainer language, not dropping it for simplicity's sake.
4. Don't manufacture edits to an already-accurate, already-clear section, and don't upgrade tone
   ("gently nudges" → "precisely corrects") without the evidence to back the stronger claim.

**Durable findings so far:**
- **(2026-07-24) First review pass**: added the benchmark accuracy comparison table (baseline
  vs. current snapshot, both dimensions' real sample sizes disclosed) requested below, and did a
  full accuracy/clarity pass over `README.md` against current source — see the file's own history
  for what changed as a result.
- **(2026-07-24) Second pass, same day — a recurring shape of gap found: docs that describe only
  the Iris-tracking half of a dual-mode feature, silently leaving Wink tracking (the *default*
  mode) uncovered.** Cross-checked every concrete README claim against `index.html`'s actual
  panel markup/labels and `src/autoScrollUI.js`/`src/settings.js`/`src/scoreAnalysis.js`/
  `src/accuracyTest.js`/`src/winkCalibrate.js`/`src/lib/followLogic.js`. Findings, all fixed in
  `README.md` this pass:
  - **A whole shipped feature had zero mention anywhere: "Calibrate wink sensitivity"**
    (`src/winkCalibrate.js`, the `winkCalibrateBtn` next to the Wink scroll strength slider) —
    measures a user's own resting/winking eye scores and derives personal thresholds
    (`lib/winkCalibration.js`), the direct Wink-tracking analog of Iris tracking's 9-point
    calibration. Added to the wink bullet in "Using Sightline" and as a new Troubleshooting entry
    ("Wink tracking misses winks, or a blink triggers a page turn by mistake").
  - **Every existing Troubleshooting/"Getting the best accuracy" entry about drift, Check
    accuracy, Head-pose comp, and Recenter is actually Iris-tracking-only** (`index.html`/
    `settings.js`'s `applyTrackingTypeUI()` hides `testBtn`/`recenterBtn`/`driftBtn`/
    `rightZoneRow`/`sheetMarginRow`/`poseToggle` outright whenever `trackingType === 'wink'`) —
    but the prose never said so, so a Wink-mode user (the default!) hit dead-end advice
    referencing controls they don't have. Tagged each affected line `(Iris tracking)` rather than
    rewriting the sections; a Wink-specific troubleshooting entry (above) fills the gap that left.
  - **The Tuning table named one slider "Motion smoothness," but the actual on-screen label is
    "Eye-tracking smoothing"** (`index.html`'s `<label for="sm">`) — fixed to match the real UI
    text; a user searching the panel for the table's own wording wouldn't have found it.
  - **"Ignore glances past the sides" (`mg`/`sheetMargin`, in `index.html`'s Advanced disclosure)
    had no README mention at all** despite being a real, working tunable (rejects gaze near the
    screen edges as "looking away" in `lib/followLogic.js`) — added as a Tuning table row, plus a
    short intro sentence noting some rows are Iris-only and/or live under "Advanced" rather than
    loose in the main panel (this applied silently to the pre-existing "Turn the page when my
    eyes reach…" row too, which was never marked either).
  - **Auto-scroll's automatic tempo adoption was undocumented.** `scoreAnalysis.js` reads a
    score's own printed tempo marks and overwrites `state.autoScroll.bpm` (and shows a "Tempo
    changes detected… applied automatically" banner) with **no confirmation step** — unlike the
    time-signature suggestion, which is always opt-in. The Quick Start walkthrough described
    setting the Tempo slider as step 3 without ever warning that step 4 (Analyze) can silently
    overwrite it. Added a sentence to step 4 explaining the auto-adoption and that a wrong-looking
    detected change just means "misread — reset the slider yourself," rather than exposing the
    benchmark's `totalBpmSpuriousCount` (0 → 42 across the corpus in this same window, per the
    benchmark table's own underlying snapshots) as a raw number to this audience — the plain-
    language caveat carries the same honesty the Applied Math persona's stddev-disclosure
    precedent asks for, without the jargon.
  - **Editorial-call check requested for this pass: agreed, no change** — leaving
    `totalBpmSpuriousCount` out of the benchmark table itself (available via the linked
    `npm run benchmark:report` / raw snapshot JSON) is the right call; the plain-language caveat
    added to the Auto-scroll walkthrough above is where that honesty belongs for this audience,
    not a second number bolted onto an already-dense table.
  - **Not changed, flagged only:** the Auto-scroll numbered walkthrough's step order (3. set
    tempo/time-sig, 4. Analyze) doesn't match `index.html`'s actual top-to-bottom panel order
    (the Analyze button sits *above* the tempo/time-signature sliders in the DOM). Left alone
    because it's not a factual error — `autoScrollUI.js` lets the tempo/time-signature sliders be
    set either before or after Analyze with a live schedule rebuild either way — and reordering a
    working panel's layout is outside this persona's mandate (documentation accuracy, not UI
    layout). Worth a look if `index.html`'s panel is ever reordered for other reasons.
  - **General lesson for future passes:** when a feature has two parallel modes (here, Iris vs.
    Wink tracking) and one is materially richer in tooling (calibration, drift, accuracy testing)
    than the other, check every generic-sounding doc sentence for a hidden mode assumption —
    `applyTrackingTypeUI()`'s hide-list in `settings.js` is the fastest single place to confirm
    which controls are actually mode-specific before writing (or trusting existing prose) about
    them as if they were universal.

**Open questions / future research:**
- Whether a lightweight CI check (e.g. grepping the README for feature names that don't appear in
  `index.html`, or vice versa) could catch doc/code drift automatically rather than relying on a
  human or this persona noticing on demand — not attempted, no evidence yet that manual review
  cadence is actually insufficient, so not worth building speculatively (same "don't build ahead
  of a demonstrated need" discipline persona 9 already applies elsewhere).

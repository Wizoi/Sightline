# Sightline development personas

This is the roster of domain-expert "personas" for Sightline feature work. Each one owns a
slice of the problem (music notation, applied math, computer vision, audio, real-time control,
the actual end user, the privacy constraint, test strategy, and feature scoping), and each entry
below captures **what we've already learned** in that domain — so a future feature discussion can
start from "here's what we know" instead of re-deriving it.

Each persona also exists as an invokable Claude Code subagent under
[`.claude/agents/`](../.claude/agents/) — e.g. "ask the OMR persona whether X is feasible" can be
a literal subagent call, not just a mental frame. Update **this file** whenever a persona's
domain produces a durable finding (a feasibility verdict, a technique that worked, a dead end);
the subagent files stay thin and point back here.

**To get all 9 personas' take on a feature or change at once** (impact analysis, or an explicit
decline if it doesn't touch their domain), use the `/persona-review` skill
([`.claude/skills/persona-review/`](../.claude/skills/persona-review/)) — it fans the feature out
to all 9 subagents in parallel and synthesizes one combined report, and prompts to write any
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
- Confidence/uncertainty estimates on the calibration fit (e.g. leave-one-out residuals across
  the 9 points) to proactively suggest recalibration, rather than only reacting to a changed
  camera/window fingerprint (`calibMismatch`).

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
    result is at worst a visible annoyance, not silent corruption.
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
  **partially addressed (2026-07-21):** it now still splits, via the title-independent printed-
  measure-number-reset signal (`detectMeasureNumberResets`) instead of instrument names, just with
  generic `Section N` names rather than real ones. Real instrument names for this case would still
  need a different bootstrap source than page 1 (e.g. each part's own title page, read
  independently) — not attempted, since the generic-name fallback already fixes the more serious
  half of this gap (measure counts no longer bleeding across an undetected part boundary).

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
  category already documented above, not evidence of a second bug, and is left as an open staff-
  detection-density gap rather than loosened further (loosening the *grouping* tolerance to paper
  over a *detection* gap risks silently re-accepting genuinely inconsistent pages, which this
  project's conservative-by-design philosophy explicitly rejects — see the existing "falls back to
  per-staff" rationale a few paragraphs above). **Verified with a real git-stash-style before/after
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
  persona 3) would be worth revisiting.

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

**Open questions / future research:**
- No current corpus of real (redacted/public-domain) band-part PDFs for regression testing
  detection accuracy over time — tests use generated fixtures, plus the one real user-provided
  file used ad hoc for the sections feature (see above). Worth considering a small checked-in set
  of public-domain engraved band parts (score-plus-parts *and* single-instrument-only PDFs, to
  cover the "no bootstrap page" gap noted in the OMR persona's open questions) if detection
  regressions become a recurring problem. The new `pdf-lib`-based in-memory fixture pattern above
  narrows this gap for text-layer logic specifically, but the pixel/rendering-dependent half (staff/
  barline detection) still has no committed real-PDF regression corpus, only literal-array unit
  tests plus ad hoc Playwright/canvas verification during a session.

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
- **F4** — small MuseScore-generated fixture corpus (4-6 PDFs) through the real render→detect
  pipeline in CI. High leverage for detection-work velocity, but scope it honestly: as designed
  it catches OMR/staff/measure regressions (the class that already bit `collapseThickness`, the
  pad=20 fix, minFrac), not D3/A1-class interaction bugs. If built, add one Playwright scenario
  that resizes/collapses the panel after Analyze and asserts the schedule invalidates or
  re-resolves correctly — that's the part that actually generalizes D3's lesson into a regression
  net; the static fixtures alone would not have caught D3.
- **F2** — declarative settings registry. Not urgent today, but it's explicitly the mechanism the
  review says will produce the *next* E1/reading-band-class bug as more modes accumulate. Do this
  before adding another top-level mode/tab, not before.
- **B2** — bundle Bravura's SMuFL time-signature glyphs to unblock digit classification. This
  isn't a new idea, it's persona 3's own documented reconsideration condition ("would need real
  engraving-font reference glyphs") being satisfied — low-medium effort, activates a feature that
  already ships inert with working plumbing.
- **A2** — give `decide()` an explicit intent channel instead of wink synthesizing a fake gaze
  point. A1 is already patched, so this is prevention of a bug *class* recurring, not an active
  fix — worth doing before the next `decide()` geometry change, not urgently now.
- **A3** — free LOO-residual validation at `finishCalibration()` time; low effort, proactive
  recalibration prompts.
- **A4** — switch `irisTracking.js`'s blink gate to the blendshape signal persona 1 already
  concluded is better; low effort, closes a documented contradiction.
- **B4** — extract shared `detectStaffRows` to stop `analyzeScore()` and `systemDetection.js`
  duplicating tuned thresholds (the exact kind of constant the minFrac episode showed does drift).
- **B5** — per-system beats-per-line override for the confirmed real mixed-meter case (Alto
  Clarinet 5/8→7/8→3/4). Real feature work, not a bug fix; needs its own UI design pass.
- **D1** — One Euro filter for gaze smoothing. Solid argument, low-med effort, but no reported
  user complaint about the current EMA — do when touching `followLogic.js` next, not as a
  standalone session.
- **E2** — PageUp/PageDown pedal keycodes; low effort, real value for hardware this audience
  actually uses, just not urgent.
- **E3** — one baseline ARIA pass (toast `aria-live`, tab roles, label associations); cheap, no
  reason to keep deferring indefinitely, but not blocking anything.
- **B3** — sharpen the full-OMR revisit trigger from "a lightweight ML model turns up" to the
  specific, checkable condition: ONNX-exported OMR models (the `oemer`-class reference point)
  becoming small/fast enough under `onnxruntime-web`/WebGPU. Documentation-only change to the
  verdict text below.

*Skip / decline for now:*
- **D4** (viewport-lazy page rendering) — real risk for the sections feature's large-PDF case, but
  Med-High effort and the review's own suggestion is right: measure actual memory on a real
  30-page score-plus-parts PDF before committing to an `IntersectionObserver` rewrite. Don't build
  this speculatively.
- **C3** (cache `beatTimestamps` per schedule) — real but minor (GC churn only, not correctness);
  low value relative to even its own low effort given everything else queued.
- **C4** (spectral flux onset detection) — explicitly sequenced behind C2 in the review itself;
  don't touch the 54-line worklet until C2 is shipped and shown insufficient.
- **A5(a)/(b)** (throttle wink-panel DOM writes, avoid per-frame object allocation) — real but
  low-impact perf hygiene; fold into a future pass through that file rather than a dedicated task.
- **D5** (idle-loop DOM writes in `autoScrollController.tick()`) — same category as A5(a)/(b), fold
  in opportunistically.

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

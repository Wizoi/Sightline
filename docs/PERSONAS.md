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

**Open questions / future research:**
- Whether iris landmarks alone (without full FaceLandmarker) could reduce model size/load time —
  not investigated; MediaPipe's face-landmark + WASM bundle is a large first-load fetch from
  Google's CDN (see Privacy/Architecture persona for why it isn't self-hosted).
- Robustness under glasses glare / low light beyond what "Check accuracy" already surfaces.

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

**Open questions / future research:**
- Repeat signs / codas / D.S. al Fine and their effect on auto-scroll's linear schedule — out of
  v1 scope, unaddressed.
- Whether note-head density (rather than just barline count) could refine the "assume uniform
  note values" approximation without tipping into full OMR.
- Bundling or rendering real music-engraving-font reference glyphs (vs. a generic system font) for
  time-signature digit matching — the specific next step that would make that detector reliable
  enough to activate, if picked back up.
- A PDF that's *only* individual parts with no combined full score first has no bootstrap page to
  collect known instrument names from, so its parts won't be auto-split into sections — untested
  how common this is for the real target audience's typical downloads (see Music Educator
  persona); may be worth a fallback (e.g. bootstrap from *any* page's repeated title pattern, not
  just page 1) if it turns out to be common.

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

**Open questions / future research:**
- Pitch/onset confusion in polyphonic instruments (piano, guitar chords) — current detector is
  tuned toward monophonic band instruments (the primary audience); untested against chordal
  playing.
- Whether onset detection could also drive **wink/gaze-independent** page turns (i.e., a third
  hands-free mode driven purely by listening) — not attempted; would need much more robust
  beat-position tracking than the current "nudge a known schedule" approach provides.

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

**Open questions / future research:**
- No current handling for **duet/ensemble parts with cues** (small cue notes from another
  instrument) — unclear how they'd interact with barline-based measure counting; likely fine
  since cues don't usually add extra barlines, but untested.
- Orchestral/piano users are explicitly a secondary audience, not unsupported — worth periodically
  checking that secondary-audience support hasn't silently regressed rather than actively
  investing in it.

---

## 7. Privacy & Client-Side Architecture Engineer

**Owns:** the "everything runs in the browser, nothing is ever uploaded" constraint, and vetting
every new feature idea against it before it gets designed.
**Files:** whole-app constraint — no `src/` file is exempt; most visible in `README.md`'s privacy
section and the absence of any server/backend in the project.

**What we've learned:**
- This is a **hard constraint, not a preference** — it has already ruled out a concrete feature
  direction (sending pages to a cloud OMR service for full rhythm/pitch extraction, which would
  have made accurate auto-scroll tempo detection much easier). Any future feature proposal that
  implies "send the score/audio/video to a server" needs a client-side-only alternative or it
  doesn't ship, no matter how much easier the server-side version would be.
  It's also why MediaPipe's face model and WASM runtime are fetched from Google's CDN rather than
  self-hosted/bundled: those are large ML assets, and the tradeoff (needing internet on first
  load only, browser-cached after) was judged acceptable since inference itself still happens
  entirely on-device — no frame or audio data ever leaves the machine, only the (large,
  non-personal) model weights come in.
- Corollary for calibration/settings data: it's stored **only in the browser** (no account, no
  sync) — that's a feature ("close the tab and nothing is kept except your saved settings"), so
  any new persisted setting should default to local storage, not assume a backend will ever
  exist.

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
**Files:** every `*.test.js` colocated under `src/lib/`; the Playwright-smoke-test pattern for
DOM-facing changes (see the `run` skill).

**What we've learned:**
- **Pure logic always gets colocated Vitest tests with synthetic fixtures** (`src/lib/*.js` +
  `*.test.js` next to it) — this is non-negotiable for anything in `src/lib/`, which exists
  specifically to hold dependency-free, testable logic separate from DOM-facing wiring.
- **DOM-facing / hardware-dependent changes get a Playwright smoke test** (headless Chromium,
  screenshot + console-error check) via the `run` skill pattern, since camera/wink features
  can't be meaningfully verified by unit tests alone and can't be manually driven by an agent
  without real hardware.
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

**Open questions / future research:**
- No current corpus of real (redacted/public-domain) band-part PDFs for regression testing
  detection accuracy over time — tests use generated fixtures, plus the one real user-provided
  file used ad hoc for the sections feature (see above). Worth considering a small checked-in set
  of public-domain engraved band parts (score-plus-parts *and* single-instrument-only PDFs, to
  cover the "no bootstrap page" gap noted in the OMR persona's open questions) if detection
  regressions become a recurring problem.

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

**Open questions worth spiking next** (candidate backlog, not commitments):
- In-browser lightweight ML for rhythm extraction (would revisit the OMR verdict — see Privacy
  persona's open question).
- Repeat signs / D.S. al Fine handling in auto-scroll's schedule (currently unhandled — see
  Music Educator persona).
- A checked-in corpus of real band-part PDFs for regression testing (see QA persona), including
  parts-only PDFs with no combined score to bootstrap section names from (see Persona 3's open
  questions).
- Bundling/rendering real music-engraving-font reference glyphs for time-signature digit
  matching — the specific, identified blocker for activating that detector (Persona 3).

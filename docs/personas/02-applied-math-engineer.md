# 2. Applied Mathematician / Numerical Methods

[← Back to persona roster](../PERSONAS.md)


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

**Item A3's follow-up, shipped (2026-07-24): stop collapsing each calibration dot's ~550ms of
raw samples to one median row before fitting — feed every sample as its own labeled row.**
- **The gap this closed:** `runCalibration()` (`src/calibration.js`) was capturing ~15-20 raw
  samples per dot over its 550ms hold, then throwing ~98% of them away (`median()` down to one
  row) before the 7-parameter ridge fit ever saw them. Every discarded sample already carried a
  real, known label (that dot's `sx,sy`) — free additional data, not requiring any new UI or
  collection time from the student.
- **What changed, and what deliberately did NOT:** `runCalibration()` now pushes every sample in a
  dot's capture window (subsampled evenly, cap 60/dot, purely a safety bound against a
  pathologically high-framerate camera — a typical webcam never gets near it) as its own
  `{sx, sy, rx, ry, bH, bV, pointId}` row, `pointId` being which of the 9 dots it came from.
  `fitCalibration`/`looResiduals`/`calibrationQuality` (`src/lib/calibrationModel.js`) all group by
  `pointId` via one shared internal helper — **when `pointId` is absent (every pre-existing
  caller/test, one row per dot), each row falls back to being its own singleton group, which is
  mathematically identical to the old behavior.** This was verified, not assumed: the entire
  pre-existing 323-test suite passed unchanged after this change, with zero test edits needed.
- **Leave-one-*point*-out, not leave-one-sample-out — reasoned explicitly, not defaulted to:**
  with many rows per dot, naively holding out one *row* at a time (as the old per-row LOO
  effectively did, back when each row was already a whole dot) would mostly just re-measure how
  well the model fits data it has already seen dozens of near-identical neighbors of — it would say
  almost nothing about generalizing to an unseen fixation, which is the entire reason LOO exists
  here. `looResiduals` now groups by `pointId` and holds out **every row belonging to a dot at
  once**, refits, and evaluates the held-out dot's own median reading against the true target —
  the direct continuous-data analog of "leave one calibration dot out," preserving exactly what A3
  was for.
- **Ridge lambda scaling — derived, not re-tuned by feel:** the original `lambda=0.05` was chosen
  for exactly one (already-denoised) row per point. Ridge solves
  `(XᵀX + λI)β = Xᵀy`; feeding `m` near-duplicate noisy samples per point instead of one scales
  `XᵀX` by roughly `m`, which — with a *fixed* λ — silently dilutes the regularization-to-data-fit
  ratio by that same factor (more samples per dot, from a higher-framerate camera, would mean
  progressively *less* effective regularization, for no principled reason). `effectiveLambda()`
  scales λ by `(total rows / distinct points)` before fitting, which is exactly `m`, restoring the
  original per-point regularization strength regardless of how many samples a session happens to
  produce. With the old one-row-per-point regime this ratio is exactly 1 — a no-op, so this is a
  correctness fix for the new regime, not a re-tune of the constant itself. **Not yet validated
  against real many-sample sessions** (no such corpus exists) — same "reasoned, not blindly tuned"
  discipline as `gridSpacingThreshold`'s own honesty note above.
- **Accuracy evidence — measured, and reported honestly rather than oversold:** a seeded synthetic
  simulation (mildly nonlinear ground-truth rx/ry↔sx/sy relationship, Gaussian per-sample noise,
  scored against held-out test points distinct from the 9 calibration dots, 40 seeds per
  condition) showed a **small but consistently real** improvement: mean held-out RMS error dropped
  from the old median-collapse baseline in the large majority of seeds at every sample-count/noise
  level tried (e.g. ~3-7% relative RMS reduction with 16 samples/dot; new-beats-old in
  34-38 of 40 seeds depending on the noise level). The effect was **largest at very low sample
  counts** (4/dot: new beat old in 38/40 seeds) and **smallest/near-a-coinflip at very high sample
  counts** (60/dot: 27/40) — consistent with the mechanism being "the ridge fit uses the real noise
  distribution instead of a per-column median summary," which matters most when the median itself
  had little to average over. **This is a real, measured, modest win, not a large one — say so
  plainly rather than overclaiming.** The bigger, more clearly-established benefit of this change
  is architectural: LOO validation is now a genuine test of generalizing to an unseen dot trained
  on the SAME kind of noisy raw data the deployed model will actually be fit on, rather than on an
  idealized 9-exact-point regime that could hide a poor fit.
- **A related, deliberately-investigated question that came back negative, also worth recording
  honestly:** does the new grouped LOO *detect a moderately-biased dot* (a systematic ~0.05-0.08
  offset on one dot, smaller than the existing corruption test's dramatic +0.4) any better than the
  old per-row LOO did? Tested via the same synthetic harness: **no measurable difference** — both
  old and new LOO detected such moderate biases identically (0/60 seeds at a bias below the
  existing `gridSpacingThreshold` cutoff, 60/60 once the bias approached that cutoff, for *both*
  approaches). The `poor`-flagging *sensitivity* to a systematically-biased dot is set by
  `gridSpacingThreshold`, not by how many samples back each row — item 1 doesn't change that
  behavior, and shouldn't be expected to. Its real benefit is the accuracy/fidelity points above,
  not sharper bad-dot detection.
- **Verified:** 5 new colocated unit tests in `src/lib/calibrationModel.test.js` (many-samples
  grouping, `pointId`-aware LOO producing exactly one residual per distinct dot rather than per
  row, corrupting a whole dot's sample cluster still gets flagged, and the "too few distinct dots"
  floor now correctly counts *dots* rather than raw row count once a dot can carry many rows).
  Full suite: `npm test` — 338 passed (was 323; +15 new incl. the per-eye-weighting tests below,
  0 regressions). The accuracy/sensitivity claims above came from a throwaway (not committed)
  seeded synthetic harness run via `node`, importing the real `calibrationModel.js` directly —
  reproducible from the numbers/methodology described here, not just asserted.

**Item 3's math core (smooth-pursuit calibration) — jointly owned with the Gaze/CV persona; see
that doc for the UI/capture-wiring side. Recorded here because two real numerical dead ends were
hit and fixed while building `src/lib/pursuitCalibration.js`, and the general lesson (LOO doesn't
port to continuous data unchanged) belongs with this persona's other LOO/validation work above.**
- **Dead end 1: picking the smooth-pursuit lag by refitting per candidate lag and comparing LOO
  residual (the natural thing to reach for, since item 1 just built exactly that machinery)
  does NOT reliably recover the true lag.** Confirmed with a seeded synthetic trace (known fixed
  lag + additive Gaussian noise, no other confound): the fit's LOO residual was *monotonically
  worse* moving away from lag=0 even when the true lag was 0.15s — i.e. it consistently favored the
  WRONG lag. Reasoned explanation: a smooth periodic (Lissajous) trajectory means a wrong lag
  doesn't scramble the (rx,ry)→(sx,sy) relationship into something obviously bad, it just
  reparameterizes it into a different, still-smooth, still-fittable relationship (a small
  time-shift of a periodic signal resembles another phase of a similar-looking signal) — the
  quadratic ridge model has enough flexibility to fit several wrong-lag hypotheses almost as well
  as the correct one. **Fix:** cross-correlate the raw measured rx(t)/ry(t) time series against the
  target's own x(t-lag)/y(t-lag) series for each candidate lag and pick the lag maximizing Pearson
  correlation (`estimateLag` in `pursuitCalibration.js`) — the same style of signal (trajectory-vs-
  trajectory correlation, not downstream fit-quality comparison) the actual "Pursuits" eye-tracking
  literature uses. Confirmed with the same synthetic trace: correlation cleanly peaks at the true
  lag (e.g. 1.999 at the true 0.15s vs 1.888 at 0s and 1.887 at 0.3s — a real, non-plateau peak),
  and using this estimated lag gives measurably better held-out RMS than a naive zero-lag
  assumption (a concrete evidence-based test in `pursuitCalibration.test.js`, not an assertion).
- **Dead end 2, still open (not resolved this session): reusing `looResiduals`/grid-spacing-style
  quality gating for a continuous trajectory over-flags good fits as "poor."** Grouping by
  time-segment (the trajectory analog of "one dot") and holding out a whole segment at a time
  — structurally the right instinct, mirroring item 1's leave-one-*point*-out reasoning — still
  produced `poor: true` almost universally in testing (checked across 3-10 segments), even for a
  fit independently shown to generalize well by the correlation/held-out-RMS test above. Likely
  cause, reasoned but not yet proven: unlike the 9-dot grid, where the 8 remaining points after
  holding one out still surround it from every side, holding out one arc of a Lissajous trajectory
  with only ~1-1.5 pattern repeats over 10s can remove the only near-visit to a region of the
  screen (e.g. a corner), turning that "held-out" check into extrapolation rather than
  interpolation — a structurally harder validation problem than the discrete grid, not a threshold
  that just needs retuning. **Consequence:** `pursuitQuality()` is shipped as a diagnostic only
  (real numbers, kept for future research) and is explicitly NOT wired to any user-facing
  "recalibrate" gate the way `calibrationQuality` gates the 9-dot flow — a documented, open
  problem, not swept under the rug. Whoever picks this up next should look at either (a) a
  fundamentally different validation approach for continuous trajectories (e.g. k-fold over
  random, non-contiguous sample subsets rather than contiguous time-arcs) or (b) a trajectory
  design with enough genuine repeat-coverage that holding out one arc doesn't remove a screen
  region's only representation — both need real experimentation, not a quick constant retune.
- **Verified:** 13 colocated unit tests in `src/lib/pursuitCalibration.test.js` covering the
  trajectory bounds/clamping, segment indexing, the lag-estimation dead-end fix (exact + noisy
  lag recovery, peak-not-plateau correlation), the end-to-end fit, the evidenced
  naive-vs-corrected-lag RMS comparison, and — deliberately kept rather than deleted — a
  "[known limitation]" regression-pin test that documents dead end 2 stays true so it can't
  silently regress into forgotten technical debt. Full suite: `npm test` — 351 passed (was 338;
  +13 new, 0 regressions).


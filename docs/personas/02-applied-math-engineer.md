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


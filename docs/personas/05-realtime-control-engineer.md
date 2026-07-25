# 5. Real-Time Control Systems / Interaction Designer

[← Back to persona roster](../PERSONAS.md)


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


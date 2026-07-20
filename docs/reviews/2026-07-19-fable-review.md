# Independent review — Fable model, 2026-07-19

An independent critical review of Sightline's assumptions, methods, and practices, run with the
Fable model (via a `general-purpose` agent primed with the full contents of
[docs/PERSONAS.md](../PERSONAS.md) plus a fresh read of the actual source). Scope: fresh scrutiny,
explicitly invited to disagree with existing verdicts where it had a technical basis to. Findings
below are as generated; not yet triaged or actioned. See each persona's section in PERSONAS.md for
the prior context this review was reacting to.

---

## Executive summary

1. **A real, reachable bug in the default tracking mode:** wink tracking's synthesized gaze point is clamped to `uy ≥ 0.02`, but `followLogic.decide()`'s per-direction dead-zone cap guarantees only an 8 px trigger sliver above a top-positioned band — so with plausible slider settings (band position ≤ dead-zone size, e.g. both at 20%), a left wink can *never* scroll up. This is exactly the "sliders interact multiplicatively" bug class persona 5 documented, re-introduced in the wink path because it duplicates the dead-zone geometry instead of sharing it.
2. **Self-host the MediaPipe model + WASM instead of Google/jsDelivr CDNs.** The assets are single-digit-to-low-tens of MB — well within GitHub Pages limits — and the target audience (high-school students, often on filtered school networks that block third-party CDNs) is the audience most likely to hit a blocked first load. It also strengthens the privacy story to "zero third-party requests."
3. **Auto-scroll geometry silently goes stale after any resize/zoom/panel-collapse:** `analyzeScore()` stores `systemBands` in absolute document pixels, `renderAll()` rebuilds the page at new dimensions, but `analyzed` stays true — Start then scrolls/highlights wrong positions with no warning. Store page-relative fractions and recompute at use time.
4. **The live-tempo "implausible onset" safety gate is dead code:** `nearestBeatTime` over a uniform beat grid can never return an error larger than half a beat, so `IMPLAUSIBLE_BEAT_FRACTION = 0.5` never rejects anything. The documented robustness property doesn't actually exist in the shipped code.
5. **Replace the fixed-alpha EMA gaze smoothing with a One Euro filter** (Casiez et al., CHI 2012, ~30 dependency-free lines): speed-adaptive cutoff gives low jitter while reading a line *and* low lag on the saccade to the next system — the exact trade-off the single "smoothness" slider currently forces users to pick a side of.

---

## Findings

### A. Gaze, calibration, and tracking (personas 1–2)

**A1. [Risk] Wink up-scroll is mathematically unreachable at reachable slider settings.**
`winkTracking.js` computes `rawUy = cfg.bandPos - cfg.deadZoneFrac - reach`, clamped to `[0.02, 0.98]`. But `decide()` triggers "up" only when `smoothY < center - deadUp`, where `deadUp = min(dead, center - 8px)`. Whenever `deadZoneFrac ≥ bandPos - 8/H` (e.g. band pos 20% + dead zone 20%; or band 12% + anything ≥ 12%), the reachable up-zone is the top 8 px of the screen — but the wink point's floor is `0.02·H` (≈16–20 px on any laptop). Result: left wink silently does nothing, in the *default* tracking type. The down direction is protected only by luck (`bandPos` slider maxes at 55%). Root cause: `winkTracking.js` re-derives trigger geometry from raw `cfg` values while `decide()` uses capped ones — hidden coupling between two modules' math.
*Impact: High (silent failure of a headline feature). Effort: Low–Med.*
**Next step:** short-term, clamp the synthesized point to *inside the capped trigger zone* by exporting the `deadUp/deadDown` computation from `followLogic.js` and reusing it. Better (see A2): stop faking gaze at all.

**A2. [Alternative approach] Give `decide()` an explicit intent channel instead of a forged gaze point.**
The "wink synthesizes a fake gaze point so decide() needs zero changes" pattern is documented as a win, but A1 shows its cost: the fake point must reverse-engineer decide()'s internal geometry, and every future decide() refinement (caps, margins, freshness windows) can silently break wink. An `input.intent: 'up' | 'down' | null` field that bypasses the geometric zone test (but still flows through the same hold/hysteresis/snap machinery) is ~15 lines, keeps the state machine shared, and removes the whole class of bug. It also lets you drop the double debounce (120 ms wink hold + 350 ms decide hold ≈ 470 ms wink-to-scroll latency — worth halving for responsiveness; the wink is already debounced upstream).
*Impact: Med. Effort: Med.*

**A3. [Optimization] Close persona 2's open question: leave-one-out validation of the calibration fit is nearly free — do it.**
9 points × a 7×7 Gaussian elimination = microseconds. Compute LOO residuals at `finishCalibration()` time and (a) show the predicted on-screen error immediately ("expect ~X% — recalibrate?" before the user discovers it mid-piece), (b) optionally pick `ridgeLambda` from a small grid by LOO error instead of the fixed 0.05. Separately: `runCalibration()` collapses ~550 ms of samples per dot to a single median row, then fits 7 parameters on 9 rows. Feeding *all* samples as rows (each labeled with its dot's `sx, sy`) gives the regression the real noise distribution, hundreds of effective observations, and honest residuals — for free, since the samples are already collected. This is the same "use the data you already have" discipline the barline `minFrac` investigation used.
*Impact: Med (proactive recalibration prompts; better fits for jittery users). Effort: Low.*

**A4. [Practice/process] The iris path's blink gate contradicts persona 1's own documented lesson.**
PERSONAS.md records that raw eyelid-distance was "tried first and was too noisy" and blendshapes are the robust closure signal — but `irisTracking.js`'s blink gate still uses raw `r.open` against an adaptive EMA baseline, while `eyeBlinkScores()` from the same MediaPipe result sits unused in that path. The adaptive baseline mitigates it, but this is one signal doing a job the codebase already concluded another signal does better, plus extra state (`openEMA`) to maintain.
*Impact: Low–Med. Effort: Low.* **Next step:** gate on `max(eyeBlinkLeft, eyeBlinkRight) > threshold` and delete `openEMA`.

**A5. [Optimization] Micro-cleanups in the per-frame camera loop.**
(a) `$('wkL')/$('wkR')` DOM lookups + `toFixed` writes run every frame whenever wink is active, even with the panel collapsed — update only when visible, or throttle to ~5 Hz. (b) `state.winkScores` allocates a fresh object per frame. (c) `calibModelId()` is defined twice, identically, in `appState.js` and `calibration.js` — only the latter is imported; the former is drift risk (a future model-version bump edited in one place invalidates saved calibrations inconsistently). Delete one.
*Impact: Low. Effort: Low.*

### B. Score analysis / OMR (persona 3)

**B1. [Practice/process] The "note-head density" open question can be closed as moot — the schedule doesn't depend on note values at all.**
`buildSchedule()` computes `duration = measures × beatsPerMeasure × secPerBeat`. A measure of 4/4 lasts 4 beats whether it holds a whole note or sixteen 16ths — the "assumes roughly uniform note values within a measure" caveat in `barlineDetection.js` and the persona-3 open question ("could note-head density refine the uniform-note-values approximation") describe an approximation the schedule never actually makes. The only real error sources are measure-count accuracy, meter changes, and repeats. Recommend striking that open question so future effort isn't spent on it; if note-head detection is ever built, its actual value is as a *barline false-positive discriminator* (a candidate column flanked by dense note-heads is likelier a stem), not schedule refinement.
*Impact: Med (redirects future research). Effort: Low (documentation).*

**B2. [Alternative approach] The time-signature detector's identified blocker has a concrete, cheap unblock: bundle Bravura's time-signature digits.**
Bravura is SIL OFL-licensed; SMuFL defines dedicated time-signature digit glyphs (`timeSig0`–`timeSig9`, U+E080–U+E089). A subsetted WOFF2 of those ten glyphs is a few KB, loads via the `FontFace` API, and renders reference templates through the existing `getDigitTemplates()` canvas path with a one-line font-name change. Since MuseScore/Dorico use Bravura and Finale/Sibelius fonts are visually much closer to Bravura than to bold sans-serif, this should move confidence well past the current 0.3 ceiling. This is client-side-safe, tiny, and directly activates a feature that already ships inert with working plumbing.
*Impact: Med. Effort: Low–Med (font subsetting + async template init).*
Related drift: `scoreAnalysis.js` line 138 still uses `bandHeight * 0.85` to find the first barline for the time-sig crop region, after `countBarlines`' default was raised to 0.95 — harmless here (a looser bound only widens the crop) but worth a comment or shared constant so the next threshold change doesn't half-apply again.

**B3. [Practice/process] On the "full OMR is infeasible client-side" verdict — agree today, but sharpen the revisit condition.**
The verdict is sound for the shipped need. One refinement: the revisit trigger shouldn't be "a lightweight in-browser ML model turns up" in the abstract — the concrete thing to watch is ONNX-exported OMR models runnable under `onnxruntime-web`/WebGPU (the `oemer` project's models are the reference point; today they're ~100 MB-class and far too slow, which is why the verdict stands). A yearly 30-minute check of that specific ecosystem is a better-shaped spike than an open-ended question. Also worth noting in the verdict: the *sections* text-layer work has quietly reduced what full OMR would even buy you — measure counts (printed numbers), section names, and tempo words are already exact; the remaining OMR prize is only meter changes and repeats.
*Impact: Low–Med. Effort: Low.*

**B4. [Optimization] `analyzeScore()` duplicates the staff-row scan from `systemDetection.js` — share the pure part, keep the triggers separate.**
The stated rationale (heavier, user-triggered vs. automatic) justifies separate *invocation*, not duplicated pixel-scan code: the `isInk` closure, the 0.45-width run-length row scan, and the 570-brightness threshold exist in both files, character-for-character. A `lib/inkScan.js` with `detectStaffRows(imageData, aw, ah)` would keep both callers honest when the next threshold tuning happens (the `minFrac` 0.85→0.95 episode shows tuned constants *do* move here).
*Impact: Low–Med (drift prevention). Effort: Low.*

**B5. [Alternative approach] For mid-section meter changes, prefer per-system *beats* over per-system *seconds*.**
Persona 3's open proposal (display each system's scheduled duration in seconds) sidesteps time signatures but asks musicians to think in a unit they don't use. A smaller generalization: `buildSchedule` already computes `measures × beatsPerMeasure`; make the schedule accept an optional `beatsPerSystem[]` override (sum of actual per-measure beat counts), editable in the existing measures-list UI as a second column, with seconds shown read-only next to it. The 5/8→7/8→3/4 Alto Clarinet case becomes "type the beat count per line" — a task a band student can do from the part directly — and every downstream consumer (`beatTimestamps`, correction, highlight) works unchanged.
*Impact: Med (it's a confirmed real case). Effort: Med.*

### C. Audio / live tempo (persona 4)

**C1. [Risk] The `IMPLAUSIBLE_BEAT_FRACTION` guard never fires.**
`beatTimestamps()` produces a globally uniform grid with spacing exactly `60/bpm` (each system's `beatDur` reduces to `secPerBeat`, and systems are contiguous). `nearestBeatTime()` therefore returns an error of at most half a beat *by construction*, so `|beatFrac| ≤ 0.5` is always true (except a sliver past the final beat). The README and PERSONAS both cite this gate as a robustness property ("more likely a mis-detection matched to the wrong beat — ignore it"), but it rejects nothing. Worse, off-beat onsets (eighth-note runs) land at ~0.5-beat errors and get *fully applied* as nudges — GAIN is small and errors roughly cancel, but it's noise injection the design believed it was filtering.
*Impact: Med. Effort: Low.*
**Next step:** either lower the gate to ~0.25–0.3 (genuinely rejects inter-beat onsets), or — better — track expected beat *phase* forward (compare to the next expected beat given the last matched one) so "matched the wrong beat entirely" is actually detectable. Add a unit test asserting the gate rejects a 0.4-beat-late onset, which today would fail and prove the point.

**C2. [Optimization] Disable browser audio processing on the mic stream — likely the single cheapest onset-quality win.**
`getUserMedia({ audio: true })` defaults enable echo cancellation, noise suppression, and auto-gain on most browsers. Noise suppression is trained to remove non-speech — i.e., precisely the instrument attacks the detector listens for — and AGC fights the rising-energy heuristic by compressing the very jumps it detects. Request `{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }`. This is a standard, well-documented requirement for music-input web apps.
*Impact: Med–High for onset fidelity. Effort: Trivial.*

**C3. [Optimization] Cache `beatTimestamps` per schedule instead of rebuilding per onset.**
`handleOnset()` reallocates the full beat array (hundreds of entries) on every onset, several times per second. The comment in `tempoSchedule.js` defends the linear *scan*; the repeated *construction* is unexamined. Build once in `startAutoScroll()` and store on `as.schedule`. Also, since the grid is uniform, `nearestBeatTime` is `round((t - t0)/beatDur)` — the array and scan could both disappear.
*Impact: Low (GC churn during playback). Effort: Low.*

**C4. [Alternative approach] If onset detection underperforms on soft attacks, the named upgrade is spectral flux with adaptive median thresholding, not full beat tracking.**
The rising-RMS detector will miss soft/legato attacks (flute, low clarinet) and slurred passages produce no onsets at all (correction then decays mid-phrase — safe, but "no signal" during legato playing will confuse users). The established middle step (Bello et al. 2005; Dixon 2006, "Onset Detection Revisited") is spectral flux over a small FFT with a median-based adaptive threshold — meaningfully better on soft attacks, still nowhere near beat tracking's failure modes, ~50–80 lines with a hand-rolled radix-2 FFT in the worklet, no dependency. Also note the fixed `+0.01` RMS floor in `onsetProcessor.js` may sit above a quiet player at laptop-mic distance; making sensitivity a worklet parameter (settable via `port.postMessage`) would let "Check accuracy"-style feedback tune it. Do C2 first and re-evaluate before building this.
*Impact: Med. Effort: Med. Cost note: adds real DSP code to a currently 54-line worklet.*

**C5. [Practice/process] `liveTempo.js`'s header claims a Playwright e2e test that does not exist.**
"Verified via a synthetic-audio Playwright test instead (see e2e/)" — there is no `e2e/` directory, no Playwright dependency in `package.json`, and no e2e job in `test.yml`. Either the test was never committed or the comment is aspirational; both are the kind of stale claim PERSONAS.md's discipline exists to prevent. Given C1 (a shipped logic property that silently doesn't hold), this feature is exactly where verification claims should be accurate.
*Impact: Med (trust in docs). Effort: Low (fix the comment) / Med (actually build the test).*

### D. Control loop and rendering (persona 5)

**D1. [Alternative approach] One Euro filter for gaze smoothing.**
The single-pole EMA forces one alpha for two regimes: fixation (want heavy smoothing — jitter is the enemy) and saccade to the next system (want near-zero lag — the page turn *is* the product). The One Euro filter (Casiez, Roussel, Vogel — CHI 2012) is the standard fix for exactly this noisy-pointing problem: cutoff frequency scales with signal speed. It's ~30 dependency-free lines, drops into `decide()` where the EMA sits, and the existing "smoothness" slider maps cleanly to `mincutoff`. PERSONAS' "no need for a Kalman filter at this signal quality" verdict is right, but One Euro is not Kalman-class complexity — it's EMA-class complexity with the trade-off removed.
*Impact: Med–High (perceived responsiveness). Effort: Low–Med. Validate with the existing followLogic test fixtures plus a step-response test.*

**D2. [Risk] `renderAll()` is re-entrant with no cancellation, and `resize` calls it undebounced.**
`renderAll()` clears `scoreEl` then sequentially awaits each page render. The `resize` handler calls it on *every* resize event (the 400 ms debounce protects only the fingerprint check), and `toggleMin`/zoom-change also call it. Two overlapping invocations interleave their `appendChild` calls after the second's `innerHTML = ''` — duplicated/out-of-order pages during a drag-resize. Fix: a generation counter (bail out of the loop when a newer call started) plus debouncing the resize path.
*Impact: Med. Effort: Low.*

**D3. [Risk] `state.autoScroll.systemBands` are absolute document pixels captured at analysis time — any re-render invalidates them silently.**
After Analyze, a window resize, zoom change, or panel collapse triggers `renderAll()`, page heights change, but `as.analyzed` stays true and `systemBands`/highlight coordinates are stale — Start then scrolls to wrong positions with no warning. Snap mode is protected (its `detectSystems()` re-runs inside `renderAll`); auto-scroll is not. Fix options: store `(pageIndex, fractionOfPageHeight)` and resolve to doc pixels at use time (correct, medium effort), or minimally set `as.analyzed = false` + surface "layout changed — re-analyze" on re-render (cheap, honest).
*Impact: Med–High (wrong-position playback is the feature's worst failure mode). Effort: Low (invalidate) / Med (fraction-based).*

**D4. [Risk] All pages render eagerly at full resolution — fine for 2-page band parts, heavy for the score-plus-parts PDFs the sections feature now invites.**
At ~1600 CSS px width and dpr 1.5–2, each page canvas is tens of MB of backing store; a 30-page full-score-plus-parts PDF (the exact input the sections feature targets) can reach hundreds of MB to >1 GB, enough to crash tabs on the low-end Chromebooks the audience uses. The sections feature quietly changed the realistic input-size distribution; rendering didn't follow. An `IntersectionObserver`-driven render-near-viewport scheme (placeholder divs at known page aspect ratios keep scroll geometry stable) is the standard fix, but note it interacts with `analyzeScore()` (which reads pixels from all canvases) — analysis would need to render pages transiently.
*Impact: Med (High for the sections use case). Effort: Med–High. Next step: measure actual memory on a real 30-page PDF before committing.*

**D5. [Optimization] Idle-loop DOM writes in `autoScrollController.tick()`.**
Every frame, forever, even when nothing plays: `$('liveTempoStatus')` lookup + `textContent` write; while playing, `setStatus()` rebuilds the same status string and `$('tempoText')`/`$('autoScrollHighlight')` are re-queried per frame. Cache element refs at module init (they're static) and skip writes when the value is unchanged. Same pattern as the deliberate `followController` early-return — just unevenly applied.
*Impact: Low. Effort: Low.*

### E. UX, audience, accessibility (persona 6)

**E1. [Risk] The default active tab is Tempo (`initTabsUI()` calls `selectTab('tabAutoScroll')`), while the README quick-start, the default tracking type (wink), and the whole onboarding flow lead with Eye/Wink.**
A first-time student following the README sees the wrong panel, and the reading band (default-on) is hidden because `applyBand()` hides it on the Tempo tab. This looks like a leftover from developing the tempo feature last, not a decision — exactly the "clarity loss is gradual and easy to miss from the inside" failure persona 6 documented.
*Impact: Med (first-run experience). Effort: Trivial. Next step: default to `tabTracking`, or persist the last-used tab in settings.*

**E2. [Optimization] Support pedal keycodes, not just pedal clicks.**
The pedal story assumes "a Bluetooth page-turner pedal usually sends a mouse click," but the common devices in this audience (AirTurn, PageFlip, Donner) ship in keyboard modes sending PageUp/PageDown or arrow keys as often as clicks. `keydown` handles arrows (60 px nudge) but not PageUp/PageDown at all. Mapping PageDown/PageUp to next/previous system when snap centers exist (else a viewport-height scroll) makes most pedals work out of the box in their default profile.
*Impact: Med for the stated audience. Effort: Low.*

**E3. [Practice/process] Zero ARIA in `index.html`.**
No `aria-live` on status/toast (state changes are invisible to screen readers), tab buttons without `role="tab"`/`aria-selected`, range inputs without programmatic label association. The core interaction is inherently visual, but the *setup* flow (load, calibrate, settings) has no such excuse, and this is a school-adjacent tool where accessibility expectations are real. A one-pass baseline: `aria-live="polite"` on the toast (not the per-frame status — that would spam), `role="tablist/tab"` + `aria-selected` on the switcher, `<label for>` on sliders.
*Impact: Low–Med. Effort: Low.*

### F. Architecture, state, and process (personas 7–9)

**F1. [Alternative approach] Self-host the MediaPipe model and WASM runtime.**
Challenging the documented Privacy-persona tradeoff: the stated reason for CDN loading is that these are "large ML assets," but the float16 `face_landmarker.task` plus the tasks-vision WASM bundle total on the order of 10–15 MB — comfortably within GitHub Pages limits and a rounding error next to the PDFs users load. The costs of the CDN approach fall hardest on this exact audience: school networks commonly filter `storage.googleapis.com`/jsDelivr (a blocked first load = app dead with a confusing error), and every visit leaks IP/referer metadata to two third parties, which sits awkwardly next to "everything happens on your own computer." Self-hosting (`public/models/`, fetched same-origin, cached by the service of Pages itself) removes both, pins the model version against silent CDN-side changes, and needs only a URL change in `camera.js` plus a download step in the deploy workflow.
*Impact: Med–High (availability for the core audience + privacy claim integrity). Effort: Low.*

**F2. [Risk] The settings layer is the seam that's starting to strain.**
Every persisted setting now exists in four hand-synced places: the slider `bind()` call, `currentToggles()`, `applyToggles()`, and the element's own `onclick` handler (button-text logic for drift/auto-frame/snap is duplicated between `applyToggles` and the click handlers, already with slightly different snap-count formatting). The wink thresholds, BPM, and tempoPct have each been threaded through this by hand. This is the mechanism by which the next "band still visible on the wrong tab"-class bug ships. A small declarative registry — one table of `{ id, kind: 'slider'|'toggle'|'value', get, set, renderDom }` that save/load/presets/reset all iterate — collapses the four places to one and makes `applyToggles` disappear. No framework needed; it's ~60 lines replacing ~120 scattered ones.
*Impact: Med (defect prevention as features accumulate). Effort: Med.*

**F3. [Practice/process] `loadPdf` has no error handling for corrupt/encrypted PDFs.**
`main.js` guards the FileReader, but `loadPdf`'s `await pdfjsLib.getDocument(...).promise` rejection (password-protected or corrupt file — both realistic for scanned band-folder PDFs) is an unhandled rejection: the empty-state stays up with no message. Wrap it and route to the existing `setStatus`/`toast` path.
*Impact: Low–Med. Effort: Trivial.*

**F4. [Practice/process] The QA corpus open question deserves a concrete recommendation: build it now, small.**
Endorsing the open question with a next step rather than agreement: generate 4–6 fixture PDFs *from MuseScore* (scriptable via its CLI, output is real notation-software engraving — the exact input class the audience has): single-staff part, score+parts, parts-only-no-score (the known bootstrap gap), mixed meter, tightly-packed 9-systems page. Check in the PDFs (they're your own generated content, so no licensing issue and no conflict with the "PDFs are git-ignored" rule for user music) and assert exact system/measure counts through the real render→detect pipeline in CI. Every documented detection bug in PERSONAS.md (`collapseThickness`, the pad=20 fix, the minFrac change) was found by exactly this kind of real-rendered input — the corpus turns that from an ad-hoc discipline into a regression net, before the next threshold tune quietly re-breaks a fixed case.
*Impact: High for detection-work velocity. Effort: Med (one-time).*

---

## What the review would explicitly NOT change

- **The pure-`lib/` vs DOM-wiring split and colocated Vitest tests.** It's consistently applied, the tests are behavioral rather than mock-heavy, and it's the reason findings like A1/C1 are cheaply fixable and testable. Keep it as the template.
- **Onset-nudge over beat tracking.** The verdict is correct and the leaky-integrator decay is genuinely the right shape; C1/C2 are refinements *within* this design, not arguments against it. Full beat tracking would still be the wrong call.
- **The "human confirms the estimate" pattern** for barlines and the confidence-gated inert time-sig detector. This is the right posture for every detector in the app; B2 just feeds the existing gate better reference data.
- **The sections reference-swap model.** The zero-consumer-changes property is real and the invariants hold on inspection (including the subtle single-section case). Don't introduce a parallel active/all data model.
- **Ridge + standardization + Gaussian elimination at this scale.** No fancier solver is warranted; A3 improves the *inputs and validation*, not the method.
- **The mutual-exclusion fix via `setFollowing()`/`pauseAutoScrollUI()`** and the "requeue rAF before doing work" pattern in both tick loops (which makes the loops exception-proof) — both are quietly good.
- **The 100% client-side constraint itself.** Nothing above requires bending it; F1 makes the app *more* client-side, not less.

The strongest overall impression: the pure-logic layers are unusually well-reasoned and well-documented, and the accumulated-lessons discipline in PERSONAS.md is genuinely working — but two of its documented safety properties (the wink dead-zone reachability lesson in A1, the implausible-onset gate in C1) don't actually hold in the shipped code, and one claimed verification (C5) doesn't exist. The process writes down lessons well; the gap is *re-verifying* that documented properties stay true as adjacent code evolves — which is exactly what the F4 corpus and a couple of targeted unit tests (A1's geometry, C1's gate) would close.

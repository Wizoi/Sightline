# Backlog — completed

[← Back to persona roster](PERSONAS.md)

Historical record of backlog items that have shipped, kept for provenance (what was fixed, when,
and how it was verified) — not an open TODO. See [`docs/BACKLOG-FUTURE.md`](BACKLOG-FUTURE.md)
for what's still open, declined, or deferred. Originally triaged from the 2026-07-19 Fable review
(see [`docs/reviews/2026-07-19-fable-review.md`](reviews/2026-07-19-fable-review.md)) plus items
added since; a persona reference like "see persona 3's write-up above" below means the owning
persona's file under `docs/personas/`, not this file.

---

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

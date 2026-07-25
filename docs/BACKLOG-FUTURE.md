# Backlog — future / open / declined

[← Back to persona roster](PERSONAS.md)

Items that are explicitly **not** being worked on right now — declined, blocked, or genuinely
open questions worth spiking eventually — tracked here for visibility, not assigned to any
persona. See [`docs/BACKLOG-DONE.md`](BACKLOG-DONE.md) for what's already shipped.

---

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

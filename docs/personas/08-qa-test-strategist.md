# 8. QA / Test Strategy Engineer

[← Back to persona roster](../PERSONAS.md)


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


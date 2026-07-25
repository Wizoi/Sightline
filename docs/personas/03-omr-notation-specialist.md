# 3. Optical Music Recognition (OMR) / Music Notation Specialist

[← Back to persona roster](../PERSONAS.md)

**Owns:** reading structure out of the rendered score image — staves, systems, barlines,
measures — without doing full music recognition. Also owns reading structure out of the PDF's
*real text layer* where one exists (part/section boundaries, tempo markings, measure numbers) —
a related but fundamentally different technique from pixel-based detection; see below.
**Files:** `src/lib/systemDetection.js`, `src/lib/inkScan.js`, `src/lib/barlineDetection.js`,
`src/scoreAnalysis.js`, `src/lib/scoreSections.js`, `src/lib/scoreText.js`,
`src/lib/timeSigMatch.js`, `src/timeSigDetection.js`

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
- **Scanned-file system-detection severe undercount (2026-07-25) was a one-layer-earlier bug than
  every prior fix in this list: not staves being dropped or mis-grouped, but real staff LINES never
  reaching `detectStaffRows`' (`lib/inkScan.js`) required single unbroken ink run at all.** A real
  degraded scan (100+-year-old photocopied band parts, this project's 4 designated regression-guard
  files) breaks a visually-solid staff line into dozens of short ink segments separated by small
  gaps (median 5px, 90th pct 19px, out of a ~1550px analysis canvas) — a real
  downsampling/print-degradation artifact, confirmed by dumping real per-row ink data and rendering
  the actual page, not assumed. **Fixed** by bridging small gaps (`gapBridgePx`, default 10px) when
  measuring a row's longest run — recovered Teutonia.pdf from 80/152 (52.6%) to 158/152 (96.1%)
  systems, with similarly large gains on the other 3 files (see the investigation log's 2026-07-25
  entry for all 4 files' before/after numbers). **A second real regression this same fix introduced
  and had to also fix, found only by re-running the FULL 39-file benchmark, not just the 4 target
  files:** ordinary printed body-text (a license-notice text box on a real clean/vector PDF,
  `CavalliniNo1-a4.pdf`) has letter/word-spacing gaps just as small as scanned-staff-line noise —
  no gap-size threshold separates them, they overlap in scale. What does: a real (even degraded)
  staff line's bridged run is still mostly ACTUAL ink (93% on the recovered Teutonia row) while a
  text paragraph's bridged run is mostly whitespace stitched together by the bridge (54-74% on the
  false-positive rows) — fixed with a second gate, `inkDensityMin` (default 0.85), requiring the
  recognized run to still be mostly real ink, calibrated with real margin on both sides and proven
  to reject nothing the pre-fix algorithm ever accepted (an unbridged winning run is always 100%
  ink by construction). **Both gates live entirely in `inkScan.js`'s pixel-to-candidate-row step;
  `systemDetection.js`'s own staff/system clustering and grouping-consistency logic — the subject of
  most of this list's other entries — is completely untouched.**
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
- **The "time-signature digits have no Unicode mapping" verdict was overgeneralized — corrected
  (2026-07-24) by a real-corpus spike, but NOT by the mechanism originally suspected.** Glyph
  *names* (a PDF font's `/Differences` array, checked directly via `page.getOperatorList()` +
  `page.commonObjs`) are a dead end for this corpus: every embedded font checked (MuseScore's
  `MScore`/`BravuraText` family) has an EMPTY `/Differences` array — there's no glyph-name
  mechanism to read at all. But plain `page.getTextContent()` — no special options, the same call
  already made for every other text-layer feature — DOES already return literal ASCII digit
  characters for a real time signature on some files (`takefive.pdf`: "5"/"4" at matching x,
  10pt apart; `Fantastic Parade.pdf`: 23 correct "6"/"8" pairs, one per instrument staff;
  `flightofbumblebee.pdf`: "2"/"4"; `Peace_Sign Clarinet.pdf`: "4"/"4"), because pdf.js's own
  internal `_simpleFontToUnicode` fallback (used when a font has no explicit `/ToUnicode` CMap)
  happens to resolve some fonts' digit glyph codes to ordinary Unicode digits. This is NOT
  predictable by vendor/software: `Departure! Clarinet.pdf`, apparently the same MuseScore engine
  as `Peace_Sign`, encodes its time-signature "4" as an undecoded SMuFL PUA codepoint (U+E084)
  instead — confirmed by direct inspection, not assumed. **Net effect: reading printed time-sig
  digits straight from the existing text layer (no OCR, no shape-matching) is real and exact
  where it works, but must be attempted per-file and gated by whether a plausible stacked digit
  pair actually turns up — it can't be trusted as "this vendor always/never has it."** Full
  evidence and the scripts used are in the investigation log's 2026-07-24 entry.
- **The above is now WIRED IN (2026-07-25), not just a documented follow-up — `lib/scoreText.js`'s
  `extractTimeSignatures`/`findStackedDigitPair` run inside `scoreAnalysis.js`'s existing per-page
  loop, before the pixel `renderHighResRegion` + `timeSigDetection.js` path, reusing the
  `pageItems` already read for section-title/measure-number purposes (no new `getTextContent()`
  call, no extra render).** A text-layer hit wins outright (`confidence: 1, source: 'text'`)
  rather than being confidence-compared via `pickBestTimeSig` — it's a read, not a recognition —
  but is still only ever offered through the same "detected — use this?" suggestion
  (`autoScrollUI.js`'s `renderTimeSigSuggestion`), never applied automatically; the pixel/OCR path
  is unchanged and still runs whenever the text layer finds nothing. **A real bug turned up during
  verification, not assumed away: gating text-layer candidates to "before the system's own first
  detected barline" — reusing the SAME pixel-based `firstBarlineCol` estimate the high-res crop
  already computes for a different purpose — actively produced a false negative on a real corpus
  file** (`flightofbumblebee.pdf`: the real "2"/"4" pair sat at x=118.8, but the pixel barline
  estimate landed at x=108.2, silently excluding it). Fixed by dropping that x restriction from the
  `scoreAnalysis.js` call site entirely — the system's own narrow single-staff y-band, the
  power-of-two-denominator plausibility gate, and a leftmost/tightest-pair tie-break turned out to
  be sufficient on their own, confirmed by re-verifying every positive file afterward (no new false
  positives, `flightofbumblebee.pdf` now correct). **Real-corpus verification (via the real running
  app, not just unit fixtures):** `takefive.pdf` → 5/4, `Fantastic Parade.pdf` → 6/8,
  `flightofbumblebee.pdf` → 2/4, `Peace_Sign Clarinet.pdf` → 4/4, all correct; `Departure!
  Clarinet.pdf` (the confirmed SMuFL-PUA counter-example) still correctly shows no suggestion at
  all, falling through cleanly to the pixel path. Full 39-file benchmark before/after: every
  metric byte-identical (this benchmark doesn't score time-signature detection at all — see
  `scripts/benchmark/run.mjs`'s `scoreFile()` — so identical numbers is the correct proof of "broke
  nothing else," not the feature's own evidence). Full write-up, including the `maxX` bug's
  diagnosis, in the investigation log's 2026-07-25 entry.
- **Vector (operator-list) staff-line/barline reading is genuinely viable for some real
  born-digital files and a hard dead end for others — investigated (2026-07-24), not shipped.**
  `page.getOperatorList()`'s raw coordinates are in each drawing op's own local user-space, NOT
  pre-composed with the accumulated CTM — recovering real page-space coordinates requires the
  caller to replay the full `save`(q)/`transform`(cm)/`restore`(Q) stack itself (confirmed
  working: composed coordinates matched the page's own known viewport exactly). Where that's
  done, `Peace_Sign Clarinet.pdf`'s staff lines have an extremely clean signature: a single
  `constructPath` op containing exactly 5 horizontal 2-point line segments at uniform y-spacing
  sharing an x-range (52 such groups found on one page) — trivially distinguishable from curves
  (slurs), thick fills (beams), and short strokes (stems) by shape alone. But `takefive.pdf` AND
  `Fantastic Parade.pdf` (two different real vendors) both have ZERO matching `constructPath`
  groups and ZERO matching filled rects for their own, equally-visible staff lines — both draw
  them via `showText` (glyph runs) instead, which `getOperatorList()` doesn't decompose into any
  per-line geometry at all, a hard dead end for those files regardless of technique. Net sample:
  1 of 3 real born-digital files checked draws staff lines as vector strokes — if anything the
  narrower case, not an even split, though too small a sample to generalize the exact ratio.
  Barline-vs-stem disambiguation (both are simple
  vertical strokes) also remains an open, untested problem even in files where the staff-line
  approach works. **Conclusion: promising but genuinely inconsistent across real vendors, and
  the barline half is unproven — a good candidate for a dedicated future investigation (with its
  own per-file viability detection and stem/barline geometry tuning), not a slam-dunk to build
  now.** Do not re-run this exact spike without new evidence; the negative half (takefive) is as
  load-bearing as the positive half (Peace_Sign).
- **Scanned-file section-name accuracy was structurally capped at 28.6% by a real bug, not just
  "hard to detect": `ocr.js`'s shared Tesseract worker had `tessedit_char_whitelist:
  '0123456789'` set ONCE at creation, making it physically incapable of ever recognizing a
  letter** — every OCR pass available for an image-only page could only ever read digits, so
  `collectKnownNames`/`findSectionTitle` (lib/scoreText.js) had nothing to match against on a
  scanned file no matter how good their position/repetition logic was. **Fixed (2026-07-24)** by
  adding a fourth OCR method, `ocrPageWords` (PSM 3, whitelist cleared), that reads real
  instrument-name/title text off a scanned page's top region and feeds it into the SAME
  `groupIntoRows`/`collectKnownNames`/`findSectionTitle` pipeline already validated for
  born-digital text, in the same `{str, x, y}` shape `page.getTextContent()` produces — so
  scanned files get the identical, already-real-corpus-tested name-matching logic, not a second
  parallel path. The whitelist is no longer set once at worker creation at all: every digit call
  site (`recognizeDigitsInBox`, `ocrNumbersByStrip`) now (re)sets it immediately before its own
  `recognize()` call, and `ocrPageWords` clears it immediately before its own — each pass is
  self-contained and safe to interleave in any order on the one shared worker, closing the
  parameter-corruption footgun this design otherwise invites. Wired into both call sites that
  needed real names on a scanned page: the main per-page loop's title/bootstrap matching (page 0
  ONLY — see below), and `fillMissingSectionNames`'s per-boundary mini-bootstrap (previously
  bailed out immediately on any page with an empty text layer).
  - **Real-corpus benchmark result: verified working end-to-end, but a SEPARATE, pre-existing bug
    blocks it from moving the 28.6% number on this specific corpus — a genuine, diagnosed-but-
    unfixed finding, not a flaw in this fix.** Direct browser-console tracing (temporary debug
    logging, removed after use) against the 4 lowest-scoring scanned files (`Teutonia.pdf`,
    `Fat Burger parts with drums (1).pdf`, `KingCotton.pdf`, `MonogramMarch.pdf`) confirmed the fix
    itself works exactly as designed: `Fat Burger` (genuinely image-only per page) had its real
    title/composer/instrument text OCR'd legibly — `"FAT"`/`"BURGER"`, `"By GEORGE VINCENT"`,
    `"Baeirone SAXOPHONE"` (a recognizable OCR misread of "Baritone Saxophone") — output that was
    STRUCTURALLY IMPOSSIBLE before this fix (the digit-only whitelist made every letter
    unrecognizable, full stop). The other three files turned out to already have a REAL, clean
    embedded text layer on their per-part pages (`"1st CLARINET."`, `"FLUTE"`, `"JOHN PHILIP
    SOUSA"` all read directly via `page.getTextContent()`, no OCR involved) — yet in all cases the
    real instrument name was still rejected by `collectKnownNames`'s position filter
    (`row.y > topY + pad` → skip), because `firstSystemForText` (built from the PIXEL-based system
    detector's `systemBands[b.systemIndex]`) placed this boundary's "first system" much lower on
    the page than where the name is actually printed — consistent with these same files' own
    already-known, severe system-detection undercount (e.g. `Teutonia.pdf`: 80 systems detected vs.
    152 true, confirmed in the same benchmark run). This is `systemDetection.js` territory, not
    `ocr.js`/`fillMissingSectionNames` — a real, valuable, NEW finding (this exact bug class,
    "under-detected systems corrupt a position-based heuristic elsewhere," previously only
    documented for `systemDetection.js`'s own internal gap-clustering, is now confirmed to also
    corrupt the text/OCR name-matching pipeline downstream) but out of scope to fix in this same
    session — flagged here as the concrete next step for whoever picks up system-detection
    accuracy on this specific class of dense historical march engravings. **The correct, safe
    behavior held throughout: no wrong name was ever surfaced, just no name at all** (the
    "Section N" generic fallback), consistent with this domain's established "never guess wrong"
    pattern — this is a missed opportunity, not a regression.
  - **Cost lesson found the hard way: word-OCR must NOT run on every OCR page.** A first version
    requested it unconditionally for every image-only page and stalled real-corpus benchmarking on
    a real ~20+-page scanned multi-part booklet — a third full `recognize()` pass per page is
    genuine, non-trivial cost, and most interior pages could never become a title match anyway
    (the main loop's `findSectionTitle` only ever fires against `knownNames` bootstrapped from
    page 0, which mainly matters for a combined SCORE's opening page — rare for this app's
    realistic scanned-file audience of individual part booklets). Scoped down to page 0 only in
    the main loop; the actual fix for a scanned multi-part booklet's per-part names is
    `fillMissingSectionNames` (driven by cheap, already-necessary measure-number-reset boundaries),
    which was always scoped to just the handful of actual boundary pages and unaffected by this.

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

---

**Full investigation history** (every accuracy fix, the Sections/text-layer feature build-out,
page-rotation, the literature/prior-art research pass, and the time-signature detection work) is
preserved in full, chronologically, in
[`docs/personas/omr/investigation-log.md`](omr/investigation-log.md) — not summarized or
trimmed, just moved out of this persona's always-loaded file so invoking this persona doesn't
require pulling in the whole history every time. Read that file when you need the *why* behind a
threshold/decision, or full provenance for a specific fix; this file is the current, load-bearing
state.

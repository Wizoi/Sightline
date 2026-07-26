# OMR / Notation Specialist — full investigation history

[← Back to persona roster](../../PERSONAS.md) · [← Back to OMR persona](../03-omr-notation-specialist.md)

Complete, chronological record of every OMR/notation investigation, fix, and research pass —
moved out of the main persona file so a routine persona invocation doesn't have to load all of it.
Nothing here has been summarized or cut; this is the verbatim history, kept because it explains
*why* a given threshold/decision is what it is, not just what the current state is.

---

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
    result is at worst a visible annoyance, not silent corruption. **Revisited and substantially
    improved (2026-07-22) — see the "Lazarus duets over-split" write-up further below**: a genuine
    additional guard (a section's own printed numbers must climb to a value plausible for its own
    system span, not just individually pass the drop/climb checks above) cut this file from 10
    sections to 5, without touching any of the 10→8/17→10/5→2 cases this paragraph already fixed.
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
  **fully addressed (2026-07-21 partial, 2026-07-22 completed — see the "three-item backlog" write-up
  below for the real-corpus evidence).** It now splits via the title-independent printed-measure-
  number-reset signal either way, AND a nameless reset boundary gets a real label where one exists —
  `fillMissingSectionNames()` (`scoreAnalysis.js`) treats THAT boundary's own first page as a one-off
  mini-bootstrap page (the exact same `collectKnownNames` left-margin/letter-run logic as the page-1
  bootstrap, just scoped to one page), re-fetching only `page.getTextContent()` for the handful of
  pages that actually need it — no new pixel rendering. Still correctly does nothing on a page with no
  extractable text at all (a genuinely scanned/image-only part) — that residual gap is a photographed-
  page limitation, not a logic gap, exactly as expected.

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
  category already documented above, not evidence of a second bug, and was left as an open staff-
  detection-density gap rather than loosened further (loosening the *grouping* tolerance to paper
  over a *detection* gap risks silently re-accepting genuinely inconsistent pages, which this
  project's conservative-by-design philosophy explicitly rejects — see the existing "falls back to
  per-staff" rationale a few paragraphs above). **Root-caused and fixed (2026-07-22) — see the
  "Fantastic Parade staff-detection density gap" write-up further below**: the actual detection gap
  turned out to be a real, narrowly-scoped `collapseThickness` bug (not a case needing the grouping
  tolerance loosened at all). **Verified with a real git-stash-style before/after
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

**A three-item backlog pass (2026-07-22), closing out the three remaining open questions from the
sections above — all verified against the real corpus with the same Playwright-driven, real-file,
before/after discipline as everything else in this section (Playwright-core installed ad hoc for
this session only, never saved to `package.json`; a small `.scratch/` driver directory used and
fully deleted afterward — no `public/*.pdf` copies, no committed binaries):**

- **Finding: the "Fantastic Parade" staff-detection-density gap was root-caused, not left open.**
  The prior write-up (Finding 1, above) correctly diagnosed the *symptom* (two real staves losing
  most of their detected lines on a dense page) but had stopped short of finding the actual
  mechanism, reasonably worried that a fix might just be re-loosening the grouping tolerance the
  Teutonia fix had just tightened. Dumping the real per-row ink data for the affected page (a
  temporary debug hook added to `pageSystemsDetailed`/`scoreAnalysis.js` for this session, fully
  reverted afterward) and rendering the actual crop at 4x found the true cause: **this file's page
  packs 23 real staves into the shared `ah=1200` analysis canvas, shrinking real line-to-line
  spacing down to ~2-3px — the SAME magnitude as the anti-aliasing-duplicate-row gap
  `collapseThickness()` was written to collapse.** Two real staves (Tenor Saxophone, Baritone
  Saxophone), each rendering every one of its 5 lines as a doubled ink row (a 1-2px internal gap),
  produced a chain of small per-step gaps that individually all cleared the old `maxGap=2` check —
  `collapseThickness`'s greedy single-linkage merge then chained the ENTIRE 5-line staff into one
  point instead of 5, discarding 4 of 5 real lines per staff. **Fixed** by additionally capping the
  group's TOTAL span from its first row at the same `maxGap` threshold (a genuine thickness-
  duplicate group is already documented as spanning only 1-2px total — comfortably inside the cap —
  so the original anti-aliasing fix is completely unaffected; a real next line 2-3px away now
  correctly starts a new group once the running span would exceed that small, physically-plausible
  single-line-thickness bound, instead of chaining indefinitely). **Verified with real before/after
  evidence**: on the affected page, both staves now correctly detect all 5 lines; document-wide, the
  file's real (UI-mutation-corrected — see below) system count went from 417 (corrupted by the
  detection gap fragmenting one real system into up to 6 fake ones) to 480 (its true structure: one
  giant 20+-instrument system per page, laid out as 2 stacked staff panels — winds, then brass —
  plus 3 percussion staves, confirmed by actually rendering and reading the page image, not
  assumed). The residual imperfection — its percussion staves (one is a genuine single-line
  percussion staff, a real, different notation convention this pipeline was never designed to
  detect as a 5-line staff at all) still don't merge into the big system, correctly falling back to
  one-system-per-staff there — is a *different*, deliberately-conservative case, not a bug: forcing
  it to merge would need staff-type-awareness this app doesn't have, and risks exactly the "silently
  accept a genuinely inconsistent page" regression the conservative design exists to prevent.
  **Methodological note that surfaced along the way and is worth generalizing**: the "systemCount"
  a caller reads off `state.autoScroll.systemBands.length` is NOT the true whole-document count once
  a PDF has more than one section — `autoScrollUI.js`'s `renderSummary()` auto-selects section 0
  whenever `sections.length > 1`, which SWAPS `systemBands` down to just that section's own slice
  (see `scoreSections.js`'s doc comment on why sections are reference-swaps, not copies). Any future
  ad hoc verification script (or future debugging session) reading that field directly will silently
  under-count on a multi-section file; the correct whole-document count is the sum across
  `state.autoScroll.sections[i].systemBands.length`, or the `systemCount` `analyzeScore()` itself
  returns before the UI ever touches state.
- **New regression test** in `systemDetection.test.js` encodes the real dumped row shape from this
  exact page (two real 5-line staves, each doubled-row, spaced ~130 apart) and asserts both resolve
  to 5-line staves in 2 separate systems, not 1 collapsed point each merged into one.

- **Finding: the Lazarus-duets over-split was revisited with fresh real data (not re-stated from the
  prior conclusion) and a genuine, additional, safe guard was found.** Re-ran the real file end to
  end: it currently produces 10 sections from 9 detected resets, exactly as previously documented.
  Dumping the real `primaryEntries` feeding `detectMeasureNumberResets` (39 raw OCR strip-scan
  readings, values oscillating 0/3/4/5/6/7/41 with almost no relationship to position) confirmed
  every prior conclusion was correct as far as it went — but computing the actual data's coherence
  (longest strictly-increasing-subsequence length as a fraction of total entries, the exact
  algorithm `filterMeasureNumberOutliers` already uses elsewhere in this file) surfaced a clean,
  well-motivated additional signal that a naive whole-document version of doesn't work: a real
  multi-section document's WHOLE-document LIS fraction is confounded by simply having multiple
  legitimate resets (a real, clean 4-section IMSLP trio file, "The Spanish Winds Trio," scores only
  0.26 whole-document despite being perfectly clean *within* each of its sections) — so the fix
  applies the check PER CANDIDATE SECTION instead: **a section's own printed readings must climb to
  a value at least roughly proportional to how many systems it spans** (a real system, by
  definition, holds at least one real measure, so an entire 40-140-system section whose own readings
  never climb past single digits is implausible on its face) — `max(readings) / span >= 0.5`.
  Verified this ratio cleanly separates the real vs. fake populations on real data: Lazarus's 9
  candidate sections score 0.00-0.29 (data-confirmed noise); a real, already-working SPARSE case
  ("KingCotton.pdf," only 2 and 5 real readings in its two genuine sections) scores 1.66 and 2.84 —
  clearly on the other side of the line despite the small sample size. **The small-sample side is
  the real hazard this guard had to avoid**: a segment with too few readings to compute the ratio
  meaningfully (a real, already-working case, "Fat Burger parts with drums," has only ONE reading in
  its one reset-introduced section) is explicitly left alone rather than second-guessed — the guard
  only ever REJECTS a candidate when there's enough corroborating data to be confident it's
  implausible (`MIN_SAMPLES_FOR_RATIO_CHECK = 3`), never when data is merely sparse. **Fixed** in
  `detectMeasureNumberResets` (`scoreText.js`, threaded through from `addMeasureNumberResetBoundaries`
  in `scoreAssembly.js`), verified end-to-end against the real file: **10 sections → 5** (4 of 9
  candidate resets survive — each introduces a section with fewer than 3 corroborating readings, so
  there isn't enough evidence to judge them either way), while KingCotton/Fat Burger/Teutonia/
  MonogramMarch/Spanish-Winds-Trio/A-Lazy-Summer-Day were all confirmed byte-for-byte unchanged.
  **An unplanned bonus, discovered only by testing, not anticipated going in**: this exact same guard
  also fixes a brand-new spurious section this backlog's OWN Fantastic-Parade fix (above) had
  introduced — fixing the staff-detection gap corrected that file's system indices enough that a
  previously-inert noisy reading now qualified as a "confident" reset at systemIndex 95, splitting a
  file that should have exactly one section into two. That segment's own numbers (n=306, real
  readings, max=87 against a span of 385) score 0.226 — well below the same 0.5 threshold — so one
  general, real-evidence-based fix resolved both problems, rather than needing a second, file-
  specific patch. Two new committed unit tests in `scoreText.test.js` encode the real Lazarus/
  KingCotton/Fat-Burger data shapes directly.
- **General lesson, worth generalizing beyond this one fix**: when a new detection/threshold fix
  changes upstream data (here: system indices), always re-check downstream consumers of that data
  on the SAME real file, not just the file(s) the new fix directly targeted — a fix can be correct
  in isolation and still expose (or even newly trigger) a latent bug one step removed, and the only
  way to catch that is running the real pipeline end-to-end again, not reasoning about each fix in
  isolation.

- **Finding: real instrument names (and other genuinely-printed structural labels) for no-
  bootstrap-page files — implemented as scoped, per boundary-page bootstrapping.** Every detected
  section boundary that still has no name after title-matching (the reset-only case above) now gets
  one more chance: `fillMissingSectionNames()` (`scoreAnalysis.js`) treats THAT boundary's own first
  page as a one-off mini-bootstrap page, reusing `collectKnownNames`'s exact left-margin/letter-run/
  `isFull` logic (no new heuristic), scoped to a single page instead of relying on "a combined score
  lists everyone." Runs as a second, targeted pass after boundaries are finalized (not folded into
  the main per-page loop, since a reset-only boundary's existence isn't known until
  `detectMeasureNumberResets` runs on the FULL document's entries, after the loop) — cheap by
  design: only re-fetches `page.getTextContent()` (no pixel rendering, no canvas) for the handful of
  pages that actually have a nameless boundary landing on them.
  - **A real refinement, found only by testing against the real target file, not assumed in
    advance**: the natural first design used "this page's own topmost system" as the reference band
    for `collectKnownNames`'s `isFull` check (reasoning "a new part starts at the top of its own
    fresh page, so these are the same system anyway"). Wrong on a real file (`Teutonia.pdf`): a
    short part can end and the next part begin PARTWAY DOWN THE SAME PHYSICAL PAGE, so the new
    part's own label sits beside ITS OWN system, not the page's first one — using the page's
    topmost system looked in completely the wrong vertical band and found nothing. **Fixed** by
    using the boundary's own system directly as the reference band instead — simpler than the
    original design AND correct for the (still more common) case where it's also the page's first.
  - **Verified against the real "Full band arrangements" folder** (the folder this feature targets):
    of its 4 files with a real detected part boundary, only `Teutonia.pdf` has an actual PDF text
    layer on the relevant page (`KingCotton`/`Fat Burger` are genuinely scanned images there — this
    correctly does nothing rather than fabricate a name, exactly as designed). On Teutonia, "Section
    2" became **"TRIO"** — confirmed by rendering the real page: not an instrument name after all,
    but a real, legitimately-printed formal-structure marker ("TRIO," at the left margin, right
    before the system where the piece's Trio strain begins and measure numbering restarts) on what
    turned out to be a single-instrument Flute part, not a multi-instrument booklet. This is a
    genuine, verified win using the exact mechanism the backlog asked for — it just revealed that
    "no bootstrap page" files in this real corpus split on more than one kind of real boundary
    (instrument changes AND intra-part structural markers), and the same left-margin/letter-run
    logic correctly picks up either, which is a fair, arguably more useful generalization of the
    original "instrument name" framing.
  - **Verified no regression on already-correctly-named files**: `JugglingClowns`, `The Spanish
    Winds Trio`, and the rest of the already-working IMSLP trio folder were confirmed byte-for-byte
    unchanged (every one of their boundaries already has a name from title-matching, so
    `fillMissingSectionNames` never even reaches them — `if (b.name) continue`).
  - **Fully scanned files (Lazarus, and the other 2 of 4 "Full band arrangements" files with a
    reset boundary) correctly stay generically named** — there is no general-purpose text-reading
    OCR in this pipeline (only the existing, narrowly-scoped NUMBER-reading OCR), so a page with no
    embedded text genuinely has nothing for this feature to read. This is an honest limitation, not
    a bug: building general OCR text-recognition for instrument labels would be materially new,
    much larger scope, not attempted here.

- **General lesson tying all three findings together, worth carrying into future OMR work**: every
  one of these three "revisit an open question" items turned out to have a real, safe, well-
  evidenced fix once actually investigated with real data — none of them were the "no safe fix
  exists" outcome the original brief flagged as an acceptable possibility. The common thread across
  all three (and consistent with every fix earlier in this section) is that the ACTUAL blocking
  detail was one level more specific than the prior write-up's diagnosis (a chain-merge span cap,
  not a grouping-tolerance loosening; a per-segment plausibility ratio, not a whole-document
  coherence score; the boundary's own system, not the page's topmost one) — reinforcing this
  project's standing discipline: dump the real data and look at the real rendered page before
  concluding a problem is unfixable, don't stop at the first plausible-sounding root cause.

**A committed, repeatable accuracy benchmark now exists (2026-07-23) — `scripts/benchmark/`
(`run.mjs`, `backfill.mjs`, `report.mjs`), replacing "re-verify by hand every time" with a trend
you can track across commits.** Built and tested against a small hand-made placeholder plus
whatever real ground-truth files the parallel corpus-labeling effort had already produced at the
time (see QA persona for the full infra write-up) — two real findings worth recording here since
they're about this domain's own data shapes, not just test-runner mechanics:
- **The real ground-truth schema the labeling agents converged on independently** (`sections:
  [{name, startPage, isGeneric}]`, `totalSystems`, `tempoMarks`) **differs from what a
  from-scratch design would guess** (flat `sectionNames`/`systemCount`/`tempoBpms` arrays) — found
  only because two real labeled files already existed in `benchmarks/ground-truth/` by the time
  this was built, and were read before finalizing the loader rather than assumed. General lesson,
  same shape as this project's "read the real getTextContent() output before coding against it"
  precedent: when a schema is being produced by parallel work, inspect real instances of it before
  committing to your own guess, even under time pressure to keep moving.
- **A single-section file's implicit section is always named `"Score"`** — both by
  `buildSections()`'s own fallback (`i === 0 ? 'Score' : ...`) and, independently, by the
  labeling agents' own convention (confirmed on real ground-truth files) — even though the app's
  `#sectionsSelect` dropdown never renders at all for this, by far the most common, case (see this
  section's "Sections are saved snapshots" note above on why the UI stays hidden here). The
  benchmark's DOM-only driver (`scripts/benchmark/lib/appDriver.mjs`) scores this hidden-dropdown
  state as the app having reported `['Score']`, not `[]` — scoring it as `[]` would have wrongly
  zeroed out section-name accuracy on every ordinary correctly-behaving single-part file, the
  overwhelming majority of this app's real target audience (Music Educator persona).

**A dev/benchmark-only "force OCR" validation pass (2026-07-23) — measuring OCR's real measure-
number-reading accuracy against trusted ground truth, not just on scanned files where ground truth
itself is lower-confidence:**
- **Motivation:** `ocrPageNumbers()`'s OCR fallback normally only ever runs on scanned/image-only
  pages, exactly where this project's own ground truth is *also* least confident (scan quality
  makes the "true" measure numbers themselves harder for a human labeler to verify — see the
  Lazarus/KingCotton ground-truth files' own confidence caveats above). Text-layer PDFs give a
  controlled way to measure "how good is OCR alone at reading printed measure numbers," using
  numbers this project is much more confident about, by deliberately forcing every page's
  measure-number reading down the OCR path even though a real text layer exists, then scoring
  against the SAME ground truth the normal (text-layer) pass already gets scored against.
- **Mechanism chosen: a URL query parameter (`?forceOcr=1`), read fresh once per `analyzeScore()`
  call via `location.search`** (`isForceOcrRequested()` in `scoreAnalysis.js`), folded into the
  existing per-page decision as `const usedOcr = (forceOcr || !pageItems.some(...)) &&
  systemsOnThisPage.length > 0`. Chosen over a hidden UI toggle or a build-time flag specifically
  because it's real, working production code (not a test-only stub or monkeypatch) while staying
  genuinely inert for a real user — nothing in the UI reads or sets it, there's no visible
  control, and no ordinary user would ever hand-type `?forceOcr=1` onto the app's URL. The
  benchmark driver (`scripts/benchmark/lib/appDriver.mjs`'s `withForceOcr()`) just navigates to
  that URL before clicking Analyze; `analyzeFile()` itself needed zero changes since navigation was
  already a separate step the caller controlled.
- **Real, surfaced-during-implementation scoping correction to the original plan: forcing OCR
  does NOT cleanly touch "measure numbers only" — it also fully suppresses real tempo-mark
  reading for any page it forces onto the OCR path, for a structural reason, not a new bug.**
  `extractTempoMarks()` (the real numeric `♩=N` reader) lives in the SAME non-OCR `else` branch as
  `extractMeasureNumbers()` in `scoreAnalysis.js`'s per-page loop, not a separate call gated
  independently — so a forced-OCR page loses its tempo marks too, with nothing (there's no
  OCR-based tempo reading) reading them instead. This is completely harmless for a REAL `usedOcr`
  page (image-only, so there was never tempo text there to lose) but becomes real the moment a
  text-layer page is forced onto that path. Section-title matching
  (`findSectionTitle`/`collectKnownNames`) is genuinely unconditional, as originally assumed —
  it reads `pageItems` directly, before the `usedOcr` branch. **Net effect, and why the validation
  script scores only system count + measures-per-system, never section names or BPM:** section
  names are unaffected either way (nothing to demonstrate); BPM isn't merely "not exercised" the
  way the original framing assumed, it's actively zeroed out by this mechanism — scoring it would
  have measured "does forcing OCR delete tempo marks" (trivially yes, every time) rather than
  anything about OCR quality.
- **New script: `scripts/benchmark/run-ocr-validation.mjs`** (own npm script,
  `benchmark:ocr-validation`), reusing `lib/scoring.mjs`, `lib/groundTruth.mjs`, `lib/devServer.mjs`,
  and the existing `lib/appDriver.mjs` (extended with the one-line `withForceOcr()` helper, not
  duplicated). For each ground-truth file: runs a normal baseline pass first to confirm THIS run
  actually has `usedOcr: false` (skips a file that already uses OCR normally — nothing to force
  away from there), then re-analyzes the same file with `?forceOcr=1` and sanity-checks the app's
  own summary text actually flips to "No embedded text..." this time (confirms the mechanism
  genuinely engaged, not just assumed). Writes to `benchmarks/ocr-validation/<date>-<sha>.json` —
  deliberately NOT `benchmarks/snapshots/`, and `report.mjs`'s per-commit trend table intentionally
  never reads this directory, since this is a synthetic "what if" probe, not "how the app behaves
  for real users today."
- **Real numbers from a full 39-file corpus run (2026-07-23, commit `c18988e`):** 32 of 39
  ground-truth files have a real text layer in a normal run (the other 7 — the two scanned "Full
  band arrangements" booklets not yet OCR'd here plus a few others — already use OCR normally and
  were correctly skipped, nothing to force). Across those 32: **system count accuracy was
  identical (81.4%) between the normal and forced-OCR pass on every single file** — confirms
  forcing OCR genuinely doesn't touch system detection at all, exactly as designed (system count
  comes from pixel/staff detection, upstream of and independent from the measure-number-reading
  branch). Of those 32, only **18 had the app's own system count exactly matching ground truth**
  (the other 14 — mostly the IMSLP trio "Score and Parts" files — are a *separate*, pre-existing
  system-over-detection gap this task didn't investigate further, unrelated to OCR forcing one way
  or the other) — measures-per-system accuracy is only meaningful on those 18 (see
  `measuresPerSystemAccuracy`'s own "only comparable when system counts match" design, `scoring.mjs`).
  On those 18: **real text-layer reading averaged 81.3% exact-match accuracy (mean abs error 0.79
  measures/system); the SAME 18 files, forced through OCR instead, averaged 71.0% (mean abs error
  1.22)** — a real, meaningful accuracy gap, but a much smaller one than "OCR barely works at all"
  would have suggested: most individual files lost roughly 10-30 points of exact-match accuracy
  (e.g. 95%→76%, 89%→67%, 83%→42%) rather than collapsing, and a few files (the `randomclarinet`
  folder, `Bouree - Händel`, `A Cruel Angel's Thesis`) scored byte-for-byte IDENTICAL in both passes
  — those happen to be files where barline-count + refinement already carries most of the correct
  answer with little contribution from the printed numbers either way, so OCR misreads had nothing
  to corrupt. One file (`Peace_Sign Clarinet`) actually scored slightly HIGHER under forced OCR
  (87%→93%) — a reminder that "OCR is strictly worse than the real text layer" is a good average
  statement, not a guarantee for every individual file.
- **General lesson for future OMR persona work: a plan's own "which downstream reads get touched"
  assumption is worth re-deriving from the actual branch structure before building the validation
  harness around it, even when the assumption sounds obviously right** — the BPM-suppression side
  effect here wasn't a hidden bug so much as an artifact of `extractTempoMarks()` sharing a branch
  with `extractMeasureNumbers()` for an unrelated reason (both only make sense to read from a real
  text layer), but it meant the *actual reason* to exclude BPM from this validation was different
  (and more interesting) than the reason assumed going in.

**Benchmark suite hardened + a real 6-commit historical trend recorded (2026-07-23).** Two real
bugs found on the first full-corpus run, both fixed:
- `scripts/benchmark/lib/appDriver.mjs`'s two `page.waitForFunction(fn, { timeout })` calls passed
  the options object as the SECOND positional argument -- Playwright treats that as the page
  function's `arg`, not `options`, silently falling back to its own 30s default regardless of the
  configured `loadTimeoutMs`/`analyzeTimeoutMs`. This is the exact same argument-order mistake
  already found and fixed once earlier this project in a hand-written Playwright driver script --
  confirmed here by the fact it broke in exactly the predicted way (timing out the 3 largest/
  slowest OCR-fallback files at 30s instead of their real 600s budget). Fixed by passing `undefined`
  as the third-positional `arg` and moving `{ timeout }` to the real options position.
- `#autoScrollTempoInfo` is deliberately blank for a flat, non-changing tempo (see
  `autoScrollUI.js`'s `refreshTempoInfo()`) -- reading only that banner therefore reported `[]`
  (indistinguishable from "nothing detected") for every single-tempo file in the corpus, even ones
  the app correctly detected and adopted a real printed tempo for. Fixed by also reading `#bpmV`
  (`"<n> bpm"`, reflecting `state.autoScroll.bpm`) as a fallback, compared against a baseline
  captured from a fresh page BEFORE any file was loaded (not an assumed hardcoded default) --
  BPM sequence accuracy went from 68.6% to 96.8% on the very same data purely from this tooling fix,
  confirming it was a benchmark blind spot, not a real app deficiency.

**Metrics now segmented by text-layer vs. scanned/OCR PDFs, not just one blended "overall" number**
(`run.mjs`'s `summarizeGroup()`, `report.mjs`'s per-group tables) -- this was necessary, not
cosmetic: blending the two regimes was hiding that section-name accuracy on scanned/OCR files
(28.6%-33.3% across every commit checked) is barely a third of text-layer files' (63.8%-81.7%,
improving over time) -- see the trend table below.

**`appDriver.mjs` made tolerant of DOM elements that don't exist yet on an old historical commit**
(`safeEval()`, defaulting to a safe fallback instead of throwing) -- found necessary backfilling
this project's own two oldest candidate commits: `#autoScrollTempoInfo` didn't exist until a later
commit (`294d43a`), and `49c66a4`'s Sections picker was still per-row text inputs, not yet the
`#sectionsSelect` dropdown this driver reads. Without this, both commits failed EVERY one of 39
files outright, discarding even the system-count data that genuinely did exist and is comparable
that far back -- full backward compatibility with every historical UI shape (e.g. reading the old
per-row inputs) was NOT attempted (real, accepted scope limit -- those two commits' `sections`/
`measures`/`tempo` data stays unrecoverable, but their system-count data isn't wasted anymore).

**Real 6-commit trend, current corpus/scoring logic applied retroactively via `git worktree`**
(`benchmark:backfill`, then `benchmark:report`) -- picked to span the feature's real evolution:

```
Date        Commit   Overall: SysCount SecName Measures BPM   | Text-layer SecName/Measures | OCR SecName/Measures
2026-07-20  49c66a4  80.6%    63.8%    3.1%    43.6%          | 63.8% / 3.1%   (no OCR yet)  | n/a
2026-07-20  89bab60  81.9%    65.9%    66.0%   43.6%          | 65.9% / 66.0%  (no OCR yet)  | n/a
2026-07-21  b58b58d  80.3%    65.9%    79.2%   96.8%          | 74.0% / 80.9%                | 28.6% / 63.9%
2026-07-21  41fa477  80.3%    65.9%    81.4%   96.8%          | 74.0% / 80.9%                | 28.6% / 86.1%
2026-07-22  1e742bd  81.1%    72.2%    81.7%   96.8%          | 81.7% / 81.3%                | 28.6% / 86.1%
2026-07-23  c18988e  80.6%    72.2%    81.7%   96.8%          | 81.7% / 81.3%                | 28.6% / 86.1%
```

Two real, opposite-valence findings this makes concrete rather than anecdotal:
- **`89bab60`'s own commit message ("fix multi-staff system grouping") is dramatically confirmed**:
  measures-per-system accuracy jumps from a barely-functional 3.1% to 66.0% in exactly that one
  commit -- the single largest jump in the whole trend, and it's the correct commit for it.
  `1e742bd`'s section-name jump (65.9%→72.2% overall, 74.0%→81.7% on text-layer files specifically)
  likewise lands exactly on the commit that introduced numeric-tempo-mark section detection +
  measure-number-reset boundaries, as expected.
- **The scanned/OCR segment's section-name accuracy has not moved AT ALL across every commit that
  has OCR fallback at all (28.6% flat, `b58b58d` through current `c18988e`)** -- despite real,
  substantial engineering effort across this exact span specifically targeting this case
  (measure-number-reset section boundaries, `fillMissingSectionNames`'s real-name-filling, the
  Item-2/plausible-section-span over-split guard). Consistent with, and now quantifying, this same
  section's own per-file finding that these fixes added MORE sections to scanned booklets
  (Teutonia 1→2, etc.) without making them reliably NAMED CORRECTLY (generic labels, or occasionally
  a wrong boundary like Teutonia's "TRIO") -- this is the one metric in the whole trend that reads
  as a real, unresolved gap rather than steady progress, and is the most promising place to look
  next if section-name accuracy on scanned booklets specifically is a priority.

**Investigated (2026-07-23, follow-up session) -- root-caused with real evidence, but NOT fixed
this round (a diagnosis + proposed direction, per this session's own explicit "don't rush a fix"
instruction): why `detectMeasureNumberResets()` barely fires on Teutonia/MonogramMarch/KingCotton/
Fat Burger despite being purpose-built for exactly this case.**
- **It's not a `detectMeasureNumberResets` logic problem at all -- it's that the OCR pipeline feeding
  it is producing almost no usable data for the vast majority of these documents.** Dumped the real
  entries feeding it on Teutonia (a temporary debug hook, reverted): only the first 12 of 79 systems
  (the systems with a genuine PDF text layer -- this file is a real MIXED document, as already
  documented) have any real measure-number entry at all; of the remaining 67 systems (85% of the
  document), OCR produced **zero** usable BOX entries and only **2** usable STRIP entries, total,
  across all 18 OCR-fallback pages on this file. `detectMeasureNumberResets` has nothing to detect a
  reset FROM for 85% of the document -- not a threshold or algorithm gap.
- **Root cause of the OCR starvation, confirmed by saving and visually inspecting the actual box
  crops sent to Tesseract (not assumed from confidence numbers alone): `locateMeasureNumber()`'s
  "topmost ink blob in the left margin above the staff" heuristic is confidently finding a box on
  nearly every system (`nBoxesLocated` ≈ `nSystems` on every page checked) -- but the crops
  themselves are consistently NOT measure numbers.** Real saved crops showed, variously: actual
  music notation (noteheads/stems), a clef/key-signature cluster, a rehearsal-mark/repeat bracket,
  and (on one page) the instrument's own printed name label ("Eb CLAR..."). Tesseract's confidence
  on these genuinely-non-number crops is correctly near-zero (observed 0-1 against a `minConfidence
  = 55` gate) -- the confidence gate is working exactly as designed, rejecting garbage rather than
  fabricating a number; the real gap is one step upstream, in what gets handed to it.
- **Working theory, not yet verified against the source engraving directly: this scanned corpus's
  actual print convention may not put a measure number above every system at all** (older
  public-domain band-part booklets often number only every 5-10 measures, or only at a line/page
  break) -- unlike the modern notation-software exports `locateMeasureNumber` was built and
  validated against, where a number is printed every system. If true, the "topmost ink above the
  staff" heuristic has nothing real to find on most systems and will always grab the nearest
  unrelated ink instead; no confidence threshold or reset-detection tweak downstream can fix an
  upstream location failure like this.
- **Proposed next step, not attempted here**: before touching `locateMeasureNumber` or
  `detectMeasureNumberResets` again, render and visually inspect a handful of real full pages from
  this specific corpus (not just the cropped boxes) to confirm/deny the working theory above -- if
  numbers really are sparse in the source engraving, the realistic fix is accepting that most
  systems on this class of scanned booklet will never have a real printed-number reading (the
  barline-count fallback already handles this gracefully) rather than chasing a location heuristic
  that has nothing reliable to locate; if numbers ARE present every system but positioned/sized
  differently than this heuristic assumes, the fix is a geometry adjustment to `locateMeasureNumber`
  specifically calibrated against THIS corpus's real crops, the same way `pad=20`/`minFrac=0.95`
  were calibrated against their own real target files.
- **Teutonia's "TRIO" false positive (also asked about in this same investigation) is explained by
  the data that DOES exist, not a new bug**: the 12 real text-layer entries show a genuine, cleanly-
  read drop (measure 31 -> 3) right where the piece's Trio strain begins -- `detectMeasureNumberResets`
  and `plausibleSectionSpan` both behave exactly as designed on this real data (ratio 76/73 = 1.04,
  comfortably above the 0.5 threshold); the boundary is real and correctly detected, it's just a
  formal-structure marker rather than an instrument change, exactly as already documented above. Nothing
  to fix here specifically -- it's a correct detection of a real, if differently-typed, boundary.

**Follow-up (2026-07-23, later same day): the "geometry adjustment" branch of the proposed next
step above, confirmed for one file — Fat Burger prints its measure numbers BELOW the staff, not
above.** Rendered and visually inspected real full pages from Fat Burger (the corpus's own
regression-guard file for this investigation) to check the two branches the prior write-up left
open — sparse source printing vs. a geometry mismatch. For Fat Burger specifically, it's geometry:
the engraving prints a number under literally every measure, with rehearsal letters in boxes above
the staff instead (`locateMeasureNumber()`'s "look above the staff" assumption was pointed at the
wrong region for this file's own convention, not looking for something that wasn't there). **Fix
built:** `lib/measureNumberLocate.js` gained `locateMeasureNumberBelow()` (mirrors the existing
above-staff locator, scanning `systemBottom + 0.08..1.0` staff-heights, calibrated against this
file's own real rendered pixels — a ~2-9pt gap before the number, a ~50pt+ clear gap before the
next system's own content begins); `ocr.js`'s `ocrNumbersByBox()` tries the above-staff box first
and only falls through to the below-staff box if that one fails the confidence gate, so files where
the above-staff read already works are completely unaffected; `scoreText.js`'s
`extractMeasureNumbers()` got the equivalent `padBelow` extension for the text-layer path. 4 new
unit tests, full suite green (307 passing), lint clean, no regressions on any of the other 3
regression-guard files.
- **Real, honest limit of this fix, confirmed by re-running the benchmark before and after: zero
  movement in any of the scanned/OCR group's aggregate numbers** (77.6%/28.6%/86.1%/85.7% —
  identical). Fat Burger's own raw `measuresPerSystem` data did change in several places (finer,
  more accurate per-system counts where a below-staff number is now actually read instead of
  missed) — a real, verified improvement to reading quality — but it doesn't move any *scored*
  metric for this file: `systemCountAccuracy` is unaffected (261 detected vs. 391 true systems —
  this fix reads numbers for systems already found, it doesn't find more systems), and
  `sectionNameAccuracy` stays 0 (still "Score"/"Section 2" vs. 19 real instrument names — section
  *naming* depends on the text-layer name-detection path, which this fix doesn't touch). **This is
  a genuine, narrow improvement worth keeping, not a fix for "why section-splitting barely works
  on scanned files" — that broader question is still open.**
- **What this investigation did NOT resolve, and shouldn't be assumed resolved: whether Teutonia/
  MonogramMarch/KingCotton's own sparse-OCR-data problem (documented above — 85% of Teutonia's
  systems have zero usable measure-number reading at all) is the same below-staff-geometry issue
  or the original "numbers genuinely printed sparsely in the source" theory.** The session that ran
  this specific check ended before reaching a documented conclusion on those 3 files — this
  write-up covers only what was independently confirmed afterward from the surviving code, its
  tests, and a fresh benchmark run, not a claim about what that session concluded for the other
  files. Follow-up investigation into those 3 specifically is the natural next step.

**Follow-up (2026-07-23, later still): resolved for all 3 remaining files — Teutonia,
MonogramMarch, and KingCotton all confirm the OTHER branch of the open question, the opposite of
Fat Burger's.** Rendered real full pages of all three at scale 2.0-2.5 via a headless Chromium page
driving pdfjs-dist directly (`getDocument`/`page.render` to a canvas, screenshotted — the same
technique class as the Fat Burger session, no app/dev-server needed since this only needed pixels +
`getTextContent()`, not the app's own detection code), and visually inspected a spread of
instruments/pages per file (Teutonia: Piccolo, Oboe, Eb Clarinet, Tenors, Flute — pages 2,3,4,6,15;
MonogramMarch: Flute, Oboe — pages 2,4,5,6; KingCotton: Piccolo, Solo Cornet, Baritone Sax — pages
1,3,12,20). **Verdict: sparse/absent-printing confirmed (theory a) for all three — none of them
prints a per-system measure number anywhere in their scanned parts, above the staff, below the
staff, or anywhere else.** This is not the same finding as "OCR can't read it" — the numerals
simply aren't there to read.
- **What IS actually printed in the exact region `locateMeasureNumber()` scans, identified
  precisely this time (a real upgrade on the prior session's looser "notation/clef clusters,
  rehearsal marks" description) — three distinct real numeral types that are legitimate printed
  digits, just never a measure number:**
  1. **Multi-measure-rest counts.** A horizontal thick bar (the standard multi-bar-rest glyph) with
     a small number directly above it stating how many measures it spans — confirmed on Teutonia
     p2 ("2" over 2 rest-measures, later "3" and "8" over longer rests) and KingCotton p20 (boxed
     "3" appearing twice over separate multi-bar rests). This is the single most dangerous
     false-friend for this heuristic: it's a real number, in the right general position (above the
     staff, left-ish), that looks exactly as plausible as a genuine measure number until you check
     what it's actually counting.
  2. **Plate/catalog numbers.** KingCotton prints "173" at the very top-left of the FIRST system on
     the Solo Cornet and Baritone Sax parts specifically (same position `locateMeasureNumber` grabs
     for a real system-opening measure number) — identical across those parts (a document-level
     plate number, not anything per-system or per-part), and reads as a perfectly legible number to
     an OCR pass with no reason to distrust it structurally. Other parts of the same file (Piccolo)
     instead print a different catalog code ("34007-11") at the page BOTTOM, outside either scan
     region — confirming this varies by original print-run convention within a single file, not a
     fixable single offset.
  3. **Repeat-ending brackets ("1"/"2") and "Trio" labels.** Present on every file, every instrument
     — a real printed "1" or "2" bracketed at a repeat, or the word "Trio" marking the second-strain
     entry point. Neither denotes measure count.
- **The one real per-system, per-measure numbering convention found in this whole exercise is the
  same shape as the "genuine text-layer" pages already known about, not a new one**: both Teutonia
  (page 3, "FLUTE" part) and MonogramMarch (pages 4-5, "MONOGRAM MARCH-FLUTE") contain a single
  MODERN re-typeset part mixed into an otherwise all-scanned, decades-old engraving — confirmed via
  `getTextContent()` returning hundreds of real text items on exactly those pages (`"1"`, `"2"`,
  `"49"`, `"50"` etc. as literal, isolated text runs) vs. zero items on every scanned page. That
  modern part numbers literally every measure with a small italic number above the barline — this
  is where the previously-documented "first 12 of Teutonia's 79 systems have a genuine reading"
  comes from: not 12 systems spread across the document, but ALL 12 systems of that one Flute page
  (its whole part fits on one rotated page). KingCotton has no such page at all — `getTextContent()`
  returned zero items on literally all 40 pages, confirming it's a pure scan cover-to-cover with no
  modern-engraving exception anywhere.
- **No fix attempted, per this task's own explicit instruction not to force one under theory
  (a).** There is no real per-system measure number in these files' scanned parts for
  `locateMeasureNumber()`/`locateMeasureNumberBelow()` to find under any geometry adjustment — the
  gap is the source content, not the scan region. Inventing a detector that manufactures a "measure
  number" out of a rest-count or a plate number would be strictly worse than the current behavior
  (Tesseract's confidence gate silently rejecting these, or `locateInBand` finding nothing to
  locate at all): the barline-count fallback already handles "no reliable number reading" correctly
  and gracefully for exactly this case. Confirmed the already-shipped `locateMeasureNumberBelow()`
  (Fat Burger's fix) doesn't regress anything here either — the below-staff margin is genuinely
  blank ink on every sampled system across all three files, so it correctly returns `null` (no ink
  blob to find) rather than grabbing something spurious.
- **No code was touched this session** (`measureNumberLocate.js`, `scoreText.js`, `ocr.js`,
  `scoreAnalysis.js` are all unchanged from the Fat Burger session's own commit), so no test run or
  benchmark re-run was needed or performed — the existing benchmark numbers for the scanned/OCR
  group already reflect the correct, unchanged behavior for these 3 files.
- **This closes out the open question left by both prior write-ups**: of the 4 files investigated
  across this whole thread, exactly 1 (Fat Burger) was a genuine geometry mismatch (numbers below
  the staff, now fixed), and 3 (Teutonia, MonogramMarch, KingCotton) are genuine sparse/absent
  source printing where the honest, safest thing this pipeline can do is exactly what it already
  does — fail to find a number and let the barline-count fallback carry the file. Any future push
  on this specific class of scanned/OCR file's accuracy should look elsewhere (e.g. the
  already-flagged flat 28.6% section-name accuracy across every OCR-fallback commit), not at
  `locateMeasureNumber`'s own geometry again — this corpus has now been checked from both branches
  and both are exhausted for these 4 files specifically.

**Every mean in the benchmark's output now ships with its own population stddev** (`scoring.mjs`'s
`stddev()`, `run.mjs`'s `summarizeGroup()`, `report.mjs`'s trend table) -- found necessary
because the flat-looking ~80% system-count mean above was hiding real movement in BOTH directions
underneath it: per-file trend data (not shown in the table above, but pulled directly from the
snapshots) shows System count stddev sits at a consistent ~26-27 points on that 80% mean across
every commit, and section-name stddev is wider still (37-45 points) -- confirming this corpus is
genuinely bimodal (~20 simple single-page files scoring 99-100% since the very first commit
measured, unchanged; ~19 hard files with real, spread-out, independently-moving accuracy). Two
concrete findings this same per-file digging surfaced, from data the aggregate alone would never
have revealed:
- **A real regression, not just a gap: Fantastic Parade's own system-count accuracy has gotten
  WORSE across this history (93%→93%→68%→68%→68%→48%)**, with the second, sharpest drop landing
  exactly on last session's own staff-density fix (`c18988e`) -- that fix was correctly verified
  against its 4 target files (Teutonia/MonogramMarch/Fat Burger/KingCotton all improved and were
  confirmed unchanged elsewhere), but no independent ground truth existed for Fantastic Parade at
  the time, so its rising raw count (417→480) read as progress against its OWN prior count when it
  was actually overshooting relative to the true 315 -- exactly the kind of miss real ground truth
  (not just "did the count go up") is for. Not yet investigated further or fixed.
- **A completely untouched, wide-spread bug**: a cluster of IMSLP trio "Score and Parts" files
  (Cuban Dancer 44%, Mystery Man 41%, Waltz Trio 51%, Running Scared 59%, My Happy Life 62%,
  Melancholic 57%, Arno Andiam 14%, and East Meets West at **0%** -- the single worst file in the
  entire corpus) have shown byte-identical system-count accuracy across all 6 commits measured,
  meaning none of the rotation/section/staff-density work done across this whole span ever touched
  whatever is over-counting systems on these specific, otherwise-clean vector files. Given how many
  files this affects and that it's never been looked at, this is likely the single highest-leverage
  unexplored investigation in the current backlog. Not yet investigated.

**Both regressions above were root-caused and fixed in the same follow-up session (2026-07-23),
via the same "dump real gap data before touching thresholds" discipline as every prior fix in this
section, plus two smaller findings (section-splitting on Fantastic Parade, and a Clarinet-1/2
naming bug) that fell out of the same investigation:**

- **Fantastic Parade fix: the n=2 grouping-consistency exact-match rule (the Teutonia fix, above)
  had a second real shape it didn't cover.** Dumping the real, complete per-page ink rows for
  Fantastic Parade's 9 combined-score pages (all 9 are byte-identical in raw layout -- a repeating
  template) showed each page's real 20-staff brace (winds panel, then brass panel) plus ONE
  separately-notated percussion staff produces exactly 2 kmeans2 groups of sizes `[20, 1]` --
  rejected by the exact-match rule (`20 !== 1`), falling the WHOLE page back to 21 one-staff
  systems and destroying the correctly-detected 20-staff brace along with it. A naive first fix
  ("a size-1 group can never itself be inconsistent, so accept pairing it with anything") was tried
  and found genuinely UNSAFE by git-stash A/B against the 4 regression-guard files: real scanned
  single-staff booklets (no bracing anywhere) can ALSO produce a `[N, 1]` split from ordinary scan/
  binding noise isolating an edge staff (e.g. Teutonia p.9's real gaps `[212.3, 118.3, 112, 120.4,
  106.3]` -> sizes `[1, 5]`), and the naive rule wrongly merged those real, separate solo staves
  into one fake system (confirmed: 5 real systems collapsed into a 474-row blob). **Fixed** by
  gating the singleton exception on the non-singleton side being LARGE (`MIN_BRACE_SIZE_FOR_
  SINGLETON_EXCEPTION = 15`) -- calibrated against real data, not guessed: across all 4 regression-
  guard files' real pages, the worst false-positive "big" side topped out at size 9 (Fat Burger
  p.31); Fantastic Parade's real case is 20. 15 sits with real margin on both sides. **Verified**:
  all 4 regression-guard files byte-for-byte unchanged (79/157/209/265 systems); Fantastic Parade's
  real (ground-truth-confirmed) system count went from 480 down to **309** against a true 315 --
  system-count accuracy 47.6%→**98.1%** via the committed benchmark tool itself (single-file run,
  before/after).
- **Fantastic Parade's zero section splits, investigated in the same pass, turned out to be a
  SEPARATE bug (not fixed by the system-count fix) with the same root shape already documented
  above for `collectKnownNames`'s "Oboes 8 J" compromise.** On this real file, its compact
  left-margin layout puts literally EVERY instrument's own time-signature glyph noise onto the same
  row as that instrument's name (not just Oboes) -- so `collectKnownNames` collected almost nothing
  usable ("Oboes 8 J", "Clarinet 1 in B b 8 J", etc.), and since `findSectionTitle`'s match test
  only ever checks whether a LATER page's row STARTS WITH the stored name, a trailing-contaminated
  name can never re-match a later page's own clean text at all -- this is exactly the "lesser-harm
  tradeoff" the original fix accepted, just never revisited to see how often it actually bites.
  **Fixed** by recognizing a structural fact confirmed on this real file: real notation software
  draws a complete instrument name as ONE pdfjs text item (`"Alto Saxophone 1"`, `"Clarinet 2 in
  B"`, etc. are each already a single item, never built word-by-word) -- so `groupIntoRows` now
  also exposes each row's own leftmost item's text (`firstItemText`) alongside the existing full
  joined `text`, and `collectKnownNames` adds it as a SECOND candidate name whenever it differs.
  Harmless when a row is already clean (the two are identical, deduped by the existing `seen` set)
  and harmless for a genuinely separate multi-line label (each of its own rows' first item is
  already that whole row). **Verified**: section-name accuracy on this one file went from
  4.2%→**58.3%** (Score + 20 of 23 real named instrument parts, up from Score alone) -- the 3
  missing are percussion staves, a real, different, already-documented notation convention (they
  sit below system 0's own band so never qualify as `isFull`, not a regression from this fix).
- **IMSLP trio over-counting fix: the `kmeans2` bimodality PRE-FILTER (`>= 0.3`), not the grouping-
  consistency check itself, was the actual blocker -- and it was never validated against a real
  multi-page combined score, only guessed.** Dumping real gap data for the worst files (East Meets
  West, Cuban Dancer Trio, Spanish Winds Trio, and 5 more) showed an extremely consistent real
  shape: a combined score's own title page (generous spacing, 1 system per page) groups fine (ratio
  0.7-0.8), but its CONTINUATION pages (4 systems/page, less breathing room) measure a real
  within-brace-vs-between-system gap ratio of only **0.20-0.26** -- comfortably bimodal to a human
  looking at the page (4 clean groups of exactly 3 staves, every time), but below the 0.3 gate, so
  these pages never even attempted grouping and fell back to one system per staff (12 "systems"
  instead of the real 4). **A flat lowering of the gate was tried first and found UNSAFE** by the
  same git-stash A/B discipline: on the real scanned single-staff regression-guard files, ordinary
  scan noise can ALSO clear a lowered gate (Teutonia p.16 measures 0.189; MonogramMarch p.7 measures
  0.251) and then get accepted by the EXISTING `>=3`-group "tolerate one non-conforming group" rule,
  which a near-uniform noise pattern can satisfy by coincidence (both pages happened to split into
  sizes `[1, 2, 2]` -- two accidental "pairs"). That tolerance is legitimate and already verified
  safe at the ORIGINAL 0.3 gate (a real 13-page braced quartet file), so removing it wasn't an
  option. **Fixed** with a two-tier gate instead: a weak signal (0.15-0.3) is only trusted when the
  resulting grouping is PERFECT (every group exactly the same size, no tolerance, no singleton
  exception either) -- a real combined score's repeated bracing clears this easily (4 groups of
  exactly 3), while noise-driven near-uniform splits on a real single-staff booklet don't. A strong
  signal (>= 0.3) keeps its existing tolerance untouched. **Verified with real before/after
  evidence**: East Meets West 27→**11** (exact match to ground truth's 11, 0%→100%), Cuban Dancer
  Trio 67→**43** (exact match to 43), Mystery Man 65→**41** (exact match), Waltz Trio 122→**82**
  (exact match), Running Scared 111→**79** (exact match), Melancholic Trio 107→**75** (exact
  match) -- 6 of 8 previously-broken files now land EXACTLY on ground truth. My Happy Life improved
  (58→50 against a true 42) but not exactly, and Arno Andiam Romanza (13, true 7) was unaffected --
  both have a genuinely irregular per-system staff count in the real engraving (confirmed via their
  own gap data: not every system on the page has the same instrumentation, e.g. a piano-only
  passage mixed with piano+clarinet systems), which this fix's deliberately-strict "must be
  perfectly uniform" requirement correctly declines to force a match for rather than risk a false
  positive -- a genuine, accepted residual, not a new bug. All 4 regression-guard files (Teutonia/
  MonogramMarch/KingCotton/Fat Burger) confirmed byte-for-byte unchanged throughout both fixes.
- **A third, smaller, independently-discovered bug fixed in the same pass: `findSectionTitle`
  returned the matched KNOWN NAME's text, not the matched ROW's own (more specific) text --
  confirmed causing "B♭ Clarinet 1" and "B♭ Clarinet 2" to both get named plain "B♭ Clarinet"** on
  several real IMSLP trio files (the exact bug the OMR persona's own backlog flagged as suspected
  but unconfirmed). Root cause: a combined score's braced Clarinet-1/Clarinet-2 staves print the
  SAME unnumbered label beside each ("B♭ Clarinet" -- the reader tells them apart by position, not
  a printed numeral), so `collectKnownNames`' dedup only ever keeps ONE generic entry; each part's
  own opening page DOES print its real numbered name ("B♭ Clarinet 1"/"2"), and both correctly
  match the generic entry via `startsWith` -- but the function then returned the STORED (generic)
  name for both, discarding the numeral. Since a match is only ever accepted when the row's text
  equals or extends the known name (never the reverse), the row's own text is always at least as
  specific -- returning it instead is strictly safe. **Fixed** (`findSectionTitle` now returns
  `row.text`) and verified via 6 new/existing unit tests (no existing test relied on the old
  `match.text` return distinguishing from `row.text`, confirming this was a real, previously
  untested gap rather than a deliberate design choice).
- **Regression coverage**: 4 new real-corpus-derived tests in `systemDetection.test.js` (the
  Fantastic Parade merge, the Teutonia false-positive guard, the East Meets West weak-gate merge,
  and the MonogramMarch weak-gate false-positive guard, all using literal real dumped row data) and
  4 new tests in `scoreText.test.js`/`scoreText.js` (firstItemText candidate collection, and the
  row-text-not-match-text return) -- 285 tests total (up from 277), all passing.
- **Verified against the FULL 39-file real corpus via the committed benchmark tool itself** (not
  just the targeted files above), run.mjs's own summary, before (committed `c18988e`) vs. after
  (this session's fixes, uncommitted):
  ```
                              Overall              | Text-layer          | Scanned/OCR
              SysCount SecName Measures BPM        | SysCount SecName    | SysCount SecName
  Before      80.6%    72.2%   81.7%    96.8%      | 81.4%    81.7%      | 76.7%    28.6%
  After       92.9%    72.5%   83.8%    96.8%      | 96.3%    82.1%      | 77.6%    28.6%
  ```
  System-count accuracy is the standout, real, corpus-wide jump (+12.3pp overall, +14.9pp on
  text-layer files specifically) -- exactly the two fixes above's real, intended effect, not
  overfitting to the handful of files directly targeted. A second, unplanned but very real
  knock-on benefit: measures-per-system is only ever comparable when system count matches ground
  truth EXACTLY (see this benchmark's own scoring design), so fixing system count on ~8 more files
  raised the comparable-file count from 20/39 to 28/39, which is most of why measures-per-system
  accuracy also rose (81.7%→83.8%) despite no measure-counting logic being touched this session.
  Section-name accuracy barely moved in the AGGREGATE (72.2%→72.5%) despite two real per-file wins
  (Fantastic Parade 4.2%→58.3%; several IMSLP trio files gaining their correct Clarinet-1/2 split) --
  expected, since both are large, real improvements diluted across a 39-file mean, not evidence the
  fixes are small. OCR section-name accuracy is confirmed unchanged (28.6%→28.6%), exactly as
  expected: item 3 above was investigated and root-caused but deliberately NOT fixed this round (a
  diagnosis + proposed direction, not a rushed fix, per this session's own instruction) -- OCR
  system-count nudged up slightly (76.7%→77.6%, within its own stddev) from unrelated small
  variation on one of the 3 non-"Full band arrangements" OCR files, not from anything touched this
  session (the 4 Full-band-arrangements regression-guard files were independently confirmed
  byte-for-byte unchanged throughout, per the git-stash A/B evidence above). All 39 files scored
  with 0 errors both before and after.

**Literature/prior-art research pass (2026-07-23, Feature Strategy-directed), checking five of this
persona's own detection techniques against academic OMR literature and real open-source OMR
projects (Audiveris, oemer, homr) for alternatives, improvements, or adjacent ideas — not a
re-spike of anything already answered above. Verdicts below, organized by file/technique:**

- **Page-rotation auto-correction (`lib/pageRotation.js`) — the academic "deskew" literature
  mostly doesn't apply here, because it's solving a different problem than this code has.** The
  large body of document-skew-detection work (Hough transform, Radon transform, projection-profile
  variance maximization) targets *continuous-angle* skew — a scanned page sitting a few degrees
  crooked on the platen — and is normally paired with a sub-pixel rotate-and-resample step. This
  code's actual bug (confirmed on real files, see the wrong-`/Rotate`-flag write-up above) is a
  *discrete*, already-known-to-be-one-of-4 problem: a PDF page's declared `/Rotate` flag is
  sometimes flatly wrong (0 vs. 90 vs. 180 vs. 270), not that the page content itself is drawn at a
  slight angle. Applying full Hough/Radon machinery to pick among 4 fixed candidates would be
  solving a harder, more general problem than the one that actually exists in this corpus — **not
  worth prototyping**, the existing `scoreOrientation`/`chooseRotation` ink-run-count approach is
  already the right-sized tool and is calibrated against real files.
  - **A real, different, and so-far-untested question this surfaces rather than answers: does any
    file in the real corpus have *continuous* few-degree skew** (e.g. a phone-photographed page,
    as opposed to a flatbed-scanned or notation-software-exported one)? None of the confirmed real
    bugs to date involve this — every one is a 90°-multiple `/Rotate` flag error — but the target
    audience's "minority scanned/photographed" case (persona 6) could plausibly include one someday.
    If it ever does, a lightweight *variance-of-row-ink-count-vs-rotation-angle* sweep (the same
    `scoreOrientation` signal, just swept over a fine angle range near 0/90/180/270 instead of only
    those 4 exact values) would be the natural, cheap extension — genuinely worth prototyping *if
    and when* a real skewed file actually surfaces, but not speculatively now; no evidence yet that
    it's needed.
  - **Tesseract's OSD (orientation & script detection) mode was checked as a possible "already-
    solved, reuse it" shortcut, since `tesseract.js` is already a lazy-loaded dependency for OCR
    fallback** — it works by classifying connected-component shapes against synthetically-rendered
    text at each of the 4 candidate rotations, i.e. the exact same "which rotation makes shapes
    correctly readable" idea, just for prose text instead of staff lines. **Not adopted**: it's
    fundamentally a *text* orientation detector, and its confidence signal comes from letterform
    recognition — for a music page (mostly staff lines, noteheads, and often little or no running
    text on an interior page) it would have far less to work with than this app's own staff-line
    ink-run signal, which is the actually-reliable structural feature on a page like this. Would
    also force loading the OCR worker on every page just to probe rotation, undermining the "OCR is
    lazy, only for genuinely image-only pages" design this codebase already deliberately keeps.
  - **A MediaPipe "document scanner" angle (raised as a possible thread, per this app's existing
    MediaPipe dependency) doesn't exist** — Google's on-device document-scanning/deskew capability
    is an Android ML Kit feature, not a MediaPipe Tasks (web) solution; nothing to adopt here, dead
    end confirmed rather than left open.

- **Staff/system detection (`lib/systemDetection.js`) — the one genuinely adoptable idea found: both
  Audiveris and oemer group staves into systems primarily via *barline continuity/alignment*, not
  (only) gap statistics.** Audiveris's GRID step gathers staves into systems "based on barlines found
  on the left side of the staves" plus detected brace/bracket connector glyphs; oemer (a from-scratch
  deep-learning OMR system, not Audiveris's classical pipeline) reports the same underlying idea in a
  different form — it "parses the barline information to infer possible grouping of tracks," i.e. a
  barline stroke that visibly continues unbroken from one staff's band down through the gap into the
  next staff's band is itself strong, direct, geometric evidence those two staves belong to the same
  system — a fundamentally different and more *direct* signal than this codebase's current approach
  (`kmeans2` bimodal clustering purely on staff-center *gap sizes*, with no reference to what's
  actually drawn in that gap). **Worth prototyping, not adopted yet:** this app already has the exact
  building block needed — `barlineDetection.js`'s column run-length ink scan already finds
  full-height vertical strokes within one system's own band; extending that same scan to check
  whether a candidate barline column's ink run *also* continues across the inter-staff gap between
  two adjacent detected staves would be a cheap, no-new-dependency, purely-geometric second signal to
  corroborate (or override) the current gap-based grouping decision — plausibly a more direct fix for
  some of the still-open residual cases this persona's own write-up already flags as irregular
  per-system staff counts (e.g. "My Happy Life," "Arno Andiam Romanza," where the current
  perfectly-uniform-groups requirement declines to merge a real but irregularly-instrumented system).
  Not attempted in this pass (out of scope — research only), but concrete enough to hand to a future
  session: reuse `findInkBlobs`/the barline column scan across the *inter-staff* band, not just the
  intra-system one.
  - **Attempted (2026-07-23) and falsified on the real corpus, across two independent
    implementations — not adopted.** The idea itself (barline continuity as a corroborating signal
    for system grouping) is exactly what Audiveris/oemer document, and the building blocks existed
    cheaply, so this was worth a real spike. Both attempts were fully implemented, unit-tested, and
    verified against the real 39-file corpus (not just synthetic fixtures) before being rejected —
    this is a genuine negative result, not an abandoned-early idea.
    - **Round 1**: a single-page signal — a candidate irregular group (gap-size clustering rejects
      it for non-uniform size, e.g. "My Happy Life"'s real 2-staff-then-3-staff pattern) is trusted
      if every internal staff-to-staff gap shows 2+ columns where ink runs the full 0.95-of-band-height
      bar on both sides AND is solid across the gap between them. **Result: never fired on either
      real target file.** Direct instrumentation against the real running app showed every genuine
      irregular page in "My Happy Life" and "Arno Andiam Romanza" produces EXACTLY 1 confirming
      column per gap, never 2+ — confirmed byte-identical app output before/after on both files.
      **Worse, on "Fat Burger parts with drums"** (a scanned single-staff-part booklet, unrelated to
      the target case) **several coincidental, genuinely-unrelated 2-staff pairings showed 4-7
      confirming columns** — more apparent "evidence" than either real target case ever produced —
      and fired a false merge, regressing that file's system count from 261 to 251 (true count 391).
      The confirming-column count runs BACKWARDS from what the design assumed: real bracing produced
      less local evidence than scan-noise coincidence did. No single per-page threshold value fixes
      the target files without also flooding Fat-Burger-style false positives.
    - **Round 2**: since real per-system instrumentation patterns repeat throughout a whole piece
      while single-page scan-noise coincidences shouldn't, the fix was redesigned around cross-page
      corroboration — a cheap first pass renders every page once (reusing that same render for the
      real per-page pipeline, so no added rendering cost), computes a coarse shape signature
      (staff count + bucketed internal spacing) for each candidate irregular group with at least 1
      confirming column, and only promotes a group to an actual merge if the SAME signature recurs
      with evidence on 2+ *distinct* pages of the document. Cleanly implemented (`computeGrouping`,
      `collectCandidateGroupSignatures`, `groupSignature` in `lib/systemDetection.js`;
      a `pageCache`-based two-pass pre-pass in `scoreAnalysis.js` that renders each page exactly
      once), thoroughly tested (18 new test cases including a full end-to-end simulation of the
      real cross-page tally), 326/326 suite passing, lint clean. **Verified against the real
      39-file corpus again — still does not help either target file** (still byte-identical output,
      before and after, on both "My Happy Life" and "Arno Andiam Romanza": their own real irregular
      shapes apparently never recur in a bucketed-signature-matching way across 2 distinct pages of
      their own documents either, despite recurring visibly to a human reader). **Fat Burger still
      regressed the identical way** (261→251) — its scanned pages share very uniform real staff
      spacing throughout (being one instrument's part, scanned from one physical source), so a
      coincidental noise "shape" is, if anything, MORE likely to coincidentally recur across 2+ of
      its pages than a deliberate one is to recur in a piece with more real instrumentation variety.
      **A third, new regression also appeared**: "HLazarus_3_Grand_Artistic_Duets" went from
      406→415 systems (true count 326), a file round 1 didn't touch at all.
    - **Verdict: dropped, not merged.** Two independently-designed, individually well-reasoned,
      individually well-tested implementations both failed to fire on the real cases they targeted
      and both introduced real regressions elsewhere in the corpus — the second attempt's
      regressions were a strict superset of the first's, not an improvement. This is strong enough
      evidence that a *local, per-page-or-cross-page geometric ink-continuity signal alone* cannot
      safely discriminate genuine repeated bracing from scan/print noise on this real corpus, at
      least not via the specific signatures tried (raw column-continuity count; coarse
      staff-count-plus-spacing shape matching). A future attempt would need either a fundamentally
      different discriminating signal (not just a stricter threshold on the same one) or to accept a
      narrower, more conservative scope than "any irregular grouping, anywhere" — e.g. requiring
      corroboration from a completely independent source (real barline/measure alignment against an
      already-known-good adjacent system) rather than shape-signature recurrence alone. Not pursued
      further this session; "My Happy Life" and "Arno Andiam Romanza" remain unfixed for now (still
      correctly falling back to one-staff-per-system, the safe conservative default — no regression,
      just no improvement either).
  - **The ML-based route (oemer's/homr's UNet segmentation models) is explicitly not worth
    it, exactly as the task's own framing anticipated.** Confirmed via oemer's own README: model
    checkpoints are large enough that first download is documented as "up to 10 minutes" — this is
    squarely the "a second multi-hundred-MB ML model" case already ruled out by this project's
    privacy/architecture posture (one ~13MB MediaPipe download is the app's one accepted heavy
    asset; a second, much larger one for a problem the existing classical approach already handles
    adequately for this audience's single-staff-part-common-case is not worth it). No genuinely
    lightweight ML alternative for staff/system segmentation was found in this search — every
    real learned-segmentation OMR project is UNet-or-larger scale, not a few-hundred-KB model.
  - **Academic staff-line detection research (the "stable paths" algorithm, Capela/Rebelo et al.,
    and its several follow-ups) targets a harder, different problem than this app has**: robust
    detection on *handwritten* or badly-degraded scores where staff lines are curved, broken, or
    inconsistently spaced — the paper's own framing is explicit that printed scores are already
    comparatively well-handled by simpler methods, and it's specifically handwritten-music
    recognition that "remains below expectations." This app's real corpus (persona 6: cleanly
    engraved band parts as the common case, scanned/photographed booklets as a real but minority
    case) has never needed anything past straightforward horizontal-ink-run scanning + 1D
    clustering — **not worth prototyping**, it solves a problem this app's real files don't
    actually have.

- **OCR fallback / measure-number location (`ocr.js`, `lib/measureNumberLocate.js`) — no better
  lightweight browser-feasible localization technique was found than what's already built, and a
  real full-OMR system's own documented approach is actually *less* targeted than this app's.**
  Audiveris delegates all text recognition (including, presumably, measure numbers — not
  separately documented as its own subproblem anywhere found) straight to Tesseract's own general
  text-block detection across the page, with no dedicated "find one isolated small numeral above a
  staff" step at all. This app's own two-method design (`BOX`: geometric ink-blob localization,
  narrowly targeted per system, then OCR just that crop at PSM 8; `STRIP`: hand the whole left
  margin to Tesseract's own PSM-11 sparse-text layout analysis and correlate results by position)
  already covers both ends of this spectrum — the narrowly-targeted approach AND the "let generic
  OCR do its own layout analysis" approach a reference OMR system relies on exclusively. **Verdict:
  this app's existing dual-method approach is already more sophisticated than what a real, mature
  reference OMR project documents doing for this exact subproblem — nothing to adopt from
  Audiveris here.**
  - **One classical-CV technique worth naming as a possible future refinement to the `BOX`
    locator specifically, not a replacement:** MSER (Maximally Stable Extremal Regions), the
    standard scene-text-detection primitive for finding text-like blobs of consistent contrast
    across multiple thresholds, is more tolerant of touching/low-contrast ink than the current
    single-threshold ink-run blob finder (`findInkBlobs`). **Marked "worth prototyping only if a
    real corpus file surfaces a genuine location failure that isn't already explained by the
    numbers simply not being printed every system"** — this persona's own already-recorded
    investigation (Teutonia/MonogramMarch/KingCotton/Fat Burger OCR starvation) found the real
    blocking issue on that corpus was upstream of localization entirely (the source engraving may
    not print a number every system at all), so a better blob-finder wouldn't have helped that
    specific, already-diagnosed case — no evidence yet that the *localization* step itself, as
    opposed to what it's given to find, is the bottleneck anywhere in the real corpus.
  - **No academic literature specifically on "OMR measure-number reading" as its own studied
    subproblem was found** — every full-OMR paper/system found treats measure numbers as generic
    page text (an OCR job), not a music-notation-specific recognition problem worth its own
    dedicated technique. This is itself a useful negative finding: this app's narrowly-scoped
    ink-geometry pre-locate step is a genuinely uncommon (not just under-published) refinement,
    not a reinvention of an existing documented technique.

- **PDF text-layer section/tempo/measure-number-reset detection (`lib/scoreText.js`,
  `lib/scoreSections.js`, `lib/tempoSchedule.js`) — confirmed: nothing meaningfully comparable
  exists in the literature or in real open-source OMR projects, and that's a genuine finding, not a
  failed search.** Every OMR paper, dataset, and open-source project found (oemer, homr, Audiveris,
  the LEGATO/LEGATO-2 vision-LM line of work, several PDF-to-MusicXML commercial tools) targets
  *image* input — pixels in, symbols out — with zero use of a PDF's own embedded text objects as a
  metadata source, even when the input PDF is itself a "born-digital" (notation-software-exported,
  not scanned) file where a real text layer demonstrably exists. The closest adjacent published
  idea found, "extraction of information from born-digital PDF documents" (a reproducible-research/
  document-analysis paper, not music-specific), confirms the general *technique* (parsing a PDF's
  real text/vector content stream instead of rasterizing and re-recognizing it) is sound and used
  elsewhere, but nobody has applied it to this specific music-score metadata problem — this
  project's own approach here is a genuinely novel (if narrow and low-effort-to-discover) niche, not
  a known-and-adoptable-from-elsewhere technique this write-up somehow missed. **No action item —
  there's nothing to adopt, and the existing approach is already correctly described elsewhere in
  this section as "a different, easier problem than full OMR," not a walk-back of that verdict.**
  One tangential but real observation while researching this: commercial "PDF/image → MusicXML"
  tools (e.g. Newzik, PDFtoMusicXML) advertise materially higher accuracy specifically on
  "born-digital" PDF input than on scans — consistent with (not contradicting) this project's own
  finding that a real text layer is a much stronger signal than pixels wherever it's available,
  just applied by those tools to full symbolic OMR rather than to the narrower
  section/tempo/measure-number metadata this app actually needs.

- **Time-signature glyph shape-matching (`lib/timeSigMatch.js`, `timeSigDetection.js`) — the
  existing backlog item (bundle real engraving-font reference glyphs) is confirmed low-cost and
  license-clear, and a cheaper zero-new-dependency alternative is worth trying first.**
  - **Bravura (the reference SMuFL font) is SIL Open Font License-licensed — free to bundle,
    embed, and redistribute, including in a project like this one** (the only restrictions are
    against selling the font standalone and against reusing the reserved name "Bravura" for a
    modified derivative — neither applies to using it as-is for template rendering). SMuFL also
    defines fixed codepoints for time-signature digits (`timeSig0`-`timeSig9`, U+E080-U+E089) — so
    the swap from the current `ctx.font = 'bold ...px sans-serif'` template generator to a bundled
    Bravura webfont is a small, mechanical change to `getDigitTemplates()` in `timeSigMatch.js`
    (load a self-hosted `@font-face`, same pattern already established for MediaPipe/tesseract.js
    self-hosting — see Privacy/Architecture persona — then render the SMuFL codepoint instead of
    the plain digit character), not a redesign of the matching algorithm itself. **This confirms
    backlog item B2 is worth doing, and de-risks it further than it already was** — license was the
    one unverified assumption behind it going in.
  - **A real caveat worth flagging alongside that confirmation, not found until actually checking:
    Bravura is one specific engraving font family among several in real-world use** (Finale
    historically defaults to its own proprietary Maestro/Broadway-style fonts; MuseScore's own
    current default is Leland, a Bravura-derived-but-distinct sibling; Dorico and most
    SMuFL-conscious tools do use Bravura or something close to it) — bundling Bravura templates
    should meaningfully improve match confidence over a generic UI sans-serif for *many* real files,
    but won't be a perfect match for every notation-software vendor's own digit glyph shapes. Worth
    validating against a handful of real files from different source software (this project's own
    39-file corpus almost certainly spans more than one originating tool) before assuming Bravura
    templates alone close the gap completely — a reasonable, well-scoped first step, not
    guaranteed to be the whole fix.
  - **A genuinely cheaper alternative worth prototyping BEFORE bundling any font, and not
    previously considered in the existing write-up: feed the same already-built high-resolution
    candidate-region crop (the 10x re-render `timeSigDetection.js` already produces) to
    `tesseract.js` instead of (or alongside) the grid-Jaccard shape matcher.** This has a real,
    concrete cost advantage over both the Bravura-template plan and an ONNX-based classifier: no
    new dependency and no new bundle weight at all for the files that matter most to this app's
    audience (persona 6's engraved-common-case), since `tesseract.js` and its self-hosted worker/
    model are already a lazy-loaded dependency for the OCR measure-number fallback — the only new
    cost is possibly triggering that same lazy load on a text-layer PDF that would otherwise never
    need OCR at all (a real but small, one-time-per-analysis cost, not a bundle-size cost). A
    general OCR model trained on varied real-world fonts and shapes is also very plausibly *more*
    tolerant of an unfamiliar engraving font's digit shapes than a rigid single-template Jaccard
    grid comparison is — genuinely untested here, but a real, falsifiable, cheap thing to try
    (render the same crop already produced, run it through the existing PSM-8 single-word Tesseract
    path already built for measure numbers, compare confidence/accuracy against the current
    matcher) before spending effort on either bundling a font or a learned classifier.
  - **A small ONNX Runtime Web-based CNN digit classifier was checked and is NOT worth it given
    this project's real constraints, confirming (not just assuming) the size math**: a trained
    MNIST-scale model itself can be genuinely tiny (a few hundred KB), but the WASM *runtime*
    onnxruntime-web needs to execute it is not — the default (non-simd/non-threaded) `.wasm` binary
    alone is documented at ~10.5MB, comparable to this app's entire existing MediaPipe download,
    for a problem (10 digits + a handful of common time signatures) that a few-hundred-KB
    hand-rolled grid comparison already solves algorithmically, with only the *reference data*
    (not the algorithm) needing improvement. Paying a second MediaPipe-sized download for this
    narrow a symbol set is not a good trade — **not worth prototyping**, exactly the "narrow
    symbol set, glyph-matching is the pragmatic right call" framing the task itself anticipated.
    (MNIST-trained digit shapes are also the wrong reference distribution anyway — trained on
    handwritten digits, not engraved music-font numerals — so even a minimal model would need its
    own from-scratch training data, not an off-the-shelf MNIST checkpoint, adding real effort on
    top of the runtime-size problem.)

**Time-signature detection follow-through (2026-07-23): both the tesseract-OCR spike and the
Bravura-template bundling (backlog B2) were implemented and tested against real files from the
39-file corpus. Neither "wins" outright — the honest result is that Tesseract, once two real bugs
found along the way were fixed, reads a genuinely clean single-glyph crop far more reliably than
either grid variant, but is fragile in ways the grid method isn't, so both now run and the higher
-confidence result wins per detection, not a fixed primary/fallback order.**
- **Bravura templates (B2) do NOT clearly beat the old plain-sans-serif fallback on real files —
  a genuinely negative/neutral finding, not the hoped-for confirmation.** Direct A/B (same real
  glyph, same code path, only the template source toggled) against a Sibelius-engraved file's
  clearly-legible "5" and "4" digits: sans-serif template confidence 0.28/0.36 vs. Bravura's own
  0.17/0.23 — both comfortably below the 0.55 threshold (so neither ever surfaced either way), but
  Bravura was *lower*, not higher, on this real glyph. On a MuseScore-engraved file (Bravura's own
  closest real-world relative), grid confidence was ALSO low (~0.10-0.20) regardless of template
  source. **Conclusion: for THIS matching approach (16x20 Jaccard grid overlap), font-accurate
  templates aren't the bottleneck they were assumed to be** — the coarse grid resolution and the
  approximate numerator/denominator row-split (see below) appear to matter more than which
  reference font supplies the digit shapes. B2 is still implemented (self-hosted, OFL-licensed,
  zero ongoing cost, safely inert if the font fails to load) since it's genuinely free and can't
  regress anything, but it should not be read as "the fix" for grid accuracy.
- **Tesseract, once fed a properly-prepared crop, is dramatically more accurate than either grid
  variant on a real, clean glyph — but getting there required finding and fixing two real problems
  neither in the original plan.** (1) A raw numerator/denominator crop sits directly ON the staff
  (unlike a measure number, which sits in the clear margin and was already known to OCR fine) —
  fed raw, Tesseract read nothing at all (0% confidence, empty string) on a real crop, confirmed
  reproducibly; blanking any row that's dark across >85% of the crop's width before OCR (a real
  staff line spans nearly the full width; a digit's own stroke never does) took the SAME real crop
  from 0% to 94% confidence, correctly reading "5". (2) The existing candidate-blob window
  (`blobs.slice(1, 4)`, both methods) was too narrow: a real 5-flat key signature produces 4
  accidental blobs before the real time-signature glyph, so the true digit was never even
  attempted — widened to `slice(1, 8)` for both methods, confirmed against the same real file (Take
  Five, correctly detecting 5/4 end-to-end once both fixes were in).
- **Tesseract's own per-character confidence is NOT reliable enough to compare directly against
  the grid method on a raw min-of-two-digits basis — found only by testing, not anticipated.** The
  same real, correctly-read "4" denominator self-reported 0% confidence (reproduced consistently
  across 4 PSM modes against the actual production self-hosted worker, not a fluke), while spurious
  reads on non-digit fragments (a clef swirl, a flat sign) self-reported non-trivial 21-70%
  confidence on their OWN single side. What actually filters out the spurious blobs, confirmed
  across every test file, is a structural gate — BOTH the numerator and denominator half must
  independently recognize a digit at all — not a confidence floor: a non-digit fragment reads as a
  digit on at most one side by chance, never cleanly on both. Once past that gate, the pair's
  reported confidence is taken as `Math.max` of the two sides (not `Math.min`, the original design)
  specifically because `Math.min` was found to actively discard the one genuinely correct real
  match in this testing session, dragged to 0 by its own denominator's confidence quirk.
- **Final combination: highest-confidence-wins between the two methods (`pickBestTimeSig`,
  `lib/timeSigMatch.js`), not a fixed primary/fallback order** — justified by the evidence above,
  not assumed going in: grid confidence never once cleared the 0.55 threshold on any real file
  tested (whether via Bravura or sans-serif templates), so in every real case tested it was
  ALREADY structurally impossible for grid to outrank a genuine OCR hit; OCR's own structural gate
  (both halves must read) already excludes the false-positive risk a naive confidence comparison
  would otherwise carry. OCR is not unconditionally trusted over grid in the code, though — a
  future file where grid genuinely does score higher (e.g. OCR's worker fails to load, or a
  cleaner scan than any tested here) is still free to win on its own merits.
- **A real, separate bug found (but NOT fixed — out of scope for this task) while sourcing test
  files, worth a dedicated future session:** `scoreAnalysis.js`'s `firstBarlineCol` heuristic (an
  85%-of-band-height continuous ink run) can trigger on a clef's own vertical stroke rather than a
  genuine barline when the staff band is short, producing a degenerate few-pixel-wide "candidate
  region" that renders as a blank crop — confirmed on 2 of 6 real MuseScore-engraved single-part
  files tested (`Mixed_Nuts Clarinet.pdf`, `Dance_In_The_Game Trumpet.pdf`), both silently skipping
  time-signature detection entirely rather than misdetecting anything. This blocked testing the
  Bravura-template hypothesis against more Bravura-native files than the one (`Peace_Sign
  Clarinet.pdf`) that happened to have a wide enough region to avoid it.
- **A real, separate, PRE-EXISTING UI bug found and fixed while verifying: `renderTimeSigSuggestion()`
  was never called at all for a single-section file** (`autoScrollUI.js`'s `renderSummary()` calls
  it only via `selectSection()`, which the single-section — i.e. most common, single-band-part —
  branch never reaches). This silently made the entire "detected — use this?" suggestion feature
  invisible for this app's most common real case ever since it was introduced, regardless of any
  grid/OCR/Bravura accuracy question — found only because every real test file in this session
  happened to be single-section, and the suggestion never appeared even once detection started
  working correctly underneath. **Fixed** (one added call in the single-section branch).
- **Verified end-to-end against real files, not just unit-level:** `randomclarinet/takefive.pdf`
  (Sibelius-engraved, famously 5/4 time, a real 5-flat key signature) now correctly shows "🔍 Time
  signature: 5/4 detected — use this?" after these fixes, confirmed by eye against the real
  rendered page. `pinkpanther.pdf` (also Sibelius) and `Peace_Sign Clarinet.pdf` (MuseScore)
  correctly show NO suggestion — the former appears to use the "𝄴" common-time symbol rather than
  digits (neither method can read that; a genuinely different, out-of-scope problem), the latter's
  numerator/denominator glyphs are packed too tightly for either method's row-split to isolate
  cleanly. Both null results are the CORRECT, safe behavior (never a wrong guess), not a bug.
  Testing used a temporary, session-only Playwright script (not committed, matching this project's
  established ad hoc verification pattern — see the Testing/QA persona) driving the real dev
  server against real files from the local corpus; no PDF or rendered crop was committed or left
  on disk afterward.

**Three-part investigation/implementation pass (2026-07-24): two spikes (time-signature glyph
NAMES via the PDF font, and vector/operator-list staff-line & barline reading) plus one shipped
fix (scanned-file section names, previously capped at 28.6% by a real bug in `ocr.js`). Full
detail below; short verdicts are in the persona file.**

- **Spike A — are time-signature glyph NAMES readable via `getOperatorList()`/`page.commonObjs`?
  Checked directly against real corpus files (`randomclarinet/takefive.pdf`, `pinkpanther.pdf`,
  `animesheetmusic/Peace_Sign Clarinet.pdf`, `Departure! Clarinet.pdf`), not assumed.** Loaded
  each with `pdfjs.getDocument({ data, fontExtraProperties: true })` (Node, `pdfjs-dist/legacy/
  build/pdf.js`, matching this project's established no-browser-automation verification pattern
  — see the QA persona), called `page.getTextContent()` then `page.getOperatorList()` to force
  fonts to load, then read each font's resolved object back via `page.commonObjs.get(loadedName,
  cb)` for every font id observed in the text items (`g_dN_fM`, pdf.js's own internal naming).
  Every embedded font checked (`QVAAAA+MScore`, `QGBAAA+MScoreRegular`, `QKBAAA+BravuraText`, and
  their siblings — all MuseScore's own font family) reported `differences: []` — an EMPTY
  `/Differences` array. **Conclusion: glyph names via this mechanism are a genuine, confirmed dead
  end for this real corpus — there is no PDF-level `/Differences` array to read at all for these
  files, so there's nothing for a name-based reader to find.** Closed; do not re-spike this exact
  mechanism without new evidence (e.g. a file from different notation software, or a PDF known to
  embed a real Type1 font with custom `/Differences`, which the corpus sampled here doesn't have).
- **But a DIFFERENT, unplanned mechanism turned up a genuine positive while investigating this:
  plain `page.getTextContent()` — the exact call already made everywhere else in this app, no
  `fontExtraProperties`, no special options — sometimes ALREADY returns literal ASCII digit
  characters for a printed time signature.** Found by dumping every text item whose `str` is a
  clean 1-2 digit run and looking for vertically-stacked pairs (same x within 3pt, y-gap 4-20pt —
  matching the real numerator/denominator layout of a printed time signature): `takefive.pdf`
  shows `"5"`/`"4"` at x=120.8, y=673.77/664.73 (gap 9.0pt) — the file's real 5/4 time signature,
  read exactly, as plain characters, no OCR or shape-matching involved. `Full band arrangements/
  Fantastic Parade.pdf` (a full conductor's score) shows 23 correctly-paired `"6"`/`"8"` stacked
  pairs, one per instrument staff on the page. `randomclarinet/flightofbumblebee.pdf` shows a
  correct `"2"`/`"4"`. `animesheetmusic/Peace_Sign Clarinet.pdf` shows a correct `"4"`/`"4"` at
  x=53.7, y=723.65/713.65 (gap 10.0pt) — the SAME file the original OCR/grid-based time-signature
  spike (see the 2026-07-23 entries above) recorded as a correct, safe null result because "the
  numerator/denominator glyphs are packed too tightly for either method's row-split to isolate
  cleanly": the text layer already has the exact, correct answer sitting completely unused, for a
  case the pixel-based approach is structurally unable to read at all.
  - **Mechanism, traced into pdf.js's own source (`node_modules/pdfjs-dist/legacy/build/
    pdf.worker.js`):** when a simple (non-composite) font has no explicit `/ToUnicode` CMap,
    `buildToUnicode()` calls `_simpleFontToUnicode()`, which walks the font's effective encoding
    (base encoding + any `/Differences`) and resolves each glyph name to Unicode via the Adobe
    Glyph List, with a `uniXXXX`/hex-parsing fallback for unrecognized names. This ALREADY runs
    unconditionally as part of ordinary text extraction — nothing new needed to trigger it, no
    `fontExtraProperties` flag required (confirmed by re-running the same digit-pair scan with
    plain `getDocument({ data })`, matching `scoreAnalysis.js`'s actual call exactly — identical
    result). Whether the glyph name resolves to a real digit's Unicode codepoint or fails and
    falls through to nothing depends entirely on what glyph name the specific embedded font
    subset happens to use for that glyph.
  - **This is NOT predictable by vendor or even by file family — checked and falsified directly.**
    `Departure! Clarinet.pdf`, whose own embedded fonts (`QKBAAA+BravuraText`, `QQBAAA+MScore` —
    the exact same font family as `Peace_Sign Clarinet.pdf`, both real MuseScore exports) encodes
    its time signature glyph as an UNDECODED SMuFL PUA codepoint instead: `U+E084` (=`timeSig4` at
    the SMuFL fixed codepoint this project's own `timeSigDetection.js` already uses for Bravura
    template rendering — `SMUFL_TIMESIG_0 = 0xE080`), appearing TWICE (once per numerator/
    denominator half) at the exact position a time signature sits, confirmed by direct inspection
    of the page's top-left text items sorted by position. So two files from what looks like the
    same underlying software diverge on this — one gives an exact, free digit read; the sibling
    gives an opaque PUA codepoint requiring the existing pixel/OCR path. Five further
    `animesheetmusic/*.pdf` files (`Dance_In_The_Game`, `Hacking_to_the_Gate`, `Mixed_Nuts`,
    `Nameless_story`, plus `Departure!` itself) all showed zero stacked-digit-pair matches;
    `Full band arrangements/KingCotton.pdf`/`MonogramMarch.pdf`/`Teutonia.pdf` (already known,
    from earlier entries, to be scanned/near-textless files) correctly showed none either.
  - **Verdict, not yet implemented:** exact time-signature reading straight off the existing text
    layer is real and free where it applies, but must be attempted per-file via the
    stacked-digit-pair geometric check (same x within a few pt, y-gap in the observed 9-10pt
    range, both values in plausible beats/note-value ranges) and gated by whether that check
    actually finds something — never assumed available from file metadata alone. Recommended as a
    cheap, high-value follow-up: run this check first in `timeSigDetection.js`/`scoreText.js`,
    keep the existing grid+OCR pixel path as the fallback for the (large) remaining set of files
    where it doesn't apply. Not built this session — spike-only, to leave budget for the required
    OCR section-name fix (below) and its benchmark verification.
- **Spike B — can staff lines and barlines be read as vector primitives via
  `page.getOperatorList()` instead of pixel scanning? Investigated against real corpus files
  (`Peace_Sign Clarinet.pdf`, `takefive.pdf`, `Fantastic Parade.pdf`, an IMSLP trio score) — a
  genuinely mixed, evidence-backed result, not shipped.**
  - **Coordinate space: `getOperatorList()`'s raw op arguments are in the CURRENT user space at
    the point each op appears in the content stream, NOT pre-composed with the accumulated CTM.**
    Confirmed by walking the `save`(`OPS.save`)/`transform`(`OPS.transform`, i.e. PDF `cm`)/
    `restore`(`OPS.restore`) op sequence and matrix-multiplying (`newCTM = m × CTM`, PDF's own row-
    vector convention) every subsequent path coordinate against the CTM in force at that point —
    the resulting composed coordinates matched the page's own known viewport exactly (e.g. a
    595×842 A4 page's staff lines landed at real y-values like 728.65, 723.65, ... within that
    range, not the raw pre-composition values in the thousands that appear directly in the
    `constructPath` args). This is real, non-trivial work a caller has to do itself — pdf.js's own
    canvas *rendering* path does this composition internally, but the public operator-list API
    hands back pre-composition numbers.
  - **Where it's checked, staff lines have an extremely clean, exploitable vector signature.**
    `Peace_Sign Clarinet.pdf`: a single `OPS.constructPath` op containing exactly 5 horizontal
    2-point line segments (`moveTo`+`lineTo` pairs) at uniform y-spacing (5.0pt apart) sharing one
    x-range (one "chunk" of staff, chaining end-to-end into the next chunk's x-start) — 52 such
    groups found on one page, none anywhere close to being confused with a slur (drawn via
    `curveTo`, not `lineTo`), a hairpin/wedge (a V of two diagonal, non-horizontal lines), a beam
    (a filled quad/thick stroke, not a plain 2-point line), or a stem (a single short vertical
    segment, not a group of 5 evenly-spaced horizontal ones). A follow-on vertical-segment height
    histogram on the same file shows a plausible barline candidate cluster (height ≈ 20pt = 4× the
    5pt line-gap = the full derived staff height, 51 occurrences) alongside several other height
    clusters (stems, flags, accents) — suggestive of a genuine barline signal, but NOT
    independently confirmed as separable from note stems by geometry alone; that disambiguation
    was not solved in this session.
  - **But this is NOT universal — falsified directly on two further real files, not just one.**
    `takefive.pdf`'s OWN, equally-visible 5-line staves produced ZERO `constructPath` groups
    matching the signature above, AND zero filled-rectangle candidates (`op counts` for this
    file's page showed 510 `constructPath` ops but none forming a 5-line staff-height group; only
    3 rects on the whole page, none staff-shaped). `Full band arrangements/Fantastic Parade.pdf`
    (a large, real conductor's score — a DIFFERENT vendor again, per its own distinct embedded
    fonts) shows the identical negative pattern: 0 matching `constructPath` groups, 0 staff-shaped
    rects, but 2083 `showText` calls. Op-count inspection on both files shows heavy `showText` use
    — strongly suggesting these vendors' engraving software draws staff lines as part of a font
    GLYPH run (`showText`) rather than raw vector path strokes, which `getOperatorList()` does not
    decompose into any usable per-line geometry at all (a `showText` op's arguments are a font
    reference + glyph/position data, not path coordinates) — a hard, structural dead end for these
    files' staff lines regardless of technique refinement. Net sample: 1 of 3 real born-digital
    files checked (`Peace_Sign Clarinet.pdf`, MuseScore's own `MScore` font) draws staff lines as
    vector strokes; the other 2 don't — if anything, this suggests the vector path may be the
    NARROWER case among real engraving software, not an even split, though 3 files is too small a
    sample to generalize the ratio itself, only the existence of both cases.
  - **Conclusion: promising but genuinely inconsistent across real vendors (viable for at least
    one major real engraving family's output, a hard dead end for at least one other), and the
    barline-vs-stem disambiguation needed to complete even the working case is unproven.** This is
    exactly the "well-documented negative/mixed result" the task asked to produce if warranted —
    NOT built as a shipping feature this session. A future dedicated investigation could build (a)
    a cheap per-file viability probe (does this page's staff lines match the 5-line-group
    signature at all?) before ever attempting the vector path, keeping the existing pixel scanner
    as the unconditional fallback it already is for scans and for vendors like `takefive.pdf`'s;
    and (b) real testing of barline/stem geometric disambiguation across more real files before
    trusting it. Do not re-attempt this exact spike without new files/evidence — both the positive
    half (Peace_Sign) and the negative half (takefive) are load-bearing findings.
- **Implementation C — scanned-file section-name accuracy was capped at exactly 28.6% across
  every benchmark snapshot ever taken (see the trend table above) by a real, previously
  misdiagnosed bug, not merely "hard."** `src/ocr.js`'s shared Tesseract worker set
  `tessedit_char_whitelist: '0123456789'` exactly ONCE, at worker creation (`getWorker()`), on the
  assumption that only digit-reading would ever run through it. That made the OCR engine ITSELF
  structurally incapable of recognizing a letter — not a downstream filtering choice, a
  recognition-time constraint — so `collectKnownNames`/`findSectionTitle` (`lib/scoreText.js`,
  already validated against real born-digital files) had literally nothing to work with on any
  image-only page, regardless of how good their position/repetition matching logic was. Every
  prior investigation session that touched OCR accuracy was, correctly, working on NUMBER-reading
  (measure numbers, time-sig digits) because that was the only thing the worker could ever
  produce.
  - **Fix:** added a fourth OCR method, `ocrPageWords` (`src/ocr.js`) — PSM 3 (fully automatic page
    segmentation), whitelist explicitly CLEARED, reading the top `topFrac` (default 0.3) of a
    scanned page's rendered image (where engraving convention reliably puts a title block/first
    system — the exact position convention `collectKnownNames` already relies on for the
    text-layer case). Returns items in the SAME `{ str, x, y }` PDF-point shape
    `page.getTextContent()` produces, specifically so the caller can feed OCR'd words into the
    exact same, already real-corpus-validated `groupIntoRows`/`collectKnownNames`/
    `findSectionTitle` pipeline — no second, parallel name-matching path to maintain or diverge
    from the text-layer one.
  - **Closed a real, load-bearing footgun while doing this, exactly as flagged going in:** since
    `getWorker()` no longer sets the whitelist once at creation, every digit-reading call site
    (`recognizeDigitsInBox` — shared by the measure-number BOX method and the time-signature OCR
    method; `ocrNumbersByStrip`) now explicitly (re)sets `tessedit_char_whitelist: '0123456789'`
    immediately before its OWN `recognize()` call, rather than relying on it being set once
    somewhere earlier and never touched. This makes every OCR pass in the file self-contained and
    safe to interleave in any order on the one shared worker (digits, then words, then digits
    again, etc. within one page's analysis) — before this fix, `ocrPageWords` clearing the
    whitelist would otherwise have silently and permanently broken every digit-reading call for
    the rest of the run, since nothing downstream ever restored it.
  - **Wired into both places `scoreAnalysis.js` needed real names on a scanned page.** The main
    per-page loop: the OCR measure-number fetch (`ocrPageNumbers`) was moved to run BEFORE
    section-title matching (previously it ran after, since it only used to produce measure-number
    entries that nothing downstream needed early) and extended to also return `wordItems` when
    asked for them — used for the page-0 bootstrap (`collectKnownNames`) ONLY, per the cost fix
    below, substituting OCR'd words for real text-layer items when `pageItems.length === 0`.
    Reuses the SAME already-rendered `stripCanvas` the existing STRIP digit method renders on that
    one page — this costs one more `recognize()` call, not another `page.render()`.
    `fillMissingSectionNames` (previously bailed out immediately — `if (!pageItems.length)
    continue;` — on any nameless boundary landing on an image-only page) now falls back to
    rendering + `ocrPageWords`-ing that one page instead, with its own matching `terminateOcr()`
    cleanup (it runs after the main loop's own worker-lifetime, so needs to free the worker again
    if it used one) — this is what actually recovers most per-part names on a scanned multi-part
    booklet (see the cost fix below for why the main loop itself only ever does this for page 0).
  - **Cost blowup found and fixed mid-verification, not anticipated going in:** the first working
    version requested `needsWordItems` for EVERY OCR page (any page with `pageItems.length ===
    0`), reusing the already-rendered strip canvas so it looked "free" (no extra render) — but a
    third `recognize()` call per page is real Tesseract latency, and running it on every single
    page of a large scanned booklet doesn't pay for itself: most interior pages could never
    become a title match regardless (see above). This stalled a real benchmark run for many
    minutes on `Personal conditioning duets and music/IMSLP231627-PMLP377546-
    HLazarus_3_Grand_Artistic_Duets.pdf` (a real multi-part scanned duets booklet, ~20+ pages) —
    caught by watching the benchmark's own progress log stop advancing past that file, not by
    reasoning about it in advance. **Fixed** by scoping the main loop's word-OCR request to
    `pageIdx === 0` only (the bootstrap case); `fillMissingSectionNames`'s own OCR use was already
    correctly scoped (only the handful of pages with an actual nameless boundary) and needed no
    change. General lesson: an OCR pass that "reuses an already-rendered canvas" is still not free
    just because it avoids a second `page.render()` — the `recognize()` call itself is the
    expensive part, and "only ever called on the OCR path" (this task's own stated cost
    constraint) isn't a tight enough bound by itself for a per-page loop on a many-page file; it
    needs to be scoped to WHERE the result could plausibly be used, not merely to WHICH FILES are
    already OCR'd.
  - **Real-corpus benchmark result and the root-cause diagnosis behind it, found by direct
    browser-console tracing (temporary debug logging added to `fillMissingSectionNames`, removed
    after use — same ad hoc verification pattern as prior sessions, see the QA persona), not
    guessed.** The full 39-file benchmark's scanned/OCR section-name accuracy stayed at EXACTLY
    28.6% before and after — the same number as every prior snapshot. Debugging this properly
    (rather than accepting a flat "no effect" at face value) by driving the real app against 4 of
    the 5 previously-zero-scoring files individually (`Teutonia.pdf`, `Fat Burger parts with drums
    (1).pdf`, `KingCotton.pdf`, `MonogramMarch.pdf` — a temporary standalone Playwright script
    reusing `scripts/benchmark/lib/{devServer,appDriver}.mjs`, not committed) found TWO distinct,
    important things:
    - **The fix itself genuinely works, verified directly.** `Fat Burger parts with drums (1).pdf`
      page 35 (a real image-only page, confirmed by `ocrPageWords` actually firing) OCR'd real,
      recognizable English words that were structurally impossible to produce before this session:
      `"FAT"`/`"BURGER"` (title), `"By GEORGE VINCENT"` (composer), `"Baeirone SAXOPHONE"` — a
      real, recognizable OCR misread of "Baritone Saxophone" (close enough to confirm the OCR
      engine is genuinely reading letters now, imperfect recognition on a real degraded scan being
      an entirely separate, expected concern from "can it recognize a letter at all").
    - **But the OTHER three files (`Teutonia`, `KingCotton`, `MonogramMarch`) turned out to already
      have a REAL, clean embedded text layer on their per-part pages — no OCR involved at all** —
      `page.getTextContent()` directly returned `"1st CLARINET."` (KingCotton), `"FLUTE"`
      (Teutonia AND MonogramMarch), `"JOHN PHILIP SOUSA"` (KingCotton), each a clean, correctly-
      spelled real instrument name or composer credit, exactly where engraving convention says it
      should be (near the very top of the part's own opening page). Yet in every one of these
      cases, `collectKnownNames`'s position filter (`row.y > topY + pad` → skip, a piece of logic
      already validated on other real files — see above) rejected the real name as "too far above
      the referenced system, must be title-block text." Tracing WHY revealed the actual root
      cause: `firstSystemForText` (built from the PIXEL-based system detector's own
      `systemBands[b.systemIndex].fracMin/fracMax`) placed this boundary's "first system" much
      lower on the page than where the name is actually printed — directly consistent with these
      same files' already-known, severe system-detection undercount confirmed in this SAME
      benchmark run (`Teutonia.pdf`: 80 systems detected vs. 152 true in ground truth;
      `MonogramMarch.pdf`: 158 vs. presumably more). If pixel-based staff detection misses or
      merges several real systems near the top of a page (this exact failure MODE — a dropped
      staff corrupting neighboring gap statistics — is already documented above for a different
      file, "Juggling Clowns," 2026-07-20), the reference system position fed into
      `collectKnownNames` ends up well below the true first system, and the real name (correctly
      printed right at the TRUE top) gets rejected as "too far above" a WRONG, too-low reference
      point.
    - **This is squarely `systemDetection.js`/pixel-detection territory, not a flaw in `ocr.js` or
      `fillMissingSectionNames`** — a genuine, valuable, NEW finding (this exact bug class,
      previously only documented as corrupting `systemDetection.js`'s OWN internal gap-clustering
      statistics, is now confirmed to ALSO corrupt the separate text/OCR name-matching pipeline
      several steps downstream) but a materially different, larger fix than this session's scope
      (would need its own dedicated diagnosis of why these specific dense historical march
      engravings under-count systems so badly — the same class of investigation the "Juggling
      Clowns" bug required). Flagged here as the concrete next step for a future system-detection
      accuracy session on this specific file class, not attempted in this session.
    - **The existing "never surface a wrong guess" safety property held throughout — confirmed,
      not just assumed:** none of these files got a WRONG name; they simply kept the generic
      "Section N" fallback, exactly the documented safe behavior when nothing sufficiently
      confident is found. This is a missed accuracy opportunity, not a correctness regression.
  - **Verification:** full test suite (323 tests) + lint clean throughout, including after
    removing the temporary debug logging used for the root-cause trace above. Real-corpus benchmark
    run before/after via `scripts/benchmark/run.mjs` — see the numbers recorded alongside this
    entry / in the persona file: no metric regressed anywhere in the 39-file suite (identical
    aggregate numbers before/after down to the same decimal), and the scanned/OCR section-name
    figure stayed at 28.6% for the reason diagnosed above, not because the fix doesn't work.

---

**Follow-up (2026-07-25): the flagged "concrete next step" above — why these specific scanned
booklets under-count systems so badly — was root-caused and fixed, not just diagnosed further.**
Picked up exactly where the previous entry left off: `Teutonia.pdf` (80 detected vs. 152 true, 52.6%
accuracy), `KingCotton.pdf` (208 vs. 303, 68.6%), `Fat Burger parts with drums (1).pdf` (261 vs. 391,
66.8%), and `MonogramMarch.pdf` (158 vs. 178, 88.8%) — the same 4 "Full band arrangements" scanned
booklets used throughout this file's history as the no-real-bracing regression guards.
- **Method: dump the real intermediate data first, per this file's own established discipline, not
  tune blind.** Added a temporary `?omrDebug=1`-gated hook (`window.__omrDebugPages`, removed before
  finishing) exposing `detectStaffRows`'s raw/collapsed line rows, `pageSystemsDetailed`'s
  `staffInfo`/`gaps`/grouping decision, and (for one targeted page at a time) a full per-row
  ink-run-length dump, driven through the real app via a temporary standalone Playwright script
  reusing `scripts/benchmark/lib/devServer.mjs` (not committed) — the same pattern as every prior
  real-corpus session in this file.
- **First hypothesis tested and REJECTED with real data: staff-line clustering/grouping
  (`systemDetection.js`) merging staves together.** Dumping `Teutonia.pdf`'s per-page system counts
  showed wildly uneven undercounting (page-by-page detected/expected: 0/6, 12/12 exact, 1/7, 3/8,
  2/7, 5/7, 2/7, 4/7, 6/8, 5/7, 0/6, 7/7 exact, 7/7 exact, 4/7, 7/7 exact, 5/7, 2/7, 3/7, 2/7, 1/7,
  2/7) — not a uniform "pairs merging" pattern a clustering bug would produce, and several pages
  already matched their true count exactly. This pointed at the earlier pixel-detection stage
  (`detectStaffRows`/`inkScan.js`) failing to find the lines AT ALL on the worst pages, not at
  `pageSystemsDetailed` mis-grouping lines it did find.
- **Root cause, confirmed by rendering the actual page and comparing pixel-by-pixel: a real scanned
  staff line frequently never reaches `detectStaffRows`' required single UNBROKEN ink run spanning
  0.45×page-width, even though the line is clearly solid to a human eye.** Rendered Teutonia's
  page 4 (Oboe part) at the app's own analysis resolution and dumped every row's longest contiguous
  run: every one of that page's 7-8 real staff lines topped out at 0.42-0.62× width (need is 0.45,
  some scored effectively 0 — not one of their 5 lines registered at all), even though each row's
  TOTAL ink coverage across the row was 50-85%. The line is broken into dozens of short segments (34
  segments on one representative row) by small gaps — median 5px, 75th pct 11px, 90th pct 19px, out
  of a ~1550px-wide canvas — a real degraded-scan/downsampling artifact (this is a 100+-year-old
  photocopied band part scanned to PDF, re-rendered at this app's fixed ah=1200 analysis
  resolution), not scattered unrelated ink: this same page's genuinely separate ink features (note
  heads, stems, beams, rests) sit behind MUCH bigger gaps, 60-227px in the same data. **This is a
  materially different failure than every previously-documented staff-detection bug in this file**
  (Juggling Clowns' dropped-staff-from-too-strict-line-count, Fantastic Parade's collapseThickness
  span cap) — those were about a whole LINE going missing or MERGING; this is about a real line's
  own ink being real but discontinuous at the pixel level.
- **Fix: `detectStaffRows` (`lib/inkScan.js`) now bridges small gaps when measuring a row's longest
  run** (`gapBridgePx`, default 10px — calibrated against the real noise-gap distribution above: past
  the bulk of the noise, nowhere near the 60px+ real inter-feature gaps, and confirmed to barely
  move an already-correctly-detected page's own passing-row count, 89→90 on this file's Flute part).
  Per-page detected system counts on Teutonia jumped from wildly uneven (listed above) to close to
  ground truth almost everywhere (8, 8, 8, 8, 7, 8, 8, 8, 8, 9, 6, 8, 9, 9 vs. true 7-8 per page),
  and the file's total went from 80/152 (52.6%) to 158/152 (96.1%).
- **A second real regression surfaced by the SAME mechanism, found only because the full 39-file
  benchmark was re-run before declaring victory (not just the 4 target files) — exactly the
  discipline this task's own instructions called for.** `Personal conditioning duets and music/
  Thirty Caprices No 1 arr Cavallini/CavalliniNo1-a4.pdf` (a clean, born-digital LilyPond-typeset
  PDF, NOT a scan) regressed from 12/12 systems (100%) to 14/12 (83.3%) — gap-bridging alone bridged
  a real 3-line Mutopia license-notice text box at the bottom of the page into 2 phantom extra
  "systems". Root cause, confirmed by dumping the real segment data for the offending rows: ordinary
  printed-text letter/word spacing is frequently JUST AS SMALL as a scanned staff line's own noise
  gaps (both commonly a handful of px) — there is no gap-size threshold that cleanly separates "a
  degraded real staff line" from "a paragraph of body text," they overlap in scale. What DOES
  separate them, confirmed with real numbers from both categories: a real (even degraded) staff
  line's bridged run is still made of mostly ACTUAL ink (93% on the real recovered Teutonia row),
  while a text paragraph's bridged run is mostly whitespace stitched together by the bridge (54-74%
  across the Cavallini box's 4 offending rows) — a line of text has much more true white space per
  unit width than a printed staff rule does, even after small gaps are bridged. **Fixed** by adding
  a second, independent gate: `inkDensityMin` (default 0.85) requires the RECOGNIZED bridged run to
  still be mostly real ink, not mostly bridged filler — calibrated with real margin above the worst
  confirmed false positive (0.74) and real margin below the confirmed true positive (0.93). Verified
  this gate rejects nothing the OLD (pre-gap-bridging) algorithm ever accepted: a row that passed
  without any bridging by definition has zero non-ink pixels in its winning run, i.e. density 1.0.
  Re-verified all 4 target scanned files' system counts were unchanged or barely changed by adding
  this second gate (Teutonia 158, KingCotton 249, MonogramMarch 182 — identical; Fat Burger 286→284,
  a 2-system difference from a couple of borderline rows no longer qualifying), while Cavallini
  returned to exactly 12/12.
- **Both fixes are narrowly scoped to `lib/inkScan.js`'s `detectStaffRows` — `systemDetection.js`'s
  clustering/grouping logic (and all of its own extensively-documented, separately-calibrated
  thresholds) is completely untouched.** This matters for the "don't re-litigate the grouping logic"
  guidance this persona's setup instructions call out: the actual bug lived one layer earlier, in
  how ink pixels become candidate line ROWS in the first place, not in how candidate rows get
  clustered into staves/systems.
- **Real-corpus benchmark, before → after (both gates), all 39 files, run via
  `scripts/benchmark/run.mjs`:**
  - `Teutonia.pdf`: 80/152 (52.6%) → 158/152 (96.1%)
  - `KingCotton.pdf`: 208/303 (68.6%) → 249/303 (82.2%)
  - `Fat Burger parts with drums (1).pdf`: 261/391 (66.8%) → 284/391 (72.6%)
  - `MonogramMarch.pdf`: 158/178 (88.8%) → 182/178 (97.8%)
  - Scanned/OCR segment's mean system-count accuracy: moved materially toward truth (see the
    persona file for the exact aggregate before/after this entry was written alongside).
  - **No other file in the 39-file corpus regressed** once the ink-density gate was added (the
    Cavallini regression above was caught, root-caused, and fixed within this same session before
    being reported as done — not left as a known issue).
  - Section-name accuracy: the theory that fixing system-count would also fix the previously-
    documented "wrong reference system corrupts `collectKnownNames`'s position filter" bug
    (2026-07-24 entry) was tested directly, not assumed — see the immediately following note.
- **The predicted section-name side effect did NOT materialize for these 4 files specifically, and
  that's worth stating plainly rather than claiming a win that didn't happen.** Even with system
  counts now close to ground truth, all 4 files still show 0% section-name accuracy in the
  benchmark. Checking why: these files' true instrument names are NOT present in their pages' own
  extracted/OCR'd text in a form `collectKnownNames` can match at all (the 2026-07-24 entry's
  positive cases — KingCotton's `"1st CLARINET."`, Teutonia's `"FLUTE"` — were found on OTHER pages
  of these same files during that session's investigation, not necessarily the specific pages this
  fix changed the reference system for). The system-detection fix genuinely removes the position-
  filter corruption bug as a possible cause going forward, but does not by itself guarantee a name
  is recoverable if the page's own text layer/OCR never produced a usable candidate in the first
  place — a separate, still-open question, not contradicted or resolved by this session.
- **Verification: full test suite (364 tests, up from 357 — 7 new real-data tests added to
  `src/lib/inkScan.test.js`, the module actually changed, rather than `systemDetection.js`, which
  is unchanged) + lint clean.** New tests use real dumped ink-segment data (the same "paste real
  numbers, document the real file/row they came from" pattern already established in
  `systemDetection.test.js`) for both the Teutonia recovery case and the Cavallini false-positive
  case, including one test per fix confirming what the OLD (pre-fix) behavior would have done, so a
  future change can't silently re-break either direction without a test failing.


---

**Text-layer time-signature detection shipped (2026-07-25) — the follow-up flagged as "not yet
wired into `timeSigDetection.js`" in the 2026-07-24 entry above, now actually wired into the real
per-page loop, plus one real bug found and fixed while verifying it against the corpus (not
assumed correct from the spike alone).**

- **What was built.** `lib/scoreText.js` gained two pure, colocated-tested functions:
  - `findStackedDigitPair(items, opts)` — given a small candidate item list, finds a numerator
    directly above a denominator at nearly the same x (the geometric signature a printed time
    signature has that no other stray digit near a system's start does — a measure number, a
    fingering, a rehearsal-mark numeral). Filters candidates to a clean 1-2 digit run, requires the
    denominator to be a plausible power-of-two-or-1 value (`{1,2,4,8,16,32}` — this is what actually
    rejects a coincidentally-aligned pair of unrelated digits, since nothing else about the check
    distinguishes "real time signature" from "any two stacked digits"), and among several plausible
    pairs prefers the leftmost/most-tightly-stacked one (a real time signature sits right after the
    clef/key signature, flush-stacked).
  - `extractTimeSignatures(pageItems, systemsOnPage, opts)` — correlates a stacked pair to each
    system in the same `{ index, yTop, yBottom }` shape family as `extractMeasureNumbers`/
    `extractTempoMarks`, with a small `pad` (default 8pt) letting the pair sit slightly outside the
    system's own auto-detected staff-line band either way, and an *optional* `maxX` a caller can
    supply to further restrict candidates to before some x (see the bug below for why
    `scoreAnalysis.js` ends up NOT using this option despite it existing and being tested).
  - `scoreAnalysis.js`'s per-page loop now tries this FIRST, at the exact point that used to go
    straight to the pixel `renderHighResRegion` + `detectTimeSignature`: `pageItems` (already read
    moments earlier for section-title/measure-number purposes — no new `getTextContent()` call, no
    extra render) is passed to `extractTimeSignatures` for the page's first system; only when that
    finds nothing does the existing high-res render + grid/OCR path run. A text-layer hit is
    trusted outright (`{ beatsPerMeasure, noteValue, confidence: 1, source: 'text' }`) rather than
    confidence-compared against the pixel methods via `pickBestTimeSig` — it's a read, not a
    recognition, categorically more trustworthy — but it is still only ever attached to
    `sec.detectedTimeSig` and offered through the SAME "detected — use this?" suggestion button
    (`autoScrollUI.js`'s `renderTimeSigSuggestion`) the pixel path already used, never applied
    automatically. This preserves the standing safety property unchanged.
- **A real bug found DURING verification, not assumed away: the obvious design choice (restrict
  text-layer candidates to before the system's own first barline, using the SAME
  `firstBarlineCol` pixel estimate `renderHighResRegion` already computes for its own crop) is
  actively harmful, confirmed on a real corpus file.** The first shipped version did exactly this —
  reprojecting `firstBarlineCol` from analysis-canvas pixel space into the text layer's point space
  via `maxX = (firstBarlineCol / aw) * pageViewport1x.width` and passing it to
  `extractTimeSignatures`. Real-file verification (see below) initially showed
  `randomclarinet/flightofbumblebee.pdf` — one of the four files the prior session's spike
  confirmed has an exact, readable "2"/"4" pair in its text layer — producing NO suggestion at all.
  Temporary debug logging (added to `scoreAnalysis.js`, removed after use) dumped the real
  candidate pool and found the actual pair sitting at x=118.77/118.04 — just past
  `maxX=108.19`. The pixel-based "first column whose ink run covers ≥85% of the staff band" heuristic
  (tuned and validated for a completely different purpose — cropping the high-res region so the
  GRID/OCR methods have the whole clef+key+timesig area to search) had landed on some other stroke
  before reaching the real barline, silently cutting off the real time signature's own x. **Fixed**
  by dropping the `maxX` restriction from the `scoreAnalysis.js` call site entirely (kept as a
  tested, optional parameter on `extractTimeSignatures` itself, just not fed unreliable data) —
  the system's own narrow y-band (this is ONE staff, not the whole page) combined with the
  power-of-two-denominator plausibility gate and the leftmost/tightest-pair tie-break turned out to
  be sufficient restriction on their own. Confirmed safe, not just hoped: removing an upper x bound
  can only ever ADD candidates further right, so every file that already found the correct
  (leftmost) pair keeps finding the identical one — verified directly by re-running all four
  positive files after the fix and confirming `Full band arrangements/Fantastic Parade.pdf` still
  correctly finds `6/8` (now recovering it on 24 systems instead of the artificially-truncated
  subset the buggy `maxX` had been silently missing) with no new false positive introduced, since
  that file's own first "system" (a huge, page-spanning braced band — this is a real full
  conductor's score, not the individual single-staff parts the app's core audience uses) turned out
  to contain 23 more instances of the identical, correct `6/8` pair further down the same
  artificially-tall band, not a coincidental wrong match.
- **Real-corpus verification (playwright-core driving the actual dev server — a temporary script
  reusing `scripts/benchmark/lib/{devServer,appDriver}.mjs`'s patterns, not committed — loading
  each file, clicking Analyze, and reading `#sectionTimeSigSuggestion`'s text):**
  - `randomclarinet/takefive.pdf` → "🔍 Time signature: 5/4 detected — use this?" (correct — the
    file's real 5/4).
  - `Full band arrangements/Fantastic Parade.pdf` → "🔍 Time signature: 6/8 detected — use this?"
    (correct).
  - `randomclarinet/flightofbumblebee.pdf` → "🔍 Time signature: 2/4 detected — use this?" (correct
    — only after the `maxX` fix above; the pre-fix version produced no suggestion at all for this
    file).
  - `animesheetmusic/Peace_Sign Clarinet.pdf` → "🔍 Time signature: 4/4 detected — use this?"
    (correct — and notable since the ORIGINAL pixel/OCR spike, 2026-07-23, recorded this exact file
    as a correct, safe null result because the numerator/denominator glyphs are packed too tightly
    for either pixel method's row-split to isolate cleanly; the text layer has no such difficulty).
  - `animesheetmusic/Departure! Clarinet.pdf` → `""` (correctly falls through to the pixel/OCR
    path with no suggestion box shown — this is the confirmed counter-example whose embedded font
    encodes the identical glyph as an undecoded SMuFL PUA codepoint instead of a plain digit; the
    fallback stays intact and unaffected).
- **Full 39-file benchmark before/after (`scripts/benchmark/run.mjs`, default ground truth/corpus):
  every metric identical, not merely close.** Aggregate summary AND every one of the 39 per-file
  JSON records diffed byte-for-byte equal between a run on the unmodified base commit and a run
  with this feature active (`JSON.stringify` equality, 0 diffs across all 39 files, summary objects
  equal) — Overall: 92.9% system count / 72.5% section names / 83.6% measures-per-system (MAE
  0.656, 28/39 comparable) / 96.8% BPM, identical in both runs down to the same decimal. This is
  the CORRECT pass condition, not a null result: this benchmark's `scoreFile()`
  (`scripts/benchmark/run.mjs`) never reads or scores time-signature detection at all, so any
  change to `timeSigByIndex`/`sec.detectedTimeSig` is invisible to it by construction — the real
  evidence for this feature is the per-file `#sectionTimeSigSuggestion` check above, and the
  benchmark's job here is only to prove nothing else (system/section/measure/tempo extraction) was
  disturbed by the new code path sitting earlier in the same per-page loop.
- **Verification:** full test suite (374 tests, +23 new colocated in `scoreText.test.js` for
  `findStackedDigitPair`/`extractTimeSignatures` using synthetic `{str,x,y}` fixtures matching the
  file's established patterns) + lint clean, both before and after the `maxX` fix. All scratch
  renders/screenshots and the temporary debug-logging/verification scripts used above were deleted
  before finishing; none of the real corpus PDFs or any render/crop of them were committed.
- **Persona verdict corrected accordingly** (see `docs/personas/03-omr-notation-specialist.md`):
  the 2026-07-24 entry's "not yet wired into `timeSigDetection.js`" framing is now stale — it *is*
  wired in, wins outright over the pixel path when it finds something, and falls through cleanly
  when it doesn't.

## 2026-07-26 — Slicing the STRIP OCR pass across workers: **negative finding, dropped**

**Context.** After the OCR worker pool landed (`src/ocr.js`), KingCotton's Analyze went 81.0s →
44.2s, and profiling showed the remaining time had one clear shape: the per-number BOX pass
parallelizes well (44.8s of recognition compressed into 15.0s of wall time across 4 workers),
but the STRIP pass is **one ~1.0s recognition per page that cannot be split**, 34 of them, run
inside a sequential page loop. That accounted for ~39s of the remaining 44s — a serial long pole
no amount of pool width can touch (Amdahl).

**Hypothesis.** Cut the left-margin strip into N horizontal slices and recognize them
concurrently. Cuts would be placed in the whitespace *between* systems so no printed measure
number is ever bisected, keeping each slice a column of numbers in context (PSM 6) rather than
degenerating into the per-number BOX method — which would have destroyed the whole point of
having two independent readings for the user to choose between.

**Spiked the risky assumption first**, before building the gap-aligned cut selection: equal-height
slices behind a `?slices=N` URL flag, purely to measure whether N smaller recognitions actually
beat one large one. Tesseract has fixed per-call setup cost, and that was the assumption most
likely to sink the idea.

**Result — it does not pay.** KingCotton, `?noCache=1` so every run does real work:

| slices | wall clock |
|---|---|
| 1 (today's behaviour) | 52.4s |
| 2 | **55.9s — slower** |
| 4 | 47.0s |

Two slices is *worse* than not slicing. Four is ~10% better than baseline, which is inside the
run-to-run variance this suite already exhibits (the same build measured 44.2s and 52.4s on
different runs; a documented earlier case swung 66.3%/75.5%/79.4% on identical code). Per-call
overhead eats essentially the whole theoretical gain. Measure counts also differed from baseline
at both slice counts, though that part is *expected* of the equal-slice spike (it bisects numbers)
and is not evidence against the gap-aligned design — the speed result is, and the speed result is
what the spike existed to obtain.

**Dropped.** Not worth the accuracy risk of changing Tesseract's segmentation context for a gain
indistinguishable from noise. Recorded here rather than retried, in the same spirit as the
barline-continuity negative finding.

**What changed the value of this work anyway:** the detection cache (`src/analysisCache.js`,
committed the same day) takes repeat analysis of the same PDF to ~1.8s, so the cold path is now
paid once per document ever rather than once per session. Remaining ideas for the cold path, if it
is ever worth revisiting: pipelining OCR across pages (invasive — the page loop carries
cross-page state) rather than subdividing within a page.

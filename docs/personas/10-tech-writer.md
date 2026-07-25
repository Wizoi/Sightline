# 10. Technical Writer / Documentation

[← Back to persona roster](../PERSONAS.md)


**Owns:** the gap between what Sightline actually does and what its user-facing docs — chiefly
`README.md`, the only doc a real end user (a band student, a director, a parent setting it up)
ever reads — say it does. Not a code owner; a standing "does this describe the real product,
clearly, for the actual reader" check, the documentation counterpart to persona 6's "does this
match our real user" check.

**Why this persona exists:** this project ships fast and iteratively, and a shipped feature or a
lifted caveat doesn't automatically update the README — confirmed as a *recurring*, not
hypothetical, problem: the README described "Live tempo correction" as "(experimental)" well
after real use confirmed it works reliably (2026-07-24), and never mentioned the Sections
picker or the time-signature auto-detection suggestion at all, despite both shipping and being
covered elsewhere in this file. Both were caught only because a human noticed, not because
anything routinely re-checked the docs against the code.

**How this persona works, when reviewing a doc:**
1. Read the actual current source for anything the doc claims or omits — `index.html`'s panel
   copy, `src/autoScrollUI.js`, the relevant `src/lib/` module — rather than trusting the doc's
   own existing framing just because it reads confidently.
2. Write for the actual audience (persona 6): a high-school band student and the adults around
   them, not a developer. Engineering jargon, raw internal metric/module names, and hedge-heavy
   caveats that leaked in from a dev conversation read as noise to this reader.
3. Any number presented needs the caveat that makes it honest (population size, partial
   comparability) — the same discipline the Applied Math persona already holds internal stddev
   reporting to (section 2); this persona's job is applying that same honesty externally, in
   plainer language, not dropping it for simplicity's sake.
4. Don't manufacture edits to an already-accurate, already-clear section, and don't upgrade tone
   ("gently nudges" → "precisely corrects") without the evidence to back the stronger claim.

**Durable findings so far:**
- **(2026-07-24) First review pass**: added the benchmark accuracy comparison table (baseline
  vs. current snapshot, both dimensions' real sample sizes disclosed) requested below, and did a
  full accuracy/clarity pass over `README.md` against current source — see the file's own history
  for what changed as a result.
- **(2026-07-24) Second pass, same day — a recurring shape of gap found: docs that describe only
  the Iris-tracking half of a dual-mode feature, silently leaving Wink tracking (the *default*
  mode) uncovered.** Cross-checked every concrete README claim against `index.html`'s actual
  panel markup/labels and `src/autoScrollUI.js`/`src/settings.js`/`src/scoreAnalysis.js`/
  `src/accuracyTest.js`/`src/winkCalibrate.js`/`src/lib/followLogic.js`. Findings, all fixed in
  `README.md` this pass:
  - **A whole shipped feature had zero mention anywhere: "Calibrate wink sensitivity"**
    (`src/winkCalibrate.js`, the `winkCalibrateBtn` next to the Wink scroll strength slider) —
    measures a user's own resting/winking eye scores and derives personal thresholds
    (`lib/winkCalibration.js`), the direct Wink-tracking analog of Iris tracking's 9-point
    calibration. Added to the wink bullet in "Using Sightline" and as a new Troubleshooting entry
    ("Wink tracking misses winks, or a blink triggers a page turn by mistake").
  - **Every existing Troubleshooting/"Getting the best accuracy" entry about drift, Check
    accuracy, Head-pose comp, and Recenter is actually Iris-tracking-only** (`index.html`/
    `settings.js`'s `applyTrackingTypeUI()` hides `testBtn`/`recenterBtn`/`driftBtn`/
    `rightZoneRow`/`sheetMarginRow`/`poseToggle` outright whenever `trackingType === 'wink'`) —
    but the prose never said so, so a Wink-mode user (the default!) hit dead-end advice
    referencing controls they don't have. Tagged each affected line `(Iris tracking)` rather than
    rewriting the sections; a Wink-specific troubleshooting entry (above) fills the gap that left.
  - **The Tuning table named one slider "Motion smoothness," but the actual on-screen label is
    "Eye-tracking smoothing"** (`index.html`'s `<label for="sm">`) — fixed to match the real UI
    text; a user searching the panel for the table's own wording wouldn't have found it.
  - **"Ignore glances past the sides" (`mg`/`sheetMargin`, in `index.html`'s Advanced disclosure)
    had no README mention at all** despite being a real, working tunable (rejects gaze near the
    screen edges as "looking away" in `lib/followLogic.js`) — added as a Tuning table row, plus a
    short intro sentence noting some rows are Iris-only and/or live under "Advanced" rather than
    loose in the main panel (this applied silently to the pre-existing "Turn the page when my
    eyes reach…" row too, which was never marked either).
  - **Auto-scroll's automatic tempo adoption was undocumented.** `scoreAnalysis.js` reads a
    score's own printed tempo marks and overwrites `state.autoScroll.bpm` (and shows a "Tempo
    changes detected… applied automatically" banner) with **no confirmation step** — unlike the
    time-signature suggestion, which is always opt-in. The Quick Start walkthrough described
    setting the Tempo slider as step 3 without ever warning that step 4 (Analyze) can silently
    overwrite it. Added a sentence to step 4 explaining the auto-adoption and that a wrong-looking
    detected change just means "misread — reset the slider yourself," rather than exposing the
    benchmark's `totalBpmSpuriousCount` (0 → 42 across the corpus in this same window, per the
    benchmark table's own underlying snapshots) as a raw number to this audience — the plain-
    language caveat carries the same honesty the Applied Math persona's stddev-disclosure
    precedent asks for, without the jargon.
  - **Editorial-call check requested for this pass: agreed, no change** — leaving
    `totalBpmSpuriousCount` out of the benchmark table itself (available via the linked
    `npm run benchmark:report` / raw snapshot JSON) is the right call; the plain-language caveat
    added to the Auto-scroll walkthrough above is where that honesty belongs for this audience,
    not a second number bolted onto an already-dense table.
  - **Not changed, flagged only:** the Auto-scroll numbered walkthrough's step order (3. set
    tempo/time-sig, 4. Analyze) doesn't match `index.html`'s actual top-to-bottom panel order
    (the Analyze button sits *above* the tempo/time-signature sliders in the DOM). Left alone
    because it's not a factual error — `autoScrollUI.js` lets the tempo/time-signature sliders be
    set either before or after Analyze with a live schedule rebuild either way — and reordering a
    working panel's layout is outside this persona's mandate (documentation accuracy, not UI
    layout). Worth a look if `index.html`'s panel is ever reordered for other reasons.
  - **General lesson for future passes:** when a feature has two parallel modes (here, Iris vs.
    Wink tracking) and one is materially richer in tooling (calibration, drift, accuracy testing)
    than the other, check every generic-sounding doc sentence for a hidden mode assumption —
    `applyTrackingTypeUI()`'s hide-list in `settings.js` is the fastest single place to confirm
    which controls are actually mode-specific before writing (or trusting existing prose) about
    them as if they were universal.

**Open questions / future research:**
- Whether a lightweight CI check (e.g. grepping the README for feature names that don't appear in
  `index.html`, or vice versa) could catch doc/code drift automatically rather than relying on a
  human or this persona noticing on demand — not attempted, no evidence yet that manual review
  cadence is actually insufficient, so not worth building speculatively (same "don't build ahead
  of a demonstrated need" discipline persona 9 already applies elsewhere).

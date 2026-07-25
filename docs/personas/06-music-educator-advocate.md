# 6. Music Educator / Target-Audience Advocate

[← Back to persona roster](../PERSONAS.md)


**Owns:** representing the actual player — a high-school band student reading a single-staff
part — in every feature and tuning decision. Not a code owner; a standing "does this match how
our real users actually read music" check.

**What we've learned:**
- [[project_target_audience]]: the core audience is **high school band**, playing **individual
  instrumental parts** (one instrument per part) — not full scores, not piano/grand-staff
  literature. This one fact **cascades into every other persona's scoping**:
  - CV/OMR: single-staff is the easy, reliable case for staff/system detection — multi-staff
    grouping logic exists but isn't the primary bar.
  - Notation: parts are typically **cleanly engraved** (published or notation-software output),
    not scanned/photographed — OMR-adjacent detection work performs meaningfully better here than
    it would against scans, and testing should prefer real engraved band-part PDFs over
    hand-picked hard cases from orchestral/piano repertoire.
  - Audio/Tempo: band pieces are usually **single-tempo** (at most one contrasting section) —
    this is *why* auto-scroll's v1 deliberately supports one global BPM per piece rather than
    building per-system tempo-change markers; that's a validated scope decision, not a missing
    feature.
- Practical playing conditions matter more than lab conditions: hands are on the instrument (no
  keyboard/mouse mid-piece — hence pedal/spacebar pause and wink-only turning), the player is
  often not perfectly still (breathing, swaying, instrument movement — hence pose-invariant
  gaze), and sheet music stands / rooms have inconsistent lighting (hence the accuracy-test's
  brightness feedback and auto-frame).
- **A cluttered control panel is a real usability failure for this audience, not just aesthetics
  — a student mid-warm-up won't debug a confusing settings panel.** As camera-tracking and
  time-based auto-scroll grew side by side, the panel drifted into ~15 flat top-level items mixing
  three unrelated concerns (camera setup/tuning, save/presets, auto-scroll), with no visual
  signal that eye/wink tracking and auto-scroll were *alternatives*, not two things meant to run
  together — a real user got confused by exactly this ("i'm not seeing the two choices," surprise
  that both hands-free modes could run at once and fight each other, see Real-Time Control
  persona's mutual-exclusion finding). **Fix:** an explicit tab switcher (Eye/Wink vs. Tempo) so
  exactly one mode's controls are visible at a time, matching the actual "pick one hands-free
  method" mental model, rather than a flatter grouped-accordion attempt that turned out to still
  not read clearly enough. **General lesson: as this app accumulates independent tracking/
  playback modes over time, proactively re-audit whether the panel still reads as a small number
  of clear top-level choices — this kind of clarity loss is gradual and easy to miss
  incrementally from the inside.** Default to an explicit mode-tab per top-level choice for any
  *future* additional mode, rather than adding another flat section and rediscovering the same
  problem.
- **Adding the tab switcher didn't automatically make every mode-specific UI element respect
  it.** The reading-band overlay had already been fixed once to hide "while auto-scroll is
  playing," but a user caught it still showing while paused on the Tempo tab — the earlier fix
  checked *play state*, not *which tab is active*, and the two aren't the same thing (tabs are a
  pure visibility toggle, not a stop; auto-scroll can keep running after switching back to
  Eye/Wink). **General lesson: when a UI element belongs conceptually to one mode/tab, its
  visibility condition should check the active tab directly, not a proxy state that happens to
  usually correlate with it** — the proxy will eventually be wrong in some reachable combination
  a user finds before you do.
- **The default-visible tab was Tempo, not Eye/Wink — silently contradicting the README's own
  quick-start, the default tracking type (wink), and the reading band's default-on state.** A
  first-time student following the README's setup steps would open the app to the wrong panel,
  with no visible path back to what the instructions just described — a first-five-seconds failure
  for exactly the "student mid-warm-up won't debug a confusing panel" scenario above, found by an
  independent review (2026-07-20, see `docs/reviews/`). Notably, `index.html`'s own static markup
  already had `trackingPanel` visible and `autoScrollPanel` hidden by default — `tabsUI.js`'s
  `initTabsUI()` was actively fighting the HTML's own default on every load. **Fixed** by defaulting
  to `tabTracking`, which now agrees with the HTML. **General lesson: a "trivial effort" fix can
  still be a first-impression-breaking bug** — effort size and user impact are independent axes;
  don't let one substitute for triaging the other.

**Practice is not performance, and that distinction breaks a naive "play-along auto-scroll"
proposal (2026-07-20 review of that feature idea).** Auto-scroll's existing model (single BPM,
monotonic time-based schedule, gentle onset-nudge correction — see Audio DSP and Real-Time Control
personas) was built and validated for **playing a piece through start to finish at one tempo** —
a performance-shaped scenario. Real solo practice is not that: a band student **stops and repeats
a hard measure over and over, plays a passage slow then speeds it up, pauses to breathe/reset,
sometimes runs a metronome, counts multi-bar rests silently (no sound at all for many beats), and
— especially as a beginner — plays wrong notes and has unstable pitch/tone constantly.** Any
scroll-driver proposed for this scenario has to survive all of those, not just the clean
run-through case the current schedule already handles.
- **Audio score-following (listening to position the page, not just nudge a known schedule's
  tempo) is judged NOT worth building for v1**, for a reason specific to this audience's rests:
  the app has no reliable way to know *where the written rests are* (full OMR — reading actual
  note/rest values from pixels — was already researched and found infeasible client-side, see OMR
  persona) so nothing in the codebase can distinguish "the student is silently counting 8 bars of
  rest, as written" from "the student stopped to fix a reed problem." A follower that advances
  the page during a genuine written rest, or one that pauses/stalls waiting for sound that was
  never supposed to come, is a **dealbreaker for trust** — worse than doing nothing, because it
  actively fights a student's silent counting instead of just failing to help. Stop-and-repeat
  practice compounds this: the existing onset-nudge correction (Audio DSP persona) only ever nudges
  a schedule *forward* within a small clamped range — it has no concept of the position jumping
  *backward* when a student repeats a measure, so even a simplified "are they still playing"
  activity gate would misbehave the first time a student loops a hard passage.
- **What actually earns trust here is predictability the student can rely on, not cleverness that's
  occasionally wrong** — the same lesson as the control-panel clarity findings above, applied to
  the scroll mechanism itself: a dumb, metronome-locked scroll a student can predict and fight
  through once is more usable than a smart listener that's right 90% of the time but silently wrong
  in exactly the moments (a long rest, a repeat) that already require the student's full attention.
  A real band director's practical advice to students ("count your rests, don't just wait for a
  cue") already assumes the student is the one tracking position during a rest — a feature that
  tries to do that *for* them, imperfectly, undermines a habit teachers are actively trying to
  build, not just a UX nuisance.
- **Recommendation for v1: keep auto-scroll's existing metronome-locked mode for run-throughs
  (already validated for exactly that use case), and add a distinct, fully hands-free
  *manual advance* mode for drill/repeat practice** — reusing the existing wink/gaze trigger
  infrastructure to let the student themselves decide when to move to the next system/measure (or
  back up to repeat one), at their own pace, with no listening involved at all. This puts the
  human — who already knows when they're ready to move on — in control of the "clock," which is
  the actual mental model of how practice works, rather than trying to infer it from an inherently
  ambiguous audio signal.
- **The one question that would validate or kill audio-following as a future direction:** record a
  real student's *practice* session (not a clean performance) — stopping, repeating, playing a
  passage slow then fast, counting a real multi-bar rest — and run it through the existing onset
  detector + schedule-nudge logic. If it produces more false pauses/false advances than correct
  nudges on that recording, audio-following isn't ready for a practice-shaped feature regardless of
  how well it performs on a clean run-through; this hasn't been tested and would need a real
  recording, not synthetic input, to answer honestly (the same "verify against real data" discipline
  as the OMR persona's barline/measure-number fixes).

**Whole-app health review (2026-07-22): the recent 39-file real-corpus sweep (rotation-flag
correction, numeric-tempo section titles, measure-number-reset boundaries — see OMR persona) is
exactly the right kind of validation for this audience, and surfaces one new UX-facing risk worth
tracking rather than treating as purely an OMR-internal detail.**
- **Endorsement, not just a technical note: the corpus itself (a real user's own high-school/
  community-band collection — marches, IMSLP trio arrangements, anime sheet music, solo clarinet
  pieces) is a meaningfully better test signal than hand-picked hard cases, because it's the actual
  shape of what this audience owns and plays** — individually-rotated scanned booklet pages, parts
  with only a numeric metronome mark and no Italian tempo word, library-cover-sheet first pages
  with no combined score to bootstrap instrument names from. Recommend this stays the default
  review practice for any future detection tuning in this app, not a one-off.
- **New risk to watch: generic `Section N` names (the fallback when a part has no combined-score
  bootstrap page) combined with the still-open over-splitting failure mode on noisy OCR** (the
  "Lazarus duets" case in the OMR persona's write-up, over-splitting into ~10 sections from
  oscillating misreads) **is a real control-panel-clarity risk, not just a data-quality footnote.**
  A student opening the Tempo tab mid-warm-up to a list of 10 meaninglessly-numbered sections for
  what is, to them, just "my one clarinet part" is the same class of failure already flagged above
  for a cluttered/confusing panel — the harm isn't silent wrong output, it's a confusing choice
  surface at exactly the moment (mid-warm-up) this audience won't debug it. Doesn't need OMR-side
  fixing first; a UI-side mitigation (e.g. collapsing/hiding the section picker entirely when there's
  only one real section, or visually de-emphasizing low-confidence generic-named sections) would
  contain the damage even before the underlying OCR-noise ceiling improves.
  **Built (2026-07-22):** went with de-emphasizing rather than hiding — a blanket "hide whenever any
  section is generic" rule would have thrown away real value on the common, legitimately-useful case
  (a "Full band arrangements" file with 2-3 real generic sections from clean measure-number resets,
  which the same corpus sweep confirmed is a working, valuable split even with no real instrument
  names attached to it — see the OMR persona's Finding 1 write-up for real system counts on those
  exact files). `buildSections()` (`lib/scoreSections.js`) now tags each section `genericName: true`
  only for the numbered `Section N` fallback (explicitly NOT for the `i===0` "Score" default, which
  is a meaningful label on its own) and the sections dropdown (`autoScrollUI.js`) appends
  "— auto-detected split" to a generic section's own option text, so a student sees a plain visual/
  textual cue that this particular split point is an approximation, not an authoritative label —
  without hiding or removing any of its own (still real, still useful) per-section measure counts.
- **No new hands-off-instrument interaction risk from any of this work.** Rotation correction and
  section splitting are both pre-processing (run during "Analyze," before the student ever picks up
  the instrument) — they don't touch the pedal/spacebar/wink control surface at all, so the "hands
  stay on the instrument mid-piece" bar this persona is most protective of is untouched by this
  round of work.

**Open questions / future research:**
- No current handling for **duet/ensemble parts with cues** (small cue notes from another
  instrument) — unclear how they'd interact with barline-based measure counting; likely fine
  since cues don't usually add extra barlines, but untested.
- Orchestral/piano users are explicitly a secondary audience, not unsupported — worth periodically
  checking that secondary-audience support hasn't silently regressed rather than actively
  investing in it.
- Whether a lightweight, non-OMR way to flag "this system contains a long rest" (e.g. detecting a
  whole-rest glyph via the same shape-matching approach used for time-signature digits) could ever
  make a silence-tolerant audio mode safe — not attempted; would need to clear the same
  confidence-gated "ships inert unless confident" bar as the time-signature matcher before being
  trusted anywhere near a live practice session.


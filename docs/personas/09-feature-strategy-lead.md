# 9. Feature Strategy & Research Lead

[← Back to persona roster](../PERSONAS.md)

**Owns:** framing a new feature idea as a question worth spiking before it's worth building —
running (or delegating) the feasibility research, writing down the verdict, and setting realistic
v1 scope. This persona is the one that produced the "full OMR is infeasible client-side" and
"single global BPM, not per-system tempo changes" verdicts that every other persona now treats as
established.

**How this persona works:**
1. State the feature idea and the *specific* question that would kill or validate it (not "can we
   detect tempo" but "can we extract rhythm from rendered PDF pixels reliably enough to drive
   auto-scroll timing, staying 100% client-side").
2. Pull in the relevant domain personas (OMR, Audio DSP, CV, Applied Math) for what's already
   known — check this file first, it may already be answered.
3. Check the Privacy/Architecture persona's constraint and the Music Educator persona's
   audience-scoping *before* investing in a full feasibility spike — many ideas are killed or
   right-sized by those two alone, cheaper than a technical investigation.
4. Where a real spike is needed, do it, then **write the verdict back into this file** under the
   relevant persona (not just leave it in chat history) — the OMR-infeasibility and single-BPM
   decisions were previously only recoverable from session memory/chat history, which is exactly
   the gap this persona system exists to close.

**Known verdicts so far** (see linked personas for full detail):
- Full automatic OMR (rhythm/pitch from pixels) for auto-scroll: **infeasible client-side** —
  barline-counting + user-confirmed BPM is the shipped substitute. (Persona 3)
- Live tempo tracking: **onset-nudge against a trusted schedule**, not full beat-tracking —
  simpler and more robust. (Persona 4)
- Auto-scroll tempo model: **one global BPM per piece** (v1), not per-system tempo-change
  markers — matches the band-part audience's typical single-tempo pieces. (Persona 3, 6)
- Wink detection: **per-user calibrated thresholds**, not a fixed global threshold — needed
  because eye asymmetry/camera angle vary enough to break a shared default for some users.
  (Persona 1, 2)
- Score sections (splitting a full-score-plus-parts PDF into named, independently-scoped parts):
  **PDF text-layer extraction is feasible and shipped** — a fundamentally different, more
  tractable technique than pixel-based OMR (it's exact text extraction, not visual recognition),
  and works for any PDF exported from real notation software. This does *not* revisit the full-OMR
  verdict above; it's a different, easier problem that happens to solve a similar-looking need.
  (Persona 3)
- Time-signature reading via glyph shape-matching: **attempted, does not yet reach reliable
  accuracy — ships safely inert** (region-finding is correct and kept; digit classification
  against generic font glyphs isn't). Would need real music-engraving-font reference glyphs to
  reconsider, not a different algorithm. (Persona 3)
- Infrared (IR) camera-based gaze tracking: **declined — no web-platform API for camera spectrum
  or illuminator control, OEM-driver-dependent sensor exposure, MediaPipe untrained/unvalidated for
  IR, and no IR-webcam-class dataset exists to build a custom model from.** The professional-tracker
  accuracy gain is a controlled-illuminator hardware property, not a spectral one, so it's out of
  reach regardless of software effort absent that specific hardware condition. A separate, real
  next step exists on the *RGB* side (spike `webeyetrack`, an existing MIT-licensed browser gaze
  library) if accuracy improvement is still wanted. (Persona 1)
- **Audio score-following** (listening to the performer and deriving playback *position* from what
  they're actually playing, rather than nudging a pre-built schedule): **infeasible client-side —
  not a new investigation, a direct corollary of the existing full-OMR verdict above.** Score-
  following needs a symbolic pitch/onset reference sequence to align the live audio against; the
  only place that reference could come from is the loaded PDF, and extracting it (scanned *or*
  cleanly engraved) from pixels *is* the full-OMR problem already ruled out for staying 100%
  client-side (Persona 3) — this app has no MusicXML/MIDI side-channel, only the PDF. Reviewed
  2026-07-20 for the "play-along auto-scroll for a practicing band student" feature ask; killed by
  checking the OMR verdict + the Privacy persona's no-cloud constraint *before* spending any spike
  effort, exactly the cheap-filters-first sequencing this persona is supposed to apply. What
  *does* remain feasible and valuable, using the exact same onset-detection machinery already
  shipped: audio that only **corrects or gates a time-based clock that's already trusted**
  (shipped: the onset-nudge tempo trim) rather than deriving position from scratch — see Persona
  4's silence-auto-pause and count-in-calibration candidates for the concrete next v2 steps in that
  direction, both of which need no new signal, only new uses of data already collected.

---

**Backlog** (completed items, and open/future/declined items) is tracked separately, not in this
persona file — see [`docs/BACKLOG-DONE.md`](../BACKLOG-DONE.md) and
[`docs/BACKLOG-FUTURE.md`](../BACKLOG-FUTURE.md). Most of that list doesn't need a dedicated
persona's ongoing judgment, just tracking; this file stays focused on this persona's actual
ongoing job (framing feature ideas, recording feasibility verdicts).

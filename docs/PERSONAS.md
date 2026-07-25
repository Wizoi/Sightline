# Sightline development personas

This is the roster of domain-expert "personas" for Sightline feature work. Each one owns a
slice of the problem (music notation, applied math, computer vision, audio, real-time control,
the actual end user, the privacy constraint, test strategy, feature scoping, and user-facing
documentation), and each linked file below captures **what we've already learned** in that
domain — so a future feature discussion can start from "here's what we know" instead of
re-deriving it.

Each persona also exists as an invokable Claude Code subagent under
[`.claude/agents/`](../.claude/agents/) — e.g. "ask the OMR persona whether X is feasible" can be
a literal subagent call, not just a mental frame. Update **that persona's own file** under
[`docs/personas/`](personas/) whenever its domain produces a durable finding (a feasibility
verdict, a technique that worked, a dead end) — the subagent `.md` files stay thin and point back
to their persona file, not to this index.

**To get all 10 personas' take on a feature or change at once** (impact analysis, or an explicit
decline if it doesn't touch their domain), use the `/persona-review` skill
([`.claude/skills/persona-review/`](../.claude/skills/persona-review/)) — it fans the feature out
to all 10 subagents in parallel and synthesizes one combined report, and prompts to write any
durable finding back into the relevant persona file.

**Why this file is just an index (2026-07-24):** the persona content used to live directly in this
one file, which grew to ~2,900 lines / ~65,000 tokens — over half of it in a single persona (OMR)
whose investigation history had accumulated for months. Reading or invoking any one persona no
longer needs to risk pulling in that whole file; each persona is now its own file, sized to what
that domain actually needs (2,000–6,000 tokens for most; OMR's still-large investigation history
is further split out into its own file so its *current-state* persona file stays small). Nothing
was trimmed or summarized in the split — every word that existed before still exists, just
reorganized. See [`docs/BACKLOG-DONE.md`](BACKLOG-DONE.md) and
[`docs/BACKLOG-FUTURE.md`](BACKLOG-FUTURE.md) for the backlog/punch-list content that used to live
inside persona 9's section — most of it doesn't need a persona's ongoing judgment, just tracking.

---

## The roster

1. [Gaze & Computer Vision Engineer](personas/01-gaze-cv-engineer.md) — turning a webcam frame
   into "where is this person looking."
2. [Applied Mathematician / Numerical Methods](personas/02-applied-math-engineer.md) —
   calibration fitting, clustering, personal-threshold derivation.
3. [Optical Music Recognition (OMR) / Music Notation Specialist](personas/03-omr-notation-specialist.md) —
   reading structure (staves, systems, barlines, measures, sections) out of a score, from pixels
   or from the PDF's real text layer. Full investigation history:
   [`personas/omr/investigation-log.md`](personas/omr/investigation-log.md).
4. [Audio DSP / Music Information Retrieval Engineer](personas/04-audio-dsp-engineer.md) — onset
   detection, the live-tempo-correction control loop.
5. [Real-Time Control Systems / Interaction Designer](personas/05-realtime-control-engineer.md) —
   the follow controller's per-frame decision logic, dead zones, smoothing, snap easing.
6. [Music Educator / Target-Audience Advocate](personas/06-music-educator-advocate.md) — the
   real end user: a high-school band student reading a single-staff part.
7. [Privacy & Client-Side Architecture Engineer](personas/07-privacy-architecture-engineer.md) —
   the "everything stays on-device, nothing is ever uploaded" hard constraint.
8. [QA / Test Strategy Engineer](personas/08-qa-test-strategist.md) — how a change should
   actually be verified (unit tests vs. real-file Playwright checks vs. ad hoc).
9. [Feature Strategy & Research Lead](personas/09-feature-strategy-lead.md) — framing a feature
   idea as a falsifiable question, known feasibility verdicts.
10. [Technical Writer / Documentation](personas/10-tech-writer.md) — the gap between what
    Sightline does and what its user-facing docs (chiefly `README.md`) say it does.

**Backlog** (not persona-owned, just tracked):
- [`docs/BACKLOG-DONE.md`](BACKLOG-DONE.md) — shipped items, kept for provenance.
- [`docs/BACKLOG-FUTURE.md`](BACKLOG-FUTURE.md) — open, declined, or deferred items.

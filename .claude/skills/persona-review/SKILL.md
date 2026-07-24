---
name: persona-review
description: Fan a proposed Sightline feature or change out to all 10 domain-expert personas (docs/PERSONAS.md, .claude/agents/) for parallel impact analysis, then synthesize one combined report. Use whenever scoping, designing, or evaluating a new Sightline feature or significant change — every persona must respond, even if only to explicitly decline with "no impact."
---

# Persona review

Runs Sightline's 10-persona "development team" (see [docs/PERSONAS.md](../../../docs/PERSONAS.md))
against a single feature or change, in parallel, and produces one combined report. The point is
coverage, not unanimity: a persona with nothing to add should say so explicitly in one line
rather than being silently skipped — a visible "no impact" is a real, load-bearing signal (it
means someone checked), not noise.

## When to use this

Any time a new feature, significant change, or open design question is being scoped for
Sightline — before committing to an approach, not after. If the user just says "run persona
review on X" or "get the team's take on X," treat X as the feature/change to analyze.

## Steps

1. **State the feature/change** in one or two sentences — restate it back plainly enough that a
   persona with zero conversation context (they get none) can evaluate it cold. If the ask is
   vague, tighten it into a concrete proposal first (what would actually change, for whom) rather
   than passing ambiguity downstream to all 10 personas.

2. **Launch all 10 persona subagents in parallel, in foreground, in a single message** — ten
   `Agent` tool calls with `run_in_background: false`, one per `subagent_type` below, all in the
   same response so they run concurrently and you get every result back before continuing:

   - `gaze-cv-engineer`
   - `applied-math-engineer`
   - `omr-notation-specialist`
   - `audio-dsp-engineer`
   - `realtime-control-engineer`
   - `music-educator-advocate`
   - `privacy-architecture-engineer`
   - `qa-test-strategist`
   - `feature-strategy-lead`
   - `tech-writer`

   Give every persona the **same self-contained prompt** (they share no context with each other
   or with this conversation), built from this template:

   > Sightline feature/change under review: {{feature description}}.
   >
   > Analyze this strictly from your persona's domain lens (see your section of
   > docs/PERSONAS.md — read it first). Structure your reply as:
   > 1. **Verdict**: "No impact" or "Impact" (pick one — don't hedge).
   > 2. If **No impact**: one or two sentences saying why this genuinely doesn't touch your
   >    domain. Do not manufacture a concern just to have something to say.
   > 3. If **Impact**: a concise assessment (roughly 100–200 words) covering: what specifically
   >    in your domain is affected, any relevant prior knowledge/verdict already on record in
   >    PERSONAS.md, concrete risks or open questions, and a recommendation (proceed / proceed
   >    with a specific caveat / needs a spike first / don't do this).
   >
   > Be concrete and specific to this feature — generic domain background the reader can already
   > get from PERSONAS.md isn't useful here.

3. **Synthesize one combined report** from the 10 replies — don't just concatenate them. Format:

   - **Feature reviewed:** the one/two-sentence restatement from step 1.
   - **Per-persona verdicts:** a compact table or list — persona name, verdict (No impact /
     Impact), one-line summary. This is the scannable part.
   - **Full analysis:** the personas that reported Impact, in full, grouped under their own
     heading.
   - **Cross-persona synthesis:** call out anything that only becomes visible by reading them
     together — two personas pulling in different directions (e.g. a technique the CV/Math
     personas like but Privacy/Architecture rules out), a risk multiple personas independently
     flagged, or a dependency chain (e.g. Feature Strategy Lead's recommended spike blocks on
     something QA flagged). If nothing cross-cuts, say so briefly rather than forcing a finding.
   - **Recommendation:** one clear next step, informed by the above — not a restatement of all 10
     opinions.

4. **Offer to persist durable findings.** If any persona's analysis produced something worth
   keeping past this conversation (a new constraint discovered, a risk worth tracking, a verdict
   reached), offer to write it into the relevant section of `docs/PERSONAS.md` — that file is the
   team's shared memory, and per each persona's own instructions, new findings belong there, not
   only in this chat.

## Notes

- Don't skip a persona because the feature "obviously" doesn't touch their domain — let them say
  so themselves in one line. That's cheap, and the discipline is the point: a consistently-empty
  section over many reviews is itself useful signal (e.g. "Audio DSP has had no impact on the
  last 6 features" tells you something about where the app's action actually is).
- If the feature is large enough that 10 full analyses would be unwieldy, it's fine to ask the
  user whether they want the full 10-way review or a scoped subset — but default to running all 10
  unless told otherwise, since that's the explicit point of this skill.

// Detects (and corrects) a page whose declared /Rotate flag is simply wrong —
// a scanning/assembly artifact seen on real combined-score PDFs (confirmed:
// Teutonia.pdf p.3/22 and MonogramMarch.pdf pp.4-5/28 both declare /Rotate 270
// on an otherwise-normal portrait page where 0 is actually correct; the
// wrongly-rotated page then feeds vertical-staff pixels into the horizontal
// staff-line/barline scanners in scoreAnalysis.js, producing nonsense measure
// counts). This is deliberately unconditional — every page gets probed at all
// 4 absolute rotations, not just ones whose declared rotation "looks
// suspicious" from downstream output — because the failure mode doesn't fail
// cleanly (a few garbage systems, not zero), so there's no reliable signal to
// gate on from the detailed pass. The probe itself is cheap (a small fixed
// render per candidate, not the shared ah=1200 detection pass), so probing
// every page costs little.
//
// Pure/testable half lives here (scoreOrientation + chooseRotation, exercised
// with synthetic ink patterns in pageRotation.test.js); the actual per-
// rotation low-res rendering lives in scoreAnalysis.js since it needs a real
// pdfjs page + canvas.

// Counts rows that look like a staff line: a horizontal run of ink spanning
// most of the row's width. Same signal as scoreAnalysis.js's own `lineRows`
// scan (a staff line is one of the few things in a music page that draws a
// long unbroken horizontal stroke) — reused here at low resolution across all
// 4 rotation candidates rather than just the page's own declared one. A page
// whose staves are actually running vertically (i.e. this rotation is wrong)
// scores near zero, since a vertical stroke never produces a wide horizontal
// run; a blank/text-only page also scores near zero in every rotation, which
// is what the caller's floor guards against.
export function scoreOrientation(isInk, width, height, needFrac = 0.45) {
  const need = needFrac * width;
  let rows = 0;
  for (let r = 0; r < height; r++) {
    let best = 0, cur = 0;
    for (let c = 0; c < width; c++) {
      if (isInk(r, c)) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    if (best > need) rows++;
  }
  return rows;
}

// Decides whether to override a page's declared rotation. scores is
// {0,90,180,270} -> scoreOrientation() result for that candidate.
// declaredRotation is the page's own (normalized) page.rotate.
//
// Two guards, both required, so this only fires on a real, convincing
// mismatch:
//   - floor: bestScore must clear an absolute minimum, so a blank/cover/
//     text-only page (no staff lines in ANY rotation — Teutonia p.1 is the
//     real case: a text-only cover with no music at all) can't get
//     "corrected" onto whichever rotation's noise happens to edge out the
//     others.
//   - ratio: bestScore must convincingly beat the declared rotation's own
//     score, not just nose ahead of it — guards against flip-flopping a
//     page whose declared rotation is already correct (e.g. every page of
//     a uniformly, correctly rotated PDF) based on a marginal difference.
// Ties for bestScore are broken toward the smaller rotation value (0 before
// 90 before 180 before 270) — in particular this prefers right-side-up (0)
// over upside-down (180) when both score identically, which a pure
// horizontal-ink-run signal genuinely cannot otherwise distinguish (a
// staff's lines are horizontal whether the page is right-side-up or upside
// down). This ambiguity doesn't arise in either confirmed real bug case
// (both declare 270, never 90/180), so it's a reasonable default rather than
// something worth a heavier signal for.
export function chooseRotation(scores, declaredRotation, { floor, ratio }) {
  const rotations = [0, 90, 180, 270];
  const declared = ((declaredRotation % 360) + 360) % 360;
  let best = rotations[0], bestScore = scores[rotations[0]] ?? 0;
  for (const r of rotations) {
    const s = scores[r] ?? 0;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (best === declared) return declared;
  const declaredScore = scores[declared] ?? 0;
  if (bestScore >= floor && bestScore >= declaredScore * ratio) return best;
  return declared;
}

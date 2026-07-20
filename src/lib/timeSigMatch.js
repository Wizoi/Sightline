// Best-effort, shape-based digit recognition for time signatures. This is
// fundamentally different from (and much less certain than) the real-text
// extraction in lib/scoreText.js: time-signature digits are drawn from the
// music engraving's glyph font with no extractable text value (confirmed
// against a real score — see lib/scoreText.js's header), so the only way
// to read one at all is to compare its rendered shape against reference
// digit shapes. Never trust this blindly — the caller only ever offers it
// as a "detected — use this?" suggestion the user confirms, never applies
// silently (see scoreAnalysis.js / autoScrollUI.js).
//
// Deliberately pure and grid-shaped: the caller (scoreAnalysis.js) does
// the DOM/canvas work of extracting a candidate region's pixels and
// rendering reference digit templates (via ctx.font/fillText — there's no
// bundled copy of the actual music engraving font, so templates are a
// plain bold sans-serif rendering of each digit; close enough for coarse
// shape matching, not exact-font OCR). This module only compares
// already-extracted, same-size binary grids.

// Jaccard-style overlap: intersection over union of "ink" cells. Robust to
// a candidate being a bit bolder/thinner than the template (unlike a raw
// pixel-difference count, which penalizes any thickness mismatch harshly),
// while still requiring real shape agreement, not just similar ink density.
export function gridSimilarity(a, b) {
  if (a.length !== b.length || a[0].length !== b[0].length) {
    throw new Error('gridSimilarity: grids must be the same dimensions');
  }
  let intersection = 0, union = 0;
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      const av = a[r][c] ? 1 : 0, bv = b[r][c] ? 1 : 0;
      if (av || bv) union++;
      if (av && bv) intersection++;
    }
  }
  return union === 0 ? 0 : intersection / union;
}

// templates: { '0': grid, '1': grid, ... } — same dimensions as candidate.
// Returns the best-matching key and its similarity score (0-1), or null if
// there are no templates at all. The caller decides what confidence
// threshold is worth acting on — this just reports the best match found.
export function matchDigit(candidate, templates) {
  let best = null, bestScore = -1;
  for (const [digit, grid] of Object.entries(templates)) {
    const score = gridSimilarity(candidate, grid);
    if (score > bestScore) { bestScore = score; best = digit; }
  }
  return best === null ? null : { digit: best, confidence: bestScore };
}

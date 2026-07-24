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
// Deliberately pure and grid-shaped: the caller (timeSigDetection.js) does
// the DOM/canvas work of extracting a candidate region's pixels and
// rendering reference digit templates. As of 2026-07-23 those templates are
// the bundled Bravura SMuFL font's own timeSig0-timeSig9 glyphs (a real
// music-engraving font, self-hosted — see timeSigDetection.js and
// scripts/fetch-bravura-assets.mjs), falling back to a plain bold
// sans-serif digit render only if that font fails to load. This module only
// compares already-extracted, same-size binary grids either way.

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

// Combines independent best-effort time-signature detections (e.g. this
// module's own grid-Jaccard shape match and a tesseract OCR pass over the
// same candidate region — see timeSigDetection.js) into one result:
// whichever non-null candidate reports the HIGHEST confidence wins outright.
// Every candidate must already be on the SAME 0-1 confidence scale — this
// function doesn't know or care what produced a given score, only compares
// the numbers it's handed (timeSigDetection.js normalizes Tesseract's native
// 0-100 confidence before calling this). Returns null when every candidate is
// null/undefined (nothing detected at all), never throws on a mixed
// null/real array — a caller naturally builds one by mapping "did this
// method produce anything" over its own list of attempted methods.
export function pickBestTimeSig(candidates) {
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    if (!best || c.confidence > best.confidence) best = c;
  }
  return best;
}

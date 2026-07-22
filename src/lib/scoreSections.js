// Groups a flat, whole-document system list into named sections (a full
// score vs. its individual parts, movements, etc.) at detected boundaries
// -- see scoreText.js's findSectionTitle for how boundaries are found.
//
// Deliberately produces *slices* of systemBands/measuresPerSystem rather
// than a parallel data structure: autoScrollController.js already reads
// state.autoScroll.{systemBands, measuresPerSystem, beatsPerMeasure, bpm}
// directly, so a "section" is just a saved snapshot of those four values.
// Selecting one (src/autoScrollUI.js) swaps its snapshot into the live
// top-level fields -- schedule building, the tempo HUD, and settings
// persistence all keep working completely unchanged.
//
// boundaries: [{ systemIndex, name, tempoMarking }], any order, need not
// include systemIndex 0 -- the first section is always implied even when
// nothing was detected there (e.g. a full score's opening page lists every
// instrument, so no single name matches it -- see collectKnownNames).
// `name` may itself be null/absent -- a boundary can be detected with no
// name at all (a printed measure-number reset with no instrument-name match
// to go with it -- see detectMeasureNumberResets), in which case this falls
// back to the same generic `Section ${i+1}` as when there's no boundary
// object at that index at all.
// bpmPerSystem: optional whole-document number[] (per-system tempo from
// printed ♩=N marks; see resolveBpmPerSystem). Sliced per section like
// systemBands. A section's `bpm`/`bpmBase` become the tempo in force at its
// first system (the carry-in), so its own manual Tempo slider starts at the
// right value and scales the section's marks proportionally.
export function buildSections({
  boundaries, systemBands, measuresPerSystem, bpmPerSystem, defaultBeatsPerMeasure, defaultBpm,
}) {
  const total = systemBands.length;
  if (!total) return [];

  const startIndices = [0, ...boundaries.map((b) => b.systemIndex).filter((i) => i > 0 && i < total)];
  const uniqueStarts = [...new Set(startIndices)].sort((a, b) => a - b);

  return uniqueStarts.map((startIdx, i) => {
    const endIdx = (i + 1 < uniqueStarts.length ? uniqueStarts[i + 1] : total) - 1;
    const boundary = boundaries.find((b) => b.systemIndex === startIdx);
    const secBpm = bpmPerSystem && bpmPerSystem[startIdx] > 0 ? bpmPerSystem[startIdx] : defaultBpm;
    const hasRealName = boundary && boundary.name;
    return {
      name: hasRealName ? boundary.name : (i === 0 ? 'Score' : `Section ${i + 1}`),
      // True only for the numbered `Section N` fallback -- a real matched
      // instrument name, AND the i===0 "Score" default, both count as a
      // real/meaningful name. Lets the UI (autoScrollUI.js) visually flag
      // that this split point was found from a printed-measure-number reset
      // alone (see detectMeasureNumberResets), with no instrument name to
      // back it up -- distinguishing a confident label from an
      // auto-detected approximation the student shouldn't read as
      // authoritative (Music Educator persona: a wall of meaningless
      // "Section 7"-style numbers, especially several from noisy OCR
      // misreads, reads as confusing panel clutter, not useful navigation).
      genericName: !hasRealName && i !== 0,
      tempoMarking: boundary ? boundary.tempoMarking || null : null,
      startSystemIndex: startIdx,
      endSystemIndex: endIdx,
      systemBands: systemBands.slice(startIdx, endIdx + 1),
      measuresPerSystem: measuresPerSystem.slice(startIdx, endIdx + 1),
      bpmPerSystem: bpmPerSystem ? bpmPerSystem.slice(startIdx, endIdx + 1) : null,
      beatsPerMeasure: defaultBeatsPerMeasure,
      bpm: secBpm,
      bpmBase: secBpm,
    };
  });
}

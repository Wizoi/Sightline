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
export function buildSections({
  boundaries, systemBands, measuresPerSystem, defaultBeatsPerMeasure, defaultBpm,
}) {
  const total = systemBands.length;
  if (!total) return [];

  const startIndices = [0, ...boundaries.map((b) => b.systemIndex).filter((i) => i > 0 && i < total)];
  const uniqueStarts = [...new Set(startIndices)].sort((a, b) => a - b);

  return uniqueStarts.map((startIdx, i) => {
    const endIdx = (i + 1 < uniqueStarts.length ? uniqueStarts[i + 1] : total) - 1;
    const boundary = boundaries.find((b) => b.systemIndex === startIdx);
    return {
      name: boundary ? boundary.name : (i === 0 ? 'Score' : `Section ${i + 1}`),
      tempoMarking: boundary ? boundary.tempoMarking || null : null,
      startSystemIndex: startIdx,
      endSystemIndex: endIdx,
      systemBands: systemBands.slice(startIdx, endIdx + 1),
      measuresPerSystem: measuresPerSystem.slice(startIdx, endIdx + 1),
      beatsPerMeasure: defaultBeatsPerMeasure,
      bpm: defaultBpm,
    };
  });
}

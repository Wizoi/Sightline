import { describe, it, expect } from 'vitest';
import {
  pickPrimaryEntries, addMeasureNumberResetBoundaries, resolveTempoSchedule,
  refineMeasuresPerSection, chooseMeasureReadings, computeWarnings,
} from './scoreAssembly.js';

describe('pickPrimaryEntries', () => {
  it('picks the source with the most entries', () => {
    const text = [{ systemIndex: 0, measureNumber: 1 }];
    const box = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 5 }];
    const strip = [];
    expect(pickPrimaryEntries([text, box, strip])).toBe(box);
  });

  it('picks the first source on a tie', () => {
    const a = [{ systemIndex: 0, measureNumber: 1 }];
    const b = [{ systemIndex: 5, measureNumber: 9 }];
    expect(pickPrimaryEntries([a, b])).toBe(a);
  });
});

describe('addMeasureNumberResetBoundaries', () => {
  it('adds a nameless boundary for each detected reset', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 1 }, // reset
    ];
    const result = addMeasureNumberResetBoundaries([], entries, 5);
    expect(result).toEqual([{ systemIndex: 2, name: null, tempoMarking: null }]);
  });

  it('does not mutate the input array (pure)', () => {
    const original = [{ systemIndex: 1, name: 'Bass Clarinet', tempoMarking: 'Andante' }];
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 1 }, // would-be reset, but system 1 already has a boundary
    ];
    const result = addMeasureNumberResetBoundaries(original, entries, 5);
    expect(result).toEqual(original); // no addition -- already covered
    expect(result).not.toBe(original); // still a new array
  });

  it('ignores an out-of-range systemIndex defensively', () => {
    const entries = [{ systemIndex: 0, measureNumber: 9 }, { systemIndex: 99, measureNumber: 1 }];
    expect(addMeasureNumberResetBoundaries([], entries, 5)).toEqual([]);
  });
});

describe('resolveTempoSchedule', () => {
  it('returns null bpmPerSystem/opening when no tempo marks were found', () => {
    expect(resolveTempoSchedule([], 4, 100)).toEqual({ bpmPerSystem: null, opening: null });
  });

  it('resolves a per-system schedule and reports the opening tempo', () => {
    const entries = [{ systemIndex: 0, bpm: 86 }, { systemIndex: 2, bpm: 128 }];
    const result = resolveTempoSchedule(entries, 4, 100);
    expect(result.bpmPerSystem).toEqual([86, 86, 128, 128]);
    expect(result.opening).toBe(86);
  });

  it('the first mark on a system wins when duplicated', () => {
    const entries = [{ systemIndex: 0, bpm: 86 }, { systemIndex: 0, bpm: 999 }];
    const result = resolveTempoSchedule(entries, 2, 100);
    expect(result.bpmPerSystem).toEqual([86, 86]);
  });
});

describe('refineMeasuresPerSection', () => {
  it('refines each section independently using its own re-based entries', () => {
    // Mirrors a real 2-part booklet: part 2 restarts numbering at 1, so its
    // own entries must be re-based to section-local indices before refining
    // (otherwise they'd look like a monotonicity-breaking drop against part 1).
    const measuresPerSystem = [30, 7, 7, 40, 8, 8];
    const rawSections = [
      { startSystemIndex: 0, endSystemIndex: 2 },
      { startSystemIndex: 3, endSystemIndex: 5 },
    ];
    const entries = [
      { systemIndex: 1, measureNumber: 12 }, // part 1, local
      { systemIndex: 2, measureNumber: 19 },
      { systemIndex: 4, measureNumber: 9 },  // part 2, global index 4 -> local 1
      { systemIndex: 5, measureNumber: 16 },
    ];
    const result = refineMeasuresPerSection(measuresPerSystem, rawSections, entries);
    // Section 0: anchored measure-1 at its own system 0, then exact deltas to
    // the known 12 and 19 -> [11, 7], last system (2) keeps its raw estimate (7).
    // Section 1: re-based entries anchor its OWN system 0 (global index 3) at
    // measure 1, then exact deltas to the known (local) 9 and 16 -> [8, 7],
    // last system (local 2 / global 5) keeps its raw estimate (8).
    expect(result).toEqual([11, 7, 7, 8, 7, 8]);
  });

  it('is a no-op with no entries', () => {
    const measuresPerSystem = [3, 3, 3];
    const rawSections = [{ startSystemIndex: 0, endSystemIndex: 2 }];
    expect(refineMeasuresPerSection(measuresPerSystem, rawSections, [])).toEqual([3, 3, 3]);
  });
});

describe('chooseMeasureReadings', () => {
  // A clearly-wrong raw (barline/pixel) estimate for both systems, so a
  // successful refinement is visibly different from it, not a coincidence.
  const measuresPerSystem = [9, 9];
  const rawSections = [{ startSystemIndex: 0, endSystemIndex: 1 }];

  it('uses the text-layer entries directly when no page fell back to OCR', () => {
    const measureNumberEntries = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 4 }];
    const result = chooseMeasureReadings({
      usedOcrAnywhere: false, measureNumberEntries, ocrEntriesBox: [], ocrEntriesStrip: [],
      measuresPerSystem, rawSections,
    });
    expect(result.readings).toBeNull();
    // system0's own printed "1" already anchors it -> exact delta to "4" (3
    // measures); system1 is the last system with no further known number, so
    // it keeps its raw (wrong) estimate of 9 untouched.
    expect(result.refinedMeasures).toEqual([3, 9]);
  });

  it('merges text-layer entries into BOTH OCR candidates (Finding 3 -- mixed document)', () => {
    // A "mixed" document: system 0's page had a real text layer (measureNumberEntries),
    // system 1's page needed OCR (only in ocrEntriesBox/Strip). The old
    // behavior discarded measureNumberEntries entirely whenever ANY page used
    // OCR; the fix merges it into both OCR candidates so system 0 still gets
    // its exact reading (refined from the wrong raw 9 down to the real 5)
    // regardless of which OCR method "wins" overall.
    const measureNumberEntries = [{ systemIndex: 0, measureNumber: 10 }];
    const ocrEntriesBox = [{ systemIndex: 1, measureNumber: 15 }];
    const ocrEntriesStrip = [];
    const result = chooseMeasureReadings({
      usedOcrAnywhere: true, measureNumberEntries, ocrEntriesBox, ocrEntriesStrip,
      measuresPerSystem, rawSections,
    });
    // box candidate merges to [{0,10},{1,15}] -> system0 refined to 15-10=5;
    // system1 (the last system in the merged list) keeps its raw estimate (9).
    expect(result.refinedMeasures).toEqual([5, 9]);
  });

  it('exposes a switchable alternative when the two OCR methods disagree', () => {
    const ocrEntriesBox = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 4 }];
    const ocrEntriesStrip = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 8 }];
    const result = chooseMeasureReadings({
      usedOcrAnywhere: true, measureNumberEntries: [], ocrEntriesBox, ocrEntriesStrip,
      measuresPerSystem, rawSections,
    });
    expect(result.readings).not.toBeNull();
    expect(result.readings.options.map((o) => o.label)).toEqual(['Per-number', 'Margin scan']);
  });

  it('does not expose a switchable alternative when both OCR methods agree', () => {
    const ocrEntriesBox = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 4 }];
    const ocrEntriesStrip = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 4 }];
    const result = chooseMeasureReadings({
      usedOcrAnywhere: true, measureNumberEntries: [], ocrEntriesBox, ocrEntriesStrip,
      measuresPerSystem, rawSections,
    });
    expect(result.readings).toBeNull();
  });
});

describe('computeWarnings', () => {
  it('warns when no systems were detected', () => {
    expect(computeWarnings(0, [])).toEqual(['No systems were detected — make sure a PDF is loaded and rendered.']);
  });

  it('warns when measure counts vary a lot across systems', () => {
    const warnings = computeWarnings(3, [1, 1, 49]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/vary a lot/);
    expect(warnings[0]).toMatch(/1-49/);
  });

  it('is silent for a plausible spread', () => {
    expect(computeWarnings(3, [4, 5, 6])).toEqual([]);
  });
});

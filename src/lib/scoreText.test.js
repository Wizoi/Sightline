import { describe, it, expect } from 'vitest';
import {
  TEMPO_WORDS, groupIntoRows, findTempoMarking, hasTempoMarking, collectKnownNames, findSectionTitle,
  extractMeasureNumbers, refineMeasureCounts, extractTempoMarks, filterMeasureNumberOutliers,
  detectMeasureNumberResets,
} from './scoreText.js';

// item() mimics the simplified {str, x, y} shape scoreAnalysis.js extracts
// from pdfjs' page.getTextContent() items.
function item(str, x, y) { return { str, x, y }; }

describe('groupIntoRows', () => {
  it('groups same-row items and joins them in x-order with a space between', () => {
    const items = [
      item('1', 81.2, 691.1),
      item('Clarinet in B', 39.1, 691.1),
      item(' ', 79.4, 691.1), // a real space item -- doesn't matter either way, see next test
    ];
    const rows = groupIntoRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Clarinet in B 1');
    expect(rows[0].x).toBeCloseTo(39.1, 5);
  });

  it('spaces adjacent items correctly even without a real space item between them', () => {
    // A real PDF doesn't always carry an explicit space item -- joining
    // survives that either way.
    const items = [item('Clarinet in B', 39.1, 691.1), item('1', 81.2, 691.1)];
    const rows = groupIntoRows(items);
    expect(rows[0].text).toBe('Clarinet in B 1');
  });

  it('drops glyph noise that happens to decode to punctuation, not just empty strings', () => {
    // A real, surprising finding: some music-engraving glyphs (staccato
    // dots, spacers) decode to ordinary-looking "." or whitespace rather
    // than an empty string, and would otherwise corrupt reconstruction.
    const items = [
      item('B', 39.0, 692.5), item('Cl. 1', 45.0, 692.5),
      item('.', 60.0, 692.5), item('.', 65.0, 692.5), item('  ', 70.0, 692.5),
    ];
    const rows = groupIntoRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('B Cl. 1');
  });

  it('keeps rows separate when y differs by more than rowEps', () => {
    const items = [item('Andante', 120, 700), item('Cl. 1', 48, 500)];
    const rows = groupIntoRows(items, 2);
    expect(rows).toHaveLength(2);
  });

  it('sorts rows top-to-bottom (highest y first)', () => {
    const items = [item('lower', 0, 100), item('upper', 0, 700)];
    const rows = groupIntoRows(items);
    expect(rows.map((r) => r.text)).toEqual(['upper', 'lower']);
  });

  it('returns an empty list for no items', () => {
    expect(groupIntoRows([])).toEqual([]);
  });

  it('drops empty-string glyph items so they cannot corrupt a row\'s x or text', () => {
    // Mirrors real music-notation glyphs (noteheads, stems) sharing a row's
    // y with real text but sitting further left, with no readable string.
    const items = [item('Andante', 120.7, 700), item('', 10, 700), item('', 5, 700)];
    const rows = groupIntoRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Andante');
    expect(rows[0].x).toBeCloseTo(120.7, 5);
  });

  it('does not let a chain of near-miss items bridge two rows via a drifting average', () => {
    // A running-average merge reference would let a dense chain of items
    // drag one row's average y toward a genuinely distant row until they
    // merge. Each of these filler items is within rowEps of its immediate
    // predecessor, but the chain as a whole spans 10pt (5x rowEps).
    const chain = [];
    for (let y = 700; y >= 690; y -= 1) chain.push(item('x', 50, y));
    const items = [item('TopRow', 40, 700), ...chain, item('BottomRow', 40, 690)];
    const rows = groupIntoRows(items, 2);
    const top = rows.find((r) => r.text.includes('TopRow'));
    const bottom = rows.find((r) => r.text.includes('BottomRow'));
    expect(top).toBeTruthy();
    expect(bottom).toBeTruthy();
    expect(top).not.toBe(bottom);
  });
});

describe('findTempoMarking', () => {
  it('finds a tempo word among the page items', () => {
    const items = [item('Juggling Clowns', 200, 750), item('Andante', 77, 693)];
    expect(findTempoMarking(items)).toEqual({ word: 'Andante', x: 77, y: 693 });
  });

  it('returns null when no tempo word is present', () => {
    expect(findTempoMarking([item('Juggling Clowns', 200, 750)])).toBeNull();
  });

  it('covers every word in the exported vocabulary', () => {
    for (const word of TEMPO_WORDS) {
      expect(findTempoMarking([item(word, 0, 0)])).toEqual({ word, x: 0, y: 0 });
    }
  });
});

describe('hasTempoMarking', () => {
  it('is true for a tempo word', () => {
    expect(hasTempoMarking([item('Andante', 82, 684)])).toBe(true);
  });

  it('is true for a bare numeric metronome mark, with no tempo word present', () => {
    // Real case: an 8-file IMSLP trio-score folder prints ONLY "♩ = 127"
    // (text layer carries just "= 127", the note glyph itself decoding to
    // nothing), never an Italian tempo word.
    expect(hasTempoMarking([item('= 127', 60, 735)])).toBe(true);
  });

  it('is true for a numeric mark with no space and a leading note glyph in the item', () => {
    expect(hasTempoMarking([item('♩=100', 60, 505)])).toBe(true);
  });

  it('is false when neither a tempo word nor a plausible numeric mark is present', () => {
    expect(hasTempoMarking([item('Juggling Clowns', 200, 750)])).toBe(false);
  });

  it('ignores an implausible numeric mark (a stray "= 5" or a huge value)', () => {
    expect(hasTempoMarking([item('= 5', 60, 505), item('= 999', 60, 504)])).toBe(false);
  });
});

describe('collectKnownNames', () => {
  // y values loosely mirror the real test file: a title block well above
  // the first system (y=739.7), the first system's own full-name labels
  // roughly at its top edge (~691) down to its own bottom edge (~570,
  // covering the whole braced system -- every instrument stacked at its own
  // staff's y but all still within system 0's own band), and later systems'
  // abbreviated labels further down the page (smaller y, PDF space is
  // bottom-up) -- outside system 0's band entirely.
  const firstSystem = { yTop: 691, yBottom: 570 };

  it('collects both the full name (system 1, isFull) and abbreviated form (later systems, not isFull)', () => {
    // Mirrors the real finding: a score prints an instrument's full name
    // only once (beside its first system), then an abbreviated form beside
    // every system after -- neither "once" nor "repeats" alone tells real
    // labels apart from one-off title text, so both forms must be kept, but
    // tagged so callers (findSectionTitle) can tell them apart -- see the
    // Finding 2 regression test below for why that tag matters.
    const rows = [
      { x: 39, y: 691, text: 'Clarinet in B 1' },
      { x: 120.7, y: 712, text: 'Andante' }, // right of the margin -- a real tempo-word row
      { x: 72.8, y: 531, text: '6' }, // a measure number row, also right of margin in real data
      { x: 45.9, y: 615, text: 'Alto Clarinet' },
      { x: 45.1, y: 577, text: 'Bass Clarinet' },
      { x: 39, y: 517, text: 'B Cl. 1' }, // system 2's abbreviated label
      { x: 46.5, y: 441, text: 'A.Cl.' },
    ];
    expect(collectKnownNames(rows, firstSystem)).toEqual([
      { text: 'Clarinet in B 1', isFull: true },
      { text: 'Alto Clarinet', isFull: true },
      { text: 'Bass Clarinet', isFull: true },
      { text: 'B Cl. 1', isFull: false },
      { text: 'A.Cl.', isFull: false },
    ]);
  });

  it('excludes title-block text sitting above the first system, even at the left margin', () => {
    // The real gotcha this was built to fix: "Score" sits at the left
    // margin just like a real instrument label, but well above where the
    // first system begins (y=739.7 vs. firstSystem.yTop=691) -- unlike
    // either form of a genuine label.
    const rows = [
      { x: 73.9, y: 739.7, text: 'Score' },
      { x: 39, y: 691, text: 'Clarinet in B 1' },
    ];
    expect(collectKnownNames(rows, firstSystem)).toEqual([{ text: 'Clarinet in B 1', isFull: true }]);
  });

  it('allows a label sitting a little above the system it names, within pad', () => {
    const rows = [{ x: 39, y: firstSystem.yTop + 10, text: 'Clarinet in B 1' }];
    expect(collectKnownNames(rows, firstSystem, { pad: 30 })).toEqual([{ text: 'Clarinet in B 1', isFull: true }]);
  });

  it('does not apply the position filter when firstSystem is unknown (null), and treats everything as isFull', () => {
    const rows = [{ x: 39, y: 9999, text: 'Clarinet in B 1' }];
    expect(collectKnownNames(rows, null)).toEqual([{ text: 'Clarinet in B 1', isFull: true }]);
  });

  it('ignores rows at or past the left-margin threshold', () => {
    const rows = [{ x: 120, y: 691, text: 'Some Title' }];
    expect(collectKnownNames(rows, firstSystem, { leftMarginX: 120 })).toEqual([]);
  });

  it('ignores very short strings', () => {
    const rows = [{ x: 10, y: 691, text: 'B' }];
    expect(collectKnownNames(rows, firstSystem, { minLength: 2 })).toEqual([]);
  });

  it('rejects pure-noise fragments with no real run of letters (a real dense-score bug)', () => {
    // Real finding on "The Fantastic Parade" (a 20+-instrument conductor's
    // score): its compact left margin puts each instrument's own time
    // signature at nearly the same y as that instrument's name, so
    // groupIntoRows correctly-by-its-own-rules merges them into one row --
    // producing garbage like "6 J" or "b J" ("J" a stray music-font glyph
    // decoding to an ordinary letter). These have no real word in them and
    // must not become "known names" -- they trivially self-match on every
    // later page where the same time-signature noise repeats alone,
    // spawning a garbage section boundary per page.
    const rows = [
      { x: 39, y: 691, text: '6 J' },
      { x: 39, y: 660, text: 'b J J' },
      { x: 39, y: 630, text: '8 J' },
    ];
    expect(collectKnownNames(rows, firstSystem)).toEqual([]);
  });

  it('keeps a compound row that still has a real name prefix, even with trailing noise', () => {
    // Less clean than fully-rejecting, but a real prefix ("Oboes") is far
    // less likely to spuriously re-match a later page verbatim than a
    // pure-noise fragment is -- see collectKnownNames' own comment.
    const rows = [{ x: 39, y: 691, text: 'Oboes 8 J' }];
    expect(collectKnownNames(rows, firstSystem)).toEqual([{ text: 'Oboes 8 J', isFull: true }]);
  });
});

describe('findSectionTitle', () => {
  const knownNames = [
    { text: 'Clarinet in B 1', isFull: true },
    { text: 'Bass Clarinet', isFull: true },
  ];

  it('detects a real title page: left-margin name + a tempo marking present', () => {
    const items = [item('Andante', 82, 684), item('Bass Clarinet', 39, 728)];
    const rows = [{ x: 39, y: 728, text: 'Bass Clarinet' }, { x: 216, y: 739, text: 'Juggling Clowns' }];
    expect(findSectionTitle(items, rows, knownNames)).toBe('Bass Clarinet');
  });

  it('does not flag a continuation page: name present but centered, no tempo word', () => {
    // Mirrors the real running-header pattern (page 13 of the test PDF):
    // "Bass Clarinet" repeats, but centered (x=275) and without "Andante".
    const items = [item('Juggling Clowns', 262, 757), item('Bass Clarinet', 275, 738)];
    const rows = [{ x: 262, y: 757, text: 'Juggling Clowns' }, { x: 275, y: 738, text: 'Bass Clarinet' }];
    expect(findSectionTitle(items, rows, knownNames)).toBeNull();
  });

  it('does not flag a page with a tempo word but no matching left-margin name', () => {
    const items = [item('Andante', 82, 684)];
    const rows = [{ x: 39, y: 728, text: 'Some Other Part' }];
    expect(findSectionTitle(items, rows, knownNames)).toBeNull();
  });

  it('detects a real title page whose only tempo signal is a bare numeric metronome mark', () => {
    // The real bug this fixes: an 8-file IMSLP trio-score folder prints
    // "B Clarinet 1" (matches knownNames via startsWith) at the left margin
    // plus "= 127" -- never an Italian tempo word -- so the old word-only
    // gate rejected every one of these real title pages.
    const items = [item('= 127', 60, 735), item('Bass Clarinet', 39, 728)];
    const rows = [{ x: 39, y: 728, text: 'Bass Clarinet' }, { x: 216, y: 739, text: 'The Spanish Winds' }];
    expect(findSectionTitle(items, rows, knownNames)).toBe('Bass Clarinet');
  });

  it('still rejects a continuation page with a numeric mark but no left-margin name match', () => {
    const items = [item('= 127', 60, 735)];
    const rows = [{ x: 275, y: 738, text: 'Some Other Part' }];
    expect(findSectionTitle(items, rows, knownNames)).toBeNull();
  });

  it('rejects a match against an ABBREVIATED (non-full) known name (real "Score and Parts" bug, Finding 2)', () => {
    // Real bug: a mid-Score CONTINUATION page (every instrument still
    // braced together, not a new part) legitimately shows an abbreviated
    // per-staff label at the left margin (as it does on every page of the
    // Score) plus the Score's own numeric tempo mark restated at the top --
    // both real signals, wrongly treated as "a new part's title page"
    // before this fix. A genuine new part's own opening page always prints
    // its FULL name, so only an isFull match should ever trigger a boundary.
    const abbrevOnly = [{ text: 'B Cl. 1', isFull: false }];
    const items = [item('= 127', 60, 735), item('B Cl. 1', 39, 728)];
    const rows = [{ x: 39, y: 728, text: 'B Cl. 1' }, { x: 216, y: 739, text: 'Juggling Clowns' }];
    expect(findSectionTitle(items, rows, abbrevOnly)).toBeNull();
  });

  it('still accepts a full-name match even when an abbreviated entry for the same instrument also exists', () => {
    const mixed = [{ text: 'Bass Clarinet', isFull: true }, { text: 'B Cl. 1', isFull: false }];
    const items = [item('Andante', 82, 684), item('Bass Clarinet', 39, 728)];
    const rows = [{ x: 39, y: 728, text: 'Bass Clarinet' }, { x: 216, y: 739, text: 'Juggling Clowns' }];
    expect(findSectionTitle(items, rows, mixed)).toBe('Bass Clarinet');
  });
});

describe('extractMeasureNumbers', () => {
  it('correlates numeric items to the system whose y-range contains them', () => {
    const items = [item('26', 72.8, 722.2), item('26', 72.8, 607.8), item('2', 72.1, 756.7)];
    const systems = [
      { index: 0, yTop: 730, yBottom: 700 },
      { index: 1, yTop: 615, yBottom: 590 },
    ];
    expect(extractMeasureNumbers(items, systems)).toEqual([
      { systemIndex: 0, measureNumber: 26 },
      { systemIndex: 1, measureNumber: 26 },
    ]);
  });

  it('skips a system with no numeric item in range', () => {
    const items = [item('26', 72.8, 722.2)];
    const systems = [{ index: 0, yTop: 800, yBottom: 780 }];
    expect(extractMeasureNumbers(items, systems)).toEqual([]);
  });

  it('ignores numbers outside every system range (e.g. a page number)', () => {
    const items = [item('2', 72.1, 756.7)]; // above all systems, like a page number
    const systems = [{ index: 0, yTop: 730, yBottom: 700 }];
    expect(extractMeasureNumbers(items, systems)).toEqual([]);
  });

  it('matches a number engraved above the system\'s own top edge, within pad', () => {
    // The real, consistently-observed engraving offset: ~10pt above yTop.
    const items = [item('21', 37.5, 393.7)];
    const systems = [{ index: 0, yTop: 383.5, yBottom: 361.7 }];
    expect(extractMeasureNumbers(items, systems)).toEqual([{ systemIndex: 0, measureNumber: 21 }]);
  });

  it('regression: matches every system on a tightly-packed real page (9 systems, one page)', () => {
    // Mirrors the real bug: with no pad, this page matched zero of 8 real
    // printed numbers, because every one sits just above its target
    // system's un-padded range on a page with fairly tight system spacing.
    const printed = [
      ['6', 607.1], ['11', 536.0], ['16', 464.7], ['21', 393.7],
      ['26', 322.4], ['33', 251.3], ['38', 180.3], ['43', 109.7],
    ];
    const items = printed.map(([n, y]) => item(n, 37.5, y));
    const systemTops = [597.3, 526.0, 454.7, 383.5, 312.2, 241.6, 170.3, 99.7];
    const systems = systemTops.map((yTop, i) => ({ index: i + 1, yTop, yBottom: yTop - 22 }));
    const result = extractMeasureNumbers(items, systems);
    expect(result).toHaveLength(8);
    expect(result.map((r) => r.measureNumber)).toEqual([6, 11, 16, 21, 26, 33, 38, 43]);
  });

  it('picks the closest candidate when a generous pad could match more than one', () => {
    const items = [item('5', 0, 100), item('9', 0, 108)]; // both within pad of yTop=95
    const systems = [{ index: 0, yTop: 95, yBottom: 80 }];
    expect(extractMeasureNumbers(items, systems)).toEqual([{ systemIndex: 0, measureNumber: 5 }]);
  });
});

describe('extractTempoMarks', () => {
  it('reads "= N" metronome marks and ties them to the system below', () => {
    // Mirrors the Cruel Angel's Thesis layout: ♩=86 above system 0, ♩=128
    // above system 1. pdfjs drops the note glyph, so the text item is "= 86".
    const items = [item('= 86', 60, 735), item('= 128', 60, 620)];
    const systems = [
      { index: 0, yTop: 730, yBottom: 700 },
      { index: 1, yTop: 615, yBottom: 585 },
    ];
    expect(extractTempoMarks(items, systems)).toEqual([
      { systemIndex: 0, bpm: 86 },
      { systemIndex: 1, bpm: 128 },
    ]);
  });

  it('accepts marks with no space and a leading note glyph in the same item', () => {
    const items = [item('♩=100', 60, 505)];
    const systems = [{ index: 0, yTop: 500, yBottom: 480 }];
    expect(extractTempoMarks(items, systems)).toEqual([{ systemIndex: 0, bpm: 100 }]);
  });

  it('ignores implausible numbers (a stray "= 5" or a huge value)', () => {
    const items = [item('= 5', 60, 505), item('= 999', 60, 504)];
    const systems = [{ index: 0, yTop: 500, yBottom: 480 }];
    expect(extractTempoMarks(items, systems)).toEqual([]);
  });

  it('returns nothing for a system with no mark in range', () => {
    const items = [item('= 120', 60, 900)]; // far above the system
    const systems = [{ index: 0, yTop: 500, yBottom: 480 }];
    expect(extractTempoMarks(items, systems)).toEqual([]);
  });
});

describe('refineMeasureCounts', () => {
  it('replaces the barline estimate with the exact delta between adjacent known systems', () => {
    const barlineEstimate = [3, 3, 3, 3]; // e.g. all guessed the same, real data disagrees
    const entries = [
      { systemIndex: 0, measureNumber: 26 },
      { systemIndex: 1, measureNumber: 30 }, // system 0 really has 4 measures
      { systemIndex: 2, measureNumber: 33 }, // system 1 really has 3 measures
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([4, 3, 3, 3]);
  });

  it('distributes the known total across a gap of un-numbered systems', () => {
    // Systems 0 and 1 are bracketed by 26 and 33 -> 7 measures across 2 systems.
    // System 1's own number wasn't found, but the total is still authoritative,
    // so it's shared out (proportionally, equal barline weights -> 4 + 3) rather
    // than left on the raw estimate.
    const barlineEstimate = [3, 3, 3];
    const entries = [
      { systemIndex: 0, measureNumber: 26 },
      { systemIndex: 2, measureNumber: 33 },
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([4, 3, 3]);
  });

  it('splits a gap evenly regardless of the (untrusted) barline estimate', () => {
    // 11 measures across 2 systems -> [6,5], ignoring the noisy barline
    // ([12,10]); the last system, past the final number, keeps its estimate.
    const barlineEstimate = [12, 10, 99];
    const entries = [
      { systemIndex: 0, measureNumber: 40 },
      { systemIndex: 2, measureNumber: 51 },
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([6, 5, 99]);
  });

  it('gives every system in a gap at least one measure', () => {
    const barlineEstimate = [0, 0, 0, 9];
    const entries = [
      { systemIndex: 0, measureNumber: 10 },
      { systemIndex: 3, measureNumber: 13 }, // 3 measures across 3 systems -> 1 each
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([1, 1, 1, 9]);
  });

  it('leaves a gap on the barline estimate when the total cannot cover one each', () => {
    // 2 measures claimed across 3 systems is implausible (a misread) -> untouched.
    const barlineEstimate = [4, 4, 4];
    const entries = [
      { systemIndex: 0, measureNumber: 10 },
      { systemIndex: 3, measureNumber: 12 },
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([4, 4, 4]);
  });

  it('ignores a non-positive delta (defensive against a misread number)', () => {
    const barlineEstimate = [3, 3];
    const entries = [{ systemIndex: 0, measureNumber: 30 }, { systemIndex: 1, measureNumber: 26 }];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([3, 3]);
  });

  it('is a no-op with no entries', () => {
    expect(refineMeasureCounts([5, 5], [])).toEqual([5, 5]);
  });

  it('anchors the unnumbered first system at measure 1 (the "Departure!" 30-vs-11 bug)', () => {
    // System 1 has no printed "1"; system 2 prints "12". Its raw barline
    // estimate is wildly high (30). Anchoring measure 1 fixes it to 12-1 = 11.
    const barlineEstimate = [30, 7, 7];
    const entries = [
      { systemIndex: 1, measureNumber: 12 },
      { systemIndex: 2, measureNumber: 19 },
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([11, 7, 7]);
  });

  it('does not double-anchor when the first system already carries a printed number', () => {
    const barlineEstimate = [9, 9];
    const entries = [{ systemIndex: 0, measureNumber: 1 }, { systemIndex: 1, measureNumber: 5 }];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([4, 9]);
  });

  it('distributes across the leading gap when the first printed number is not on system 1', () => {
    // Systems 0,1 unnumbered; first printed number "19" is on system 2. With the
    // implicit measure-1 anchor that's 18 measures across systems 0,1 -> [9,9]
    // (even), instead of both staying on the raw estimate.
    const barlineEstimate = [30, 8, 8];
    const entries = [{ systemIndex: 2, measureNumber: 19 }];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([9, 9, 8]);
  });
});

describe('filterMeasureNumberOutliers', () => {
  it('keeps a clean strictly-increasing sequence untouched', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 18 },
    ];
    expect(filterMeasureNumberOutliers(entries)).toEqual(entries);
  });

  it('drops a single misread that breaks monotonicity (an OCR slip)', () => {
    // 18 misread as 2 on system 2 — off the increasing run, so discarded.
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 2 },
      { systemIndex: 3, measureNumber: 24 },
    ];
    expect(filterMeasureNumberOutliers(entries)).toEqual([
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 3, measureNumber: 24 },
    ]);
  });

  it('drops a too-high misread as well (keeps the longer coherent run)', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 5 },
      { systemIndex: 1, measureNumber: 88 }, // misread, breaks the run
      { systemIndex: 2, measureNumber: 10 },
      { systemIndex: 3, measureNumber: 15 },
    ];
    expect(filterMeasureNumberOutliers(entries)).toEqual([
      { systemIndex: 0, measureNumber: 5 },
      { systemIndex: 2, measureNumber: 10 },
      { systemIndex: 3, measureNumber: 15 },
    ]);
  });

  it('sorts by systemIndex before evaluating (order-independent)', () => {
    const entries = [
      { systemIndex: 2, measureNumber: 18 },
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
    ];
    expect(filterMeasureNumberOutliers(entries)).toEqual([
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 18 },
    ]);
  });

  it('returns a 0/1-entry list unchanged', () => {
    expect(filterMeasureNumberOutliers([])).toEqual([]);
    expect(filterMeasureNumberOutliers([{ systemIndex: 0, measureNumber: 5 }])).toEqual([{ systemIndex: 0, measureNumber: 5 }]);
  });
});

describe('detectMeasureNumberResets', () => {
  it('detects a part restarting at measure 1', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 1 }, // a new part begins here
      { systemIndex: 3, measureNumber: 5 },
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([2]);
  });

  it('detects multiple resets across a multi-part booklet', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 5, measureNumber: 30 },
      { systemIndex: 6, measureNumber: 1 }, // part 2 starts
      { systemIndex: 10, measureNumber: 22 },
      { systemIndex: 11, measureNumber: 2 }, // part 3 starts (pickup measure "2")
      { systemIndex: 15, measureNumber: 18 },
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([6, 11]);
  });

  it('does not flag a plain increasing sequence', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
      { systemIndex: 2, measureNumber: 18 },
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([]);
  });

  it('does not flag a drop to a value above maxRestart (likely a misread, not a real restart)', () => {
    // A genuine restart is always small (1, or a small pickup number); a
    // drop to something bigger (e.g. 38 misread as 25) is left for
    // refineMeasureCounts' own defensive total<=0 guard to no-op on,
    // rather than spawning a bogus section boundary.
    const entries = [
      { systemIndex: 0, measureNumber: 30 },
      { systemIndex: 1, measureNumber: 25 },
      { systemIndex: 2, measureNumber: 29 },
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([]);
  });

  it('respects a custom maxRestart', () => {
    const entries = [{ systemIndex: 0, measureNumber: 30 }, { systemIndex: 1, measureNumber: 5 }];
    expect(detectMeasureNumberResets(entries)).toEqual([]); // 5 > default maxRestart of 3
    expect(detectMeasureNumberResets(entries, { maxRestart: 5 })).toEqual([1]);
  });

  it('sorts by systemIndex before evaluating (order-independent)', () => {
    const entries = [
      { systemIndex: 2, measureNumber: 1 },
      { systemIndex: 0, measureNumber: 9 },
      { systemIndex: 1, measureNumber: 14 },
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([2]);
  });

  it('rejects a flatlined repeated misread instead of a real restart (real corpus bug)', () => {
    // Real finding on "A Lazy Summer Day": some OTHER printed digit (almost
    // certainly not a measure number at all -- possibly a second-player
    // suffix like "Flute 2") gets picked up as measureNumber 2 on several
    // consecutive systems in a row. A genuine restart always resumes
    // climbing on the very next reading; a flatlined repeat never does, so
    // this must be rejected even though the very first "2" alone looks
    // exactly like a valid small-restart drop.
    const entries = [
      { systemIndex: 0, measureNumber: 15 },
      { systemIndex: 1, measureNumber: 19 },
      { systemIndex: 2, measureNumber: 2 }, // misread, not a real restart
      { systemIndex: 3, measureNumber: 2 }, // same misread again
      { systemIndex: 4, measureNumber: 2 },
      { systemIndex: 5, measureNumber: 36 }, // real numbering resumes
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([]);
  });

  it('still accepts a real restart whose very next reading confirms it climbs', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 24 },
      { systemIndex: 1, measureNumber: 2 }, // a genuine restart this time
      { systemIndex: 2, measureNumber: 6 }, // confirms it: climbing again
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([1]);
  });

  it('accepts a restart with no following entry to confirm or contradict it', () => {
    const entries = [
      { systemIndex: 0, measureNumber: 24 },
      { systemIndex: 1, measureNumber: 2 }, // last entry -- nothing to contradict it
    ];
    expect(detectMeasureNumberResets(entries)).toEqual([1]);
  });

  it('returns nothing for a 0/1-entry list', () => {
    expect(detectMeasureNumberResets([])).toEqual([]);
    expect(detectMeasureNumberResets([{ systemIndex: 0, measureNumber: 5 }])).toEqual([]);
  });
});

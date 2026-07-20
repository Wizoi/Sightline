import { describe, it, expect } from 'vitest';
import {
  TEMPO_WORDS, groupIntoRows, findTempoMarking, collectKnownNames, findSectionTitle, extractMeasureNumbers,
  refineMeasureCounts,
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

describe('collectKnownNames', () => {
  // y values loosely mirror the real test file: a title block well above
  // the first system (y=739.7), the first system's own full-name labels
  // roughly at its top edge (~691), and later systems' abbreviated labels
  // further down the page (smaller y, PDF space is bottom-up).
  const topSystemY = 691;

  it('collects both the full name (system 1) and abbreviated form (later systems)', () => {
    // Mirrors the real finding: a score prints an instrument's full name
    // only once (beside its first system), then an abbreviated form beside
    // every system after -- neither "once" nor "repeats" alone tells real
    // labels apart from one-off title text, so both forms must be kept.
    const rows = [
      { x: 39, y: 691, text: 'Clarinet in B 1' },
      { x: 120.7, y: 712, text: 'Andante' }, // right of the margin -- a real tempo-word row
      { x: 72.8, y: 531, text: '6' }, // a measure number row, also right of margin in real data
      { x: 45.9, y: 615, text: 'Alto Clarinet' },
      { x: 45.1, y: 577, text: 'Bass Clarinet' },
      { x: 39, y: 517, text: 'B Cl. 1' }, // system 2's abbreviated label
      { x: 46.5, y: 441, text: 'A.Cl.' },
    ];
    expect(collectKnownNames(rows, topSystemY)).toEqual(['Clarinet in B 1', 'Alto Clarinet', 'Bass Clarinet', 'B Cl. 1', 'A.Cl.']);
  });

  it('excludes title-block text sitting above the first system, even at the left margin', () => {
    // The real gotcha this was built to fix: "Score" sits at the left
    // margin just like a real instrument label, but well above where the
    // first system begins (y=739.7 vs. topSystemY=691) -- unlike either
    // form of a genuine label.
    const rows = [
      { x: 73.9, y: 739.7, text: 'Score' },
      { x: 39, y: 691, text: 'Clarinet in B 1' },
    ];
    expect(collectKnownNames(rows, topSystemY)).toEqual(['Clarinet in B 1']);
  });

  it('allows a label sitting a little above the system it names, within pad', () => {
    const rows = [{ x: 39, y: topSystemY + 10, text: 'Clarinet in B 1' }];
    expect(collectKnownNames(rows, topSystemY, { pad: 30 })).toEqual(['Clarinet in B 1']);
  });

  it('does not apply the position filter when topSystemY is unknown (null)', () => {
    const rows = [{ x: 39, y: 9999, text: 'Clarinet in B 1' }];
    expect(collectKnownNames(rows, null)).toEqual(['Clarinet in B 1']);
  });

  it('ignores rows at or past the left-margin threshold', () => {
    const rows = [{ x: 120, y: 691, text: 'Some Title' }];
    expect(collectKnownNames(rows, topSystemY, { leftMarginX: 120 })).toEqual([]);
  });

  it('ignores very short strings', () => {
    const rows = [{ x: 10, y: 691, text: 'B' }];
    expect(collectKnownNames(rows, topSystemY, { minLength: 2 })).toEqual([]);
  });
});

describe('findSectionTitle', () => {
  const knownNames = ['Clarinet in B 1', 'Bass Clarinet'];

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

  it('leaves systems untouched when their neighbor is not directly adjacent (a gap)', () => {
    const barlineEstimate = [3, 3, 3];
    const entries = [
      { systemIndex: 0, measureNumber: 26 },
      { systemIndex: 2, measureNumber: 33 }, // system 1's number wasn't found -- a gap
    ];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([3, 3, 3]);
  });

  it('ignores a non-positive delta (defensive against a misread number)', () => {
    const barlineEstimate = [3, 3];
    const entries = [{ systemIndex: 0, measureNumber: 30 }, { systemIndex: 1, measureNumber: 26 }];
    expect(refineMeasureCounts(barlineEstimate, entries)).toEqual([3, 3]);
  });

  it('is a no-op with no entries', () => {
    expect(refineMeasureCounts([5, 5], [])).toEqual([5, 5]);
  });
});

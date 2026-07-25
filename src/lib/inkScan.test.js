import { describe, it, expect } from 'vitest';
import { detectStaffRows } from './inkScan.js';

// Build an isInk(row, col) callback from a set of "fully inked" rows plus an
// explicit width, matching the (isInk, aw, ah) calling convention this
// function shares with the rest of this codebase's pixel scanners.
function inkFromRows(inkedRows, aw, ah, { runLength = aw } = {}) {
  const rowSet = new Set(inkedRows);
  return (r, c) => rowSet.has(r) && c < runLength;
}

// Build an isInk(row, col) callback for ONE row from an explicit list of
// [startCol, length] ink segments -- the same shape real dumped scan data
// naturally comes in (a row's ink broken into many short runs, not one
// continuous block). Every other row is entirely non-ink.
function inkFromSegments(targetRow, segments) {
  return (r, c) => {
    if (r !== targetRow) return false;
    return segments.some(([start, len]) => c >= start && c < start + len);
  };
}

describe('detectStaffRows', () => {
  it('returns no rows when nothing is inked', () => {
    const isInk = () => false;
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('picks rows whose longest ink run exceeds the width threshold', () => {
    const isInk = inkFromRows([3, 9], 100, 20);
    expect(detectStaffRows(isInk, 100, 20)).toEqual([3, 9]);
  });

  it('ignores a row whose ink run falls short of the default 0.45*width need', () => {
    // Run length 44 out of width 100 -- just short of the default need (45).
    const isInk = inkFromRows([5], 100, 20, { runLength: 44 });
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('includes a row whose ink run just clears the default 0.45*width need', () => {
    // Run length 46 out of width 100 -- just over the default need (45).
    const isInk = inkFromRows([5], 100, 20, { runLength: 46 });
    expect(detectStaffRows(isInk, 100, 20)).toEqual([5]);
  });

  it('only counts the longest contiguous run, not total inked pixels on the row', () => {
    // Two short separate ink runs (20 + 20 = 40 total) neither individually
    // nor combined-as-a-single-run reach the 45px need for a 100px-wide row
    // -- scattered ink (e.g. note heads/stems, not a staff line) must not
    // register as a detected row.
    const isInk = (r, c) => r === 7 && ((c >= 0 && c < 20) || (c >= 60 && c < 80));
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  it('honors a custom widthFrac threshold', () => {
    const isInk = inkFromRows([2], 100, 10, { runLength: 30 });
    expect(detectStaffRows(isInk, 100, 10)).toEqual([]); // default 0.45 -> need 45, misses
    expect(detectStaffRows(isInk, 100, 10, { widthFrac: 0.25 })).toEqual([2]); // need 25, hits
  });

  // Real dumped ink-segment data from a scanned single-staff-part booklet
  // ("Full band arrangements/Teutonia.pdf," Oboe part, page row 256 at this
  // module's aw=1553 analysis-canvas width) -- root-caused via
  // docs/personas/omr/investigation-log.md's 2026-07-25 entry. Before the
  // gap-bridging fix, this row (a REAL staff line, confirmed by rendering
  // the actual page) was invisible to detectStaffRows entirely: its longest
  // unbroken ink run was only 402px, well under the 0.45*1553=698.85 need,
  // even though 1012 of its 1553 columns are ink (65%) -- the line is
  // broken into 34 short segments by small scan-degradation gaps (median
  // ~5px in the real full-page data this row was drawn from), not one big
  // legitimate gap. This one page alone had 7-8 real staves silently
  // undercounted to 1 detected system before this fix.
  const REAL_SCANNED_STAFF_LINE_ROW = 256;
  const REAL_SCANNED_STAFF_LINE_SEGMENTS = [
    [172, 3], [184, 2], [206, 11], [279, 3], [297, 4], [304, 1], [313, 9], [337, 6],
    [356, 9], [373, 3], [377, 6], [384, 2], [394, 1], [396, 10], [408, 2], [419, 1],
    [421, 8], [435, 10], [446, 4], [458, 14], [478, 4], [486, 12], [499, 37], [537, 2],
    [541, 19], [562, 2], [566, 16], [583, 2], [587, 12], [600, 2], [603, 20], [624, 39],
    [665, 334], [1000, 402],
  ];

  it('bridges the small scan-degradation gaps in a real broken staff line and detects it (real corpus bug, Teutonia.pdf Oboe part)', () => {
    const isInk = inkFromSegments(REAL_SCANNED_STAFF_LINE_ROW, REAL_SCANNED_STAFF_LINE_SEGMENTS);
    expect(detectStaffRows(isInk, 1553, 1200)).toEqual([REAL_SCANNED_STAFF_LINE_ROW]);
  });

  it('would have missed that same real staff line entirely at the old (unbridged) behavior -- documents what the fix actually changed', () => {
    const isInk = inkFromSegments(REAL_SCANNED_STAFF_LINE_ROW, REAL_SCANNED_STAFF_LINE_SEGMENTS);
    expect(detectStaffRows(isInk, 1553, 1200, { gapBridgePx: 0 })).toEqual([]);
  });

  // Contrast case, same real page/file: a row whose staff line rendered
  // with one big unbroken run (967px, comfortably over the 698.85 need) --
  // already correctly detected before this fix, and must stay unaffected
  // by gap-bridging now being on by default.
  it('still detects an already-clean real staff line row unaffected by gap-bridging (Teutonia.pdf Oboe part, row 397)', () => {
    const segments = [
      [153, 3], [166, 4], [175, 2], [182, 17], [205, 13], [232, 3], [248, 8], [273, 5],
      [290, 1], [292, 8], [310, 10], [327, 2], [340, 1], [349, 2], [359, 3], [371, 2],
      [377, 2], [380, 4], [392, 2], [399, 6], [412, 14], [430, 2], [433, 967],
    ];
    const isInk = inkFromSegments(397, segments);
    expect(detectStaffRows(isInk, 1553, 1200)).toEqual([397]);
  });

  it('does NOT bridge two genuinely separate ink features across a real-scale gap (regression guard for the default gapBridgePx=10)', () => {
    // Same shape as the "scattered blobs" test above, just re-affirmed at
    // this module's real gapBridgePx=10 default: a 40px gap between two
    // 20px blobs is nowhere near small enough to bridge, so this must stay
    // undetected -- gap-bridging must not turn ordinary note-head/stem
    // spacing into a false staff-line reading.
    const isInk = (r, c) => r === 7 && ((c >= 0 && c < 20) || (c >= 60 && c < 80));
    expect(detectStaffRows(isInk, 100, 20)).toEqual([]);
  });

  // Real dumped ink-segment data from a real, clean/vector (NOT scanned)
  // PDF -- "Personal conditioning duets and music/Thirty Caprices No 1 arr
  // Cavallini/CavalliniNo1-a4.pdf," row 1112 of its Mutopia license-notice
  // text box at the bottom of the page (aw=848 at this module's analysis-
  // canvas scale). This is the real regression the gap-bridging fix above
  // introduced and root-caused via docs/personas/omr/investigation-log.md's
  // 2026-07-25 entry: ordinary body-text letter/word spacing is frequently
  // just as small as a scanned staff line's own noise gaps (both commonly a
  // handful of px), so gapBridgePx alone bridged this text line into a
  // 389px run -- comfortably over the 0.45*848=381.6 need -- turning a
  // 3-line legal notice into 2 phantom extra "systems" on an otherwise
  // perfectly-detected 12-system single page (12/12 before this fix, 14/12
  // with gap-bridging alone and no density gate). Must NOT be detected.
  const REAL_TEXT_ROW_SEGMENTS = [
    [98, 2], [106, 4], [114, 5], [122, 3], [127, 4], [132, 4], [140, 9], [150, 3], [154, 3],
    [158, 8], [168, 4], [176, 9], [186, 4], [191, 9], [231, 4], [236, 4], [241, 3], [245, 8],
    [254, 4], [259, 6], [266, 3], [270, 4], [277, 2], [281, 8], [290, 4], [295, 3], [300, 3],
    [305, 9], [343, 5], [361, 2], [364, 2], [368, 5], [374, 4], [380, 3], [387, 4], [393, 4],
    [402, 5], [409, 4], [414, 15], [431, 2], [435, 4], [440, 5], [447, 5], [460, 6], [467, 5],
    [473, 4], [478, 5], [488, 4], [494, 5], [501, 4], [510, 9], [520, 3], [526, 3], [531, 5],
    [538, 4], [543, 9], [557, 4], [562, 4], [572, 8], [582, 18], [601, 5], [607, 2], [610, 3],
    [614, 4], [620, 3], [631, 10], [643, 4], [649, 8], [658, 7], [666, 2], [673, 4], [679, 5],
    [687, 5], [696, 6], [704, 4], [709, 9], [719, 4], [724, 15], [748, 2],
  ];

  it('does NOT bridge real body-text letter/word spacing into a false staff-line reading (real corpus bug, CavalliniNo1-a4.pdf license box)', () => {
    const isInk = inkFromSegments(1112, REAL_TEXT_ROW_SEGMENTS);
    expect(detectStaffRows(isInk, 848, 1200)).toEqual([]);
  });

  it('confirms gap-bridging ALONE (no density gate) would have wrongly detected that same real text row -- documents what the density gate fixes', () => {
    const isInk = inkFromSegments(1112, REAL_TEXT_ROW_SEGMENTS);
    expect(detectStaffRows(isInk, 848, 1200, { inkDensityMin: 0 })).toEqual([1112]);
  });

  it('still detects the real recovered scanned staff line at the default inkDensityMin (its bridged run is 93% real ink, comfortably above the 0.85 gate)', () => {
    const isInk = inkFromSegments(REAL_SCANNED_STAFF_LINE_ROW, REAL_SCANNED_STAFF_LINE_SEGMENTS);
    expect(detectStaffRows(isInk, 1553, 1200, { inkDensityMin: 0.85 })).toEqual([REAL_SCANNED_STAFF_LINE_ROW]);
  });

  // Regression guard for a latent bug in the first version of the density
  // gate: it measured density on the row's LONGEST run only, so a row
  // holding both a genuine solid staff line AND a longer-but-sparser
  // bridged stretch elsewhere (a dashed rule, a widely-spaced text line)
  // had the sparse one win "longest", fail the density check, and take the
  // whole row down with it -- silently dropping a real staff line that even
  // the ORIGINAL pre-bridging algorithm would have accepted. Qualification
  // is now evaluated per-run instead. Not seen on the 39-file corpus, but
  // reachable, and exactly the mixed-content row this module now scans.
  it('accepts a row whose solid staff-line run qualifies even when a LONGER, sparser bridged stretch also exists on that row', () => {
    const aw = 1000; // need = 0.45 * 1000 = 450
    const isInk = (r, c) => {
      if (c < 460) return true;                    // genuine solid run, clears need at density 1.0
      if (c >= 500) return ((c - 500) % 15) < 6;   // longer sparse bridged stretch, density ~0.4
      return false;
    };
    expect(detectStaffRows(isInk, aw, 1)).toEqual([0]);
  });

  it('still rejects a row that ONLY has the sparse bridged stretch (the density gate is not weakened by the per-run change)', () => {
    const aw = 1000;
    const isInk = (r, c) => (c % 15) < 6; // ~40% density throughout, no solid run anywhere
    expect(detectStaffRows(isInk, aw, 1)).toEqual([]);
  });
});

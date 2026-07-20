import { describe, it, expect } from 'vitest';
import { pageSystems, pageSystemsDetailed } from './systemDetection.js';

// Real inter-line spacing is scaled up (x3 vs. earlier, less realistic
// fixtures) so it stays comfortably clear of collapseThickness()'s
// near-duplicate-row merging (see the dedicated test below) — multiplying
// every coordinate by a constant doesn't change any clustering decision,
// so the expected outputs are just the original expected values x3.
describe('pageSystems', () => {
  it('returns nothing/identity for fewer than 2 line rows', () => {
    expect(pageSystems([])).toEqual([]);
    expect(pageSystems([5])).toEqual([5]);
  });

  it('treats evenly-spaced single staves as separate systems (single-staff part)', () => {
    // Three solo staves (5 lines each), evenly spaced apart -> no bracing pattern
    // to detect, so each staff should stay its own system.
    const rows = [
      0, 6, 12, 18, 24,        // staff 1, center 12
      72, 78, 84, 90, 96,      // staff 2, center 84
      144, 150, 156, 162, 168, // staff 3, center 156
    ];
    expect(pageSystems(rows)).toEqual([12, 84, 156]);
  });

  it('groups braced multi-staff systems consistently (full score)', () => {
    // Two systems, each with two braced staves close together, and a much
    // bigger gap between systems -> should merge each pair into one system.
    const rows = [
      0, 6, 12, 18, 24,           // system A, staff 1, center 12
      42, 48, 54, 60, 66,         // system A, staff 2, center 54
      162, 168, 174, 180, 186,    // system B, staff 1, center 174
      204, 210, 216, 222, 228,    // system B, staff 2, center 216
    ];
    expect(pageSystems(rows)).toEqual([33, 195]);
  });

  it('falls back to per-staff systems when grouping is inconsistent', () => {
    // Three staves where the gaps don't fall into a consistent bimodal
    // (bracing vs. system) pattern -> no safe grouping, one system per staff.
    const rows = [
      0, 6, 12, 18, 24,         // center 12
      60, 66, 72, 78, 84,       // center 72 (gap 60 from previous)
      105, 111, 117, 123, 129,  // center 117 (gap 45 from previous)
    ];
    const result = pageSystems(rows);
    expect(result).toEqual([12, 72, 117]);
  });

  it('tolerates a staff with only 2 of 5 lines detected (real multi-staff score, rest-heavy passage)', () => {
    // Real lineRows from page 1 of a clarinet-quartet score ("Juggling
    // Clowns" by Bill Malcolm) -- 4 systems of 4 braced staves each. One
    // staff (Clarinet 2's, in the 2nd system) has several consecutive
    // whole-measure rests and produced only 2 detected line-rows instead of
    // 5. Before the >=2 (was >=3) fix, dropping that staff entirely didn't
    // just shrink one system -- it fragmented the *whole page* into 15
    // single-staff "systems" (verified against the real file), because the
    // neighbors' gap grew past the grouping cutoff once the staff between
    // them vanished. This must group into exactly 4 systems, one per
    // printed line, not one per staff.
    const rows = [
      139, 144, 149, 158, 197, 202, 211, 216, 255, 259, 264, 269, 274, 312, 317, 322, 327,
      403, 408, 413, 418, 461, 466, 480, 519, 528, 533, 538, 581, 586, 591, 596,
      667, 672, 677, 682, 687, 725, 730, 735, 744, 783, 788, 797, 802, 841, 845, 850, 855, 860,
      931, 936, 941, 950, 989, 994, 998, 1003, 1008, 1047, 1051, 1056, 1061, 1066, 1104, 1109, 1114, 1119, 1124,
    ];
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(4);
    expect(systems.map((s) => Math.round(s.rowMin))).toEqual([139, 403, 667, 931]);
    expect(systems.map((s) => Math.round(s.rowMax))).toEqual([327, 596, 860, 1124]);
  });

  it('collapses thick anti-aliased lines (multiple adjacent detected rows per physical line) before clustering into staves', () => {
    // Confirmed against a real rendered PDF: each physical staff line came
    // back as 2 adjacent "ink" rows (gap 1) rather than exactly 1, due to
    // line thickness/anti-aliasing. Before collapseThickness() existed, the
    // resulting glut of tiny 1px gaps corrupted the median-based clustering
    // cutoff so badly that all 5 lines were treated as separate staves of
    // one line each (rejected, needing >=3) instead of a single 5-line staff.
    const rows = [149, 150, 155, 156, 161, 162, 167, 168, 173, 174];
    expect(pageSystems(rows)).toEqual([161.5]);
  });
});

describe('pageSystemsDetailed', () => {
  it('returns row extents alongside centers for single-staff systems', () => {
    const rows = [0, 6, 12, 18, 24, 72, 78, 84, 90, 96];
    expect(pageSystemsDetailed(rows)).toEqual([
      { center: 12, rowMin: 0, rowMax: 24 },
      { center: 84, rowMin: 72, rowMax: 96 },
    ]);
  });

  it('spans the extent across all braced staves in a grouped system', () => {
    const rows = [
      0, 6, 12, 18, 24,           // system A, staff 1
      42, 48, 54, 60, 66,         // system A, staff 2
      162, 168, 174, 180, 186,    // system B, staff 1
      204, 210, 216, 222, 228,    // system B, staff 2
    ];
    expect(pageSystemsDetailed(rows)).toEqual([
      { center: 33, rowMin: 0, rowMax: 66 },
      { center: 195, rowMin: 162, rowMax: 228 },
    ]);
  });

  it('agrees with pageSystems on centers for any input', () => {
    const rows = [0, 6, 12, 18, 24, 60, 66, 72, 78, 84, 105, 111, 117, 123, 129];
    expect(pageSystemsDetailed(rows).map((s) => s.center)).toEqual(pageSystems(rows));
  });

  it('extent reflects collapsed (thickness-merged) row positions, not raw duplicates', () => {
    const rows = [149, 150, 155, 156, 161, 162, 167, 168, 173, 174];
    const [sys] = pageSystemsDetailed(rows);
    expect(sys.rowMin).toBe(149.5);
    expect(sys.rowMax).toBe(173.5);
  });
});

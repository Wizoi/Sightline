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

  // A staff of 5 lines starting at row S (spacing 6, center S+12) -- matches
  // this file's existing literal-row convention, just parameterized so a
  // list of desired staff CENTERS can be turned into raw line rows.
  function staffLines(startRow) {
    return [startRow, startRow + 6, startRow + 12, startRow + 18, startRow + 24];
  }
  function staffRowsForCenters(centers) {
    return centers.flatMap((c) => staffLines(c - 12));
  }

  it('does NOT group 2 unequal-size clusters just because a single gap looks bimodal (real corpus bug, Teutonia.pdf)', () => {
    // Real bug found via a real scanned single-staff-part booklet ("Full band
    // arrangements/Teutonia.pdf") with NO real bracing anywhere in the
    // document: 7 solo staves, gaps mostly ~100-125 plus one much larger
    // outlier gap (a scan/binding irregularity). kmeans2 saw that single
    // outlier as "bimodal" and split the run into exactly 2 groups (sizes 4
    // and 3) -- the old "tolerate at most one non-conforming group" check
    // (best >= grp.length - 1) is VACUOUS for exactly 2 groups (best is
    // always >= 1 out of 2), so it silently accepted this mismatched 4-vs-3
    // split as "consistent" and merged unrelated solo staves into 2 fake
    // multi-staff systems. Gaps here mirror that real shape: [100,100,100,
    // 230,100,100] -- clearly bimodal by kmeans2 (ratio well over 0.3), but
    // the two resulting group sizes (4 and 3) don't match, so this must fall
    // back to 7 separate one-staff systems, not 2 grouped ones.
    const centers = [12, 112, 212, 312, 542, 642, 742];
    const rows = staffRowsForCenters(centers);
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(7);
    expect(systems.map((s) => s.center)).toEqual(centers);
  });

  it('still groups 2 EQUAL-size clusters (real 2-system page, both systems share the same bracing)', () => {
    // Contrast with the test above: when a real 2-group split has matching
    // sizes (the normal case for a real score, which reuses the same
    // instrumentation every system), it must still group -- the exact-match
    // requirement for grp.length===2 must not reject genuinely consistent
    // 2-system pages, only mismatched ones.
    const rows = [
      0, 6, 12, 18, 24,           // system A, staff 1
      42, 48, 54, 60, 66,         // system A, staff 2
      162, 168, 174, 180, 186,    // system B, staff 1
      204, 210, 216, 222, 228,    // system B, staff 2
    ];
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(2);
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

  it('does NOT chain-collapse a whole 5-line staff into one point when real line spacing is as small as the anti-aliasing-duplicate gap (real corpus bug, Fantastic Parade.pdf)', () => {
    // Real dumped ink rows from page 1 of a real 20+-instrument conductor's
    // score ("Full band arrangements/Fantastic Parade.pdf"), Tenor Saxophone
    // and Baritone Saxophone staves (both visibly full 5-line staves in the
    // rendered page -- confirmed by rendering the actual crop, not assumed).
    // Fitting 23 staves into the shared ah=1200 analysis canvas shrinks real
    // line-to-line spacing down to ~2-3px -- the SAME magnitude as the
    // anti-aliasing-duplicate-row gap collapseThickness() collapses. Each
    // physical line here ALSO doubled into 2 adjacent rows (gap 1), and the
    // gap from one line's second duplicate row to the next line's first
    // duplicate row is only 2 -- individually within the old maxGap=2 check,
    // so the OLD per-step-only collapseThickness chain-merged the entire
    // 10-row staff into a single point (mean ~464.5 / ~606.5), discarding 4
    // of each staff's 5 real lines and, on the real file, cascading into a
    // wrong page-wide system grouping. Capping the group's total span (not
    // just each step) at the same threshold fixes it: each staff must
    // collapse to exactly 5 points (one per real line), and two staves this
    // far apart (gap ~130, comfortably a real system-vs-system distance on
    // this densely-packed page) must NOT be merged into one system.
    const rows = [
      458, 459, 461, 462, 464, 465, 467, 468, 470, 471, // Tenor Saxophone
      600, 601, 603, 604, 606, 607, 609, 610, 612, 613, // Baritone Saxophone
    ];
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(2);
    expect(systems.map((s) => Math.round(s.rowMin))).toEqual([459, 601]);
    expect(systems.map((s) => Math.round(s.rowMax))).toEqual([471, 613]);
  });

  it('merges a big real brace + one unrelated lone staff (real corpus bug/fix, Fantastic Parade.pdf p.1)', () => {
    // Real, complete dumped ink rows from page 1 of "Full band arrangements/
    // Fantastic Parade.pdf": a 20-staff conductor's-score brace (winds, then
    // brass) plus one separately-notated percussion staff. This whole page
    // used to fall back to 21 one-staff systems (grp sizes [20, 1] rejected
    // by the exact-size-match rule) -- confirmed as the real cause of this
    // file's system count regressing from a true 315 to 480. Must now merge
    // into exactly 2 systems: the 20-staff brace, and the lone staff on its
    // own (never merged INTO the brace -- it's genuinely a different staff).
    const rows = [
      120, 121, 123, 124, 126, 127, 130, 133, 163, 166, 169, 172, 175, 205, 208, 211, 214, 217, 218,
      247, 248, 250, 251, 253, 254, 256, 257, 259, 260, 289, 290, 292, 293, 295, 296, 298, 299, 301, 302,
      332, 335, 338, 341, 344, 374, 377, 380, 383, 386, 416, 419, 422, 425, 426, 428, 429,
      458, 459, 461, 462, 464, 465, 467, 468, 470, 471, 500, 501, 503, 504, 506, 507, 510, 513,
      561, 564, 567, 570, 573, 603, 604, 606, 607, 609, 610, 612, 613, 615, 616,
      645, 646, 648, 649, 651, 652, 654, 655, 657, 658, 687, 688, 691, 694, 697, 700,
      730, 733, 736, 739, 742, 772, 775, 778, 779, 781, 782, 784, 785,
      814, 815, 817, 818, 820, 821, 823, 824, 826, 827, 856, 857, 859, 860, 862, 863, 865, 866, 868, 869,
      899, 902, 905, 908, 911, 941, 944, 947, 950, 953,
      998, 999, 1034, 1035, 1040, 1041, 1047, // the lone percussion staff
      1086, 1089, 1092, 1095, 1098,
    ];
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(2);
    expect(Math.round(systems[0].rowMin)).toBe(121);
    expect(Math.round(systems[0].rowMax)).toBe(953);
  });

  it('does NOT merge a real single-staff booklet page just because scan noise produces the same [N, 1] shape (real corpus regression guard, Teutonia.pdf p.9)', () => {
    // Real dumped ink rows from a scanned single-staff-part booklet with NO
    // real bracing anywhere in the document. A scan/binding irregularity
    // (not a real system-vs-staff distinction) makes the gaps look bimodal
    // with sizes [1, 5] -- the SAME shape as the Fantastic Parade fix above
    // -- but here the "big" side is only 5 staves, nowhere near a genuine
    // full-ensemble brace, so it must stay 6 separate one-staff systems.
    const rows = [
      240, 346, 357, 379, 455, 499, 562, 584, 669, 680, 691, 703, 713, 714,
      777, 811, 822, 918, 929, 930, 1024, 1036,
    ];
    expect(pageSystemsDetailed(rows)).toHaveLength(6);
  });

  it('groups real IMSLP "Score and Parts" continuation pages whose bimodal ratio is too weak for the original 0.3 gate (real corpus bug, East Meets West / Cuban Dancer Trio / etc.)', () => {
    // Real dumped ink rows from a combined-score continuation page (4 real
    // systems, each 3 braced staves: Flute/Clarinet/Clarinet) -- the real
    // between-system gap is only ~0.21-0.26x bigger than the within-system
    // gap at this page's density, well under the original 0.3 gate, so this
    // whole page used to fall back to 12 separate one-staff "systems"
    // instead of the real 4 three-staff ones. This exact page shape was
    // byte-identical (0% system-count accuracy) across the whole project's
    // history until this fix.
    const rows = [
      95, 96, 103, 110, 111, 118, 126, 175, 182, 183, 190, 198, 205, 206,
      254, 255, 262, 269, 270, 277, 278, 285, 352, 353, 360, 367, 368, 375, 382, 383,
      432, 439, 440, 447, 454, 455, 462, 511, 512, 519, 526, 527, 534, 542,
      609, 617, 624, 625, 632, 639, 640, 689, 696, 697, 704, 711, 712, 719,
      768, 769, 776, 783, 784, 791, 798, 799, 866, 873, 874, 881, 889, 896, 897,
      945, 946, 953, 961, 968, 969, 976, 1030, 1031, 1038, 1045, 1046, 1053, 1060, 1061,
    ];
    const systems = pageSystemsDetailed(rows);
    expect(systems).toHaveLength(4);
  });

  it('does NOT let the weak bimodal gate group near-uniform single-staff-booklet noise, even when it happens to look pairwise "consistent" (real corpus regression guard, MonogramMarch.pdf p.7)', () => {
    // Real dumped ink rows from ANOTHER single-staff booklet with no real
    // bracing. Its naturally-varying scan spacing clears the lowered 0.15
    // gate (ratio ~0.25) and, unlike the Teutonia case above, happens to
    // split into groups of size [1, 2, 2] -- superficially "consistent" by
    // the >=3-group tolerant rule's own mode-based logic -- but this is
    // still 5 genuinely separate solo staves, not a real 2-staff brace
    // repeated twice. The weak gate must require a PERFECT (not tolerant)
    // match, so this must stay 5 separate one-staff systems.
    const rows = [
      237, 357, 368, 380, 402, 403, 484, 485, 496, 508, 520,
      629, 630, 641, 652, 664, 746, 769, 780, 781, 875, 886, 887, 1000,
    ];
    expect(pageSystemsDetailed(rows)).toHaveLength(5);
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

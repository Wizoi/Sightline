import { mean, median } from './mathUtils.js';
import { clusterVals, kmeans2 } from './clustering.js';

// Detect musical SYSTEMS (not individual staves) from a page's staff-line
// row positions. Works for full scores where several instrument staves are
// braced into one system AND for single-staff parts. Method: cluster the
// staff-line rows into staves (5 lines each), then group staves into systems
// — but only when the grouping is consistent (equal staves per system, like
// a real score); otherwise each staff is its own system.
//
// `lineRows` are row indices (in the same coordinate space the caller
// measured them in) where a staff line was detected.
export function pageSystems(lineRows) {
  return pageSystemsDetailed(lineRows).map((s) => s.center);
}

// A physical staff line rendered with any anti-aliasing/thickness commonly
// registers as 2-3 adjacent "ink" rows instead of exactly 1 (confirmed
// against a real rendered PDF, not hypothetical). Left alone, those tiny
// thickness gaps (often 1px) get mixed into the same gap statistics used
// below to size the staff-line clustering cutoff, dragging the median (and
// so the cutoff) down so far that real, larger gaps between distinct lines
// no longer cluster together at all — every line ends up "alone". Collapsing
// near-duplicate rows into one representative point first removes that
// noise at the source. A real gap between two distinct staff lines is
// essentially never this small (if it were, the lines wouldn't be
// separately resolvable in the image at all), so this is safe.
//
// The per-step `maxGap` check alone is NOT enough on a densely-packed page,
// though — found on a real 20+-instrument conductor's score ("The Fantastic
// Parade"), where fitting 23 staves into the shared ah=1200 analysis canvas
// shrinks real line-to-line spacing down to ~2-3px, the SAME magnitude as
// the anti-aliasing-duplicate-row gap this function was written to collapse.
// A chain of small per-step gaps (each individually <= maxGap, since a
// doubled-row line's own internal gap and the gap to the NEXT real line's
// first doubled row can both read as 1-2px at this scale) then greedily
// single-linkage-merges an entire 5-line staff into ONE point instead of 5 --
// confirmed directly against real dumped row/ink data: two real staves
// (Tenor Saxophone, Baritone Saxophone) that visibly render full 5-line
// staves collapsed to a single representative row, silently discarding 4 of
// their 5 lines and, downstream, corrupting that system's whole-page
// grouping. Capping the group's TOTAL span from its first row (not just each
// step) at the same maxGap threshold fixes this: a genuine thickness-
// duplicate group is documented above as spanning only 1-2px total (2-3
// adjacent rows), well inside this cap, so the original bug's fix is
// unaffected; a real next staff line 2-3px away now correctly starts a new
// group once the running span would exceed that small, physically-plausible
// single-line-thickness bound, instead of chaining indefinitely.
function collapseThickness(rows, maxGap = 2) {
  const out = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - cur[cur.length - 1] <= maxGap && rows[i] - cur[0] <= maxGap) cur.push(rows[i]);
    else { out.push(mean(cur)); cur = [rows[i]]; }
  }
  out.push(mean(cur));
  return out;
}

// Same detection as pageSystems(), but also returns each system's row
// extent (rowMin/rowMax spanning the staff lines that compose it) — needed
// by barline detection (lib/barlineDetection.js) to know which vertical
// band of the page to scan. pageSystems() is a thin wrapper around this
// that keeps its original centers-only contract for existing callers (Snap
// mode) — the two never duplicate the clustering logic itself.
export function pageSystemsDetailed(rawLineRows) {
  if (rawLineRows.length < 2) {
    return rawLineRows.map((r) => ({ center: r, rowMin: r, rowMax: r }));
  }
  const lineRows = collapseThickness(rawLineRows);
  if (lineRows.length < 2) {
    return lineRows.map((r) => ({ center: r, rowMin: r, rowMax: r }));
  }
  const sp = [];
  for (let i = 1; i < lineRows.length; i++) sp.push(lineRows[i] - lineRows[i - 1]);
  const med = median(sp) || 5;
  // A staff needs at least 2 of its 5 lines to register as "ink" to count.
  // Confirmed against a real multi-staff score (a clarinet quartet): a staff
  // with several consecutive whole-measure rests produced only 2 detected
  // lines instead of 5 (rest-heavy passages apparently don't always reinforce
  // every line the way note-dense ones do), and dropping that staff entirely
  // (the old >=3 threshold) didn't just lose one staff's extent -- it changed
  // the gap between its neighbors enough to make the *whole page's* grouping
  // look inconsistent, silently falling every system back to one-staff-per-
  // system for a page that's actually cleanly 4-braced throughout. Verified
  // across all 13 pages of that real file: this loosened threshold fixes the
  // 3 affected pages and changes nothing on the other 10 (including
  // single-staff instrument-part pages, where nothing this loose should ever
  // spuriously cluster since real staff lines are never just 2px apart).
  const staves = clusterVals(lineRows, Math.max(3, med * 1.9)).filter((g) => g.length >= 2);
  const staffInfo = staves.map((g) => ({ center: mean(g), rowMin: Math.min(...g), rowMax: Math.max(...g) }));
  if (staffInfo.length < 2) return staffInfo.slice();

  const sc = staffInfo.map((s) => s.center);
  const gaps = [];
  for (let i = 1; i < sc.length; i++) gaps.push(sc[i] - sc[i - 1]);
  const [lo, hi] = kmeans2(gaps);
  if ((hi - lo) / Math.max(lo, 1) >= 0.3) {           // gaps look bimodal → maybe grouped
    // group staffInfo the same way clusterVals would group sc, but carrying
    // the full staff records along so extents survive the grouping.
    const cutoff = (lo + hi) / 2;
    const grp = [[staffInfo[0]]];
    for (let i = 1; i < staffInfo.length; i++) {
      const last = grp[grp.length - 1];
      if (staffInfo[i].center - last[last.length - 1].center <= cutoff) last.push(staffInfo[i]);
      else grp.push([staffInfo[i]]);
    }
    const sizes = grp.map((g) => g.length);
    const counts = {}; let modeSize = sizes[0], best = 0;
    sizes.forEach((s) => { counts[s] = (counts[s] || 0) + 1; if (counts[s] > best) { best = counts[s]; modeSize = s; } });
    // "tolerate at most one non-conforming group" (best >= grp.length - 1) is
    // VACUOUS when there are only 2 groups: best is always >= 1 for any 2
    // groups (whichever size wins the tie), so this check could never reject
    // a 2-way split no matter how mismatched the two sizes were. Confirmed as
    // a real bug via a real scanned single-staff-part booklet ("Teutonia.pdf",
    // Full band arrangements folder): a page with 7 solo staves (no real
    // bracing anywhere in this document) produced gaps of mostly ~90-125 plus
    // ONE much larger outlier (a scan/binding irregularity, not a real
    // system-vs-staff distinction), which kmeans2 saw as "bimodal" and split
    // into exactly 2 groups of sizes 3 and 4 -- accepted as "consistent"
    // purely because grp.length-1 == 1 == best, even though the two group
    // sizes plainly don't match. A real multi-staff score reuses the SAME
    // instrumentation every system, so two real systems on one page should
    // have the same staff count; requiring exact equality when there are
    // only 2 groups (instead of "at most one off", which can't discriminate
    // at n=2) closes this loophole without touching the >=3-group case
    // (already verified safe against a real 13-page braced quartet file, see
    // the "tolerates a staff with only 2 of 5 lines detected" test/comment
    // above) at all.
    const consistent = grp.length === 2 ? best === 2 : modeSize > 1 && best >= grp.length - 1;
    if (consistent) {       // consistent multi-staff systems
      return grp.map((g) => ({
        center: mean(g.map((s) => s.center)),
        rowMin: Math.min(...g.map((s) => s.rowMin)),
        rowMax: Math.max(...g.map((s) => s.rowMax)),
      }));
    }
  }
  return staffInfo.slice();                            // otherwise: each staff is its own system
}

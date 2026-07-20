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
function collapseThickness(rows, maxGap = 2) {
  const out = [];
  let cur = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - cur[cur.length - 1] <= maxGap) cur.push(rows[i]);
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
  const staves = clusterVals(lineRows, Math.max(3, med * 1.9)).filter((g) => g.length >= 3);
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
    if (modeSize > 1 && best >= grp.length - 1) {       // consistent multi-staff systems
      return grp.map((g) => ({
        center: mean(g.map((s) => s.center)),
        rowMin: Math.min(...g.map((s) => s.rowMin)),
        rowMax: Math.max(...g.map((s) => s.rowMax)),
      }));
    }
  }
  return staffInfo.slice();                            // otherwise: each staff is its own system
}

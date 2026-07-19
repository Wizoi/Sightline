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
  if (lineRows.length < 2) return lineRows.slice();
  const sp = [];
  for (let i = 1; i < lineRows.length; i++) sp.push(lineRows[i] - lineRows[i - 1]);
  const med = median(sp) || 5;
  const staves = clusterVals(lineRows, Math.max(3, med * 1.9)).filter(g => g.length >= 3);
  const sc = staves.map(mean);
  if (sc.length < 2) return sc.slice();
  const gaps = [];
  for (let i = 1; i < sc.length; i++) gaps.push(sc[i] - sc[i - 1]);
  const [lo, hi] = kmeans2(gaps);
  if ((hi - lo) / Math.max(lo, 1) >= 0.3) {           // gaps look bimodal → maybe grouped
    const grp = clusterVals(sc, (lo + hi) / 2);
    const sizes = grp.map(g => g.length);
    const counts = {}; let modeSize = sizes[0], best = 0;
    sizes.forEach(s => { counts[s] = (counts[s] || 0) + 1; if (counts[s] > best) { best = counts[s]; modeSize = s; } });
    if (modeSize > 1 && best >= grp.length - 1) return grp.map(mean);   // consistent multi-staff systems
  }
  return sc.slice();                                   // otherwise: each staff is its own system
}

// Groups sorted numbers into clusters: a new cluster starts whenever the gap
// to the previous value exceeds `cutoff`.
export function clusterVals(vals, cutoff) {
  const g = [[vals[0]]];
  for (let i = 1; i < vals.length; i++) {
    const last = g[g.length - 1];
    if (vals[i] - last[last.length - 1] <= cutoff) last.push(vals[i]);
    else g.push([vals[i]]);
  }
  return g;
}

// Splits x into a low and high cluster by iteratively refining two centroids
// (a tiny 1D k-means with k=2).
export function kmeans2(x) {
  let lo = Math.min(...x), hi = Math.max(...x);
  if (hi === lo) return [lo, hi];
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    let ls = 0, ln = 0, hs = 0, hn = 0;
    for (const v of x) { if (v <= mid) { ls += v; ln++; } else { hs += v; hn++; } }
    if (ln) lo = ls / ln;
    if (hn) hi = hs / hn;
  }
  return [lo, hi];
}

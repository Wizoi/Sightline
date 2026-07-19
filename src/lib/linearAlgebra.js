// n x n Gaussian elimination with partial pivoting: solves M x = v.
export function solveLin(M, v) {
  const n = v.length, A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const pv = A[c][c] || 1e-9;
    for (let j = c; j <= n; j++) A[c][j] /= pv;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map(row => row[n]);
}

// Ridge-regularized least squares (the intercept, feats[k][0], is left
// unregularized). Returns the coefficient vector.
export function lstsqRidge(feats, ys, lambda) {
  const n = feats[0].length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0)), v = new Array(n).fill(0);
  for (let k = 0; k < feats.length; k++) {
    const f = feats[k], y = ys[k];
    for (let i = 0; i < n; i++) { v[i] += f[i] * y; for (let j = 0; j < n; j++) M[i][j] += f[i] * f[j]; }
  }
  for (let i = 1; i < n; i++) M[i][i] += lambda;
  return solveLin(M, v);
}

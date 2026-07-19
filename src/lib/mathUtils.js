export function mean(a) {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function stddev(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length));
}

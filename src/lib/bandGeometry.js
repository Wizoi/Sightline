/* Geometry for direct manipulation of the reading band (see bandDrag.js).
 *
 * Split out from bandDrag.js purely so it stays testable: bandDrag imports
 * ui.js, which touches the DOM at import time, so anything living there
 * can't be unit-tested without a browser. These functions are the part with
 * real arithmetic in it, so they're the part worth testing. */

// How close to an edge counts as grabbing the edge rather than the middle.
// Generous enough to hit with a finger, small enough that a normal-sized
// band still leaves a usable middle region.
export const EDGE_PX = 16;

/* Which part of the band a point is over: 'top'/'bottom' resize, 'middle'
 * moves. A band thinner than two edge zones has no middle left, so it's
 * treated as all-edge — resizing is what someone is most likely reaching
 * for on a band that small, and the alternative (overlapping zones where
 * top wins) would make the bottom edge unreachable. */
export function regionAt(clientY, rect, edgePx = EDGE_PX) {
  if (rect.height <= edgePx * 2) {
    return clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
  }
  if (clientY - rect.top <= edgePx) return 'top';
  if (rect.bottom - clientY <= edgePx) return 'bottom';
  return 'middle';
}

/* Resizing by dragging an edge. The band is drawn centered on bandPos with
 * a half-height of deadZoneFrac, so the new half-height is just the
 * distance from that center to wherever the edge was dragged. Absolute
 * value so dragging an edge past the center mirrors rather than going
 * negative. Returned as a fraction of viewport height, matching cfg. */
export function halfHeightFrom(clientY, viewportH, bandPos) {
  return Math.abs(clientY - bandPos * viewportH) / viewportH;
}

/* Pinch-to-resize: scale the size the band had when the fingers went down
 * by how much they've spread since. A ratio rather than a delta so the
 * gesture behaves the same whether it starts wide or narrow. Pinches that
 * start with the fingers nearly together are ignored (ratio 1) — the
 * divisor is too small there to mean anything, and would fling the band to
 * its limit on the first frame. */
export function pinchScale(startSpreadPx, spreadPx, minSpreadPx = 8) {
  if (!(startSpreadPx > minSpreadPx)) return 1;
  return spreadPx / startSpreadPx;
}

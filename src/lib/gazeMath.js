// --- 3D vector helpers (landmarks scaled to detection-image pixels) --------
export function v3(lm, i, w, h) { return { x: lm[i].x * w, y: lm[i].y * h, z: (lm[i].z || 0) * w }; }
export function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vscl(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vcross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
export function vnorm(a) { const m = Math.hypot(a.x, a.y, a.z) || 1e-9; return vscl(a, 1 / m); }

// Head-fixed orthonormal basis from rigid face landmarks. De-rotating the eye
// vector by this basis makes the gaze feature invariant to head rotation.
export function headBasis(lm, w, h) {
  const Lc = v3(lm, 234, w, h), Rc = v3(lm, 454, w, h), top = v3(lm, 10, w, h), chin = v3(lm, 152, w, h);
  const right = vnorm(vsub(Rc, Lc));
  const fwd = vnorm(vcross(right, vsub(chin, top)));   // face normal
  const down = vnorm(vcross(fwd, right));              // orthogonal down
  return { right, down, fwd };
}

// Eye-in-head gaze angles (pose-invariant) for one eye.
export function eyeGaze(lm, iris, outer, inner, B, w, h) {
  const o = v3(lm, outer, w, h), i2 = v3(lm, inner, w, h), ir = v3(lm, iris, w, h);
  const c = vscl(vadd(o, i2), 0.5);
  const eyeW = Math.hypot(o.x - i2.x, o.y - i2.y, o.z - i2.z) || 1e-6;
  const eyeC = vsub(c, vscl(B.fwd, 0.6 * eyeW));       // eyeball center ~behind the corners
  const g = vnorm(vsub(ir, eyeC));                     // optical axis (camera frame)
  const gh = { x: vdot(g, B.right), y: vdot(g, B.down), z: vdot(g, B.fwd) };   // -> head frame
  return { yaw: Math.atan2(gh.x, gh.z || 1e-6), pitch: Math.asin(Math.max(-1, Math.min(1, gh.y))) };
}

export function eyeOpen(lm, up, lo, outer, inner) {
  const w = Math.hypot(lm[inner].x - lm[outer].x, lm[inner].y - lm[outer].y) || 1e-6;
  return Math.hypot(lm[lo].x - lm[up].x, lm[lo].y - lm[up].y) / w;
}

// Confidence-weighted combination of the two eyes' signals, replacing a flat
// (L+R)/2 average. A weight pair of {left:1, right:1} (the default) reduces
// to exactly that flat average — the identity case this must always degrade
// to when both eyes are equally trustworthy — so every existing call site
// that doesn't pass weights is completely unaffected.
function wavg(l, r, wl, wr) {
  const wsum = wl + wr || 1;
  return (l * wl + r * wr) / wsum;
}

// Never fully zero out an eye's contribution, even when its confidence weight
// says "trust it much less right now": a single eye's own gaze estimate is
// itself noisier than a blend of two (it loses whatever independent-noise
// averaging a blend gives you), so a momentary bad reading from the
// *confidence signal itself* (e.g. a one-frame blendshape glitch) can't swing
// all the way to a pure single-eye estimate.
const MIN_EYE_WEIGHT = 0.1;

// Derives a per-eye confidence weight from MediaPipe's eyeBlinkLeft/Right
// blendshape scores (the same purpose-built, model-normalized closure signal
// already used for wink/blink gating — see eyeBlinkScores below) rather than
// from raw eyelid-landmark geometry. This matters here for the same reason it
// mattered for blink gating: a person's two eyes are rarely perfectly
// symmetric even at rest (see winkLogic.js's per-user gap-threshold write-up
// in the Applied Math persona doc), so a confidence signal built from raw,
// person-specific anatomy (e.g. plain eyelid-gap ratio) would systematically
// and *permanently* down-weight whichever eye is naturally narrower at rest —
// exactly the "normal asymmetry at rest" failure mode this must not
// introduce. The blink blendshape is a model-fit "how closed is this eye"
// classifier score that already accounts for per-face anatomy much better
// than raw pixel geometry, so ordinary rest-state asymmetry between two
// otherwise-fine eyes shows up as only a small gap between two already-small
// scores (e.g. 0.08 vs 0.12) — barely nudging the resulting weights off
// 50/50 — while a real problem (glasses glare, an occluding head turn, a
// partial closure) reliably drives one eye's score up much more than the
// other's, which is exactly when down-weighting that eye is wanted.
export function eyeConfidence(left, right) {
  return { left: Math.max(MIN_EYE_WEIGHT, 1 - left), right: Math.max(MIN_EYE_WEIGHT, 1 - right) };
}

// Gaze features: pose-invariant yaw/pitch (usePose) OR 2D width-normalized
// iris ratios. Plus eye openness (for blink gating). `weights` (from
// eyeConfidence, above) lets a caller down-weight whichever eye currently
// looks less trustworthy instead of always splitting 50/50.
// Also returns each eye's OWN unblended ratios (rxL/ryL, rxR/ryR) alongside
// the blended rx/ry. The blend is still the default signal, but the two eyes
// are not always equally good predictors of where a person is actually
// looking: ocular dominance is common, and a small misalignment between the
// eyes (a phoria) makes one eye's apparent iris offset a systematically
// worse fit to the true gaze target than the other's. Averaging then mixes
// a good signal into a worse one, and no amount of downstream smoothing
// recovers that. Carrying the per-eye values through lets the calibration
// fit MEASURE which eye (or the blend) actually predicts the user's own
// clicked targets best, rather than assuming the average is optimal — see
// lib/calibrationModel.js's chooseEyeMode.
//
// Note these are distinct from the `weights` argument, which handles a
// different problem: momentary OCCLUSION (glare, a head turn) making one
// eye untrustworthy right now. That's per-frame and transient; eye dominance
// is a stable property of the person.
export function eyeRatios(lm, usePose, w, h, weights = { left: 1, right: 1 }) {
  const open = (eyeOpen(lm, 159, 145, 33, 133) + eyeOpen(lm, 386, 374, 263, 362)) / 2;
  const wl = weights.left ?? 1, wr = weights.right ?? 1;
  if (usePose) {
    const B = headBasis(lm, w, h);
    const L = eyeGaze(lm, 468, 33, 133, B, w, h), R = eyeGaze(lm, 473, 263, 362, B, w, h);
    return {
      rx: wavg(L.yaw, R.yaw, wl, wr), ry: wavg(L.pitch, R.pitch, wl, wr), open,
      rxL: L.yaw, ryL: L.pitch, rxR: R.yaw, ryR: R.pitch,
    };
  }
  const one = (iris, outer, inner) => {
    const cx = (lm[outer].x + lm[inner].x) / 2, cy = (lm[outer].y + lm[inner].y) / 2;
    const eyeW = Math.hypot(lm[inner].x - lm[outer].x, lm[inner].y - lm[outer].y) || 1e-6;
    return { rx: (lm[iris].x - cx) / eyeW, ry: (lm[iris].y - cy) / eyeW };
  };
  const L = one(468, 33, 133), R = one(473, 263, 362);
  return {
    rx: wavg(L.rx, R.rx, wl, wr), ry: wavg(L.ry, R.ry, wl, wr), open,
    rxL: L.rx, ryL: L.ry, rxR: R.rx, ryR: R.ry,
  };
}

// Eye-look blendshape signals (pose-normalized by the model) — extra
// features. Same confidence-weighting as eyeRatios, same default no-op.
export function blendVec(res, weights = { left: 1, right: 1 }) {
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (!cats) return { bH: 0, bV: 0 };
  const g = {};
  for (const c of cats) g[c.categoryName] = c.score;
  const wl = weights.left ?? 1, wr = weights.right ?? 1;
  const up = wavg(g.eyeLookUpLeft || 0, g.eyeLookUpRight || 0, wl, wr);
  const dn = wavg(g.eyeLookDownLeft || 0, g.eyeLookDownRight || 0, wl, wr);
  const inn = wavg(g.eyeLookInLeft || 0, g.eyeLookInRight || 0, wl, wr);
  const out = wavg(g.eyeLookOutLeft || 0, g.eyeLookOutRight || 0, wl, wr);
  return { bH: out - inn, bV: dn - up };
}

// Per-eye blink/closure scores (0 = open, 1 = fully closed) straight from
// MediaPipe's blendshapes — a purpose-built, model-computed signal for "is
// this eye closed," and much more robust than inferring it from raw eyelid
// landmark distances (which are noisy enough that a deliberate wink can fail
// to clear a fixed threshold). Used for wink detection.
export function eyeBlinkScores(res) {
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (!cats) return { left: 0, right: 0 };
  const g = {};
  for (const c of cats) g[c.categoryName] = c.score;
  return { left: g.eyeBlinkLeft || 0, right: g.eyeBlinkRight || 0 };
}

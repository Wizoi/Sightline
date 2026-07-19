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

// Gaze features: pose-invariant yaw/pitch (usePose) OR 2D width-normalized
// iris ratios. Plus eye openness (for blink gating).
export function eyeRatios(lm, usePose, w, h) {
  const open = (eyeOpen(lm, 159, 145, 33, 133) + eyeOpen(lm, 386, 374, 263, 362)) / 2;
  if (usePose) {
    const B = headBasis(lm, w, h);
    const L = eyeGaze(lm, 468, 33, 133, B, w, h), R = eyeGaze(lm, 473, 263, 362, B, w, h);
    return { rx: (L.yaw + R.yaw) / 2, ry: (L.pitch + R.pitch) / 2, open };
  }
  const one = (iris, outer, inner) => {
    const cx = (lm[outer].x + lm[inner].x) / 2, cy = (lm[outer].y + lm[inner].y) / 2;
    const eyeW = Math.hypot(lm[inner].x - lm[outer].x, lm[inner].y - lm[outer].y) || 1e-6;
    return { rx: (lm[iris].x - cx) / eyeW, ry: (lm[iris].y - cy) / eyeW };
  };
  const L = one(468, 33, 133), R = one(473, 263, 362);
  return { rx: (L.rx + R.rx) / 2, ry: (L.ry + R.ry) / 2, open };
}

// Eye-look blendshape signals (pose-normalized by the model) — extra features.
export function blendVec(res) {
  const cats = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
  if (!cats) return { bH: 0, bV: 0 };
  const g = {};
  for (const c of cats) g[c.categoryName] = c.score;
  const up = ((g.eyeLookUpLeft || 0) + (g.eyeLookUpRight || 0)) / 2;
  const dn = ((g.eyeLookDownLeft || 0) + (g.eyeLookDownRight || 0)) / 2;
  const inn = ((g.eyeLookInLeft || 0) + (g.eyeLookInRight || 0)) / 2;
  const out = ((g.eyeLookOutLeft || 0) + (g.eyeLookOutRight || 0)) / 2;
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

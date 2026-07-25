import { describe, it, expect } from 'vitest';
import {
  vsub, vadd, vscl, vdot, vcross, vnorm,
  headBasis, eyeGaze, eyeRatios, blendVec, eyeBlinkScores, eyeConfidence,
} from './gazeMath.js';

const W = 640, H = 480;

// A minimal, symmetric, frontal-facing set of face landmarks: the face edges
// and chin/forehead are arranged so headBasis works out to a clean identity
// basis (right=+x, down=+y, fwd=+z), and both irises sit exactly at the
// midpoint of their eye corners (i.e. "looking straight ahead").
function makeLandmarks({ irisOffsetX = 0, irisOffsetXL, irisOffsetXR } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i, x, y, z = 0) => { lm[i] = { x, y, z }; };
  const offL = irisOffsetXL ?? irisOffsetX, offR = irisOffsetXR ?? irisOffsetX;

  set(234, 0.3, 0.5);  // left face edge
  set(454, 0.7, 0.5);  // right face edge
  set(10, 0.5, 0.2);   // forehead/top
  set(152, 0.5, 0.8);  // chin

  // left eye: outer 33, inner 133, iris 468
  set(33, 0.35, 0.5);
  set(133, 0.45, 0.5);
  set(468, 0.40 + offL, 0.5);
  set(159, 0.40, 0.48); // upper lid
  set(145, 0.40, 0.52); // lower lid

  // right eye: inner 362, outer 263, iris 473
  set(263, 0.65, 0.5);
  set(362, 0.55, 0.5);
  set(473, 0.60 + offR, 0.5);
  set(386, 0.60, 0.48); // upper lid
  set(374, 0.60, 0.52); // lower lid

  return lm;
}

describe('vector helpers', () => {
  it('vsub/vadd/vscl do componentwise arithmetic', () => {
    const a = { x: 1, y: 2, z: 3 }, b = { x: 4, y: 5, z: 6 };
    expect(vsub(a, b)).toEqual({ x: -3, y: -3, z: -3 });
    expect(vadd(a, b)).toEqual({ x: 5, y: 7, z: 9 });
    expect(vscl(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
  });
  it('vdot computes the dot product', () => {
    expect(vdot({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(0);
    expect(vdot({ x: 2, y: 3, z: 4 }, { x: 1, y: 1, z: 1 })).toBe(9);
  });
  it('vcross is perpendicular to both inputs', () => {
    const c = vcross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(c).toEqual({ x: 0, y: 0, z: 1 });
  });
  it('vnorm produces a unit vector', () => {
    const n = vnorm({ x: 3, y: 4, z: 0 });
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 8);
  });
});

describe('headBasis', () => {
  it('produces an orthonormal basis for a symmetric frontal face', () => {
    const B = headBasis(makeLandmarks(), W, H);
    for (const v of [B.right, B.down, B.fwd]) {
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
    }
    expect(vdot(B.right, B.down)).toBeCloseTo(0, 6);
    expect(vdot(B.right, B.fwd)).toBeCloseTo(0, 6);
    expect(vdot(B.down, B.fwd)).toBeCloseTo(0, 6);
  });
});

describe('eyeGaze', () => {
  it('reports ~zero yaw/pitch when the iris sits at the eye-corner midpoint', () => {
    const lm = makeLandmarks();
    const B = headBasis(lm, W, H);
    const L = eyeGaze(lm, 468, 33, 133, B, W, H);
    expect(L.yaw).toBeCloseTo(0, 3);
    expect(L.pitch).toBeCloseTo(0, 3);
  });

  it('yaw moves away from zero when the iris shifts off-center', () => {
    const lm = makeLandmarks({ irisOffsetX: 0.03 });
    const B = headBasis(lm, W, H);
    const L = eyeGaze(lm, 468, 33, 133, B, W, H);
    expect(Math.abs(L.yaw)).toBeGreaterThan(0.01);
  });
});

describe('eyeRatios', () => {
  it('pose mode: centered irises give ~zero rx/ry', () => {
    const r = eyeRatios(makeLandmarks(), true, W, H);
    expect(r.rx).toBeCloseTo(0, 3);
    expect(r.ry).toBeCloseTo(0, 3);
    expect(r.open).toBeGreaterThan(0);
  });

  it('flat (non-pose) mode: centered irises give ~zero rx/ry', () => {
    const r = eyeRatios(makeLandmarks(), false, W, H);
    expect(r.rx).toBeCloseTo(0, 6);
    expect(r.ry).toBeCloseTo(0, 6);
  });

  it('flat mode: shifting the iris right makes rx positive', () => {
    const r = eyeRatios(makeLandmarks({ irisOffsetX: 0.03 }), false, W, H);
    expect(r.rx).toBeGreaterThan(0);
  });
});

describe('eyeBlinkScores', () => {
  it('returns zeros when blendshapes are absent', () => {
    expect(eyeBlinkScores({})).toEqual({ left: 0, right: 0 });
  });

  it('reads eyeBlinkLeft/eyeBlinkRight independently', () => {
    const res = {
      faceBlendshapes: [{
        categories: [
          { categoryName: 'eyeBlinkLeft', score: 0.92 },
          { categoryName: 'eyeBlinkRight', score: 0.03 },
        ],
      }],
    };
    expect(eyeBlinkScores(res)).toEqual({ left: 0.92, right: 0.03 });
  });
});

describe('eyeConfidence', () => {
  it('gives equal weight to two equally-open eyes', () => {
    const w = eyeConfidence(0.05, 0.05);
    expect(w.left).toBeCloseTo(w.right, 8);
  });

  it('barely shifts weight for ordinary rest-state asymmetry (small gap between two low scores)', () => {
    const w = eyeConfidence(0.08, 0.12);
    // Should stay close to 50/50, not swing hard toward one eye.
    const total = w.left + w.right;
    expect(w.left / total).toBeGreaterThan(0.48);
    expect(w.left / total).toBeLessThan(0.52);
  });

  it('meaningfully down-weights an eye with an elevated (but sub-blink-gate) closure score', () => {
    const w = eyeConfidence(0.05, 0.28); // right eye compromised (glare/occlusion/partial closure)
    expect(w.right).toBeLessThan(w.left);
    const total = w.left + w.right;
    // A clear shift away from 50/50 (contrast with the ~48-52% band the
    // ordinary-rest-asymmetry case above stays within).
    expect(w.right / total).toBeLessThan(0.45);
  });

  it('never fully zeroes out either eye, even at full closure', () => {
    const w = eyeConfidence(1, 1);
    expect(w.left).toBeGreaterThan(0);
    expect(w.right).toBeGreaterThan(0);
  });
});

describe('eyeRatios with per-eye weighting', () => {
  it('defaults (no weights passed) reduce to the flat 50/50 average, unchanged from before', () => {
    const lm = makeLandmarks({ irisOffsetXL: 0.03, irisOffsetXR: -0.01 });
    const withoutWeights = eyeRatios(lm, false, W, H);
    const withEqualWeights = eyeRatios(lm, false, W, H, { left: 1, right: 1 });
    expect(withoutWeights.rx).toBeCloseTo(withEqualWeights.rx, 10);
  });

  it('equal per-eye confidence (both eyes equally good) matches the flat average', () => {
    const lm = makeLandmarks({ irisOffsetXL: 0.03, irisOffsetXR: -0.01 });
    const flat = eyeRatios(lm, false, W, H);
    const weighted = eyeRatios(lm, false, W, H, eyeConfidence(0.05, 0.05));
    expect(weighted.rx).toBeCloseTo(flat.rx, 6);
  });

  it('down-weighting a compromised eye pulls rx toward the trusted eye\'s own reading', () => {
    // Left iris shifted further right than the right iris — a flat average
    // sits between the two; down-weighting the right eye (as if compromised)
    // should pull the combined rx toward the left eye's own (larger) rx.
    const lm = makeLandmarks({ irisOffsetXL: 0.04, irisOffsetXR: 0.01 });
    const leftOnly = eyeRatios(lm, false, W, H, { left: 1, right: 0 });
    const flat = eyeRatios(lm, false, W, H, { left: 1, right: 1 });
    const rightMostlyDistrusted = eyeRatios(lm, false, W, H, { left: 1, right: 0.1 });
    expect(rightMostlyDistrusted.rx).toBeGreaterThan(flat.rx);
    expect(rightMostlyDistrusted.rx).toBeLessThan(leftOnly.rx + 1e-9);
  });

  it('pose mode also respects per-eye weighting', () => {
    const lm = makeLandmarks({ irisOffsetXL: 0.03, irisOffsetXR: -0.03 });
    const flat = eyeRatios(lm, true, W, H, { left: 1, right: 1 });
    const leftWeighted = eyeRatios(lm, true, W, H, { left: 1, right: 0.1 });
    // Left iris moved positive, right iris moved negative -> trusting left
    // more should move the combined yaw toward the (positive) left-only value.
    expect(leftWeighted.rx).toBeGreaterThan(flat.rx);
  });
});

describe('blendVec', () => {
  it('returns zeros when blendshapes are absent', () => {
    expect(blendVec({})).toEqual({ bH: 0, bV: 0 });
  });

  it('derives horizontal/vertical eye-look signals from category scores', () => {
    const res = {
      faceBlendshapes: [{
        categories: [
          { categoryName: 'eyeLookUpLeft', score: 0.2 },
          { categoryName: 'eyeLookUpRight', score: 0.2 },
          { categoryName: 'eyeLookDownLeft', score: 0.0 },
          { categoryName: 'eyeLookDownRight', score: 0.0 },
          { categoryName: 'eyeLookInLeft', score: 0.1 },
          { categoryName: 'eyeLookInRight', score: 0.1 },
          { categoryName: 'eyeLookOutLeft', score: 0.5 },
          { categoryName: 'eyeLookOutRight', score: 0.5 },
        ],
      }],
    };
    const { bH, bV } = blendVec(res);
    expect(bH).toBeCloseTo(0.4, 8);  // out(0.5) - in(0.1)
    expect(bV).toBeCloseTo(-0.2, 8); // down(0) - up(0.2)
  });

  it('defaults (no weights passed) match equal-weight combination, unchanged from before', () => {
    const res = {
      faceBlendshapes: [{
        categories: [
          { categoryName: 'eyeLookOutLeft', score: 0.6 },
          { categoryName: 'eyeLookOutRight', score: 0.2 },
        ],
      }],
    };
    expect(blendVec(res)).toEqual(blendVec(res, { left: 1, right: 1 }));
  });

  it('down-weighting the right eye pulls bH toward the left eye\'s own reading', () => {
    const res = {
      faceBlendshapes: [{
        categories: [
          { categoryName: 'eyeLookOutLeft', score: 0.6 },
          { categoryName: 'eyeLookOutRight', score: 0.2 },
        ],
      }],
    };
    const flat = blendVec(res, { left: 1, right: 1 });
    const leftTrusted = blendVec(res, { left: 1, right: 0.1 });
    expect(leftTrusted.bH).toBeGreaterThan(flat.bH);
  });
});

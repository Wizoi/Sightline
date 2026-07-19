import { describe, it, expect } from 'vitest';
import {
  vsub, vadd, vscl, vdot, vcross, vnorm,
  headBasis, eyeGaze, eyeRatios, blendVec, eyeBlinkScores,
} from './gazeMath.js';

const W = 640, H = 480;

// A minimal, symmetric, frontal-facing set of face landmarks: the face edges
// and chin/forehead are arranged so headBasis works out to a clean identity
// basis (right=+x, down=+y, fwd=+z), and both irises sit exactly at the
// midpoint of their eye corners (i.e. "looking straight ahead").
function makeLandmarks({ irisOffsetX = 0 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i, x, y, z = 0) => { lm[i] = { x, y, z }; };

  set(234, 0.3, 0.5);  // left face edge
  set(454, 0.7, 0.5);  // right face edge
  set(10, 0.5, 0.2);   // forehead/top
  set(152, 0.5, 0.8);  // chin

  // left eye: outer 33, inner 133, iris 468
  set(33, 0.35, 0.5);
  set(133, 0.45, 0.5);
  set(468, 0.40 + irisOffsetX, 0.5);
  set(159, 0.40, 0.48); // upper lid
  set(145, 0.40, 0.52); // lower lid

  // right eye: inner 362, outer 263, iris 473
  set(263, 0.65, 0.5);
  set(362, 0.55, 0.5);
  set(473, 0.60 + irisOffsetX, 0.5);
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
});

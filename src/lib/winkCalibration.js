// Derives personal wink-detection thresholds from a short calibration
// sample (both eyes resting, then each eye's wink held in turn), instead of
// using lib/winkLogic.js's fixed defaults — useful when one eye's blink
// score runs structurally higher or lower than the other's at rest (common:
// camera angle, lighting, natural asymmetry), which a single shared
// threshold can't accommodate well for everyone.

const MIN_CLOSED = 0.15, MAX_CLOSED = 0.6;
const MIN_GAP = 0.04, MAX_GAP = 0.25;

// sample: { restLeft, restRight, leftPeakOwn, leftPeakOther, rightPeakOwn, rightPeakOther }
// restLeft/restRight: each eye's score while both are relaxed and open.
// leftPeakOwn/leftPeakOther: the left eye's own peak, and the right eye's
// peak at the same moment, during a held left wink (and the mirror for right).
export function deriveWinkThresholds(sample) {
  const { restLeft, restRight, leftPeakOwn, rightPeakOwn } = sample;

  // Sit partway between the highest resting value and the weaker eye's
  // wink peak, so it's comfortably clear of rest noise on either eye while
  // still reachable by whichever eye winks less dramatically.
  const restMax = Math.max(restLeft, restRight);
  const peakMin = Math.min(leftPeakOwn, rightPeakOwn);
  const closedThreshold = clamp(restMax + 0.4 * (peakMin - restMax), MIN_CLOSED, MAX_CLOSED);

  // Half of the smaller observed eye-to-eye gap — clearly reachable by a
  // real wink on either side, while still requiring a real gap to exist.
  const gapThreshold = clamp(0.5 * Math.min(winkGap(sample, 'left'), winkGap(sample, 'right')), MIN_GAP, MAX_GAP);

  return { closedThreshold, gapThreshold };
}

function winkGap(sample, eye) {
  return eye === 'left'
    ? sample.leftPeakOwn - sample.leftPeakOther
    : sample.rightPeakOwn - sample.rightPeakOther;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Guards against saving a calibration that's worse than just keeping the
// defaults — e.g. if a wink couldn't be told apart from the other eye or
// from rest at all (didn't hold it, camera trouble, etc).
export function isUsableCalibration(sample) {
  return (
    winkGap(sample, 'left') > 0.05 &&
    winkGap(sample, 'right') > 0.05 &&
    sample.leftPeakOwn > 0.15 &&
    sample.rightPeakOwn > 0.15
  );
}

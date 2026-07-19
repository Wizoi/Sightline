// Pure wink-detection state machine: distinguishes a deliberate one-eyed wink
// (one eye's blink score crosses the closed threshold while the other stays
// open) from an involuntary blink (both eyes closing together — explicitly
// ignored), and debounces a wink hold before committing to it. Mirrors
// followLogic.decide()'s hold-before-commit pattern so a quick/stray wink
// can't misfire.
//
// left/right are MediaPipe's per-eye blink blendshape scores (0 = open,
// 1 = fully closed — see lib/gazeMath.js's eyeBlinkScores), already
// model-normalized, so no baseline learning is needed here.

// MediaPipe's eyeBlinkLeft/Right scores don't reliably reach anywhere near
// 1.0 for a real, deliberate (non-exaggerated) wink — observed real-world
// winks have peaked around ~0.45-0.5 against a resting baseline around
// ~0.1, so 0.5 was too strict and silently never triggered. 0.3 sits
// comfortably above resting noise and below a real wink's peak.
const CLOSED_THRESHOLD = 0.3;

// A threshold on one eye alone isn't enough: an ordinary two-eyed blink
// rarely closes both eyes in perfect lockstep, so a brief moment where one
// eye's score has risen past CLOSED_THRESHOLD while the other hasn't quite
// caught up yet would otherwise misread as a wink. Requiring a clear gap
// between the two eyes' scores — not just one crossing a fixed line —
// rejects "both elevated, one a bit more" (a blink) while still accepting a
// real wink (one eye closed, the other still near its resting baseline).
const GAP_THRESHOLD = 0.15;

export function createWinkState() {
  return { candidate: null, since: 0 };
}

// input: { left, right, now, holdMs }
export function decideWink(state, input) {
  const { left, right, now, holdMs } = input;
  const leftClosed = left >= CLOSED_THRESHOLD && (left - right) >= GAP_THRESHOLD;
  const rightClosed = right >= CLOSED_THRESHOLD && (right - left) >= GAP_THRESHOLD;

  let nextCandidate = null;
  if (leftClosed && !rightClosed) nextCandidate = 'left';
  else if (rightClosed && !leftClosed) nextCandidate = 'right';
  // both closed together (blink) or neither clearly closed -> ignored

  const nextSince = nextCandidate !== state.candidate ? now : state.since;
  const committed = nextCandidate && (now - nextSince) >= holdMs ? nextCandidate : null;

  return {
    state: { candidate: nextCandidate, since: nextSince },
    wink: committed,
  };
}

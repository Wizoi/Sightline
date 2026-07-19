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

export function createWinkState() {
  return { candidate: null, since: 0 };
}

// input: { left, right, now, holdMs }
export function decideWink(state, input) {
  const { left, right, now, holdMs } = input;
  const leftClosed = left >= CLOSED_THRESHOLD;
  const rightClosed = right >= CLOSED_THRESHOLD;

  let nextCandidate = null;
  if (leftClosed && !rightClosed) nextCandidate = 'left';
  else if (rightClosed && !leftClosed) nextCandidate = 'right';
  // both closed (blink) or both open -> nextCandidate stays null, ignored

  const nextSince = nextCandidate !== state.candidate ? now : state.since;
  const committed = nextCandidate && (now - nextSince) >= holdMs ? nextCandidate : null;

  return {
    state: { candidate: nextCandidate, since: nextSince },
    wink: committed,
  };
}

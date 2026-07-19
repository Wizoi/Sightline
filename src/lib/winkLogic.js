// Pure wink-detection state machine: distinguishes a deliberate one-eyed wink
// (one eye's openness drops well below its own baseline while the other eye
// stays near its baseline) from an involuntary blink (both eyes drop
// together — explicitly ignored) or ordinary camera noise, and debounces a
// wink hold before committing to it. Mirrors followLogic.decide()'s
// hold-before-commit pattern so a quick/stray wink can't misfire.

const CLOSED_RATIO = 0.5;   // an eye counts as "closed" below this fraction of its own open baseline
const BASELINE_EMA = 0.03;  // slow tracking of each eye's normal "open" width

export function createWinkState() {
  return { leftBaseline: null, rightBaseline: null, candidate: null, since: 0 };
}

// input: { left, right, now, holdMs } — left/right are this frame's per-eye
// openness (see lib/gazeMath.js's eyeOpenness).
export function decideWink(state, input) {
  const { left, right, now, holdMs } = input;
  let leftBaseline = state.leftBaseline == null ? left : state.leftBaseline;
  let rightBaseline = state.rightBaseline == null ? right : state.rightBaseline;

  const leftClosed = left < CLOSED_RATIO * leftBaseline;
  const rightClosed = right < CLOSED_RATIO * rightBaseline;

  // Only drift the baseline while that eye looks normally open, so holding a
  // wink doesn't slowly redefine "open" as "closed" out from under itself.
  if (!leftClosed) leftBaseline += BASELINE_EMA * (left - leftBaseline);
  if (!rightClosed) rightBaseline += BASELINE_EMA * (right - rightBaseline);

  let nextCandidate = null;
  if (leftClosed && !rightClosed) nextCandidate = 'left';
  else if (rightClosed && !leftClosed) nextCandidate = 'right';
  // both closed (blink) or both open -> nextCandidate stays null, ignored

  const nextSince = nextCandidate !== state.candidate ? now : state.since;
  const committed = nextCandidate && (now - nextSince) >= holdMs ? nextCandidate : null;

  return {
    state: { leftBaseline, rightBaseline, candidate: nextCandidate, since: nextSince },
    wink: committed,
  };
}

import { describe, it, expect } from 'vitest';
import { createWinkState, decideWink } from './winkLogic.js';

const OPEN = 0.05;   // a plausible "eye open" blink score
const CLOSED = 0.9;  // a plausible "eye closed" blink score
const holdMs = 200;

function run(frames) {
  let state = createWinkState();
  let last = { wink: null, state };
  for (const f of frames) {
    last = decideWink(state, { left: f.left, right: f.right, now: f.now, holdMs });
    state = last.state;
  }
  return last;
}

describe('decideWink', () => {
  it('does not trigger while both eyes stay open', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: OPEN, right: OPEN, now: 100 },
      { left: OPEN, right: OPEN, now: 500 },
    ]);
    expect(r.wink).toBeNull();
  });

  it('commits a left wink once the left eye stays closed past the hold delay', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: CLOSED, right: OPEN, now: 10 },
      { left: CLOSED, right: OPEN, now: 250 },
    ]);
    expect(r.wink).toBe('left');
  });

  it('commits a right wink once the right eye stays closed past the hold delay', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: OPEN, right: CLOSED, now: 10 },
      { left: OPEN, right: CLOSED, now: 250 },
    ]);
    expect(r.wink).toBe('right');
  });

  it('ignores a wink that has not been held long enough yet', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: CLOSED, right: OPEN, now: 10 },
      { left: CLOSED, right: OPEN, now: 150 }, // only 140ms held, holdMs=200
    ]);
    expect(r.wink).toBeNull();
  });

  it('never triggers when both eyes close together (a blink, not a wink)', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: CLOSED, right: CLOSED, now: 10 },
      { left: CLOSED, right: CLOSED, now: 500 },
    ]);
    expect(r.wink).toBeNull();
  });

  it('resets the hold timer if the candidate eye switches mid-hold', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: CLOSED, right: OPEN, now: 10 },   // candidate: left
      { left: OPEN, right: CLOSED, now: 150 },  // candidate switches to right — timer restarts
      { left: OPEN, right: CLOSED, now: 300 },  // only 150ms since the switch
    ]);
    expect(r.wink).toBeNull();
  });

  it('recovers cleanly after a wink releases (both eyes reopen)', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: CLOSED, right: OPEN, now: 10 },
      { left: CLOSED, right: OPEN, now: 250 }, // left wink commits here
      { left: OPEN, right: OPEN, now: 400 },   // released
    ]);
    expect(r.wink).toBeNull();
  });

  it('treats a borderline score right at the threshold as open (>= counts as closed)', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: 0.5, right: OPEN, now: 10 },
      { left: 0.5, right: OPEN, now: 300 },
    ]);
    expect(r.wink).toBe('left');
  });

  it('does not misread an imperfectly-synced blink as a wink', () => {
    // Both eyes rise together (a blink), but not in perfect lockstep — one
    // is a little ahead of the other. Neither crosses CLOSED_THRESHOLD with
    // a clear enough gap over the other to count as a deliberate wink.
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: 0.35, right: 0.25, now: 10 },
      { left: 0.4, right: 0.38, now: 100 },
      { left: 0.35, right: 0.25, now: 300 },
    ]);
    expect(r.wink).toBeNull();
  });

  it('still triggers when one eye is clearly closed and the other only mildly elevated', () => {
    const r = run([
      { left: OPEN, right: OPEN, now: 0 },
      { left: 0.6, right: 0.15, now: 10 },  // gap 0.45, comfortably over GAP_THRESHOLD
      { left: 0.6, right: 0.15, now: 300 },
    ]);
    expect(r.wink).toBe('left');
  });
});

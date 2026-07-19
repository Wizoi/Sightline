import { describe, it, expect } from 'vitest';
import { createWinkState, decideWink } from './winkLogic.js';

const OPEN = 0.3;   // a plausible "eye open" width ratio
const CLOSED = 0.02; // a plausible "eye closed" width ratio
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
      { left: OPEN, right: OPEN, now: 0 },      // establishes baseline
      { left: CLOSED, right: OPEN, now: 10 },   // left starts closing
      { left: CLOSED, right: OPEN, now: 250 },  // held past holdMs (200ms)
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
});

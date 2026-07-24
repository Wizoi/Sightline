import { describe, it, expect } from 'vitest';
import { createFollowState, decide } from './followLogic.js';

const cfg = {
  deadZoneFrac: 0.18, bandPos: 0.5, rightZoneFrac: 0.62,
  maxSpeed: 360, smoothWin: 12, holdMs: 350, sheetMargin: 0.06,
};
const W = 1000, H = 800; // center=400, dead=144, rightStart=620, rightBound=940

function baseInput(overrides = {}) {
  return {
    now: 1000, dt: 0.05, cfg, biasY: 0,
    rawGaze: null, driftOn: false, snapOn: false, systemCentersDoc: [],
    scrollY: 0, docMax: 2000, viewportW: W, viewportH: H,
    ...overrides,
  };
}

describe('decide: gaze validity gating', () => {
  it('reports no-gaze when rawGaze is missing', () => {
    const r = decide(createFollowState(), baseInput({ rawGaze: null }));
    expect(r.status).toEqual({ cls: 's-bad', text: 'no gaze — hold' });
    expect(r.zoneText).toBe('–');
    expect(r.scroll).toBeNull();
  });

  it('reports no-gaze when the sample is stale', () => {
    const r = decide(createFollowState(), baseInput({ rawGaze: { x: 300, y: 400, t: 1000 - 300 } }));
    expect(r.status.text).toBe('no gaze — hold');
  });

  it('reports looking-away when gaze is outside the sheet margins', () => {
    const r = decide(createFollowState(), baseInput({ rawGaze: { x: 990, y: 400, t: 990 } }));
    expect(r.status).toEqual({ cls: 's-warn', text: 'looking away — hold' });
    expect(r.zoneText).toBe('off');
  });
});

describe('decide: smooth mode', () => {
  it('stays put while reading inside the band', () => {
    const r = decide(createFollowState(), baseInput({ rawGaze: { x: 300, y: 400, t: 990 } }));
    expect(r.zoneText).toBe('read');
    expect(r.scroll).toBeNull();
    expect(r.status.text).toBe('following');
  });

  it('withholds scrolling until the hold delay elapses, then engages', () => {
    const input1 = baseInput({ now: 1000, rawGaze: { x: 300, y: 700, t: 990 } }); // offset=300 > dead
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('down');
    expect(r1.status.text).toBe('hold…');
    expect(r1.scroll).toBeNull();

    const input2 = baseInput({ now: 1400, dt: 0.4, rawGaze: { x: 300, y: 700, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.status.text).toBe('following');
    expect(r2.scroll).toEqual({ type: 'by', amount: expect.any(Number) });
    expect(r2.scroll.amount).toBeGreaterThan(0);
  });

  it('triggers a line-end scroll when gaze reaches the right zone', () => {
    const input1 = baseInput({ now: 1000, rawGaze: { x: 900, y: 400, t: 990 } }); // in band, past rightStart
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('line-end ↓');
    const input2 = baseInput({ now: 1400, dt: 0.4, rawGaze: { x: 900, y: 400, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.scroll.amount).toBeGreaterThan(0);
  });
});

describe('decide: snap mode', () => {
  const systemCentersDoc = [100, 500, 900];

  it('picks the next system and (after the hold delay) sets a snap target', () => {
    const input1 = baseInput({ now: 1000, snapOn: true, systemCentersDoc, rawGaze: { x: 300, y: 700, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.state.snapTarget).toBeNull();
    expect(r1.status.text).toBe('advance → snap');

    const input2 = baseInput({ now: 1400, snapOn: true, systemCentersDoc, rawGaze: { x: 300, y: 700, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.state.snapTarget).toBe(100); // next system (500) minus band center (400)
  });

  it('converges to the snap target and finishes with an absolute scroll', () => {
    let state = { ...createFollowState(), snapTarget: 100 };
    let scrollY = 0;
    let landed = null;
    for (let i = 0; i < 50 && landed === null; i++) {
      const now = 2000 + i * 50;
      const r = decide(state, baseInput({ now, dt: 0.05, snapOn: true, systemCentersDoc, scrollY, rawGaze: { x: 300, y: 700, t: now - 10 } }));
      state = r.state;
      if (r.scroll?.type === 'by') scrollY += r.scroll.amount;
      if (r.scroll?.type === 'to') { scrollY = r.scroll.y; landed = r.scroll.y; }
    }
    expect(landed).toBe(100);
    expect(state.snapTarget).toBeNull();
  });

  it('falls back to "reading" when there is no next system to snap to', () => {
    const r = decide(createFollowState(), baseInput({
      now: 1000, snapOn: true, systemCentersDoc: [100], scrollY: 900,
      rawGaze: { x: 300, y: 700, t: 990 },
    }));
    expect(r.status.text).toBe('reading');
    expect(r.zoneText).toBe('read');
  });
});

describe('decide: up trigger stays reachable when the band sits near the top', () => {
  // Regression test: "Where you read on screen" can go as low as 12%, and with
  // the default 18% dead-zone size that used to make bandPos <= deadZoneFrac,
  // which made `offset < -dead` mathematically unreachable (offset's minimum
  // possible value is -center, and center was smaller than dead) — "up" would
  // silently never trigger, while "down" kept working fine. See followLogic.js.
  const topBandCfg = { ...cfg, bandPos: 0.12 }; // center = 96, dead = 144 (dead > center!)

  it('still triggers an upward scroll when gaze is near the very top of the screen', () => {
    const input1 = baseInput({ cfg: topBandCfg, now: 1000, rawGaze: { x: 300, y: 2, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('up');

    const input2 = baseInput({ cfg: topBandCfg, now: 1400, dt: 0.4, rawGaze: { x: 300, y: 2, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.status.text).toBe('following');
    expect(r2.scroll).toEqual({ type: 'by', amount: expect.any(Number) });
    expect(r2.scroll.amount).toBeLessThan(0); // scrolling up
  });

  it('also reaches the snap-mode "back a system" trigger near the top of the screen', () => {
    const systemCentersDoc = [50, 400];
    const input1 = baseInput({
      cfg: topBandCfg, now: 1000, snapOn: true, systemCentersDoc, scrollY: 200,
      rawGaze: { x: 300, y: 2, t: 990 },
    });
    const r1 = decide(createFollowState(), input1);
    expect(r1.status.text).toBe('back a system');
  });
});

describe('decide: winkIntent explicit intent channel', () => {
  // Wink tracking calls decide() directly with a { dir, strength, t } intent
  // instead of synthesizing a fake rawGaze point (see winkTracking.js and
  // PERSONAS.md section 5, item A2) — these mirror the equivalent rawGaze-
  // driven tests above, but via the intent channel, and with no rawGaze at
  // all (it should never be consulted while a fresh winkIntent is present).

  it('withholds scrolling until the hold delay elapses, then scrolls down for a "down" intent', () => {
    const input1 = baseInput({ now: 1000, winkIntent: { dir: 1, strength: 1, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('down');
    expect(r1.status.text).toBe('hold…');
    expect(r1.scroll).toBeNull();

    const input2 = baseInput({ now: 1400, dt: 0.4, winkIntent: { dir: 1, strength: 1, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.status.text).toBe('following');
    expect(r2.scroll.amount).toBeGreaterThan(0);
  });

  it('scrolls up for an "up" intent', () => {
    const input1 = baseInput({ now: 1000, winkIntent: { dir: -1, strength: 1, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('up');

    const input2 = baseInput({ now: 1400, dt: 0.4, winkIntent: { dir: -1, strength: 1, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.scroll.amount).toBeLessThan(0);
  });

  it('scales scroll speed with intent strength', () => {
    const r1a = decide(createFollowState(), baseInput({ now: 1000, winkIntent: { dir: 1, strength: 0.1, t: 990 } }));
    const r2a = decide(r1a.state, baseInput({ now: 1400, dt: 0.4, winkIntent: { dir: 1, strength: 0.1, t: 1390 } }));

    const r1b = decide(createFollowState(), baseInput({ now: 1000, winkIntent: { dir: 1, strength: 1, t: 990 } }));
    const r2b = decide(r1b.state, baseInput({ now: 1400, dt: 0.4, winkIntent: { dir: 1, strength: 1, t: 1390 } }));

    expect(r2b.scroll.amount).toBeGreaterThan(r2a.scroll.amount);
  });

  it('reaches the up trigger even when the band sits near the top of the screen — structurally immune to the dead-zone-cap class of bug, since it never derives a direction from band geometry at all', () => {
    const topBandCfg = { ...cfg, bandPos: 0.12 }; // the exact config that used to make "up" unreachable via rawGaze
    const input1 = baseInput({ cfg: topBandCfg, now: 1000, winkIntent: { dir: -1, strength: 1, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.zoneText).toBe('up');
    const input2 = baseInput({ cfg: topBandCfg, now: 1400, dt: 0.4, winkIntent: { dir: -1, strength: 1, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.scroll.amount).toBeLessThan(0);
  });

  it('drives snap mode: advances to the next system on a "down" intent, retreats on "up"', () => {
    const systemCentersDoc = [100, 500, 900];
    const input1 = baseInput({ now: 1000, snapOn: true, systemCentersDoc, winkIntent: { dir: 1, strength: 1, t: 990 } });
    const r1 = decide(createFollowState(), input1);
    expect(r1.status.text).toBe('advance → snap');
    expect(r1.state.snapTarget).toBeNull();

    const input2 = baseInput({ now: 1400, snapOn: true, systemCentersDoc, winkIntent: { dir: 1, strength: 1, t: 1390 } });
    const r2 = decide(r1.state, input2);
    expect(r2.state.snapTarget).toBe(100); // next system (500) minus band center (400)

    const input3 = baseInput({ now: 1000, snapOn: true, systemCentersDoc, scrollY: 500, winkIntent: { dir: -1, strength: 1, t: 990 } });
    const r3 = decide(createFollowState(), input3);
    expect(r3.status.text).toBe('back a system');
  });

  it('ignores rawGaze entirely while a fresh winkIntent is present', () => {
    // rawGaze here is positioned to be "looking away" (off-sheet) — if it
    // were consulted at all, this would report 'off', not a wink direction.
    const input = baseInput({
      now: 1000, rawGaze: { x: 990, y: 400, t: 990 },
      winkIntent: { dir: 1, strength: 1, t: 990 },
    });
    const r = decide(createFollowState(), input);
    expect(r.zoneText).toBe('down');
  });

  it('falls back to the rawGaze/no-gaze path once the intent goes stale', () => {
    const stale = baseInput({ now: 1000, winkIntent: { dir: 1, strength: 1, t: 700 } }); // 300ms old
    const r = decide(createFollowState(), stale);
    expect(r.status.text).toBe('no gaze — hold');
  });
});

describe('decide: gaze smoothing (One Euro filter)', () => {
  // decide() no longer runs a fixed-alpha EMA over rawGaze — see
  // lib/oneEuroFilter.js and lib/oneEuroFilter.test.js for the filter's own
  // unit tests. These two tests check the *integration*: that decide()
  // actually threads the filter's extra per-axis state (dX/dY) correctly
  // frame to frame through its own `state` object, the same way it already
  // threads smoothX/smoothY.
  it('starts a fresh FollowState with the filter derivative memory zeroed', () => {
    const s = createFollowState();
    expect(s.dX).toBe(0);
    expect(s.dY).toBe(0);
  });

  it('tracks a large fast gaze jump noticeably further in one frame than the old fixed-alpha EMA would have (smoothWin=12 -> old alpha=1/12)', () => {
    const r1 = decide(createFollowState(), baseInput({ now: 1000, rawGaze: { x: 300, y: 400, t: 990 } }));
    expect(r1.state.smoothY).toBe(400); // first sample: passed through untouched, like the old EMA

    // A big jump (400 -> 700) over one ~33ms frame — saccade-sized speed.
    const r2 = decide(r1.state, baseInput({ now: 1033, dt: 1 / 30, rawGaze: { x: 300, y: 700, t: 1030 } }));

    const oldEmaValue = 400 + (1 / cfg.smoothWin) * (700 - 400); // what the old EMA would have produced: 425
    expect(r2.state.smoothY).toBeGreaterThan(oldEmaValue + 20); // clearly further along than the old fixed-alpha step
    expect(r2.state.smoothY).toBeLessThan(700); // still a low-pass, not an instant snap
  });
});

describe('decide: drift correction', () => {
  it('nudges biasY toward center only when drift is on and reading', () => {
    const input = baseInput({ driftOn: true, biasY: 0, rawGaze: { x: 300, y: 450, t: 990 } });
    const r = decide(createFollowState(), input);
    expect(r.biasY).not.toBe(0);
    expect(Math.abs(r.biasY)).toBeLessThan(0.01);
  });

  it('leaves biasY untouched when drift is off', () => {
    const input = baseInput({ driftOn: false, biasY: 0.02, rawGaze: { x: 300, y: 450, t: 990 } });
    const r = decide(createFollowState(), input);
    expect(r.biasY).toBe(0.02);
  });
});

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

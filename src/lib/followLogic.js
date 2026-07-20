// Pure per-frame decision logic for the follow controller: given the reading
// band, the current (smoothed) gaze, and the previous frame's local state, it
// decides what zone we're in, whether to scroll (or snap), and what the HUD
// should say. No DOM access happens here — followController.js applies the
// returned effects and keeps this function easy to unit test.

export function createFollowState() {
  return {
    smoothX: null,
    smoothY: null,
    snapTarget: null,
    curZone: 0,
    zoneSince: 0,
    scrollCarry: 0,
  };
}

// Per-direction dead-zone reach in pixels, shared by decide() and anything
// else that needs to know where the up/down trigger zones actually are (e.g.
// wink tracking synthesizing a gaze point — see winkTracking.js). Capped per
// direction so it can never swallow the *entire* travel room above or below
// the band: a band positioned near the top of the screen (bandPos <=
// deadZoneFrac — well within the sliders' range) would otherwise make the
// "up" trigger mathematically unreachable, since offset's minimum possible
// value is -center. A single source of truth for this cap matters because a
// second caller re-deriving it from raw cfg values (not the capped result)
// can silently synthesize a point that never actually clears the real
// trigger zone — this happened once already with the wink tracker.
export function deadZoneBounds(cfg, H) {
  const center = H * cfg.bandPos;
  const dead = cfg.deadZoneFrac * H;
  const minRoom = 8; // px
  return {
    center,
    deadUp: Math.min(dead, Math.max(0, center - minRoom)),
    deadDown: Math.min(dead, Math.max(0, H - center - minRoom)),
  };
}

// input: {
//   now, dt, cfg, biasY,
//   rawGaze: { x, y, t } | null,
//   driftOn, snapOn, systemCentersDoc: number[],
//   scrollY, docMax, viewportW, viewportH,
// }
// returns: {
//   state: <next FollowState>, biasY: <possibly updated>,
//   status: { cls, text }, zoneText, velText,
//   scroll: null | { type: 'by', amount } | { type: 'to', y },
// }
export function decide(state, input) {
  const {
    now, dt, cfg, rawGaze, driftOn, snapOn, systemCentersDoc,
    scrollY, docMax, viewportW: W, viewportH: H,
  } = input;
  let { smoothX, smoothY, snapTarget, curZone, zoneSince, scrollCarry } = state;
  let biasY = input.biasY;

  const fresh = rawGaze && (now - rawGaze.t) < 250;
  if (!fresh) {
    return {
      state: { smoothX, smoothY, snapTarget, curZone: 0, zoneSince, scrollCarry },
      biasY,
      status: { cls: 's-bad', text: 'no gaze — hold' },
      zoneText: '–', velText: '0', scroll: null,
    };
  }
  const onSheetX = rawGaze.x > W * cfg.sheetMargin && rawGaze.x < W * (1 - cfg.sheetMargin);
  const onScreenY = rawGaze.y > 0 && rawGaze.y < H;
  if (!onSheetX || !onScreenY) {
    return {
      state: { smoothX, smoothY, snapTarget, curZone: 0, zoneSince, scrollCarry },
      biasY,
      status: { cls: 's-warn', text: 'looking away — hold' },
      zoneText: 'off', velText: '0', scroll: null,
    };
  }

  const alpha = 1 / Math.max(1, cfg.smoothWin);
  smoothX = (smoothX == null) ? rawGaze.x : smoothX + alpha * (rawGaze.x - smoothX);
  smoothY = (smoothY == null) ? rawGaze.y : smoothY + alpha * (rawGaze.y - smoothY);

  const { center, deadUp, deadDown } = deadZoneBounds(cfg, H);
  const offset = smoothY - center;
  const inBand = offset >= -deadUp && offset <= deadDown;
  const rightBound = W * (1 - cfg.sheetMargin);
  const rightStart = W * cfg.rightZoneFrac;
  const reading = inBand && smoothX <= rightStart;

  // drift correction: while reading, nudge the vertical mapping so resting
  // gaze settles at the band center. Slow + clamped so it can't run away.
  if (driftOn && reading) {
    biasY = biasY * (1 - 0.05 * dt) + 0.03 * (cfg.bandPos - smoothY / H) * dt;
    biasY = Math.min(0.15, Math.max(-0.15, biasY));
  }

  // --- SNAP MODE: advance/retreat whole systems -----------------------
  if (snapOn && systemCentersDoc.length) {
    if (snapTarget != null) {
      const step = (snapTarget - scrollY) * Math.min(1, dt * 6);
      const arriving = Math.abs(snapTarget - (scrollY + step)) < 2;
      return {
        state: { smoothX, smoothY, snapTarget: arriving ? null : snapTarget, curZone, zoneSince, scrollCarry },
        biasY,
        status: { cls: 's-good', text: 'snapping…' },
        zoneText: 'snap', velText: String(Math.round(dt ? step / dt : 0)),
        scroll: arriving ? { type: 'to', y: snapTarget } : { type: 'by', amount: step },
      };
    }
    const bandDocY = scrollY + center;
    // advance to the next system when you finish the line (gaze to the right
    // of the band) OR simply look down at the next group (below the band).
    if ((inBand && smoothX > rightStart) || offset > deadDown) {
      const next = systemCentersDoc.find((y) => y > bandDocY + 8);
      if (next != null) {
        let nextZone = curZone, nextSince = zoneSince, nextTarget = snapTarget;
        if (curZone !== 1) { nextZone = 1; nextSince = now; }
        if (now - nextSince >= cfg.holdMs) { nextTarget = Math.min(docMax, Math.max(0, next - center)); nextZone = 0; }
        return {
          state: { smoothX, smoothY, snapTarget: nextTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry },
          biasY,
          status: { cls: 's-good', text: 'advance → snap' },
          zoneText: smoothX > rightStart ? 'line-end' : 'down', velText: '0', scroll: null,
        };
      }
    } else if (offset < -deadUp) {
      const prev = [...systemCentersDoc].reverse().find((y) => y < bandDocY - 8);
      if (prev != null) {
        let nextZone = curZone, nextSince = zoneSince, nextTarget = snapTarget;
        if (curZone !== -1) { nextZone = -1; nextSince = now; }
        if (now - nextSince >= cfg.holdMs) { nextTarget = Math.max(0, prev - center); nextZone = 0; }
        return {
          state: { smoothX, smoothY, snapTarget: nextTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry },
          biasY,
          status: { cls: 's-good', text: 'back a system' },
          zoneText: 'up', velText: '0', scroll: null,
        };
      }
    }
    return {
      state: { smoothX, smoothY, snapTarget, curZone: 0, zoneSince, scrollCarry },
      biasY,
      status: { cls: 's-good', text: 'reading' },
      zoneText: 'read', velText: '0', scroll: null,
    };
  }

  // --- SMOOTH MODE: proportional velocity -----------------------------
  let vIntent = 0, label = 'read';
  if (inBand && smoothX > rightStart) {
    const mag = Math.min(1, (smoothX - rightStart) / Math.max(1, rightBound - rightStart));
    vIntent = mag * cfg.maxSpeed; label = 'line-end ↓';
  } else if (offset > deadDown) {
    const mag = Math.min(1, (offset - deadDown) / Math.max(1, H - center - deadDown));
    vIntent = mag * cfg.maxSpeed; label = 'down';
  } else if (offset < -deadUp) {
    const mag = Math.min(1, (-offset - deadUp) / Math.max(1, center - deadUp));
    vIntent = -mag * cfg.maxSpeed; label = 'up';
  }
  const zone = Math.sign(vIntent);
  let nextZone = curZone, nextSince = zoneSince;
  if (zone !== curZone) { nextZone = zone; nextSince = now; }
  const engaged = (now - nextSince) >= cfg.holdMs;
  const v = engaged ? vIntent : 0;
  let nextCarry = scrollCarry + v * dt;
  const whole = Math.trunc(nextCarry);
  nextCarry -= whole;

  return {
    state: { smoothX, smoothY, snapTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry: nextCarry },
    biasY,
    status: { cls: 's-good', text: engaged || zone === 0 ? 'following' : 'hold…' },
    zoneText: label, velText: String(Math.round(v)),
    scroll: whole !== 0 ? { type: 'by', amount: whole } : null,
  };
}

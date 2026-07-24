// Pure per-frame decision logic for the follow controller: given the reading
// band, the current (smoothed) gaze, and the previous frame's local state, it
// decides what zone we're in, whether to scroll (or snap), and what the HUD
// should say. No DOM access happens here — followController.js applies the
// returned effects and keeps this function easy to unit test.

import { oneEuroStep } from './oneEuroFilter.js';

export function createFollowState() {
  return {
    smoothX: null,
    smoothY: null,
    // Derivative-estimate memory for the One Euro filter (lib/oneEuroFilter.js)
    // — threaded alongside smoothX/smoothY the same explicit way, one per axis
    // so the two filter instances never share state. Only ever read/updated in
    // the gaze-point smoothing step below; the winkIntent branch (which never
    // touches smoothX/smoothY either) just passes these through unchanged.
    dX: 0,
    dY: 0,
    snapTarget: null,
    curZone: 0,
    zoneSince: 0,
    scrollCarry: 0,
  };
}

// Maps the single "Eye-tracking smoothing" slider (cfg.smoothWin, range
// 3-40, see settings.js/index.html) onto the One Euro filter's `minCutoff`
// (Hz) — the jitter floor: how much smoothing applies while gaze is
// essentially still. `beta` (how fast the cutoff opens up as speed rises) is
// deliberately NOT driven by this slider — see ONE_EURO_BETA below — because
// exposing two raw filter parameters would undo the point of this being one
// low-cognitive-load control for a band-student user, and beta only affects
// behavior *during* a fast saccade, which isn't the axis this slider's
// "snappy, more jitter" <-> "smooth, more lag" labeling describes anyway.
//
// The old EMA's alpha was 1/smoothWin, i.e. smoothWin behaved like an
// N-frame moving-average time constant. To keep existing saved slider
// positions (real users may have this in localStorage) landing on a
// comparably-smooth *resting* behavior rather than a jarring jump, this
// converts that same "N frames" time constant to Hz assuming a representative
// ~30fps webcam frame rate: tau = smoothWin / 30 seconds, minCutoff = 1 /
// (2*pi*tau). Actual runtime dt is measured live and unaffected by this
// assumption — it only calibrates where the slider's existing 3-40 range
// lands in Hz space. (smoothWin=12, the default, lands at ~0.4Hz; smoothWin=3
// at ~1.6Hz; smoothWin=40 at ~0.12Hz.)
const ASSUMED_FPS = 30;
function minCutoffFromSmoothWin(smoothWin) {
  const tau = Math.max(1, smoothWin) / ASSUMED_FPS;
  return 1 / (2 * Math.PI * tau);
}

// Fixed, pre-tuned speed-adaptiveness constant (Hz per px/s of estimated
// gaze speed) — empirically chosen (see lib/oneEuroFilter.test.js) as the
// largest value that still keeps steady-state jitter variance *below* the
// old fixed-alpha EMA's on synthetic small (~3px) reading-line jitter, while
// a real saccade (a sustained few-hundred-px/s swing held over many frames,
// not a single noisy blip) still opens the cutoff up enough to cut the old
// EMA's ~26-frame settle time down to ~5 frames. Not exposed to users for
// the same reason minCutoff's derivation above is: one slider, not three.
const ONE_EURO_BETA = 0.0008;

// Per-direction dead-zone reach in pixels — used by decide()'s own gaze-point
// path below, and by anything else that needs to know where the on-screen
// up/down trigger zones actually sit (e.g. rendering the reading-band overlay
// in the DOM). Capped per direction so it can never swallow the *entire*
// travel room above or below the band: a band positioned near the top of the
// screen (bandPos <= deadZoneFrac — well within the sliders' range) would
// otherwise make the "up" trigger mathematically unreachable, since offset's
// minimum possible value is -center. A single source of truth for this cap
// matters because a second caller re-deriving it from raw cfg values (not the
// capped result) can silently reintroduce that unreachable-trigger bug — this
// happened once already, when wink tracking used to drive decide() by
// synthesizing a fake on-screen gaze point rather than calling it directly
// (see the `winkIntent` explicit-intent channel below, which replaced that
// indirection entirely and so no longer needs this cap at all).
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
//   winkIntent: { dir: -1 | 1, strength: 0..1, t } | null,
//   driftOn, snapOn, systemCentersDoc: number[],
//   scrollY, docMax, viewportW, viewportH,
// }
// returns: {
//   state: <next FollowState>, biasY: <possibly updated>,
//   status: { cls, text }, zoneText, velText,
//   scroll: null | { type: 'by', amount } | { type: 'to', y },
// }
//
// `winkIntent` is an explicit "just scroll up/down" channel for signals that
// were never a screen position in the first place (wink tracking's committed
// left/right wink — see src/tracking/winkTracking.js). It's handled by its
// own branch below, entirely separate from the gaze-point path: no sheet-
// margin/on-screen check, no EMA smoothing, no dead-zone geometry, no drift
// correction and no line-end detection apply to it, because none of those
// exist to serve a real (x, y) position that this signal never had. This
// replaces an earlier design where wink tracking synthesized a fake gaze
// point positioned just past the dead-zone edge for decide() to re-derive a
// direction from — workable, but fragile: the synthesized point had to
// exactly track decide()'s own (capped, per-direction) dead-zone geometry to
// avoid landing back inside the zone it was meant to clear, which broke once
// already (see PERSONAS.md section 5, finding on `deadZoneBounds`/
// `winkTracking.js`). A real, direct intent channel can't reintroduce that
// bug class at all, because it never derives a direction from geometry to
// begin with. Still timestamp-gated (same 250ms freshness window as
// `rawGaze`) so a stale/stuck value (e.g. left over after switching away from
// wink tracking mid-session) can't drive scrolling forever.
export function decide(state, input) {
  const {
    now, dt, cfg, rawGaze, winkIntent, driftOn, snapOn, systemCentersDoc,
    scrollY, docMax, viewportW: W, viewportH: H,
  } = input;
  let { smoothX, smoothY, dX, dY, snapTarget, curZone, zoneSince, scrollCarry } = state;
  let biasY = input.biasY;

  const freshIntent = winkIntent && (now - winkIntent.t) < 250;
  if (freshIntent) {
    const dir = winkIntent.dir; // -1 = up, 1 = down
    const label = dir < 0 ? 'up' : 'down';

    if (snapOn && systemCentersDoc.length) {
      if (snapTarget != null) {
        const step = (snapTarget - scrollY) * Math.min(1, dt * 6);
        const arriving = Math.abs(snapTarget - (scrollY + step)) < 2;
        return {
          state: { smoothX, smoothY, dX, dY, snapTarget: arriving ? null : snapTarget, curZone, zoneSince, scrollCarry },
          biasY,
          status: { cls: 's-good', text: 'snapping…' },
          zoneText: 'snap', velText: String(Math.round(dt ? step / dt : 0)),
          scroll: arriving ? { type: 'to', y: snapTarget } : { type: 'by', amount: step },
        };
      }
      const center = H * cfg.bandPos;
      const bandDocY = scrollY + center;
      const next = dir > 0
        ? systemCentersDoc.find((y) => y > bandDocY + 8)
        : [...systemCentersDoc].reverse().find((y) => y < bandDocY - 8);
      if (next != null) {
        let nextZone = curZone, nextSince = zoneSince, nextTarget = snapTarget;
        if (curZone !== dir) { nextZone = dir; nextSince = now; }
        if (now - nextSince >= cfg.holdMs) {
          nextTarget = dir > 0
            ? Math.min(docMax, Math.max(0, next - center))
            : Math.max(0, next - center);
          nextZone = 0;
        }
        return {
          state: { smoothX, smoothY, dX, dY, snapTarget: nextTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry },
          biasY,
          status: { cls: 's-good', text: dir > 0 ? 'advance → snap' : 'back a system' },
          zoneText: label, velText: '0', scroll: null,
        };
      }
      return {
        state: { smoothX, smoothY, dX, dY, snapTarget, curZone: 0, zoneSince, scrollCarry },
        biasY,
        status: { cls: 's-good', text: 'reading' },
        zoneText: 'read', velText: '0', scroll: null,
      };
    }

    // smooth mode: strength maps directly to speed — there's no continuous
    // position to derive a proportional magnitude from, unlike the gaze path.
    const mag = Math.min(1, Math.max(0, winkIntent.strength));
    const vIntent = dir * mag * cfg.maxSpeed;
    let nextZone = curZone, nextSince = zoneSince;
    if (dir !== curZone) { nextZone = dir; nextSince = now; }
    const engaged = (now - nextSince) >= cfg.holdMs;
    const v = engaged ? vIntent : 0;
    let nextCarry = scrollCarry + v * dt;
    const whole = Math.trunc(nextCarry);
    nextCarry -= whole;

    return {
      state: { smoothX, smoothY, dX, dY, snapTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry: nextCarry },
      biasY,
      status: { cls: 's-good', text: engaged ? 'following' : 'hold…' },
      zoneText: label, velText: String(Math.round(v)),
      scroll: whole !== 0 ? { type: 'by', amount: whole } : null,
    };
  }

  const fresh = rawGaze && (now - rawGaze.t) < 250;
  if (!fresh) {
    return {
      state: { smoothX, smoothY, dX, dY, snapTarget, curZone: 0, zoneSince, scrollCarry },
      biasY,
      status: { cls: 's-bad', text: 'no gaze — hold' },
      zoneText: '–', velText: '0', scroll: null,
    };
  }
  const onSheetX = rawGaze.x > W * cfg.sheetMargin && rawGaze.x < W * (1 - cfg.sheetMargin);
  const onScreenY = rawGaze.y > 0 && rawGaze.y < H;
  if (!onSheetX || !onScreenY) {
    return {
      state: { smoothX, smoothY, dX, dY, snapTarget, curZone: 0, zoneSince, scrollCarry },
      biasY,
      status: { cls: 's-warn', text: 'looking away — hold' },
      zoneText: 'off', velText: '0', scroll: null,
    };
  }

  // One Euro filter (lib/oneEuroFilter.js) in place of a fixed-alpha EMA:
  // speed-adaptive cutoff gives low jitter while reading a line and low lag
  // on the saccade to the next system, rather than one fixed trade-off point
  // for every gaze speed. See minCutoffFromSmoothWin/ONE_EURO_BETA above for
  // the slider-to-filter-parameter mapping.
  const minCutoff = minCutoffFromSmoothWin(cfg.smoothWin);
  const xStep = oneEuroStep(smoothX == null ? null : { value: smoothX, deriv: dX }, rawGaze.x, dt, minCutoff, ONE_EURO_BETA);
  const yStep = oneEuroStep(smoothY == null ? null : { value: smoothY, deriv: dY }, rawGaze.y, dt, minCutoff, ONE_EURO_BETA);
  smoothX = xStep.value; dX = xStep.deriv;
  smoothY = yStep.value; dY = yStep.deriv;

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
        state: { smoothX, smoothY, dX, dY, snapTarget: arriving ? null : snapTarget, curZone, zoneSince, scrollCarry },
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
          state: { smoothX, smoothY, dX, dY, snapTarget: nextTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry },
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
          state: { smoothX, smoothY, dX, dY, snapTarget: nextTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry },
          biasY,
          status: { cls: 's-good', text: 'back a system' },
          zoneText: 'up', velText: '0', scroll: null,
        };
      }
    }
    return {
      state: { smoothX, smoothY, dX, dY, snapTarget, curZone: 0, zoneSince, scrollCarry },
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
    state: { smoothX, smoothY, dX, dY, snapTarget, curZone: nextZone, zoneSince: nextSince, scrollCarry: nextCarry },
    biasY,
    status: { cls: 's-good', text: engaged || zone === 0 ? 'following' : 'hold…' },
    zoneText: label, velText: String(Math.round(v)),
    scroll: whole !== 0 ? { type: 'by', amount: whole } : null,
  };
}

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../appState.js';
import { canFollow, followGate, setTrackingType } from './index.js';

// canFollow gates the "Follow eyes" button. It encodes the intended setup
// SEQUENCE (camera -> calibrate -> verify), so these tests are really about
// making sure a user can't skip a step and end up following with an
// unchecked calibration.
describe('canFollow: setup gating', () => {
  beforeEach(() => {
    state.camReady = false;
    state.pdfDoc = null;
    state.calibrated = false;
    state.verified = false;
    setTrackingType('iris');
  });

  it('blocks everything until the camera is on', () => {
    state.pdfDoc = {}; state.calibrated = true; state.verified = true;
    expect(canFollow()).toBe(false);
  });

  it('blocks until a PDF is loaded', () => {
    state.camReady = true; state.calibrated = true; state.verified = true;
    expect(canFollow()).toBe(false);
  });

  it('blocks an uncalibrated iris setup even with camera and PDF ready', () => {
    state.camReady = true; state.pdfDoc = {};
    expect(canFollow()).toBe(false);
  });

  it('still blocks after calibrating, until the accuracy check has been run', () => {
    state.camReady = true; state.pdfDoc = {}; state.calibrated = true;
    expect(canFollow()).toBe(false);
  });

  it('allows following once camera, PDF, calibration and verification are all done', () => {
    state.camReady = true; state.pdfDoc = {}; state.calibrated = true; state.verified = true;
    expect(canFollow()).toBe(true);
  });

  it('wink tracking needs neither calibration nor verification -- only camera and a PDF', () => {
    setTrackingType('wink');
    state.camReady = true; state.pdfDoc = {};
    expect(canFollow()).toBe(true);
  });
});

// followGate() is what the UI uses to explain WHY Follow-eyes is
// unavailable, and canFollow() is derived from it, so they cannot disagree
// by construction. These pin the reasons themselves — a blocked button that
// names the wrong prerequisite is as unhelpful as one that names none.
describe('followGate: reasons', () => {
  beforeEach(() => {
    state.camReady = false; state.pdfDoc = null;
    state.calibrated = false; state.verified = false;
    setTrackingType('iris');
  });

  it('names each missing prerequisite in order as they are satisfied', () => {
    expect(followGate()).toEqual([false, 'Start the camera first']);
    state.camReady = true;
    expect(followGate()).toEqual([false, 'Load a PDF first']);
    state.pdfDoc = {};
    expect(followGate()).toEqual([false, 'Calibrate first']);
    state.calibrated = true;
    expect(followGate()).toEqual([false, 'Run Verify first']);
    state.verified = true;
    expect(followGate()).toEqual([true, '']);
  });

  it('always pairs "blocked" with a reason and "available" with none', () => {
    for (const camReady of [false, true]) {
      for (const pdf of [false, true]) {
        for (const calibrated of [false, true]) {
          for (const verified of [false, true]) {
            state.camReady = camReady; state.pdfDoc = pdf ? {} : null;
            state.calibrated = calibrated; state.verified = verified;
            const [ok, why] = followGate();
            expect(why.length > 0).toBe(!ok);
            expect(ok).toBe(canFollow());
          }
        }
      }
    }
  });

  it('wink tracking skips the calibration/verify steps entirely', () => {
    setTrackingType('wink');
    state.camReady = true; state.pdfDoc = {};
    expect(followGate()).toEqual([true, '']);
  });
});

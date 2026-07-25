import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../appState.js';
import { canFollow, setTrackingType } from './index.js';

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

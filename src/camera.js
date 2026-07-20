import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { state } from './appState.js';
import { $, video, setStatus, showRecalBanner } from './ui.js';
import { loadCalibration, calibMismatch, currentFingerprint, calibModelId } from './calibration.js';
import { getActiveTracking, canFollow } from './tracking/index.js';

// MediaPipe's WASM runtime and the face-landmarker model are served from
// this app's own origin (public/mediapipe/, populated at dev/build time by
// scripts/fetch-mediapipe-assets.mjs) rather than a third-party CDN — the
// combined ~13MB turned out to be well within what's reasonable to
// self-host, and this app's core audience (school networks/devices) is
// exactly the audience most likely to have Google/jsDelivr's domains
// blocked by a content filter, which previously meant the app simply
// couldn't start. Inference still runs entirely on-device either way; only
// where the (non-personal) model weights are *fetched from* changed.
const WASM_URL = import.meta.env.BASE_URL + 'mediapipe/wasm';
const MODEL_URL = import.meta.env.BASE_URL + 'mediapipe/models/face_landmarker.task';

export const PROC_W = 640, PROC_H = 480;  // detection runs on this face-cropped, upscaled canvas
const procCanvas = document.createElement('canvas');
procCanvas.width = PROC_W; procCanvas.height = PROC_H;
const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });

let lastVideoTime = -1;

export async function startCamera() {
  if (state.camReady) return;
  setStatus('s-warn', 'loading model…');
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    try {
      state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      });
    } catch (gpuErr) {
      state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      });
    }
    // Capture at higher resolution so the face region keeps real detail when the
    // digital zoom crops and upscales it (falls back to whatever the cam offers).
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    await video.play();
    // Use the camera's real (hardware) zoom if it exposes one; else digital.
    state.videoTrack = stream.getVideoTracks()[0];
    try {
      const caps = state.videoTrack.getCapabilities ? state.videoTrack.getCapabilities() : {};
      if (caps && caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max > caps.zoom.min) {
        state.hwZoom = true; state.zoomCap = { min: caps.zoom.min, max: caps.zoom.max };
      }
    } catch (e) { /* zoom capability probing is best-effort */ }
    if (!state.autoFrame) setCameraZoom(parseFloat($('cz').value) / 100);
    state.camReady = true;
    $('camBtn').textContent = '🎥 Camera on';
    $('calibBtn').disabled = false;

    // Restore a saved iris calibration by default (only relevant if iris
    // tracking is the active type); flag if the setup looks different.
    const saved = getActiveTracking().needsCalibration ? loadCalibration() : null;
    if (saved && saved.model === calibModelId() && saved.coefX && saved.coefY && saved.gnorm) {
      state.coefX = saved.coefX; state.coefY = saved.coefY; state.gnorm = saved.gnorm;
      state.calibFp = saved.fp || null; state.calibrated = true;
      $('calibBtn').textContent = '🎯 Recalibrate';
      $('testBtn').disabled = false;
      const reasons = state.calibFp ? calibMismatch(state.calibFp, currentFingerprint()) : [];
      if (reasons.length) { showRecalBanner(reasons); setStatus('s-warn', 'calibration restored — ' + reasons[0]); }
      else setStatus('', 'calibration restored — ready');
    } else if (getActiveTracking().needsCalibration) {
      setStatus('', 'camera on — calibrate next');
    } else {
      setStatus('', 'camera on — ready to follow');
    }
    // Whichever branch ran above, re-check whether Follow-eyes can now be
    // enabled — a tracking type that doesn't need calibration (e.g. wink
    // tracking) should unlock it as soon as the camera (and a PDF) are ready.
    $('runBtn').disabled = !canFollow();
    requestAnimationFrame(predict);
  } catch (e) {
    setStatus('s-bad', 'camera/model blocked — allow the camera, or serve via http://localhost');
    console.error(e);
  }
}

function predict() {
  requestAnimationFrame(predict);
  if (!state.camReady || !state.faceLandmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  // Face-following digital zoom: crop around the face and upscale it so distant
  // eyes are detected at higher resolution. Periodically (and whenever the face
  // is lost) we drop to the FULL frame to re-find the face and re-anchor the
  // crop — so a big movement can't slip out of the zoomed view.
  const desiredZoom = state.autoFrame ? state.autoZoom : state.cameraZoom;
  const zooming = desiredZoom > 1.02;
  const periodic = (++state.reanchorCtr % 40) === 0;             // ~once per second
  const reanchor = zooming && (periodic || state.faceMiss > 6 || !state.faceCenterVid);
  const z = reanchor ? 1 : desiredZoom;
  const cw = vw / z, ch = vh / z;
  const fx = state.faceCenterVid ? state.faceCenterVid.x : vw / 2;
  const fy = state.faceCenterVid ? state.faceCenterVid.y : vh / 2;
  const sx0 = Math.max(0, Math.min(vw - cw, fx - cw / 2));
  const sy0 = Math.max(0, Math.min(vh - ch, fy - ch / 2));
  procCtx.drawImage(video, sx0, sy0, cw, ch, 0, 0, PROC_W, PROC_H);
  drawPreview();

  const res = state.faceLandmarker.detectForVideo(procCanvas, performance.now());
  const has = res.faceLandmarks && res.faceLandmarks.length;
  state.facePresent = !!has;
  sampleBrightness();
  if (!has) { state.faceMiss++; return; }
  state.faceMiss = 0;

  const lm = res.faceLandmarks[0];
  const fcx = sx0 + ((lm[234].x + lm[454].x) / 2) * cw;
  const fcy = sy0 + ((lm[10].y + lm[152].y) / 2) * ch;
  if (reanchor) {
    state.faceCenterVid = { x: fcx, y: fcy };          // authoritative re-anchor from the wide view
    return;                                            // skip gaze this frame (face is low-res here)
  }
  // track face center in VIDEO pixels for the next crop (smoothed)
  state.faceCenterVid = state.faceCenterVid
    ? { x: state.faceCenterVid.x + 0.3 * (fcx - state.faceCenterVid.x), y: state.faceCenterVid.y + 0.3 * (fcy - state.faceCenterVid.y) }
    : { x: fcx, y: fcy };
  // face size/pos as a fraction of the FULL frame (for accuracy suggestions)
  state.faceBox = { cx: fcx / vw, cy: fcy / vh, size: Math.abs(lm[454].x - lm[234].x) * cw / vw };
  if (state.autoFrame) {   // lock-and-zoom: keep the face at ~60% of the view
    const faceWvid = Math.abs(lm[454].x - lm[234].x) * cw;       // face width in video px
    const targetZ = Math.min(3.5, Math.max(1, (vw * 0.60) / Math.max(1, faceWvid)));
    state.autoZoom += 0.1 * (targetZ - state.autoZoom);
  }

  // Hand the raw landmarks to whichever Tracking Type is active — iris/pose
  // gaze mapping, wink detection, or (in future) something else. It returns
  // unclamped screen-fraction coordinates, or null if there's nothing to
  // report this frame (blinking, not calibrated, no wink held, etc).
  const result = getActiveTracking().onFrame(lm, res, PROC_W, PROC_H, window.innerHeight);
  if (state.trackingType === 'wink') {
    // Live readout so wink strength/reliability can be tuned by eye instead
    // of guesswork — scores are MediaPipe's eyeBlinkLeft/eyeBlinkRight
    // (0 = open, 1 = fully closed).
    $('wkL').textContent = state.winkScores.left.toFixed(2);
    $('wkR').textContent = state.winkScores.right.toFixed(2);
  }
  if (result) {
    const sx = Math.min(1, Math.max(0, result.ux)), sy = Math.min(1, Math.max(0, result.uy));
    const t = performance.now();
    state.rawGaze = { x: sx * window.innerWidth, y: sy * window.innerHeight, t };
    state.gazeUnclamped = { x: result.ux, y: result.uy, t };   // honest error for the accuracy test
    if (state.showGaze) {
      const gazeEl = $('gaze');
      gazeEl.style.left = state.rawGaze.x + 'px';
      gazeEl.style.top = state.rawGaze.y + 'px';
    }
  }
}

function drawPreview() {
  const pv = $('camview');
  if (pv && pv.style.display === 'block') pv.getContext('2d').drawImage(procCanvas, 0, 0, pv.width, pv.height);
}

// Sample average brightness of what the detector sees (throttled).
let bframe = 0;
const bcanvas = document.createElement('canvas'); bcanvas.width = 32; bcanvas.height = 24;
const bctx = bcanvas.getContext('2d', { willReadFrequently: true });
function sampleBrightness() {
  if ((bframe++ % 5) !== 0) return;
  try {
    bctx.drawImage(procCanvas, 0, 0, 32, 24);
    const d = bctx.getImageData(0, 0, 32, 24).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    state.frameBrightness = s / (d.length / 4);
  } catch (e) { /* canvas not readable yet — skip this sample */ }
}

// Camera zoom — hardware zoom when the camera supports it (real detail),
// otherwise a face-following digital crop. Orthogonal to gaze features, so no
// recalibration is needed either way.
export function setCameraZoom(z) {
  if (state.hwZoom && state.zoomCap && state.videoTrack && state.videoTrack.applyConstraints) {
    const val = state.zoomCap.min + (state.zoomCap.max - state.zoomCap.min) * Math.min(1, Math.max(0, (z - 1) / 2));
    state.videoTrack.applyConstraints({ advanced: [{ zoom: val }] }).catch(() => {});
    state.cameraZoom = 1;    // hardware does the zoom → skip the digital crop
  } else {
    state.cameraZoom = z;    // digital crop-and-upscale
  }
  $('czv').textContent = z.toFixed(1) + '×' + (state.hwZoom ? ' (hardware)' : '');
}

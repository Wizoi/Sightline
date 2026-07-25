# 7. Privacy & Client-Side Architecture Engineer

[← Back to persona roster](../PERSONAS.md)


**Owns:** the "everything runs in the browser, nothing is ever uploaded" constraint, and vetting
every new feature idea against it before it gets designed.
**Files:** whole-app constraint — no `src/` file is exempt; most visible in `README.md`'s privacy
section and the absence of any server/backend in the project. `scripts/fetch-mediapipe-assets.mjs`
and `public/mediapipe/` (git-ignored, populated at dev/build time) hold the self-hosted MediaPipe
assets — see below.

**What we've learned:**
- This is a **hard constraint, not a preference** — it has already ruled out a concrete feature
  direction (sending pages to a cloud OMR service for full rhythm/pitch extraction, which would
  have made accurate auto-scroll tempo detection much easier). Any future feature proposal that
  implies "send the score/audio/video to a server" needs a client-side-only alternative or it
  doesn't ship, no matter how much easier the server-side version would be.
- Corollary for calibration/settings data: it's stored **only in the browser** (no account, no
  sync) — that's a feature ("close the tab and nothing is kept except your saved settings"), so
  any new persisted setting should default to local storage, not assume a backend will ever
  exist.
- **The "MediaPipe's model/WASM are too large to self-host" tradeoff was never actually measured,
  and turned out to be wrong.** An independent review (2026-07-19) challenged it; verification
  (2026-07-20, live `HEAD`/download checks against the exact pinned URLs) found the real combined
  size is **~13MB** (float16 `face_landmarker.task` = 3.76MB, the larger of the two WASM variants
  ≈ 9MB — only one loads per session) — comfortably small, not "large" by this project's own PDF-
  loading standards. The CDN-loading approach's actual cost fell on exactly this app's audience:
  school networks commonly filter `storage.googleapis.com`/`cdn.jsdelivr.net`, which meant a
  blocked first load killed the app outright with a confusing error for a user with no way to
  self-diagnose "my school blocks Google's CDN" — worse than the inconvenience the CDN approach
  was chosen to avoid. **Fixed** (2026-07-20, see `docs/reviews/`): `scripts/fetch-mediapipe-
  assets.mjs` runs automatically before `dev`/`build` (via npm's `pre*` script lifecycle) and
  copies the WASM files straight out of the already-installed `@mediapipe/tasks-vision` npm
  package (so they can never drift from the pinned dependency version) plus downloads the model
  once from its stable, version-pinned URL; `camera.js` now points at same-origin
  `/mediapipe/wasm` and `/mediapipe/models/face_landmarker.task` instead. `public/mediapipe/` is
  git-ignored — a ~13MB binary doesn't belong in git history when it can be regenerated
  deterministically from a pinned dependency + a stable URL, the same reasoning that keeps user
  PDFs out of the repo. Licensing checked out too (`@mediapipe/tasks-vision` is Apache-2.0; native
  MediaPipe apps already bundle the `.task` file by design). The model URL was already pinned to
  version `1`, not `latest`, so self-hosting introduces **no new staleness risk** versus what was
  already shipping — a version bump requires a code change either way, CDN or not. **The
  constraint itself never actually required a CDN** — it was always "no frame/audio data leaves
  the machine," and inference still runs 100% on-device either way; this was a scope refinement of
  *how* the model gets to the browser, not a reversal of the constraint. **General lesson: a
  documented tradeoff's numbers should be treated as a claim to verify, not a fact to cite
  indefinitely** — this one sat unverified long enough for the actual asset sizes to never once
  have been checked against the real, small numbers.

- **Play-along audio score-following (mic-driven auto-scroll for a soloist) — reviewed 2026-07-20,
  verdict: no hard blocker, but three gaps in the existing posture, not zero-cost to ship:**
  - **The mic isn't explicitly covered by the privacy posture yet.** `liveTempo.js` already does
    `getUserMedia({ audio: true, ... })` for onset-based tempo correction (see Audio DSP persona),
    but the README's privacy section and this persona's own framing talk about "camera frame" far
    more prominently than audio — an implicit "audio inherits the same treatment as video" has
    never been written down. A *new*, more ambitious mic feature (driving scroll position, not
    just nudging a known schedule) is exactly the moment to make that explicit rather than let it
    stay implied.
  - **Any new pitch/onset ML model must follow the MediaPipe self-hosting precedent**, not the
    CDN-fetch pattern that precedent replaced: fetched at build/dev time from the installed npm
    package or a pinned stable URL (a `scripts/fetch-*-assets.mjs`-style script), served
    same-origin under `public/`, git-ignored, regenerable — not a runtime fetch from a third-party
    CDN a school network might block, and not assumed "too large to self-host" without actually
    checking its size the way the MediaPipe number was checked.
  - **The single most tempting phone-home vector here is accuracy-improvement telemetry** —
    "send a short clip/anonymized features to help us tune the detector" is a realistic ask for
    whoever builds the pitch/onset model, and must be preempted explicitly (no such call in the
    code, and ideally a smoke-test assertion that no network request fires while the mic is
    active), not just avoided by omission.
  - **Mic permission UX should mirror the camera's existing plain-language, at-point-of-use ask**,
    plus a one-line "analyzed on this device, never transmitted" affordance right at the permission
    prompt — this is also the fastest thing a school IT approver needs to see, not something to
    leave buried in a README.
  - **Holding a decoded PDF and a live mic buffer in memory at once is not a new privacy risk** —
    both are already in-process/in-memory-only with nothing written to disk; the only thing worth
    guarding against is a future engineer accidentally routing a raw audio buffer into
    localStorage (only settings belong there, per the existing corollary above).
  - Whether audio-based position-in-score estimation (matching played pitches/onsets to a known
    note sequence via something DTW-like) is even *feasible* client-side — as opposed to the
    existing "nudge a known schedule" onset correction — is the Audio DSP/OMR personas' call, not
    this persona's; note only that it would face the same "must recover actual note identity from
    something" problem that already made full pixel-based OMR infeasible, if the design ever needs
    to know *which* notes were played, not just *that* a note started.

**When to invoke:** early — at the *idea* stage of any feature that touches camera frames,
microphone audio, or the loaded PDF, before design work goes further. Cheaper to redirect a
feature idea here than to redesign it after building a server-dependent prototype.

**Open questions / future research:**
- Whether a **lightweight in-browser ML model** (WASM/TF.js-class, not a full cloud OMR pipeline)
  could someday narrow the gap on true rhythm extraction without breaking the client-side
  constraint — this is the condition under which the OMR Specialist's "infeasible" verdict (see
  persona 3) would be worth revisiting. **Sharpened to a specific, checkable trigger (2026-07-23),
  not just "a lightweight model turns up":** revisit if ONNX-exported OMR models (the `oemer`-class
  reference point already researched in persona 3's literature pass — see "Literature/prior-art
  research pass," staff/system-detection bullet) become small/fast enough to run acceptably under
  `onnxruntime-web`/WebGPU. As of that same research pass, `onnxruntime-web`'s own non-SIMD/
  non-threaded WASM runtime alone is ~10.5MB — comparable to this app's entire existing MediaPipe
  download — before even counting a real OMR model's own weights, so the condition is not yet met.

